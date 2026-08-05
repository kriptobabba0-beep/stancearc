// lib/leaderboardStore.ts - the site's half of the leaderboard: a KV namespace holding one
// ready-to-serve payload per market, written by the keeper's indexer and read by /api/leaderboard.
//
// KV is the whole point of the redesign. The previous store was the per-colo Cache API, which
// gave every Cloudflare location its own leaderboard at its own block height, so refreshing the
// page could move you between a current copy and a week-old one. KV is global: every isolate in
// every colo reads the same bytes, so there is exactly one answer to "what are the standings".
//
// The payload is stored as the exact JSON the API returns. Serving is then a read and a passthrough
// - no parsing, no aggregation, no chain access on the request path at all.
import { getCloudflareContext } from '@opennextjs/cloudflare';

/** The slice of the KV API this module uses - keeps the code testable without Workers types. */
export interface LeaderboardKV {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
}

export const kvKey = (marketId: string) => `leaderboard:v1:${marketId.toLowerCase()}`;
/** Per-address rows, read server-side only, to answer "where do I stand?" outside the top rows. */
export const kvSelfKey = (marketId: string) => `leaderboard:v1:${marketId.toLowerCase()}:self`;

/**
 * The bound KV namespace, or null when it isn't configured.
 *
 * Null is a normal state, not a crash: local `next dev`, a preview build, or a deploy made before
 * the namespace was created all land here. Callers degrade to an explicit "no data yet" instead of
 * throwing, so a missing binding shows up as an empty leaderboard with a reason rather than a 500.
 */
export function leaderboardKV(): LeaderboardKV | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, LeaderboardKV | undefined>;
    return env.LEADERBOARD_KV ?? null;
  } catch {
    return null; // outside a Workers request context (build, tests, `next dev`)
  }
}

export async function readPayload(marketId: string, kv = leaderboardKV()): Promise<string | null> {
  if (!kv) return null;
  try {
    return await kv.get(kvKey(marketId), 'text');
  } catch {
    return null; // a KV blip must not take the page down
  }
}

export async function writePayload(marketId: string, json: string, kv = leaderboardKV()): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(kvKey(marketId), json);
    return true;
  } catch {
    return false;
  }
}

export async function writeSelfIndex(marketId: string, json: string, kv = leaderboardKV()): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(kvSelfKey(marketId), json);
    return true;
  } catch {
    return false;
  }
}

/** One address's rows, looked up server-side. Returns null when unknown - never throws. */
export async function readSelfRows(
  marketId: string,
  address: string,
  kv = leaderboardKV(),
): Promise<{ address: string; all: unknown; d30: unknown; d7: unknown } | null> {
  if (!kv) return null;
  const addr = address.toLowerCase();
  try {
    const raw = await kv.get(kvSelfKey(marketId), 'text');
    if (!raw) return null;
    const idx = JSON.parse(raw) as Record<'all' | 'd30' | 'd7', Record<string, unknown>>;
    const pick = (w: 'all' | 'd30' | 'd7') => idx?.[w]?.[addr] ?? null;
    const rows = { address: addr, all: pick('all'), d30: pick('d30'), d7: pick('d7') };
    return rows.all || rows.d30 || rows.d7 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time string comparison for the ingest secret.
 *
 * Written out rather than taken from node:crypto so it behaves identically on the Workers runtime
 * and under vitest. Length is compared first and leaks only the length, which is not the secret.
 */
export function secretsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * What we serve before the indexer's first push: a valid, empty payload rather than an error, so
 * the page renders its normal empty state with `syncing` set instead of showing a failure for what
 * is really just a cold start.
 *
 * Lives here rather than in the route because Next.js route files may only export handlers.
 */
export function warmingUpPayload(
  market: { id: string; feeArena: string; baseSymbol: string; quoteSymbol?: string },
  reason: string,
) {
  return {
    market: market.id,
    arena: market.feeArena,
    baseSymbol: market.baseSymbol,
    quoteSymbol: market.quoteSymbol ?? 'USDC',
    head: '0',
    cursor: '0',
    syncing: true,
    progress: 0,
    updatedAt: 0,
    generatedAt: 0,
    lastError: reason,
    totals: {
      epochsSettled: 0,
      volumeUsd6: '0',
      swapUsd6: '0',
      liqUsd6: '0',
      feeUsd6: '0',
      redistributedUsd6: '0',
      participants: 0,
    },
    rows: [],
    d30: [],
    d7: [],
  };
}

/** The payload shape the indexer is allowed to publish. Rejects anything that isn't one. */
export function validatePayload(body: unknown, marketId: string): string | null {
  if (typeof body !== 'object' || body === null) return 'body must be an object';
  const p = body as Record<string, unknown>;
  if (typeof p.market !== 'string' || p.market !== marketId) return 'market mismatch';
  if (typeof p.arena !== 'string' || !p.arena) return 'arena is required';
  if (typeof p.head !== 'string' || typeof p.cursor !== 'string') return 'head/cursor must be strings';
  if (typeof p.generatedAt !== 'number') return 'generatedAt must be a number';
  if (typeof p.totals !== 'object' || p.totals === null) return 'totals is required';
  for (const k of ['rows', 'd30', 'd7']) {
    if (!Array.isArray(p[k])) return `${k} must be an array`;
  }
  return null;
}
