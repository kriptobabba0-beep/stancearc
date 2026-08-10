// app/api/campaign/ingest/route.ts — the only way campaign standings enter the site.
//
// Same shared secret as the leaderboard ingest: both come from the same indexer on the same box,
// and a second credential would be one more thing to rotate without being one more thing an
// attacker has to get past. Fails CLOSED when unconfigured.
import { NextResponse } from 'next/server';
import {
  secretsMatch,
  upsertCampaignIndex,
  validateCampaign,
  writeCampaign,
  writeCurrentCampaignId,
} from '@/lib/leaderboardStore';
import { campaignTitle } from '@/lib/campaignMeta';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const deny = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function POST(req: Request): Promise<NextResponse> {
  const expected = process.env.LEADERBOARD_INGEST_SECRET?.trim();
  if (!expected) return deny(503, 'ingest is not configured');
  if (!secretsMatch(req.headers.get('X-Leaderboard-Secret'), expected)) return deny(401, 'unauthorized');

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return deny(413, 'payload too large');

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return deny(400, 'body is not valid JSON');
  }

  const problem = validateCampaign(body);
  if (problem) return deny(400, problem);

  const p = body as {
    id: string;
    title?: string;
    live?: boolean;
    startBlock: string;
    endBlock: string;
    cursor?: string;
    totals?: { volumeUsd6?: string; participants?: number };
    prize?: { prizeUsd?: number };
  };
  const id = p.id;
  if (!(await writeCampaign(id, raw))) return deny(503, 'campaign storage is unavailable');

  // Two derived keys, both best-effort: the standings are already stored by this point, so a
  // failure here costs a stale pointer or a missing row on the index, never the campaign itself.
  // The pointer is what lets a campaign start without a frontend deploy; the index is what lets
  // the campaign page list what exists without opening every campaign in turn.
  const pointed = await writeCurrentCampaignId(id);
  const indexed = await upsertCampaignIndex({
    id,
    title: campaignTitle(id, p.title),
    live: p.live !== false,
    startBlock: p.startBlock,
    endBlock: p.endBlock,
    cursor: p.cursor ?? p.startBlock,
    generatedAt: (body as { generatedAt: number }).generatedAt,
    volumeUsd6: p.totals?.volumeUsd6 ?? '0',
    participants: p.totals?.participants ?? 0,
    prizeUsd: p.prize?.prizeUsd ?? 0,
  });

  return NextResponse.json(
    { ok: true, id, bytes: raw.length, pointed, indexed },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
