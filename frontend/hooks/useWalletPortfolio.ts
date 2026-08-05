'use client';

// hooks/useWalletPortfolio.ts - token balances (multicall) + USD valuation for a wallet address.

import { useReadContracts } from 'wagmi';
import { formatUnits } from 'viem';
import { TOKENS, type TokenInfo } from '@/lib/tokens';
import { arcTestnet } from '@/lib/chain';
import { erc20Abi } from '@/abis';
import { useTokenPrices, type TokenUsdPrices } from '@/hooks/useTokenPrices';

/** USD price for a token symbol from the price snapshot (USDC defaults to $1 before prices load). */
function priceFor(p: TokenUsdPrices | undefined, symbol: string): number {
  if (!p) return symbol === 'USDC' ? 1 : 0;
  if (symbol === 'cirBTC') return p.cirBTC;
  if (symbol === 'EURC') return p.EURC;
  if (symbol === 'USDC') return p.USDC;
  return 0;
}

export interface TokenBalance {
  token: TokenInfo;
  raw: bigint;
  amount: number;
  priceUsd: number;
  usd: number;
}

export function useWalletPortfolio(address?: `0x${string}`) {
  const prices = useTokenPrices();
  const { data, refetch, isLoading } = useReadContracts({
    contracts: TOKENS.map((t) => ({
      address: t.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: address ? [address] : undefined,
      chainId: arcTestnet.id,
    })),
    query: { enabled: !!address, refetchInterval: 20_000 },
  });

  const balances: TokenBalance[] = TOKENS.map((t, i) => {
    const raw = (data?.[i]?.result as bigint | undefined) ?? 0n;
    const amount = Number(formatUnits(raw, t.decimals));
    const priceUsd = priceFor(prices.data, t.symbol);
    return { token: t, raw, amount, priceUsd, usd: amount * priceUsd };
  });
  const totalUsd = balances.reduce((s, b) => s + b.usd, 0);

  return {
    balances,
    totalUsd,
    refetch,
    isLoading,
    pricesReady: !!prices.data,
  };
}
