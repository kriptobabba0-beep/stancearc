// GET /api/circle/activity - the live arena activity feed, powered by Circle SCP event monitors.
//
// Reads Circle's indexed event history (GET /contracts/events) for every live v3 arena, decodes the raw
// topics+data with the FeeArenaV3 ABI (Circle returns decodedData: null for UNVERIFIED-on-Arc contracts),
// merges, sorts newest-first and caps. The Circle API key stays server-side; the response carries only
// public on-chain data. Degrades to an empty feed (never 500s) so the UI shows "catching up", not a crash.
import { NextResponse } from 'next/server';
import { listContractEvents } from '@/lib/server/circleServer';
import { MARKETS, isV3Market } from '@/lib/markets';
import { decodeArenaEvent } from '@/lib/activity/decode';
import { mergeActivity } from '@/lib/activity/merge';
import type { ActivityEvent } from '@/lib/activity/types';

export const runtime = 'nodejs';

const PER_MARKET_PAGE = 50;

// CDN-coalesce viewer polls: many viewers share one ~10s upstream window so the server-only key isn't
// hit 1:1 with the 12s client poll. A degraded response is NOT cached (so the feed recovers next poll).
const CACHE_HEADERS = { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' };

/** Prefer a dedicated SCP key if configured; else fall back to the main Circle key. */
function scpApiKey(): string | undefined {
  return process.env.CIRCLE_SCP_API_KEY?.trim() || process.env.CIRCLE_API_KEY?.trim() || undefined;
}

export async function GET(req: Request): Promise<NextResponse> {
  const apiKey = scpApiKey();
  // Optional ?market=<id> scopes the feed to ONE market so a tab shows only its own activity (a busier
  // sibling arena can otherwise fill the MAX_FEED_EVENTS cap and starve the selected market). No param =
  // the legacy all-markets feed. An unknown id resolves to an empty (not all-markets) feed - never the
  // wrong market's rows.
  const marketId = new URL(req.url).searchParams.get('market');
  const markets = MARKETS.filter(isV3Market).filter((m) => !marketId || m.id === marketId);
  if (markets.length === 0) return NextResponse.json({ events: [] }, { headers: CACHE_HEADERS });

  // Per-market, each isolated by a synchronously-attached .catch so one arena's failure (or a scope gap)
  // can't blank the whole feed and no rejection escapes. A failed market resolves to null.
  const perMarket = await Promise.all(
    markets.map((m): Promise<ActivityEvent[] | null> =>
      listContractEvents(m.feeArena, { apiKey, pageSize: PER_MARKET_PAGE })
        .then((raw) =>
          raw
            .map((r) => decodeArenaEvent(r, { id: m.id, label: m.label, quoteSymbol: m.quoteSymbol }))
            .filter((e): e is ActivityEvent => e !== null),
        )
        .catch(() => null),
    ),
  );

  const merged = mergeActivity(perMarket);
  return NextResponse.json(merged, merged.degraded ? undefined : { headers: CACHE_HEADERS });
}
