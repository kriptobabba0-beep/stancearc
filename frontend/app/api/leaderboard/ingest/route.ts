// app/api/leaderboard/ingest/route.ts — the ONLY way standings enter the site.
//
// The keeper's indexer owns the leaderboard and POSTs a ready-to-serve payload here; this handler
// authenticates it, checks the shape, and puts it in KV. Nothing else writes that key, which is
// what makes the site's answer single-valued.
//
// The secret is a shared string rather than a signature because both ends are ours and the
// transport is TLS: a signature would add key management without changing who can write. It is
// compared in constant time, and a missing secret fails CLOSED — an unconfigured deploy rejects
// every write rather than accepting anonymous ones.
import { NextResponse } from 'next/server';
import { secretsMatch, validatePayload, writePayload, writeSelfIndex } from '@/lib/leaderboardStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The board itself is capped, but the self-index carries a row per participant, so this has to
 * scale with the arena's population rather than with what a browser receives. 16 MB leaves room
 * for tens of thousands of wallets and still stops anything absurd.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

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

  // The indexer sends { payload, index }: the capped board a browser receives, and the per-address
  // index only this server reads. A bare payload is still accepted so an older indexer keeps
  // working through a deploy — it just cannot answer "where do I stand?" past the capped rows.
  const wrapped = body as { payload?: unknown; index?: unknown };
  const hasIndex = typeof wrapped?.payload === 'object' && wrapped.payload !== null;
  const payload = hasIndex ? wrapped.payload : body;

  const marketId = (payload as { market?: unknown })?.market;
  if (typeof marketId !== 'string' || !marketId) return deny(400, 'market is required');

  const problem = validatePayload(payload, marketId);
  if (problem) return deny(400, problem);

  // Store the payload's own bytes, not a re-serialisation of the envelope: what gets served is
  // exactly what was validated, and the read path never has to parse it.
  const payloadJson = hasIndex ? JSON.stringify(payload) : raw;
  if (!(await writePayload(marketId, payloadJson))) return deny(503, 'leaderboard storage is unavailable');

  let indexBytes = 0;
  if (hasIndex && wrapped.index && typeof wrapped.index === 'object') {
    const indexJson = JSON.stringify(wrapped.index);
    indexBytes = indexJson.length;
    // Best-effort: a failed index write only costs the self-lookup, so the board still publishes.
    await writeSelfIndex(marketId, indexJson);
  }

  return NextResponse.json(
    { ok: true, market: marketId, bytes: payloadJson.length, indexBytes },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
