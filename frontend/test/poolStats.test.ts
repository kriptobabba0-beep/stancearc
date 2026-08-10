import { describe, it, expect } from 'vitest';
import {
  toHuman,
  reserveUsd,
  tvlUsd,
  swapNotionalUsd,
  feesFromVolume,
  feeAprPct,
  bucketSeries,
  formatUsd,
  formatPct,
} from '@/lib/poolStats';

describe('poolStats — toHuman', () => {
  it('returns 0 for a zero amount', () => {
    expect(toHuman(0n, 8)).toBe(0);
  });
  it('scales by decimals (1 cirBTC = 1e8 raw at 8dp)', () => {
    expect(toHuman(100_000_000n, 8)).toBe(1);
    expect(toHuman(150_000_000n, 8)).toBeCloseTo(1.5, 9);
  });
  it('scales a 6dp quote (1 USDC = 1e6 raw)', () => {
    expect(toHuman(1_000_000n, 6)).toBe(1);
    expect(toHuman(2_500_000n, 6)).toBeCloseTo(2.5, 9);
  });
  it('handles negative (signed swap amounts)', () => {
    expect(toHuman(-1_000_000n, 6)).toBeCloseTo(-1, 9);
  });
});

describe('poolStats — TVL', () => {
  it('values a single reserve in USD', () => {
    // 0.5 cirBTC (8dp) at $60,000 = $30,000.
    expect(reserveUsd(50_000_000n, 8, 60_000)).toBeCloseTo(30_000, 6);
  });
  it('sums both legs at their own decimals and prices', () => {
    const tvl = tvlUsd({
      reserveBaseRaw: 50_000_000n, // 0.5 cirBTC
      baseDecimals: 8,
      baseUsd: 60_000, // $30,000
      reserveQuoteRaw: 20_000_000_000n, // 20,000 USDC
      quoteDecimals: 6,
      quoteUsd: 1, // $20,000
    });
    expect(tvl).toBeCloseTo(50_000, 4);
  });
});

describe('poolStats — volume / fees / APR', () => {
  it('values a swap by its (abs) quote leg', () => {
    // A swap moving 1,234.56 USDC, sign irrelevant.
    expect(swapNotionalUsd(-1_234_560_000n, 6, 1)).toBeCloseTo(1234.56, 4);
    expect(swapNotionalUsd(1_234_560_000n, 6, 1)).toBeCloseTo(1234.56, 4);
  });
  it('derives fees from volume × fee tier (0.3%)', () => {
    expect(feesFromVolume(1000, 3000)).toBeCloseTo(3, 9);
  });
  it('annualises APR from 24h fees and TVL', () => {
    expect(feeAprPct(3, 1000)).toBeCloseTo(109.5, 6); // 3*365/1000*100
  });
  it('returns 0 APR when TVL is zero (no div by zero)', () => {
    expect(feeAprPct(3, 0)).toBe(0);
  });
});

describe('poolStats — bucketSeries', () => {
  it('buckets values into equal windows (oldest → newest)', () => {
    const out = bucketSeries(
      [
        { t: 0, v: 1 },
        { t: 5, v: 2 },
        { t: 99, v: 4 },
      ],
      0,
      100,
      2,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(3); // t=0,5 → first half
    expect(out[1]).toBe(4); // t=99 → second half
  });
  it('ignores items outside the window and never throws on degenerate input', () => {
    expect(bucketSeries([{ t: -1, v: 9 }], 0, 100, 3)).toEqual([0, 0, 0]);
    expect(bucketSeries([{ t: 1, v: 9 }], 100, 0, 3)).toEqual([0, 0, 0]); // toT<=fromT
  });
});

describe('poolStats — formatters', () => {
  it('formats whole-dollar grouped USD', () => {
    expect(formatUsd(40_726_958)).toBe('$40,726,958');
    expect(formatUsd(36)).toBe('$36');
  });
  it('shows cents below $1 and $0 for zero/negatives', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(-5)).toBe('$0');
  });
  it('formats percent to 2dp with a sane cap', () => {
    expect(formatPct(166.617)).toBe('166.62%');
    expect(formatPct(0.58)).toBe('0.58%');
    expect(formatPct(50_000)).toBe('>9,999%');
    expect(formatPct(Number.NaN)).toBe('—');
  });
});
