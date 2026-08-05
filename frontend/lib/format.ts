// lib/format.ts - render-only formatters wrapping viem formatUnits. NEVER performs money math.
import { formatUnits } from 'viem';

const trim = (s: string): string => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export function formatUSDC(raw: bigint): string { return trim(formatUnits(raw, 6)); }
export function formatWETH(raw: bigint): string { return trim(formatUnits(raw, 18)); }
export function formatPrice18(raw: bigint): string { return trim(formatUnits(raw, 18)); }

/**
 * Per-market base leg (non-USDC), formatted at the active market's decimals (WETH 18dp, cirBTC 8dp, …).
 * Renders the FULL fractional precision of `decimals` (viem formatUnits is exact - no rounding), then
 * only strips trailing zeros. So a tiny cirBTC balance like 0.0001 (10_000 raw at 8dp) stays visible as
 * "0.0001" and never collapses to "0"; a single satoshi (1 raw) renders "0.00000001". Only a genuine
 * zero raw amount yields "0".
 */
export function formatBase(raw: bigint, decimals: number): string { return trim(formatUnits(raw, decimals)); }

/**
 * bps (int) -> percent string, e.g. 150 -> "1.5%".
 *
 * Small sub-1% bands must stay legible: a 20-bps band is 0.20% and MUST read as "0.20%", never a
 * trailing-zero-stripped "0.2%" that's easy to misread (and never "0%"). So for any non-zero value
 * whose percent magnitude is below 1 we keep a fixed 2 fractional digits; ≥1% keeps the trimmed form
 * so 150 -> "1.5%" and 10000 -> "100%" are unchanged. Zero stays "0%".
 */
export function formatBps(bps: number): string {
  if (bps !== 0 && Math.abs(bps) < 100) {
    // |percent| < 1 - show a fixed 2 decimals so e.g. 20 -> "0.20%", 5 -> "0.05%", 1 -> "0.01%".
    // Integer bps below 100 divide exactly into hundredths, so toFixed(2) is precise here.
    return `${(bps / 100).toFixed(2)}%`;
  }
  return `${trim(formatUnits(BigInt(bps), 2))}%`;
}

/** signed bps (bigint, from EpochView.deltaBps) -> signed percent, e.g. 300 -> "+3%". */
export function formatDeltaBps(deltaBps: bigint): string {
  const sign = deltaBps > 0n ? '+' : deltaBps < 0n ? '-' : '';
  const abs = deltaBps < 0n ? -deltaBps : deltaBps;
  return `${sign}${trim(formatUnits(abs, 2))}%`;
}
