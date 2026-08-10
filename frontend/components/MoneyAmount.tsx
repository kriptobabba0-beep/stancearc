'use client';

import { formatUSDC, formatWETH, formatPrice18, formatBase } from '@/lib/format';
import { useActiveMarket } from '@/components/MarketProvider';

interface MoneyAmountProps {
  value: bigint;
  /**
   * 'USDC' (6dp, global) | 'price' (18dp quote) | 'WETH' (18dp, legacy default-market base) |
   * 'base' (the active market's base leg — pass `decimals` for the active market's baseDecimals).
   */
  token: 'USDC' | 'WETH' | 'price' | 'base';
  /** Required for token='base': the active market's baseDecimals (WETH 18, WBTC 8, …). */
  decimals?: number;
  className?: string;
}

/** Renders an on-chain bigint amount as a human-readable string. NEVER converts to Number for math. */
export function MoneyAmount({ value, token, decimals, className }: MoneyAmountProps) {
  let formatted: string;
  switch (token) {
    case 'USDC':
      formatted = formatUSDC(value);
      break;
    case 'WETH':
      formatted = formatWETH(value);
      break;
    case 'base':
      // Default to 18dp if decimals omitted so a missing prop degrades to the legacy WETH behavior.
      formatted = formatBase(value, decimals ?? 18);
      break;
    case 'price':
      formatted = formatPrice18(value);
      break;
  }
  return <span className={className}>{formatted}</span>;
}

/**
 * The active market's base leg: "<amount> <baseSymbol>" formatted at the market's baseDecimals.
 * Use wherever the non-USDC leg is shown (replaces the old `<MoneyAmount token="WETH"/> WETH` pair),
 * so a BTC market renders e.g. "0.001 WBTC" at 8dp instead of "… WETH" at 18dp.
 */
export function BaseAmount({ value, className }: { value: bigint; className?: string }) {
  const market = useActiveMarket();
  return (
    <span className={className}>
      {formatBase(value, market.baseDecimals)} {market.baseSymbol}
    </span>
  );
}
