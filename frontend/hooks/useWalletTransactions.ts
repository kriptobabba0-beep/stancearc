'use client';

// hooks/useWalletTransactions.ts — the embedded wallet's recent transactions (Circle history feed).

import { useQuery } from '@tanstack/react-query';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import type { CircleTxDto } from '@/lib/circle/client';

export function useWalletTransactions(enabled: boolean) {
  const { fetchTransactions, address, kind } = useCircleWallet();
  return useQuery<CircleTxDto[]>({
    queryKey: ['fa-circle-txs', address, kind],
    enabled: enabled && !!address,
    refetchInterval: 30_000,
    queryFn: () => fetchTransactions(),
  });
}
