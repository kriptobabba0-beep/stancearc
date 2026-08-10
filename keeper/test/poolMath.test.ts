import { describe, it, expect } from 'vitest';
import {
  isqrt,
  sqrtPriceX96ToPrice18,
  price18ToSqrtPriceX96,
  amount0Delta,
  amount1Delta,
  baseAmountToMovePrice,
  poolDeliverableQuote,
  poolDeliverableBase,
  maxBaseSellForUsdcOut,
} from '../src/poolMath.js';

const Q96 = 1n << 96n;
const ONE18 = 10n ** 18n;

describe('isqrt', () => {
  it('computes floor sqrt for small + exact squares', () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(8n)).toBe(2n); // floor
    expect(isqrt(9n)).toBe(3n);
    expect(isqrt(10n ** 36n)).toBe(10n ** 18n);
  });
});

describe('sqrtPriceX96ToPrice18 — cirBTC(8dp)/USDC(6dp)', () => {
  // Build the exact sqrtPriceX96 for a known price, then check the decode lands within
  // 1 bps of the target (isqrt floor introduces a sub-wei rounding only).
  const baseDec = 8;
  const quoteDec = 6;

  for (const baseIsToken0 of [true, false]) {
    it(`round-trips ~100000 USDC/base (baseIsToken0=${baseIsToken0})`, () => {
      const target = 100_000n * ONE18; // $100k per BTC, 18dp
      const sp = price18ToSqrtPriceX96(target, baseDec, quoteDec, baseIsToken0);
      const back = sqrtPriceX96ToPrice18(sp, baseDec, quoteDec, baseIsToken0);
      // Within 1 bps of target.
      const diff = back > target ? back - target : target - back;
      expect(diff * 10_000n <= target).toBe(true);
    });

    it(`round-trips ~1.0 USDC/base (baseIsToken0=${baseIsToken0})`, () => {
      const target = ONE18;
      const sp = price18ToSqrtPriceX96(target, baseDec, quoteDec, baseIsToken0);
      const back = sqrtPriceX96ToPrice18(sp, baseDec, quoteDec, baseIsToken0);
      const diff = back > target ? back - target : target - back;
      // 1 bps tolerance.
      expect(diff * 10_000n <= target).toBe(true);
    });
  }

  it('handles a directly-constructed sqrtPriceX96 (base==token0, equal decimals)', () => {
    // With equal decimals and a raw price of 1, sqrtPriceX96 == Q96 -> price18 == 1e18.
    const price = sqrtPriceX96ToPrice18(Q96, 6, 6, true);
    expect(price).toBe(ONE18);
  });

  it('inverts correctly when base is token1 (raw price 1, equal decimals)', () => {
    const price = sqrtPriceX96ToPrice18(Q96, 6, 6, false);
    expect(price).toBe(ONE18);
  });

  it('returns 0 for a zero/under sqrtPrice (defensive)', () => {
    expect(sqrtPriceX96ToPrice18(0n, 8, 6, true)).toBe(0n);
    expect(price18ToSqrtPriceX96(0n, 8, 6, true)).toBe(0n);
  });

  it('is monotonic: a higher pool sqrtPrice => higher USDC/base when base is token0', () => {
    const lo = sqrtPriceX96ToPrice18(Q96, 8, 6, true);
    const hi = sqrtPriceX96ToPrice18(Q96 * 2n, 8, 6, true);
    expect(hi > lo).toBe(true);
  });

  it('is anti-monotonic when base is token1 (higher sqrtPrice => lower USDC/base)', () => {
    const lo = sqrtPriceX96ToPrice18(Q96, 8, 6, false);
    const hi = sqrtPriceX96ToPrice18(Q96 * 2n, 8, 6, false);
    expect(hi < lo).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V3 amount deltas + the liquidity sizing primitive that backs the arb HIGH-1/HIGH-2 fix.
// ---------------------------------------------------------------------------
describe('amount0Delta / amount1Delta', () => {
  it('returns 0 for non-positive liquidity', () => {
    expect(amount0Delta(0n, Q96, Q96 * 2n)).toBe(0n);
    expect(amount1Delta(0n, Q96, Q96 * 2n)).toBe(0n);
    expect(amount1Delta(-5n, Q96, Q96 * 2n)).toBe(0n);
  });

  it('returns 0 when the two sqrt-prices are equal (zero-width move)', () => {
    expect(amount0Delta(10n ** 12n, Q96, Q96)).toBe(0n);
    expect(amount1Delta(10n ** 12n, Q96, Q96)).toBe(0n);
  });

  it('is order-independent (|sqrtB - sqrtA|)', () => {
    const L = 10n ** 12n;
    expect(amount0Delta(L, Q96, Q96 * 3n)).toBe(amount0Delta(L, Q96 * 3n, Q96));
    expect(amount1Delta(L, Q96, Q96 * 3n)).toBe(amount1Delta(L, Q96 * 3n, Q96));
  });

  it('amount1Delta matches the closed form L*(Δsqrt)/2^96', () => {
    const L = 10n ** 12n;
    const a = Q96;
    const b = Q96 * 2n;
    expect(amount1Delta(L, a, b)).toBe((L * (b - a)) / Q96);
  });

  it('amount0Delta matches the closed form L*2^96*(Δsqrt)/(a*b)', () => {
    const L = 10n ** 12n;
    const a = Q96;
    const b = Q96 * 2n;
    expect(amount0Delta(L, a, b)).toBe((L * Q96 * (b - a)) / (a * b));
  });

  it('scales linearly with liquidity', () => {
    const a = Q96;
    const b = Q96 * 2n;
    expect(amount1Delta(2n * 10n ** 12n, a, b)).toBe(2n * amount1Delta(10n ** 12n, a, b));
  });
});

describe('baseAmountToMovePrice — cirBTC(8dp)/USDC(6dp), base==token1', () => {
  const bd = 8;
  const qd = 6;
  const b0 = false; // cirBTC is token1
  const L = 5n * 10n ** 15n;
  const REF = 100_000n * ONE18; // $100k

  it('returns 0 for a zero-width move (from == to)', () => {
    expect(baseAmountToMovePrice(L, REF, REF, bd, qd, b0)).toBe(0n);
  });

  it('returns 0 for non-positive liquidity or prices', () => {
    expect(baseAmountToMovePrice(0n, REF, REF + ONE18, bd, qd, b0)).toBe(0n);
    expect(baseAmountToMovePrice(L, 0n, REF, bd, qd, b0)).toBe(0n);
    expect(baseAmountToMovePrice(L, REF, 0n, bd, qd, b0)).toBe(0n);
  });

  it('grows monotonically with the size of the price move', () => {
    const small = baseAmountToMovePrice(L, REF, REF + REF / 1_000n, bd, qd, b0); // +10bps
    const big = baseAmountToMovePrice(L, REF, REF + REF / 100n, bd, qd, b0); //    +100bps
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0n);
  });

  it('scales linearly with liquidity (deeper pool => proportionally larger trade)', () => {
    const to = REF + REF / 100n; // +100bps
    const one = baseAmountToMovePrice(L, REF, to, bd, qd, b0);
    const two = baseAmountToMovePrice(2n * L, REF, to, bd, qd, b0);
    // Allow a 1-wei floor-division wobble.
    const diff = two > 2n * one ? two - 2n * one : 2n * one - two;
    expect(diff).toBeLessThanOrEqual(2n);
  });

  it('is comparable in magnitude for a move up vs down by the same gap', () => {
    const up = baseAmountToMovePrice(L, REF, REF + REF / 100n, bd, qd, b0);
    const down = baseAmountToMovePrice(L, REF, REF - REF / 100n, bd, qd, b0);
    // The base-leg amount differs because the V3 curve is convex (a down-move needs
    // slightly more base than the symmetric up-move), but both are sane positive sizes of
    // comparable magnitude — assert within 5% (the measured asymmetry at 100bps is ~1.5%).
    expect(up).toBeGreaterThan(0n);
    expect(down).toBeGreaterThan(0n);
    const hi = up > down ? up : down;
    const lo = up > down ? down : up;
    expect((hi - lo) * 20n <= hi).toBe(true); // |Δ| <= 5% of the larger
  });

  it('uses amount0Delta when base IS token0 (inverted-sort market)', () => {
    // base==token0 path: the size comes from amount0Delta, not amount1Delta.
    const sFrom = price18ToSqrtPriceX96(REF, bd, qd, true);
    const sTo = price18ToSqrtPriceX96(REF + REF / 100n, bd, qd, true);
    const expected = amount0Delta(L, sFrom, sTo);
    expect(baseAmountToMovePrice(L, REF, REF + REF / 100n, bd, qd, true)).toBe(expected);
  });
});

describe('poolDeliverableQuote / poolDeliverableBase — depth caps', () => {
  it('returns a safety fraction of the pool balance', () => {
    expect(poolDeliverableQuote(1_000_000_000n, 7000)).toBe(700_000_000n); // 70%
    expect(poolDeliverableBase(2_000_000n, 7000)).toBe(1_400_000n);
  });
  it('a one-sided (empty) pool yields zero — collapses the leg to dust', () => {
    expect(poolDeliverableQuote(0n, 7000)).toBe(0n);
    expect(poolDeliverableBase(0n, 7000)).toBe(0n);
  });
  it('zero/negative safety yields zero (defensive)', () => {
    expect(poolDeliverableQuote(1_000_000n, 0)).toBe(0n);
    expect(poolDeliverableBase(1_000_000n, -5)).toBe(0n);
  });
});

describe('maxBaseSellForUsdcOut — inverse of the USDC budget conversion', () => {
  const bd = 8, qd = 6;
  const REF = 60_000n * ONE18; // $60k per cirBTC, 18dp

  it('is the inverse of usdcBudgetToBase: 60 USDC of deliverable -> 0.001 cirBTC at $60k', () => {
    // 60 USDC (raw 6dp = 60_000_000) / $60k = 0.001 cirBTC = 100_000 raw (8dp).
    expect(maxBaseSellForUsdcOut(60_000_000n, REF, bd, qd)).toBe(100_000n);
  });
  it('an empty deliverable or non-positive ref yields zero', () => {
    expect(maxBaseSellForUsdcOut(0n, REF, bd, qd)).toBe(0n);
    expect(maxBaseSellForUsdcOut(60_000_000n, 0n, bd, qd)).toBe(0n);
  });
  it('a tiny deliverable (one-sided pool) caps the SELL to near-zero', () => {
    // 0.0006 USDC deliverable -> 0.00000001 cirBTC = 1 raw — below any minTradeBase, so the caller idles.
    expect(maxBaseSellForUsdcOut(600n, REF, bd, qd)).toBe(1n);
  });
});
