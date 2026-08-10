// lib/poolStatsStore.ts — the cache behind /api/pool-stats.
//
// The pool page's 24h figures cost roughly fifty eth_getLogs calls to produce, because Arc caps
// each one at a 10,000-block range. That is a fixed price; the only question is how often it is
// paid. Cached here, it is paid once a minute for the whole site instead of once per visitor.
//
// The freshness rule has two rungs rather than one. Inside FRESH_MS the stored answer is simply
// correct enough. Between FRESH_MS and STALE_MS it is served immediately AND refreshed in the
// background, so a visitor never waits for a scan they did not cause. Only a completely cold or
// long-abandoned cache makes someone wait, and even then they get numbers rather than an error.
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { PoolFlow } from '@/lib/poolFlow';

export const POOL_STATS_KEY = 'poolstats:v1';
/** Serve without touching the chain. Volume over a day barely moves in a minute. */
export const FRESH_MS = 60_000;
/** Still worth serving, but refresh behind the visitor's back. */
export const STALE_MS = 15 * 60_000;

export interface StoredPoolStats extends PoolFlow {
  generatedAt: number;
}

/** The slice of KV this module uses — keeps the code testable without Workers types. */
export interface PoolStatsKV {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export function poolStatsKV(): PoolStatsKV | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, PoolStatsKV | undefined>;
    return env.LEADERBOARD_KV ?? null;
  } catch {
    return null; // outside a Workers request context (build, tests, `next dev`)
  }
}

export async function readStored(kv = poolStatsKV()): Promise<StoredPoolStats | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(POOL_STATS_KEY, 'text');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPoolStats;
    return typeof parsed?.generatedAt === 'number' && parsed.rowFlow ? parsed : null;
  } catch {
    return null; // a KV blip must not take the page down
  }
}

export async function writeStored(value: StoredPoolStats, kv = poolStatsKV()): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(POOL_STATS_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Run work that must outlive the response (the background refresh).
 *
 * Returning a response normally cancels anything still running, so without waitUntil a stale
 * entry would be served forever and never refreshed. Returns whether the runtime accepted the
 * work, so the caller can tell "refreshing" from "no background support here".
 */
export function runInBackground(work: Promise<unknown>): boolean {
  try {
    const ctx = getCloudflareContext().ctx as { waitUntil?: (p: Promise<unknown>) => void } | undefined;
    if (typeof ctx?.waitUntil !== 'function') return false;
    ctx.waitUntil(work);
    return true;
  } catch {
    return false; // outside a Workers request context
  }
}

export type Freshness = 'fresh' | 'stale' | 'expired';

/** How a stored answer should be treated right now. */
export function freshnessOf(stored: StoredPoolStats | null, now: number): Freshness {
  if (!stored) return 'expired';
  const age = now - stored.generatedAt;
  if (age < 0) return 'fresh'; // clock skew between colos: trust it rather than rescanning
  if (age <= FRESH_MS) return 'fresh';
  if (age <= STALE_MS) return 'stale';
  return 'expired';
}
