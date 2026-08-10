// The indexer is the single writer behind the site's leaderboard. Its loop is timing-bound, so
// what is tested here is everything that decides WHAT gets written: window arithmetic (a wrong
// window silently skips or replays blocks, and replaying double-counts), log routing (a log
// attributed to the wrong contract corrupts the standings), config parsing (a bad market config
// must fail loudly at boot, not index the wrong arena), and snapshot round-tripping through disk.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nextWindow,
  decodeWindow,
  loadIndexerConfig,
  loadSnapshot,
  saveSnapshot,
  pushPayload,
  loadCampaignConfigs,
  type IndexerMarket,
} from '../src/leaderboardIndexer.js';
import { emptySnapshot, applyLogs } from '../src/leaderboardIndex.js';

const ARENA = '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2';
const POOL = '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b';
const NPM = '0x1111111111111111111111111111111111111111';
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const market: IndexerMarket = {
  id: 'btc', arena: ARENA, pool: POOL, npm: NPM,
  baseSymbol: 'cirBTC', quoteSymbol: 'USDC',
  fromBlock: 100n, baseDecimals: 8, baseIsToken0: true,
};

const noLog = () => {};
const tmpDir = () => mkdtempSync(join(tmpdir(), 'lb-'));

describe('nextWindow', () => {
  it('walks the chain in fixed strides without gaps or overlap', () => {
    const a = nextWindow(100n, 100_000n, 9_000n)!;
    expect(a).toEqual([100n, 9_099n]);
    // The next window must start exactly one past the previous end — a gap loses blocks, an
    // overlap re-folds them and double-counts every aggregate in the range.
    const b = nextWindow(a[1] + 1n, 100_000n, 9_000n)!;
    expect(b[0]).toBe(9_100n);
  });

  it('clamps the last window to the head and reports caught-up', () => {
    expect(nextWindow(95n, 100n, 9_000n)).toEqual([95n, 100n]);
    expect(nextWindow(101n, 100n, 9_000n)).toBeNull();
  });
});

describe('decodeWindow', () => {
  // One address-only getLogs returns every contract's logs mixed together; routing them by
  // address is what makes a single call cover all three sources.
  const swapTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

  it('routes each log to the contract it came from and skips unmodelled events', () => {
    const logs = [
      // A pool Swap: recipient indexed, amounts + sqrtPrice + liquidity + tick in data.
      {
        address: POOL,
        topics: [
          swapTopic,
          `0x000000000000000000000000${ALICE.slice(2)}`,
          `0x000000000000000000000000${ALICE.slice(2)}`,
        ],
        data:
          '0x' +
          (2n ** 256n - 1_000_000n).toString(16).padStart(64, '0') + // amount0 = -1_000_000
          (2_000_000n).toString(16).padStart(64, '0') +
          (2n ** 96n).toString(16).padStart(64, '0') +
          (1n).toString(16).padStart(64, '0') +
          (0n).toString(16).padStart(64, '0'),
        blockNumber: 10n,
        logIndex: 0,
      },
      // An event this indexer does not model — must be dropped, not throw.
      { address: POOL, topics: ['0x' + 'ab'.repeat(32)], data: '0x', blockNumber: 10n, logIndex: 1 },
      // A contract we don't track at all.
      { address: '0x9999999999999999999999999999999999999999', topics: [swapTopic], data: '0x', blockNumber: 10n, logIndex: 2 },
    ] as never;

    const out = decodeWindow(logs, market);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('pool');
    expect(out[0]!.eventName).toBe('Swap');
  });

  it('returns nothing for an empty window instead of throwing', () => {
    expect(decodeWindow([] as never, market)).toEqual([]);
  });
});

describe('loadIndexerConfig', () => {
  const base = {
    LEADERBOARD_MARKETS: JSON.stringify([
      { id: 'btc', arena: ARENA, pool: POOL, npm: NPM, baseSymbol: 'cirBTC', fromBlock: '48684148', baseDecimals: 8, baseIsToken0: true },
    ]),
    LEADERBOARD_RPC_URL: 'https://rpc.example',
  } as NodeJS.ProcessEnv;

  it('parses markets and applies neighbourly defaults', () => {
    const cfg = loadIndexerConfig(base);
    expect(cfg.markets[0]!.arena).toBe(ARENA);
    expect(cfg.markets[0]!.fromBlock).toBe(48_684_148n);
    expect(cfg.markets[0]!.quoteSymbol).toBe('USDC');
    // Defaults exist so a misconfigured deploy is polite rather than a thundering herd.
    expect(cfg.throttleMs).toBeGreaterThanOrEqual(1_000);
    expect(cfg.windowBlocks).toBe(9_000n);
  });

  it('fails loudly rather than indexing the wrong thing', () => {
    expect(() => loadIndexerConfig({ ...base, LEADERBOARD_MARKETS: undefined })).toThrow(/required/);
    expect(() => loadIndexerConfig({ ...base, LEADERBOARD_MARKETS: 'not json' })).toThrow(/valid JSON/);
    expect(() => loadIndexerConfig({ ...base, LEADERBOARD_MARKETS: '[]' })).toThrow(/non-empty/);
    expect(() =>
      loadIndexerConfig({ ...base, LEADERBOARD_MARKETS: JSON.stringify([{ id: 'btc' }]) }),
    ).toThrow(/arena is required/);
    expect(() => loadIndexerConfig({ ...base, LEADERBOARD_RPC_URL: undefined, KEEPER_RPC_URL: undefined })).toThrow(/RPC_URL/);
  });
});

describe('snapshot on disk', () => {
  const cfg = (dir: string) => ({ stateDir: dir }) as never;

  it('round-trips a snapshot so a restart never re-scans what it already knows', () => {
    const dir = tmpDir();
    const snap = emptySnapshot(ARENA, 100n, 8, true);
    applyLogs(snap, [], 5_000n, Date.now());
    expect(saveSnapshot(cfg(dir), market, snap, noLog)).toBe(true);

    const back = loadSnapshot(cfg(dir), market, noLog);
    expect(back.cursor).toBe(5_001n);
  });

  it('starts fresh when the snapshot belongs to a REPLACED arena', () => {
    const dir = tmpDir();
    const snap = emptySnapshot('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 100n, 8, true);
    applyLogs(snap, [], 9_999n, Date.now());
    saveSnapshot(cfg(dir), { ...market, arena: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, snap, noLog);
    // Same file, but the configured arena is different now — those totals are another contract's.
    const back = loadSnapshot(cfg(dir), market, noLog);
    expect(back.cursor).toBe(market.fromBlock);
    expect(back.arena).toBe(ARENA);
  });

  it('starts fresh on a corrupt file rather than crashing the service', () => {
    const dir = tmpDir();
    writeFileSync(join(dir, 'leaderboard-btc.json'), '{ this is not json', 'utf8');
    expect(loadSnapshot(cfg(dir), market, noLog).cursor).toBe(market.fromBlock);
  });
});

describe('pushPayload', () => {
  const cfg = { ingestUrl: 'https://site.example/api/leaderboard/ingest', ingestSecret: 's3cret' } as never;

  it('sends the shared secret and reports success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    const r = await pushPayload(cfg, { market: 'btc' }, fetchImpl as never);
    expect(r.ok).toBe(true);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init.headers as Record<string, string>)['X-Leaderboard-Secret']).toBe('s3cret');
  });

  it('reports a rejection instead of throwing, so a bad push cannot kill the loop', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    expect(await pushPayload(cfg, {}, fetchImpl as never)).toMatchObject({ ok: false, status: 401 });
  });

  it('survives a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await pushPayload(cfg, {}, fetchImpl as never)).toMatchObject({ ok: false, status: 0 });
  });

  it('does nothing when ingest is not configured', async () => {
    const fetchImpl = vi.fn();
    expect(await pushPayload({ ingestUrl: null, ingestSecret: null } as never, {}, fetchImpl as never)).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// The bug this guards against shipped once and was invisible: the arena event fragments were
// hand-written, `epochId` was declared uint256 where the contract emits uint64, every topic0
// therefore hashed to something the chain never emits, and parseEventLogs({strict:false}) skipped
// all of them without an error. The page still rendered, volume still looked right (it comes from
// the pool), and the standings quietly reported 0 epochs, 0 fees and empty 7D/30D windows.
//
// So this decodes REAL logs captured from the live arena. A signature that drifts from the
// contract fails here instead of in production.
describe('arena decoding against real captured logs', () => {
  const raw = (JSON.parse(
    readFileSync(new URL('./fixtures-arenaLogs.json', import.meta.url), 'utf8'),
  ) as Array<Record<string, string>>).map((l) => ({
    ...l,
    blockNumber: BigInt(l.blockNumber!),
    logIndex: parseInt(l.logIndex!, 16),
  })) as never;

  const arenaMarket = { ...market, arena: '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2' };

  it('decodes the lifecycle events the standings are built from', () => {
    const names = new Set(decodeWindow(raw, arenaMarket).map((l) => l.eventName));
    for (const required of ['EpochCreated', 'Staked', 'PositionProcessed', 'EpochSettled']) {
      expect(names, `${required} did not decode — the ABI has drifted from the contract`).toContain(required);
    }
  });

  it('feeds the engine real epoch state rather than silently nothing', () => {
    const snap = emptySnapshot(arenaMarket.arena, 1n, 8, false);
    applyLogs(snap, decodeWindow(raw, arenaMarket), 99n, Date.now());
    // The exact symptom of the shipped bug: these were all zero while the page looked fine.
    expect(snap.totals.epochsSettled).toBeGreaterThan(0);
    expect(snap.epochPrice.size).toBeGreaterThan(0);
    expect(snap.epochTime.size).toBeGreaterThan(0);
    expect(snap.lastTimeSec).toBeGreaterThan(0);
  });
});

// The campaign runs inside the same loop as the leaderboard, so what matters is that it stays a
// SEPARATE index: its own start block, its own file, and a hard stop at the end block. Folding one
// block past the deadline changes a result that has already been announced.
describe('campaign config', () => {
  const base = {
    LEADERBOARD_MARKETS: JSON.stringify([
      { id: 'btc', arena: ARENA, pool: POOL, npm: NPM, baseSymbol: 'cirBTC', fromBlock: '1', baseDecimals: 8, baseIsToken0: true },
    ]),
    LEADERBOARD_RPC_URL: 'https://rpc.example',
  } as NodeJS.ProcessEnv;

  const CAMPAIGN = JSON.stringify({
    id: 'aug',
    marketId: 'btc',
    startBlock: '55000000',
    endBlock: '56000000',
    excluded: ['0xAAAA000000000000000000000000000000000001'],
    tiers: [{ minVolumeUsd6: '0', prizeUsd: 300 }, { minVolumeUsd6: '250000000000', prizeUsd: 400 }],
  });

  it('parses the range, lowercases the exclusions and keeps the tiers', () => {
    const [c] = loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: CAMPAIGN }).campaigns;
    expect(c!.startBlock).toBe(55_000_000n);
    expect(c!.endBlock).toBe(56_000_000n);
    // Addresses arrive checksummed and are compared lowercase, so an exclusion must not depend on case.
    expect(c!.excluded.has('0xaaaa000000000000000000000000000000000001')).toBe(true);
    expect(c!.tiers[1]!.prizeUsd).toBe(400);
  });

  it('treats an absent campaign as "no campaign", not as a boot failure', () => {
    // The live leaderboard must never be taken down by a campaign that isn't configured yet.
    expect(loadIndexerConfig(base).campaigns).toEqual([]);
    expect(loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: '' }).campaigns).toEqual([]);
  });

  it('rejects a campaign missing the fields that decide what is measured', () => {
    for (const bad of [{ marketId: 'btc', startBlock: '1' }, { id: 'a', startBlock: '1' }, { id: 'a', marketId: 'btc' }]) {
      expect(() => loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: JSON.stringify(bad) })).toThrow(/required/);
    }
  });

  it('an open-ended campaign has no end block, and never clamps', () => {
    const cfg = loadIndexerConfig({
      ...base,
      CAMPAIGN_CONFIG: JSON.stringify({ id: 'x', marketId: 'btc', startBlock: '10' }),
    });
    expect(cfg.campaigns[0]!.endBlock).toBe(0n);
    // The window walker is what enforces the stop; with no end there is nothing to stop at.
    expect(nextWindow(10n, 100n, 9_000n)).toEqual([10n, 100n]);
  });
});

// Campaigns overlap in practice: one finishing while the next runs, and finished ones still worth
// publishing so they stay on the site. Running an indexer per campaign would mean another copy of
// the same fold over the same logs, so one loop carries them all.
describe('several campaigns at once', () => {
  const base = {
    LEADERBOARD_MARKETS: JSON.stringify([
      { id: 'btc', arena: '0x' + '1'.repeat(40), pool: '0x' + '2'.repeat(40), npm: '0x' + '3'.repeat(40), baseSymbol: 'cirBTC', baseDecimals: 8, fromBlock: '1' },
    ]),
    LEADERBOARD_RPC_URL: 'https://rpc.example',
  };
  const c = (over: Record<string, unknown> = {}) => ({
    id: 'a',
    marketId: 'btc',
    startBlock: '100',
    endBlock: '200',
    tiers: [{ minVolumeUsd6: '0', prizeUsd: 100 }],
    ...over,
  });

  it('loads every campaign in an array, keeping their own ranges', () => {
    const cfg = loadIndexerConfig({
      ...base,
      CAMPAIGN_CONFIG: JSON.stringify([c(), c({ id: 'b', startBlock: '300', endBlock: '0' })]),
    });
    expect(cfg.campaigns.map((x) => x.id)).toEqual(['a', 'b']);
    expect(cfg.campaigns[0]!.endBlock).toBe(200n);
    expect(cfg.campaigns[1]!.endBlock).toBe(0n); // still running
  });

  it('still accepts a single campaign object, so existing configs keep working', () => {
    const cfg = loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: JSON.stringify(c()) });
    expect(cfg.campaigns).toHaveLength(1);
    expect(cfg.campaigns[0]!.id).toBe('a');
  });

  it('refuses two campaigns sharing an id rather than letting them overwrite each other', () => {
    // They publish under the same key, so they would take turns replacing each other's standings
    // and the result would read as one campaign whose numbers flicker.
    expect(() =>
      loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: JSON.stringify([c(), c({ startBlock: '999' })]) }),
    ).toThrow(/two campaigns with id "a"/);
  });

  it('carries an optional title through for the site to display', () => {
    const cfg = loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: JSON.stringify([c({ title: 'August Sprint' })]) });
    expect(cfg.campaigns[0]!.title).toBe('August Sprint');
    const untitled = loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: JSON.stringify([c()]) });
    expect(untitled.campaigns[0]!.title).toBeUndefined();
  });

  it('reports a bad campaign by name instead of failing anonymously', () => {
    expect(() =>
      loadIndexerConfig({ ...base, CAMPAIGN_CONFIG: JSON.stringify([c(), { marketId: 'btc', startBlock: '1' }]) }),
    ).toThrow(/required/);
  });
});
