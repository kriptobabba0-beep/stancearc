// app/api/agent/signal/route.ts - the Limen Agent's per-epoch stance signal.
//
// GET /api/agent/signal?market=<id>  ->  { signal, rationale, rationaleSource, epoch, generatedAt }
//
// Reads the LIVE epoch (band, settlement time) from the arena on-chain, pulls the trailing
// hour of 1-minute Pyth benchmark bars for the market's settlement feed(s), and runs the
// pure quant core: estimated qualification odds for UP / DOWN / RANGE over the REMAINING
// time to settlement, plus a plain-language rationale. The rationale is template-rendered
// by default; when ANTHROPIC_API_KEY is configured the agent asks Claude to write it from
// the same numbers (never to change them) and falls back to the template on any failure.
// Advisory only - the response carries the disclaimer the UI must show.
import { NextResponse } from 'next/server';
import { createPublicClient, fallback, http } from 'viem';
import { arcTestnet } from '@/lib/chain';
import { marketById } from '@/lib/markets';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { computeStanceSignal, renderRationale, type StanceSignal } from '@/lib/agent/quant';
import { fetchMarketCloses } from '@/lib/agent/history';
import { withRateLimitResilience } from '@/lib/rpcResilience';
import { ARC_EXTRA_HTTP_RPCS } from '@/lib/arcEndpoints';

export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; body: unknown }>();

const client = createPublicClient({
  chain: arcTestnet,
  transport: withRateLimitResilience(fallback([http(), ...ARC_EXTRA_HTTP_RPCS.map((u) => http(u))])),
});

interface EpochSlice {
  epochId: string;
  phase: number;
  entryCloseTime: string;
  settlementTime: string;
  bandBps: number;
}

async function readEpoch(arena: `0x${string}`): Promise<EpochSlice> {
  const e = (await client.readContract({
    address: arena,
    abi: feeArenaV3Abi,
    functionName: 'currentEpoch',
  })) as {
    epochId: bigint;
    phase: number | bigint;
    entryCloseTime: bigint;
    settlementTime: bigint;
    bandBps: number | bigint;
  };
  return {
    epochId: e.epochId.toString(),
    phase: Number(e.phase),
    entryCloseTime: e.entryCloseTime.toString(),
    settlementTime: e.settlementTime.toString(),
    bandBps: Number(e.bandBps),
  };
}

/** Ask Claude to phrase the rationale from the signal's own numbers. Falls back to null. */
async function llmRationale(s: StanceSignal, marketLabel: string): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content:
              `You are the Limen Agent, advising an LP on the ${marketLabel} market. ` +
              `From these computed numbers ONLY (do not invent any), write 2 short sentences explaining the recommendation. ` +
              `Numbers: view=${s.view}, pUp=${(s.pUp * 100).toFixed(1)}%, pDown=${(s.pDown * 100).toFixed(1)}%, ` +
              `pRange=${(s.pRange * 100).toFixed(1)}%, expectedMove=±${(s.features.volH * 100).toFixed(2)}%, ` +
              `band=±${(s.features.bandFrac * 100).toFixed(2)}%, minutesToSettlement=${Math.round(s.features.horizonSec / 60)}, ` +
              `momentum(logReturn over horizon, capped)=${s.features.driftH.toExponential(2)}. ` +
              `Plain register, no hype, no advice-guarantees.`,
          },
        ],
      }),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const marketId = url.searchParams.get('market') ?? '';

  const hit = cache.get(marketId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json(hit.body);
  }

  let market;
  try {
    market = marketById(marketId);
  } catch {
    return NextResponse.json({ error: `unknown market: ${marketId}` }, { status: 400 });
  }

  try {
    const epoch = await readEpoch(market.feeArena);
    const nowSec = Math.floor(Date.now() / 1000);
    const horizonSec = Number(epoch.settlementTime) - nowSec;

    if (horizonSec <= 0 || epoch.bandBps <= 0) {
      const body = {
        signal: null,
        reason: 'epoch is past its settlement moment - a fresh signal arrives with the next epoch',
        epoch,
        generatedAt: nowSec,
      };
      cache.set(marketId, { at: Date.now(), body });
      return NextResponse.json(body);
    }

    const { closes, barSec } = await fetchMarketCloses(market.feedId, market.quoteFeedId);
    const signal = computeStanceSignal(closes, barSec, horizonSec, epoch.bandBps);
    if (signal === null) {
      const body = { signal: null, reason: 'not enough recent price data to estimate', epoch, generatedAt: nowSec };
      cache.set(marketId, { at: Date.now(), body });
      return NextResponse.json(body);
    }

    const llm = await llmRationale(signal, market.label);
    const body = {
      signal,
      rationale: llm ?? renderRationale(signal),
      rationaleSource: llm !== null ? 'model' : 'template',
      disclaimer:
        'Statistical estimate from recent oracle prices - not financial advice. The agent can be wrong; stance only reallocates epoch fees, never LP principal.',
      epoch,
      generatedAt: nowSec,
    };
    cache.set(marketId, { at: Date.now(), body });
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'signal unavailable' },
      { status: 502 },
    );
  }
}
