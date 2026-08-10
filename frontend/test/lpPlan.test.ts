import { describe, it, expect, vi } from 'vitest';
import { formatUnits } from 'viem';

// planLiquidity is pure, but its module pulls tick helpers from useMintPosition, whose import
// chain reads ENV — stub just those two (spacing 60 / ±887220 are the 0.3%-tier constants).
vi.mock('@/hooks/useMintPosition', () => ({
  tickSpacingForFee: () => 60,
  fullRangeTicks: () => ({ tickLower: -887_220, tickUpper: 887_220 }),
}));

import { planLiquidity, positionAmounts } from '@/lib/agent/lpPlan';
import { priceToTick, sqrtRatioAtTick } from '@/lib/rangeMath';

// The copilot's "$V across [lower, upper]" sizing. Live cirBTC/USDC orientation is
// baseIsToken0=false (USDC sorts first), so that's the primary case; the flipped orientation
// must behave identically (the math is orientation-parameterised, never hardcoded).

const BASE_DEC = 8; // cirBTC
const QUOTE_DEC = 6; // USDC

function sqrtPAt(priceHuman: number, baseIsToken0: boolean): bigint {
  const dec0 = baseIsToken0 ? BASE_DEC : QUOTE_DEC;
  const dec1 = baseIsToken0 ? QUOTE_DEC : BASE_DEC;
  return sqrtRatioAtTick(priceToTick(priceHuman, dec0, dec1, baseIsToken0));
}

function totalValueUsd(r: { baseLeg: bigint; usdcLeg: bigint; priceNow: number }): number {
  return Number(formatUnits(r.usdcLeg, QUOTE_DEC)) + Number(formatUnits(r.baseLeg, BASE_DEC)) * r.priceNow;
}

describe('planLiquidity — sizing a position from total value + price band', () => {
  for (const baseIsToken0 of [false, true]) {
    const label = baseIsToken0 ? 'base=token0' : 'base=token1 (live orientation)';

    it(`${label}: an in-band range splits into BOTH legs summing to the asked total`, () => {
      const r = planLiquidity({
        amountUsdc: 5,
        priceLower: 55_000,
        priceUpper: 75_000,
        sqrtPriceX96: sqrtPAt(63_000, baseIsToken0),
        baseDecimals: BASE_DEC,
        quoteDecimals: QUOTE_DEC,
        baseIsToken0,
        feeTier: 3000,
      });
      expect(r.outOfBand).toBe(false);
      expect(r.baseLeg > 0n).toBe(true);
      expect(r.usdcLeg > 0n).toBe(true);
      expect(Math.abs(r.tickLower % 60)).toBe(0);
      expect(Math.abs(r.tickUpper % 60)).toBe(0);
      expect(r.tickLower).toBeLessThan(r.tickUpper);
      expect(r.priceNow).toBeGreaterThan(62_000);
      expect(r.priceNow).toBeLessThan(64_000);
      expect(totalValueUsd(r)).toBeGreaterThan(4.85);
      expect(totalValueUsd(r)).toBeLessThanOrEqual(5.01);
    });

    it(`${label}: a band ABOVE the price is all base (the pool sells base as price climbs in)`, () => {
      const r = planLiquidity({
        amountUsdc: 5,
        priceLower: 70_000,
        priceUpper: 80_000,
        sqrtPriceX96: sqrtPAt(63_000, baseIsToken0),
        baseDecimals: BASE_DEC,
        quoteDecimals: QUOTE_DEC,
        baseIsToken0,
        feeTier: 3000,
      });
      expect(r.outOfBand).toBe(true);
      expect(r.usdcLeg).toBe(0n);
      expect(r.baseLeg > 0n).toBe(true);
      expect(totalValueUsd(r)).toBeGreaterThan(4.9);
      expect(totalValueUsd(r)).toBeLessThanOrEqual(5.01);
    });

    it(`${label}: a band BELOW the price is all quote`, () => {
      const r = planLiquidity({
        amountUsdc: 5,
        priceLower: 50_000,
        priceUpper: 60_000,
        sqrtPriceX96: sqrtPAt(63_000, baseIsToken0),
        baseDecimals: BASE_DEC,
        quoteDecimals: QUOTE_DEC,
        baseIsToken0,
        feeTier: 3000,
      });
      expect(r.outOfBand).toBe(true);
      expect(r.baseLeg).toBe(0n);
      expect(r.usdcLeg > 0n).toBe(true);
      expect(Number(formatUnits(r.usdcLeg, QUOTE_DEC))).toBeCloseTo(5, 5);
    });
  }

  it('no band = full range, both legs funded', () => {
    const r = planLiquidity({
      amountUsdc: 10,
      sqrtPriceX96: sqrtPAt(63_000, false),
      baseDecimals: BASE_DEC,
      quoteDecimals: QUOTE_DEC,
      baseIsToken0: false,
      feeTier: 3000,
    });
    expect(r.tickLower).toBe(-887_220);
    expect(r.tickUpper).toBe(887_220);
    expect(r.baseLeg > 0n).toBe(true);
    expect(r.usdcLeg > 0n).toBe(true);
    expect(totalValueUsd(r)).toBeGreaterThan(9.7);
    expect(totalValueUsd(r)).toBeLessThanOrEqual(10.01);
  });

  it('positionAmounts: in-range holds both tokens and round-trips the liquidity', () => {
    // Build the band AROUND the actual 63k tick so the price is genuinely inside it.
    const t = priceToTick(63_000, QUOTE_DEC, BASE_DEC, false);
    const tickLower = t - 300;
    const tickUpper = t + 300;
    const sqrtP = sqrtPAt(63_000, false);
    const L = 10n ** 12n;
    const { amount0, amount1 } = positionAmounts({ liquidity: L, sqrtPriceX96: sqrtP, tickLower, tickUpper });
    expect(amount0 > 0n).toBe(true);
    expect(amount1 > 0n).toBe(true);
    // Recover L from the token1 leg (L = amount1·Q96/(sp−sqrtL)) — floor rounding only.
    const Q96 = 2n ** 96n;
    const back = (amount1 * Q96) / (sqrtP - sqrtRatioAtTick(tickLower));
    const drift = L > back ? L - back : back - L;
    expect(drift < L / 1000n).toBe(true);
  });

  it('positionAmounts: out-of-range positions are one-sided; zero liquidity is empty', () => {
    const t = priceToTick(63_000, QUOTE_DEC, BASE_DEC, false);
    const sqrtP = sqrtPAt(63_000, false);
    const belowTicks = positionAmounts({ liquidity: 10n ** 12n, sqrtPriceX96: sqrtP, tickLower: t - 2_000, tickUpper: t - 1_000 });
    const aboveTicks = positionAmounts({ liquidity: 10n ** 12n, sqrtPriceX96: sqrtP, tickLower: t + 1_000, tickUpper: t + 2_000 });
    // sqrt price grows with tick: a band BELOW the price-tick is fully crossed (all
    // token1), a band ABOVE it is untouched (all token0).
    expect(belowTicks.amount0).toBe(0n);
    expect(belowTicks.amount1 > 0n).toBe(true);
    expect(aboveTicks.amount1).toBe(0n);
    expect(aboveTicks.amount0 > 0n).toBe(true);
    expect(positionAmounts({ liquidity: 0n, sqrtPriceX96: sqrtP, tickLower: t - 300, tickUpper: t + 300 })).toEqual({ amount0: 0n, amount1: 0n });
  });

  it('rejects a zero amount and an inverted band', () => {
    expect(() =>
      planLiquidity({
        amountUsdc: 0,
        sqrtPriceX96: sqrtPAt(63_000, false),
        baseDecimals: BASE_DEC,
        quoteDecimals: QUOTE_DEC,
        baseIsToken0: false,
        feeTier: 3000,
      }),
    ).toThrow();
    expect(() =>
      planLiquidity({
        amountUsdc: 5,
        priceLower: 75_000,
        priceUpper: 55_000,
        sqrtPriceX96: sqrtPAt(63_000, false),
        baseDecimals: BASE_DEC,
        quoteDecimals: QUOTE_DEC,
        baseIsToken0: false,
        feeTier: 3000,
      }),
    ).toThrow();
  });
});
