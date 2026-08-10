// app/api/campaign/route.ts — GET ?id=<campaign> returns the campaign standings.
//
// A KV read and a passthrough, exactly like the leaderboard: the keeper's indexer owns the numbers
// and publishes them, so this cannot disagree with itself between visitors, and prize-deciding
// figures are never recomputed per request.
import { NextResponse } from 'next/server';
import { readCampaign, readCurrentCampaignId } from '@/lib/leaderboardStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Standings update once per indexer publish, so a short shared cache turns a rush of viewers on
// announcement day into one KV read per location. Live rankings are the point of the page, and
// fifteen seconds keeps it fresher than the data can change.
const EDGE_CACHE = { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' };

export async function GET(req: Request): Promise<NextResponse> {
  // No id means "whatever campaign is running", answered from the pointer the indexer keeps
  // current. Asking by name still works, and is how a finished campaign stays reachable.
  const asked = new URL(req.url).searchParams.get('id');
  const id = asked ?? (await readCurrentCampaignId());
  if (!id) {
    return NextResponse.json(
      { id: null, live: false, pending: true, volume: [], pnl: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const stored = await readCampaign(id);
  if (stored === null) {
    // Not an error: a campaign announced before its first publish simply has no standings yet.
    return NextResponse.json(
      { id, live: true, pending: true, volume: [], pnl: [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return new NextResponse(stored, { headers: { 'Content-Type': 'application/json', ...EDGE_CACHE } });
}
