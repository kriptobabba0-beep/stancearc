// lib/leaderboardStore.ts — the site's half of the leaderboard: a KV namespace holding one
// ready-to-serve payload per market, written by the keeper's indexer and read by /api/leaderboard.
//
// KV is the whole point of the redesign. The previous store was the per-colo Cache API, which
// gave every Cloudflare location its own leaderboard at its own block height, so refreshing the
// page could move you between a current copy and a week-old one. KV is global: every isolate in
// every colo reads the same bytes, so there is exactly one answer to "what are the standings".
//
// The payload is stored as the exact JSON the API returns. Serving is then a read and a passthrough
// — no parsing, no aggregation, no chain access on the request path at all.
import { getCloudflareContext } from '@opennextjs/cloudflare';

/** The slice of the KV API this module uses — keeps the code testable without Workers types. */
export interface LeaderboardKV {
  get(key: string, type?: 'text'): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
}

export const kvKey = (marketId: string) => `leaderboard:v1:${marketId.toLowerCase()}`;
/** Per-address rows, read server-side only, to answer "where do I stand?" outside the top rows. */
export const kvSelfKey = (marketId: string) => `leaderboard:v1:${marketId.toLowerCase()}:self`;
/** A campaign's standings. Its own key so a finished campaign is never overwritten by the next. */
export const kvCampaignKey = (campaignId: string) => `campaign:v1:${campaignId.toLowerCase()}`;
/**
 * Which campaign the site should show, written by whoever published last.
 *
 * Without this the campaign page has to be told its id at build time, so starting a campaign
 * means a frontend deploy, and a mismatch between the id the keeper publishes and the one the
 * page asks for shows an empty board on a campaign that is running perfectly. The keeper knows
 * which campaign is current; letting it say so is the only version that cannot drift.
 */
export const kvCampaignCurrentKey = 'campaign:v1:current';
/**
 * The list of campaigns that have ever published, newest first.
 *
 * Kept as its own small key rather than derived by listing the namespace: a KV list costs a call
 * per page and returns keys, not the figures the index page needs, so building this from the
 * publishes we already receive is both cheaper and complete. It holds summaries only — opening a
 * campaign still reads that campaign's own key.
 */
export const kvCampaignIndexKey = 'campaign:v1:index';

/** One row of the campaign index: enough to list and group a campaign without opening it. */
export interface CampaignSummary {
  id: string;
  title: string;
  live: boolean;
  startBlock: string;
  endBlock: string;
  /** How far the indexer has folded in, so a running campaign can show real progress. */
  cursor: string;
  generatedAt: number;
  volumeUsd6: string;
  participants: number;
  prizeUsd: number;
}

/** How many campaigns the index keeps. Far above any plausible number of real campaigns. */
const CAMPAIGN_INDEX_CAP = 100;

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

export async function readCampaign(campaignId: string, kv = leaderboardKV()): Promise<string | null> {
  if (!kv) return null;
  try {
    return await kv.get(kvCampaignKey(campaignId), 'text');
  } catch {
    return null;
  }
}

export async function writeCampaign(campaignId: string, json: string, kv = leaderboardKV()): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(kvCampaignKey(campaignId), json);
    return true;
  } catch {
    return false;
  }
}

/** Every campaign that has published, newest first. Empty when none ever has. */
export async function readCampaignIndex(kv = leaderboardKV()): Promise<CampaignSummary[]> {
  if (!kv) return [];
  try {
    const raw = await kv.get(kvCampaignIndexKey, 'text');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((c) => c && typeof (c as CampaignSummary).id === 'string') as CampaignSummary[]) : [];
  } catch {
    return [];
  }
}

/**
 * Record a campaign in the index, replacing any earlier entry for the same id.
 *
 * Ordering is newest-first by when the campaign STARTED, not by when it last published: a running
 * campaign republishes every loop, and sorting on that would shuffle finished campaigns around
 * every thirty seconds for no reason a reader could follow.
 */
export async function upsertCampaignIndex(entry: CampaignSummary, kv = leaderboardKV()): Promise<boolean> {
  if (!kv) return false;
  try {
    const list = (await readCampaignIndex(kv)).filter((c) => c.id !== entry.id);
    list.push(entry);
    list.sort((a, b) => {
      const sa = BigInt(a.startBlock || '0');
      const sb = BigInt(b.startBlock || '0');
      if (sa !== sb) return sb > sa ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
    await kv.put(kvCampaignIndexKey, JSON.stringify(list.slice(0, CAMPAIGN_INDEX_CAP)));
    return true;
  } catch {
    return false;
  }
}

/** The id of the campaign to show when the caller didn't name one. Null when none is set. */
export async function readCurrentCampaignId(kv = leaderboardKV()): Promise<string | null> {
  if (!kv) return null;
  try {
    const id = await kv.get(kvCampaignCurrentKey, 'text');
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Point the site at a campaign. Best-effort by design: the standings are already stored under
 * their own key by the time this runs, so a failed pointer write costs a stale pointer, never
 * the data.
 */
export async function writeCurrentCampaignId(campaignId: string, kv = leaderboardKV()): Promise<boolean> {
  if (!kv) return false;
  try {
    await kv.put(kvCampaignCurrentKey, campaignId);
    return true;
  } catch {
    return false;
  }
}

/** The shape the indexer is allowed to publish for a campaign. */
export function validateCampaign(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return 'body must be an object';
  const p = body as Record<string, unknown>;
  if (typeof p.id !== 'string' || !p.id) return 'id is required';
  if (typeof p.startBlock !== 'string' || typeof p.endBlock !== 'string') return 'blocks must be strings';
  if (typeof p.generatedAt !== 'number') return 'generatedAt must be a number';
  if (typeof p.totals !== 'object' || p.totals === null) return 'totals is required';
  if (typeof p.prize !== 'object' || p.prize === null) return 'prize is required';
  for (const k of ['volume', 'pnl']) {
    if (!Array.isArray(p[k])) return `${k} must be an array`;
  }
  return null;
}

/** One address's rows, looked up server-side. Returns null when unknown — never throws. */
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
