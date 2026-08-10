// app/api/campaigns/route.ts — the list behind the campaign index page.
//
// Summaries only: enough to group campaigns into running and finished and to show what each one
// is worth, without opening any of them. Opening one reads that campaign's own key through
// /api/campaign, so a long history costs nothing until someone actually clicks into it.
import { NextResponse } from 'next/server';
import { readCampaignIndex } from '@/lib/leaderboardStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Matched to the indexer's publish interval: a running campaign's figures cannot change faster
// than they are published, and a rush of visitors then costs one KV read per location.
const EDGE_CACHE = { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=60' };

export async function GET(): Promise<NextResponse> {
  const campaigns = await readCampaignIndex();
  return NextResponse.json({ campaigns }, { headers: EDGE_CACHE });
}
