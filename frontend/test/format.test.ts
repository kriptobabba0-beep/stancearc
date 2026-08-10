import { describe, it, expect } from 'vitest';
import { formatUSDC, formatWETH, formatPrice18, formatBps, formatDeltaBps, formatBase } from '@/lib/format';

describe('formatters (render-only, formatUnits)', () => {
  it('formatUSDC: 6dp', () => {
    expect(formatUSDC(3750n * 10n ** 6n)).toBe('3750');
    expect(formatUSDC(1_500_000n)).toBe('1.5');
  });
  it('formatWETH: 18dp', () => {
    expect(formatWETH(2_500_000_000_000_000_000n)).toBe('2.5');
    expect(formatWETH(0n)).toBe('0');
  });
  it('formatPrice18: 18dp quote', () => {
    expect(formatPrice18(3000n * 10n ** 18n)).toBe('3000');
  });
  it('formatBase: per-market decimals (WETH 18dp, WBTC 8dp)', () => {
    expect(formatBase(2_500_000_000_000_000_000n, 18)).toBe('2.5'); // 2.5 WETH at 18dp
    expect(formatBase(100_000n, 8)).toBe('0.001'); // 0.001 WBTC at 8dp
    expect(formatBase(1_50000000n, 8)).toBe('1.5'); // 1.5 WBTC at 8dp
  });
  it('formatBase: a SMALL cirBTC balance (8dp) stays visible — never collapses to "0"', () => {
    // 0.0001 cirBTC = 10_000 raw at 8dp. Must render a visible non-zero fractional string, not "0".
    const small = formatBase(10_000n, 8);
    expect(small).not.toBe('0');
    expect(small).toBe('0.0001');
    expect(Number(small)).toBeGreaterThan(0);
    // Even a single satoshi (1 raw at 8dp = 0.00000001) must keep all the way down to the 8th place.
    expect(formatBase(1n, 8)).toBe('0.00000001');
    // A genuine zero balance is still "0".
    expect(formatBase(0n, 8)).toBe('0');
  });
  it('formatBps: 150 -> "1.5%"', () => {
    expect(formatBps(150)).toBe('1.5%');
    expect(formatBps(10000)).toBe('100%');
  });
  it('formatBps: a small sub-1% band (20 bps) renders "0.20%", never "0%"', () => {
    // The live cirBTC market runs a 20-bps band. It must read as "0.20%", not be rounded to "0%".
    expect(formatBps(20)).toBe('0.20%');
    expect(formatBps(20)).not.toBe('0%');
    expect(formatBps(5)).toBe('0.05%'); // 5 bps
    expect(formatBps(1)).toBe('0.01%'); // 1 bps — still visible
    // A genuine zero band is still "0%".
    expect(formatBps(0)).toBe('0%');
  });
  it('formatDeltaBps: signed percent from bigint bps', () => {
    expect(formatDeltaBps(300n)).toBe('+3%');
    expect(formatDeltaBps(-151n)).toBe('-1.51%');
    expect(formatDeltaBps(0n)).toBe('0%');
  });
});
