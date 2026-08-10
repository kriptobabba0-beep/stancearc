// poolStatsStore.test.ts — the cache in front of the pool page's 24h scan.
//
// The scan costs about fifty eth_getLogs calls because Arc caps each one at a 10,000-block
// range, so what matters here is who ends up paying for it: a visitor should almost never wait,
// and should never be shown an error while usable figures exist.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kvStore = new Map<string, string>();
const ctx = { waitUntil: vi.fn() as unknown as (p: Promise<unknown>) => void };
let kvBound = true;
let ctxBound = true;

vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: kvBound
      ? {
          LEADERBOARD_KV: {
            get: async (k: string) => kvStore.get(k) ?? null,
            put: async (k: string, v: string) => void kvStore.set(k, v),
          },
        }
      : {},
    ctx: ctxBound ? ctx : undefined,
  }),
}));

import {
  FRESH_MS,
  STALE_MS,
  POOL_STATS_KEY,
  freshnessOf,
  readStored,
  writeStored,
  runInBackground,
  type StoredPoolStats,
} from '@/lib/poolStatsStore';

const stats = (generatedAt: number): StoredPoolStats => ({
  generatedAt,
  prices: { USDC: 1, cirBTC: 60_000 },
  rowFlow: { btc: { volume24Usd: 1234, fees24Usd: 3.7 } },
  spark: { volume: [1, 2], fees: [0.1, 0.2], tvlShape: [1, 1] },
});

beforeEach(() => {
  kvStore.clear();
  kvBound = true;
  ctxBound = true;
  vi.mocked(ctx.waitUntil).mockClear?.();
});

describe('freshnessOf', () => {
  const now = 1_000_000;

  it('treats a just-written answer as fresh', () => {
    expect(freshnessOf(stats(now), now)).toBe('fresh');
    expect(freshnessOf(stats(now - FRESH_MS + 1), now)).toBe('fresh');
  });

  it('treats a minute-old answer as stale: serve it, but refresh behind the visitor', () => {
    expect(freshnessOf(stats(now - FRESH_MS - 1), now)).toBe('stale');
    expect(freshnessOf(stats(now - STALE_MS + 1), now)).toBe('stale');
  });

  it('treats a long-abandoned answer as expired', () => {
    expect(freshnessOf(stats(now - STALE_MS - 1), now)).toBe('expired');
  });

  it('has nothing to serve when the cache is empty', () => {
    expect(freshnessOf(null, now)).toBe('expired');
  });

  it('trusts a timestamp from the future rather than rescanning', () => {
    // Colo clocks disagree by a second or two. Reading that as "impossibly old" would make
    // every visitor to the fast colo pay for a scan.
    expect(freshnessOf(stats(now + 5_000), now)).toBe('fresh');
  });
});

describe('the stored payload', () => {
  it('round-trips through KV', async () => {
    expect(await writeStored(stats(42))).toBe(true);
    const back = await readStored();
    expect(back?.generatedAt).toBe(42);
    expect(back?.rowFlow.btc.volume24Usd).toBe(1234);
  });

  it('reads as empty rather than throwing when KV is not bound', async () => {
    kvBound = false;
    expect(await readStored()).toBeNull();
    expect(await writeStored(stats(1))).toBe(false);
  });

  it('ignores a corrupt entry instead of serving it as figures', async () => {
    kvStore.set(POOL_STATS_KEY, '{ this is not json');
    expect(await readStored()).toBeNull();
  });

  it('rejects an entry that is missing the numbers the page reads', async () => {
    kvStore.set(POOL_STATS_KEY, JSON.stringify({ generatedAt: 1 }));
    expect(await readStored()).toBeNull();
  });
});

describe('background refresh', () => {
  it('hands the refresh to the runtime so it outlives the response', () => {
    // Returning a response cancels anything still running. Without this the stale entry would
    // be served for ever and the cache would never move on.
    const work = Promise.resolve();
    expect(runInBackground(work)).toBe(true);
    expect(ctx.waitUntil).toHaveBeenCalledWith(work);
  });

  it('reports honestly when the runtime has no background hook', () => {
    ctxBound = false;
    expect(runInBackground(Promise.resolve())).toBe(false);
  });
});
