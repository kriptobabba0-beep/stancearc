// lib/agent/signalCore.ts — one implementation of "the stance signal for a market, now".
//
// Shared by the REST endpoint (/api/agent/signal) and the Limen Copilot's get_stance_signal
// tool so the two can never drift apart: read the LIVE epoch (band, settlement time) from the
// arena, pull the trailing hour of 1-minute Pyth benchmark bars for the market's settlement
// feed(s), and run the pure quant core over the REMAINING time to settlement.
import { createPublicClient, fallback, http } from 'viem';
import { arcTestnet } from '@/lib/chain';
import { marketById, type Market } from '@/lib/markets';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { computeStanceSignal, renderRationale, type StanceSignal } from '@/lib/agent/quant';
import { fetchMarketCloses } from '@/lib/agent/history';
import { withRateLimitResilience } from '@/lib/rpcResilience';
import { ARC_EXTRA_HTTP_RPCS } from '@/lib/arcEndpoints';

// Lazily constructed so importing this module (e.g. in tests) has no env/network side effects.
// Primary endpoint + Circle-documented mirrors behind the shared rate-limit gate: one throttled
// moment must never make a copilot tool call fail.
let _client: ReturnType<typeof createPublicClient> | undefined;
const client = () =>
  (_client ??= createPublicClient({
    chain: arcTestnet,
    transport: withRateLimitResilience(fallback([http(), ...ARC_EXTRA_HTTP_RPCS.map((u) => http(u))])),
  }));

export interface EpochSlice {
  epochId: string;
  phase: number;
  entryCloseTime: string;
  settlementTime: string;
  bandBps: number;
}

export async function readEpochSlice(arena: `0x${string}`): Promise<EpochSlice> {
  const e = (await client().readContract({
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

export interface SignalBundle {
  market: Market;
  epoch: EpochSlice;
  signal: StanceSignal | null;
  rationale: string | null;
  /** Present when signal is null — the honest reason there is nothing to estimate. */
  reason: string | null;
  generatedAt: number;
}

/** Build the live signal bundle for a market id. Throws on unknown market / upstream failure. */
export async function buildSignalBundle(marketId: string): Promise<SignalBundle> {
  const market = marketById(marketId);
  const epoch = await readEpochSlice(market.feeArena);
  const nowSec = Math.floor(Date.now() / 1000);
  const horizonSec = Number(epoch.settlementTime) - nowSec;

  if (horizonSec <= 0 || epoch.bandBps <= 0) {
    return {
      market,
      epoch,
      signal: null,
      rationale: null,
      reason: 'epoch is past its settlement moment — a fresh signal arrives with the next epoch',
      generatedAt: nowSec,
    };
  }

  const { closes, barSec } = await fetchMarketCloses(market.feedId, market.quoteFeedId);
  const signal = computeStanceSignal(closes, barSec, horizonSec, epoch.bandBps);
  if (signal === null) {
    return {
      market,
      epoch,
      signal: null,
      rationale: null,
      reason: 'not enough recent price data to estimate',
      generatedAt: nowSec,
    };
  }
  return { market, epoch, signal, rationale: renderRationale(signal), reason: null, generatedAt: nowSec };
}

/** The disclaimer every surfaced estimate ships with. */
export const SIGNAL_DISCLAIMER =
  'Statistical estimate from recent oracle prices — not financial advice. The agent can be wrong; stance only reallocates epoch fees, never LP principal.';
