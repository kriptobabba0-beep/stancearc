// hooks/useOraclePrice.ts - the LIVE oracle price for display + qualification math.
//
// LIVE-FIRST: Hermes (the same Pyth feed settlement anchors to) polled every ~3s, so the price
// and everything derived from it (sparkline, "qualifying now") keep moving during the LOCKED
// phase - the on-chain IPriceOracle.getPrice() only advances when a tx posts a blob (stakes,
// keeper settles), so reading it alone froze the UI for the whole locked window. The on-chain
// read stays as the FALLBACK (Hermes unreachable) and both sources share the same feed(s) and
// 18-dp math (cross = BTC/USD ÷ EUR/USD for the EURC market), so the two values agree within a
// publish tick and the stake flow's entry-anchor guard sees no discontinuity.
import { useQuery } from '@tanstack/react-query';
import { useReadContract } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { fetchPythUpdateWithPrice, fetchPythCrossUpdateWithPrice } from '@/lib/pyth';
import { ENV } from '@/lib/env';
import { arcTestnet } from '@/lib/chain';
import type { OraclePrice } from '@/lib/types';

export function useOraclePrice() {
  const { oracle } = useMarketContracts();
  const market = useActiveMarket();

  // On-chain read - the fallback, and what the contract itself would report right now.
  const q = useReadContract({ ...oracle, functionName: 'getPrice', chainId: arcTestnet.id, query: { refetchInterval: 5000 } });

  // Live Hermes read - same feed(s) + the exact pythToPrice18 math the stake flow uses.
  const live = useQuery({
    queryKey: ['hermes-live', market.id],
    queryFn: () =>
      market.quoteFeedId
        ? fetchPythCrossUpdateWithPrice(ENV.HERMES_URL, market.feedId, market.quoteFeedId)
        : fetchPythUpdateWithPrice(ENV.HERMES_URL, market.feedId),
    refetchInterval: 3_000,
    staleTime: 2_000,
    retry: 1,
  });

  const tuple = q.data as readonly [bigint, bigint] | undefined;
  const price: OraclePrice | undefined = live.data
    ? { price18: live.data.price18, updatedAt: BigInt(live.data.publishTimeSec) }
    : tuple
      ? { price18: tuple[0], updatedAt: tuple[1] }
      : undefined;
  return { ...q, data: price };
}
