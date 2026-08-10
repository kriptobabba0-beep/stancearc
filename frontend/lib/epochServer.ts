// lib/epochServer.ts — server-side (non-React) reads for the per-epoch share route + its OG image.
// The OG image and the /epoch/[id] metadata run on the server with no wallet/localStorage, so they
// read the DEFAULT market via a plain viem client built from ENV (not the wagmi/client config).
//
// Best-effort & defensive: any RPC/parse failure resolves to null so the share page still renders a
// generic card instead of throwing a 500. NEVER used in the live interactive path.
import { createPublicClient, fallback, http } from 'viem';
import { ENV } from '@/lib/env';
import { arcTestnet } from '@/lib/chain';
import { MARKETS } from '@/lib/markets';
import { marketContracts } from '@/lib/contracts';
import { withRateLimitResilience } from '@/lib/rpcResilience';
import { arcHttpEndpoints } from '@/lib/arcEndpoints';
import type { EpochView, Side } from '@/lib/types';

/** A read-only viem client pinned to Arc, for server-side reads. Built lazily per call (stateless). */
function serverClient() {
  return createPublicClient({
    chain: arcTestnet,
    transport: withRateLimitResilience(fallback(arcHttpEndpoints(ENV.RPC_HTTP_URLS).map((u) => http(u)))),
  });
}

/** Compact, OG-friendly projection of a settled epoch for the share card. */
export interface EpochShareData {
  epochId: bigint;
  settled: boolean;
  rolledOver: boolean;
  winningSide: Side;
  /** Total pot in 6dp USD (base leg × oracle price + USDC leg). 0 when unknown. */
  potUsd6: bigint;
  /** The market's price-pair base symbol (e.g. "cirBTC") for the card copy. */
  baseSymbol: string;
}

/**
 * Read the settled-epoch projection for the DEFAULT market. Returns null on any failure or for an
 * out-of-range / unreadable epoch id. Imports lib/quant lazily-free (pure) to value the pot in USD.
 */
export async function readEpochShareData(epochId: bigint): Promise<EpochShareData | null> {
  try {
    const market = MARKETS[0];
    const { feeArena, oracle } = marketContracts(market);
    const client = serverClient();

    const epoch = (await client.readContract({
      address: feeArena.address,
      abi: feeArena.abi,
      functionName: 'getEpoch',
      args: [epochId],
    })) as EpochView;

    // Oracle price (18dp) for the base-leg USD valuation. Best-effort; default 0 if it fails.
    let price18 = 0n;
    try {
      const tuple = (await client.readContract({
        address: oracle.address,
        abi: oracle.abi,
        functionName: 'getPrice',
      })) as readonly [bigint, bigint];
      price18 = tuple[0];
    } catch {
      /* oracle read failed — pot USD falls back to the USDC leg only */
    }

    const { potUsd6 } = await import('@/lib/quant');
    return {
      epochId: epoch.epochId,
      settled: Number(epoch.phase) === 3, // PhaseView.Settled
      rolledOver: epoch.rolledOver,
      winningSide: epoch.winningSide,
      potUsd6: potUsd6({
        potWETH: epoch.potWETH,
        potUSDC: epoch.potUSDC,
        baseDecimals: market.baseDecimals,
        price18,
      }),
      baseSymbol: market.baseSymbol,
    };
  } catch {
    return null;
  }
}
