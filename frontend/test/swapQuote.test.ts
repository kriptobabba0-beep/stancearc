import { describe, it, expect } from 'vitest';
import { quoteExactInputSingle, priceImpactBps, Q96 } from '@/lib/swapQuote';

// quoteExactInputSingle is the PURE exact-input single-pool quote for a FULL-RANGE (constant-L) V3
// pool. We hand-work a clean example for BOTH directions and assert amountOut exactly (the math is
// integer/bigint, so there is no rounding tolerance to chase), plus the canonical V3 invariants:
//   - zeroForOne (token0 in) → price FALLS (sqrtAfter < sqrtBefore), output is token1 ≈ net·P.
//   - !zeroForOne (token1 in) → price RISES (sqrtAfter > sqrtBefore), output is token0 ≈ net/P.
//   - price impact GROWS with input size.
//   - a tiny near-spot input ≈ the spot exchange (net·P / net÷P) and barely moves the price.
//   - guards: L === 0 / amountIn === 0 → a zero quote with the price unchanged.
//
// Example pool: sqrtPriceX96 = 2·Q96 ⇒ spot P = (sqrt/Q96)² = 4 (token1 per token0). L = 1e18. Fee 0.3%.
// All expected outputs were computed independently from the canonical V3 SqrtPriceMath relations.
const SQRT_P = 2n * Q96; // spot price P = 4
const L = 10n ** 18n;
const FEE = 3000; // 0.3%

describe('quoteExactInputSingle — zeroForOne (token0 in, price falls)', () => {
  it('quotes the exact token1 output and lowers the price for a 1e15 input', () => {
    const q = quoteExactInputSingle({ amountIn: 10n ** 15n, zeroForOne: true, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    // Hand-worked exact output (token1).
    expect(q.amountOut).toBe(3_980_063_752_876_763n);
    // Near-spot sanity: output ≈ net·P where net = amountIn·(1−0.3%). net·P = 0.997e15·4 = 3.988e15.
    const net = (10n ** 15n * 997_000n) / 1_000_000n;
    const spotApprox = net * 4n; // P = 4
    // Within ~0.2% of the spot product for this small size (slippage pulls it slightly below).
    expect(q.amountOut).toBeLessThan(spotApprox);
    expect(spotApprox - q.amountOut).toBeLessThan(spotApprox / 400n);
    // token0 in ⇒ price falls.
    expect(q.sqrtPriceAfterX96).toBeLessThan(SQRT_P);
    expect(q.priceImpactBps).toBe(39);
  });

  it('price impact grows with input size', () => {
    const small = quoteExactInputSingle({ amountIn: 10n ** 15n, zeroForOne: true, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    const large = quoteExactInputSingle({ amountIn: 10n ** 17n, zeroForOne: true, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    expect(large.amountOut).toBe(332_499_583_124_895_781n);
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    expect(large.priceImpactBps).toBe(3048);
  });
});

describe('quoteExactInputSingle — !zeroForOne (token1 in, price rises)', () => {
  it('quotes the exact token0 output and raises the price for a 1e15 input', () => {
    const q = quoteExactInputSingle({ amountIn: 10n ** 15n, zeroForOne: false, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    // Hand-worked exact output (token0).
    expect(q.amountOut).toBe(249_125_810_783_324n);
    // Near-spot sanity: output ≈ net/P where net = 0.997e15, P = 4 → 0.997e15/4 ≈ 2.4925e14.
    const net = (10n ** 15n * 997_000n) / 1_000_000n;
    const spotApprox = net / 4n;
    expect(q.amountOut).toBeLessThan(spotApprox);
    expect(spotApprox - q.amountOut).toBeLessThan(spotApprox / 400n);
    // token1 in ⇒ price rises.
    expect(q.sqrtPriceAfterX96).toBeGreaterThan(SQRT_P);
    expect(q.priceImpactBps).toBe(9);
  });

  it('price impact grows with input size', () => {
    const small = quoteExactInputSingle({ amountIn: 10n ** 15n, zeroForOne: false, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    const large = quoteExactInputSingle({ amountIn: 10n ** 17n, zeroForOne: false, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    expect(large.amountOut).toBe(23_741_486_879_077_963n);
    expect(large.priceImpactBps).toBeGreaterThan(small.priceImpactBps);
    expect(large.priceImpactBps).toBe(1021);
  });
});

describe('quoteExactInputSingle — tiny near-spot input barely moves the price', () => {
  it('a dust input rounds to a near-zero price impact in both directions', () => {
    const tiny0 = quoteExactInputSingle({ amountIn: 10n ** 9n, zeroForOne: true, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    const tiny1 = quoteExactInputSingle({ amountIn: 10n ** 9n, zeroForOne: false, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    // 1e9 against 1e18 liquidity is ~1e-9 of depth → impact floors to 0 bps (sub-0.01%).
    expect(tiny0.priceImpactBps).toBe(0);
    expect(tiny1.priceImpactBps).toBe(0);
    // Still produces a positive output (fee taken, spot exchange).
    expect(tiny0.amountOut).toBeGreaterThan(0n);
    expect(tiny1.amountOut).toBeGreaterThan(0n);
    // And the price still moves in the right direction (just rounds to 0 bps when reported).
    expect(tiny0.sqrtPriceAfterX96).toBeLessThanOrEqual(SQRT_P);
    expect(tiny1.sqrtPriceAfterX96).toBeGreaterThanOrEqual(SQRT_P);
  });
});

describe('quoteExactInputSingle — guards', () => {
  it('returns a zero quote (price unchanged) when liquidity is 0', () => {
    const q = quoteExactInputSingle({ amountIn: 10n ** 15n, zeroForOne: true, sqrtPriceX96: SQRT_P, liquidity: 0n, feePips: FEE });
    expect(q.amountOut).toBe(0n);
    expect(q.sqrtPriceAfterX96).toBe(SQRT_P);
    expect(q.priceImpactBps).toBe(0);
  });

  it('returns a zero quote (price unchanged) when amountIn is 0', () => {
    const q = quoteExactInputSingle({ amountIn: 0n, zeroForOne: false, sqrtPriceX96: SQRT_P, liquidity: L, feePips: FEE });
    expect(q.amountOut).toBe(0n);
    expect(q.sqrtPriceAfterX96).toBe(SQRT_P);
    expect(q.priceImpactBps).toBe(0);
  });

  it('returns a zero quote when sqrtPriceX96 is non-positive', () => {
    const q = quoteExactInputSingle({ amountIn: 10n ** 15n, zeroForOne: true, sqrtPriceX96: 0n, liquidity: L, feePips: FEE });
    expect(q.amountOut).toBe(0n);
    expect(q.priceImpactBps).toBe(0);
  });
});

describe('priceImpactBps', () => {
  it('is 0 when the price does not move', () => {
    expect(priceImpactBps(SQRT_P, SQRT_P)).toBe(0);
  });

  it('is symmetric in magnitude (direction-agnostic) and ~ doubling sqrt → ~300% (30000 bps)', () => {
    // P scales with sqrt² so doubling sqrt quadruples P: ΔP/P = 3 → 30000 bps. Halving → −0.75 → 7500 bps.
    expect(priceImpactBps(SQRT_P, 2n * SQRT_P)).toBe(30_000);
    expect(priceImpactBps(SQRT_P, SQRT_P / 2n)).toBe(7_500);
  });

  it('returns 0 when the before price is non-positive', () => {
    expect(priceImpactBps(0n, SQRT_P)).toBe(0);
  });
});
