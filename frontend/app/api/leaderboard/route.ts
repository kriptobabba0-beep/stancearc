// app/api/leaderboard/route.ts - GET ?market=<id> returns the standings.
//
// This handler does no chain access and no aggregation. The keeper's indexer maintains the index
// and pushes a finished payload to KV (see app/api/leaderboard/ingest); serving is a KV read and a
// passthrough, which is why it answers in milliseconds and why every visitor sees the same numbers
// no matter which Cloudflare location they land in.
//
// It used to advance an incremental chain scan on the request path, with the snapshot in per-colo
// cache. That gave each colo its own leaderboard at its own block height - refreshing could swing
// between current and week-old data - and a visitor who happened to trigger a scan waited about
// ten seconds for a web page.
import { NextResponse } from 'next/server';
import { MARKETS, isV3Market } from '@/lib/markets';
import { readPayload, readSelfRows, warmingUpPayload } from '@/lib/leaderboardStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The board changes once per indexer publish (30s), so letting Cloudflare hold it briefly turns a
 * thousand simultaneous readers into one KV read per location instead of a thousand. Fifteen
 * seconds keeps the page fresher than the data can change.
 *
 * This is NOT the per-colo caching that caused the original bug. That cached a different INDEX per
 * location, each at its own block height, and they diverged by days. This caches identical bytes
 * for a few seconds; every location converges on the same publish either way.
 */
const EDGE_CACHE = { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' };

const isAddress = (v: string | null): v is string => !!v && /^0x[a-fA-F0-9]{40}$/.test(v);

export async function GET(req: Request): Promise<NextResponse> {
  const marketId = new URL(req.url).searchParams.get('market');
  const market = MARKETS.find((m) => m.id === (marketId ?? MARKETS[0]?.id));
  if (!market) {
    return NextResponse.json({ error: `unknown market "${marketId}"` }, { status: 404, headers: NO_STORE });
  }
  if (!isV3Market(market)) {
    return NextResponse.json({ error: 'leaderboard requires a v3 market' }, { status: 400, headers: NO_STORE });
  }

  const stored = await readPayload(market.id);
  if (stored === null) {
    return NextResponse.json(warmingUpPayload(market, 'the indexer has not published yet'), { headers: NO_STORE });
  }

  // No viewer asked about themselves: straight passthrough of bytes already validated at ingest -
  // nothing to parse, and identical for everyone, so it can be edge-cached.
  const self = new URL(req.url).searchParams.get('self');
  if (!isAddress(self)) {
    return new NextResponse(stored, { headers: { 'Content-Type': 'application/json', ...EDGE_CACHE } });
  }

  // A viewer already among the published rows needs nothing extra - the badge finds them in place.
  const addr = self.toLowerCase();
  if (stored.includes(`"address":"${addr}"`)) {
    return new NextResponse(stored, { headers: { 'Content-Type': 'application/json', ...EDGE_CACHE } });
  }

  // Outside the published rows: look up that ONE address server-side and attach it. The index this
  // reads holds every participant and is never sent to a browser, which is the point - it answers
  // "where do I stand?" without undoing the cap on what everyone downloads.
  const rows = await readSelfRows(market.id, addr);
  const body = JSON.parse(stored) as Record<string, unknown>;
  body.self = rows ?? { address: addr, all: null, d30: null, d7: null };
  // Varies per reader, so this one is not edge-cached.
  return NextResponse.json(body, { headers: NO_STORE });
}
