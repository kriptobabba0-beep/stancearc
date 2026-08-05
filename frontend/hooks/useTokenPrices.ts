'use client';

// hooks/useTokenPrices.ts - live USD prices for the wallet's tokens, from Pyth (Hermes).
//   cirBTC = BTC/USD, EURC = EUR/USD, USDC = $1. Cached + auto-refreshed via react-query.

import { useQuery } from '@tanstack/react-query';
import { ENV } from '@/lib/env';
import { MARKETS } from '@/lib/markets';
import { fetchPythUpdateWithPrice } from '@/lib/pyth';

// Canonical Pyth feed ids - fallbacks if a market doesn't supply one.
const BTC_USD = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const EUR_USD = '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b';

export interface TokenUsdPrices {
  cirBTC: number;
  USDC: number;
  EURC: number;
}

/** Prefer the live cirBTC market's BTC feed id; fall back to the canonical id. */
function btcFeedId(): string {
  return MARKETS.find((m) => /btc/i.test(m.baseSymbol))?.feedId ?? BTC_USD;
}

async function fetchUsd(feedId: string): Promise<number> {
  const { price18 } = await fetchPythUpdateWithPrice(ENV.HERMES_URL, feedId);
  return Number(price18) / 1e18;
}

export function useTokenPrices() {
  return useQuery<TokenUsdPrices>({
    queryKey: ['fa-token-prices'],
    refetchInterval: 30_000,
    staleTime: 20_000,
    queryFn: async () => {
      const [btc, eur] = await Promise.allSettled([fetchUsd(btcFeedId()), fetchUsd(EUR_USD)]);
      return {
        cirBTC: btc.status === 'fulfilled' ? btc.value : 0,
        USDC: 1,
        EURC: eur.status === 'fulfilled' ? eur.value : 0,
      };
    },
  });
}
