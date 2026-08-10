import { describe, it, expect } from 'vitest';
import { Q96 } from '@/lib/swapQuote';
import {
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  maxUsableTick,
  minUsableTick,
  tickToPrice,
  priceToTick,
  sqrtPriceX96ToPrice,
  alignTicks,
  presetTicks,
  customTicks,
  sqrtRatioAtTick,
  counterpartAmount,
  tickRangeStatus,
  PRESET_PCT,
} from '@/lib/rangeMath';

// rangeMath is the PURE foundation of the range-selectable liquidity feature. Tests are anchored to
// the LIVE cirBTC/USDC market vector (verified on-chain):
//   slot0.sqrtPriceX96 = 3137823051102157504608244265, slot0.tick = -64580
//   token0 = USDC (dec0 = 6), token1 = cirBTC (dec1 = 8), baseIsToken0 = false
//   P_raw = (sqrtP/2^96)^2 ≈ 1.5685e-3 (token1-raw per token0-raw) ⇔ ≈ 63,750 USDC per cirBTC.
// The INVERSION is the point of these tests: with baseIsToken0=false, a HIGHER human (USDC/cirBTC)
// price is a LOWER raw price and thus a LOWER tick.
const LIVE_SQRT_P = 3137823051102157504608244265n;
const LIVE_TICK = -64580;
const DEC0 = 6; // USDC (token0)
const DEC1 = 8; // cirBTC (token1)
const BASE_IS_T0 = false; // base (cirBTC) is token1
const SPACING = 60; // fee tier 3000

describe('tick/price conversions — live cirBTC/USDC vector', () => {
  it('sqrtPriceX96ToPrice on the live slot0 is within 1% of 63,750 USDC/cirBTC', () => {
    const p = sqrtPriceX96ToPrice(LIVE_SQRT_P, DEC0, DEC1, BASE_IS_T0);
    expect(Math.abs(p - 63_750) / 63_750).toBeLessThan(0.01);
  });

  it('tickToPrice at the live tick is within 1% of 63,750 USDC/cirBTC', () => {
    const p = tickToPrice(LIVE_TICK, DEC0, DEC1, BASE_IS_T0);
    expect(Math.abs(p - 63_750) / 63_750).toBeLessThan(0.01);
  });

  it('priceToTick(63750) lands within one spacing of the live tick and round-trips', () => {
    const tick = priceToTick(63_750, DEC0, DEC1, BASE_IS_T0);
    expect(Math.abs(tick - LIVE_TICK)).toBeLessThanOrEqual(SPACING);
    // Round-trip tolerance: one tick-spacing of price movement = 1.0001^60 − 1 ≈ 0.6%.
    const back = tickToPrice(tick, DEC0, DEC1, BASE_IS_T0);
    const oneSpacing = 63_750 * (Math.pow(1.0001, SPACING) - 1);
    expect(Math.abs(back - 63_750)).toBeLessThanOrEqual(oneSpacing);
  });

  it('sqrtRatioAtTick brackets the live sqrtPriceX96 at the live tick (on-chain consistency)', () => {
    // slot0.tick = -64580 means sqrtRatioAtTick(-64580) <= slot0.sqrtPriceX96 < sqrtRatioAtTick(-64579).
    expect(sqrtRatioAtTick(LIVE_TICK)).toBeLessThanOrEqual(LIVE_SQRT_P);
    expect(sqrtRatioAtTick(LIVE_TICK + 1)).toBeGreaterThan(LIVE_SQRT_P);
  });

  it('guards: sqrtPriceX96ToPrice returns 0 on a non-positive sqrt; priceToTick throws on bad prices', () => {
    expect(sqrtPriceX96ToPrice(0n, DEC0, DEC1, BASE_IS_T0)).toBe(0);
    expect(() => priceToTick(0, DEC0, DEC1, BASE_IS_T0)).toThrow();
    expect(() => priceToTick(-1, DEC0, DEC1, BASE_IS_T0)).toThrow();
    expect(() => priceToTick(Number.NaN, DEC0, DEC1, BASE_IS_T0)).toThrow();
  });
});

describe('orientation/inversion (baseIsToken0 = false vs true)', () => {
  it('baseIsToken0=false: a HIGHER human price produces a LOWER tick', () => {
    expect(priceToTick(68_000, DEC0, DEC1, BASE_IS_T0)).toBeLessThan(priceToTick(60_000, DEC0, DEC1, BASE_IS_T0));
    // …and tickToPrice is decreasing in tick.
    expect(tickToPrice(LIVE_TICK + 600, DEC0, DEC1, BASE_IS_T0)).toBeLessThan(tickToPrice(LIVE_TICK, DEC0, DEC1, BASE_IS_T0));
  });

  it('baseIsToken0=true (control): a higher human price produces a HIGHER tick', () => {
    // Mirror market: base 8dp as token0, USDC 6dp as token1 (no inversion).
    expect(priceToTick(68_000, 8, 6, true)).toBeGreaterThan(priceToTick(60_000, 8, 6, true));
  });

  it('tickToPrice/priceToTick are mutually consistent in both orientations', () => {
    for (const tick of [-64_620, -60, 0, 60, 64_620]) {
      expect(priceToTick(tickToPrice(tick, DEC0, DEC1, false), DEC0, DEC1, false)).toBe(tick);
      expect(priceToTick(tickToPrice(tick, 8, 6, true), 8, 6, true)).toBe(tick);
    }
  });

  it('customTicks(60000, 68000) straddles the live tick (maxPrice → tickLower under inversion)', () => {
    const { tickLower, tickUpper } = customTicks(60_000, 68_000, DEC0, DEC1, BASE_IS_T0, SPACING);
    expect(tickLower).toBeLessThan(LIVE_TICK);
    expect(tickUpper).toBeGreaterThan(LIVE_TICK);
    // NOTE: `x % 60` is -0 for negative multiples in JS and Object.is(-0, 0) is false — compare with ===.
    expect(tickLower % SPACING === 0).toBe(true);
    expect(tickUpper % SPACING === 0).toBe(true);
    // The UPPER tick must correspond to the LOWER human price (inversion resolved inside customTicks):
    // tick(60000) ≈ -63972 (upper bound), tick(68000) ≈ -65225 (lower bound).
    expect(tickUpper).toBe(Math.ceil(priceToTick(60_000, DEC0, DEC1, BASE_IS_T0) / SPACING) * SPACING);
    expect(tickLower).toBe(Math.floor(priceToTick(68_000, DEC0, DEC1, BASE_IS_T0) / SPACING) * SPACING);
  });

  it('customTicks validates the price band', () => {
    expect(() => customTicks(68_000, 60_000, DEC0, DEC1, BASE_IS_T0, SPACING)).toThrow(); // reversed
    expect(() => customTicks(60_000, 60_000, DEC0, DEC1, BASE_IS_T0, SPACING)).toThrow(); // empty
    expect(() => customTicks(0, 68_000, DEC0, DEC1, BASE_IS_T0, SPACING)).toThrow(); // non-positive
  });
});

describe('presetTicks — nesting, alignment, containment around the live tick', () => {
  const narrow = presetTicks('narrow', LIVE_TICK, SPACING);
  const balanced = presetTicks('balanced', LIVE_TICK, SPACING);
  const wide = presetTicks('wide', LIVE_TICK, SPACING);
  const full = presetTicks('full', LIVE_TICK, SPACING);

  it('exposes the preset percentages for UI labels', () => {
    expect(PRESET_PCT).toEqual({ narrow: 0.05, balanced: 0.15, wide: 0.5 });
  });

  it('all presets are spacing-aligned and contain the current tick (in-range)', () => {
    for (const r of [narrow, balanced, wide, full]) {
      // `x % 60` is -0 for negative multiples (Object.is(-0, 0) is false) — compare with ===.
      expect(r.tickLower % SPACING === 0).toBe(true);
      expect(r.tickUpper % SPACING === 0).toBe(true);
      expect(r.tickLower).toBeLessThan(r.tickUpper);
      expect(tickRangeStatus(LIVE_TICK, r.tickLower, r.tickUpper)).toBe('in-range');
    }
  });

  it('narrow ⊂ balanced ⊂ wide ⊂ full (strict nesting)', () => {
    expect(balanced.tickLower).toBeLessThan(narrow.tickLower);
    expect(balanced.tickUpper).toBeGreaterThan(narrow.tickUpper);
    expect(wide.tickLower).toBeLessThan(balanced.tickLower);
    expect(wide.tickUpper).toBeGreaterThan(balanced.tickUpper);
    expect(full.tickLower).toBeLessThan(wide.tickLower);
    expect(full.tickUpper).toBeGreaterThan(wide.tickUpper);
  });

  it('narrow is ±~488 ticks (= ln(1.05)/ln(1.0001)) before spacing rounding', () => {
    // delta = round(ln(1.05)/ln(1.0001)) = 488 → band [-65068, -64092] → aligned [-65100, -64080].
    expect(narrow).toEqual({ tickLower: -65_100, tickUpper: -64_080 });
  });

  it('full equals the spacing-aligned usable bounds (±887220 for spacing 60)', () => {
    expect(full).toEqual({ tickLower: -887_220, tickUpper: 887_220 });
    expect(maxUsableTick(SPACING)).toBe(887_220);
    expect(minUsableTick(SPACING)).toBe(-887_220);
  });
});

describe('alignTicks — edge cases', () => {
  it('already-aligned in-bounds ranges pass through untouched', () => {
    expect(alignTicks(-65_100, -64_080, SPACING)).toEqual({ tickLower: -65_100, tickUpper: -64_080 });
  });

  it('rounds lower DOWN and upper UP (negative-tick floor/ceil, never narrows the band)', () => {
    expect(alignTicks(-65_068, -64_092, SPACING)).toEqual({ tickLower: -65_100, tickUpper: -64_080 });
    expect(alignTicks(61, 119, SPACING)).toEqual({ tickLower: 60, tickUpper: 120 });
  });

  it('equal aligned ticks widen by exactly one spacing', () => {
    expect(alignTicks(120, 120, SPACING)).toEqual({ tickLower: 120, tickUpper: 180 });
    expect(alignTicks(0, 0, SPACING)).toEqual({ tickLower: 0, tickUpper: 60 });
  });

  it('clamps to the usable bounds (±887220 for spacing 60)', () => {
    expect(alignTicks(-2_000_000, 2_000_000, SPACING)).toEqual({ tickLower: -887_220, tickUpper: 887_220 });
  });

  it('a range collapsed onto the TOP bound widens DOWNWARD (stays usable)', () => {
    expect(alignTicks(887_272, 999_999, SPACING)).toEqual({ tickLower: 887_160, tickUpper: 887_220 });
  });

  it('swaps reversed inputs defensively', () => {
    expect(alignTicks(100, -100, SPACING)).toEqual({ tickLower: -120, tickUpper: 120 });
  });

  it('rejects a non-positive spacing', () => {
    expect(() => alignTicks(0, 60, 0)).toThrow();
    expect(() => alignTicks(0, 60, -60)).toThrow();
  });
});

describe('sqrtRatioAtTick — canonical TickMath port', () => {
  it('matches the canonical anchors: tick 0 → Q96, MIN_TICK → MIN_SQRT_RATIO, MAX_TICK → MAX_SQRT_RATIO', () => {
    // These are TickMath.sol's own constants — they pin every bit-shift multiplier at once.
    expect(sqrtRatioAtTick(0)).toBe(Q96);
    expect(sqrtRatioAtTick(MIN_TICK)).toBe(MIN_SQRT_RATIO);
    expect(sqrtRatioAtTick(MAX_TICK)).toBe(MAX_SQRT_RATIO);
  });

  it('is monotonically increasing in tick', () => {
    const ticks = [MIN_TICK, -887_220, LIVE_TICK, -60, -1, 0, 1, 60, 64_580, 887_220, MAX_TICK];
    for (let i = 1; i < ticks.length; i++) {
      expect(sqrtRatioAtTick(ticks[i]!)).toBeGreaterThan(sqrtRatioAtTick(ticks[i - 1]!));
    }
  });

  it('round-trips with the float tick selection: round(log_{1.0001}((sqrt/Q96)^2)) === tick', () => {
    for (const tick of [-887_220, -65_100, LIVE_TICK, -60, 0, 60, 65_100, 887_220]) {
      const s = Number(sqrtRatioAtTick(tick)) / Number(Q96);
      expect(Math.round(Math.log(s * s) / Math.log(1.0001))).toBe(tick);
    }
  });

  it('throws outside [MIN_TICK, MAX_TICK] and on non-integer ticks', () => {
    expect(() => sqrtRatioAtTick(MAX_TICK + 1)).toThrow();
    expect(() => sqrtRatioAtTick(MIN_TICK - 1)).toThrow();
    expect(() => sqrtRatioAtTick(0.5)).toThrow();
  });
});

describe('counterpartAmount — in-range (hand-worked)', () => {
  // Hand derivation (clean Q96 multiples, every division exact — no rounding to excuse):
  //   sqrtL = 1·Q96, sqrtP = 2·Q96, sqrtU = 4·Q96 (raw prices 1, 4, 16), amount0 = 1e12.
  //   L       = amount0·sqrtP·sqrtU/(Q96·(sqrtU−sqrtP)) = 1e12·(2Q·4Q)/(Q·2Q) = 1e12·8Q²/2Q² = 4e12
  //   amount1 = L·(sqrtP−sqrtL)/Q96 = 4e12·(2Q−Q)/Q = 4e12·Q/Q = 4e12
  // Independent cross-check — a position of L = 4e12 over [Q, 4Q] at sqrtP = 2Q holds exactly:
  //   amount0 = L·Q96·(sqrtU−sqrtP)/(sqrtP·sqrtU) = 4e12·Q·2Q/8Q² = 1e12  ✓ (the input we gave)
  //   amount1 = L·(sqrtP−sqrtL)/Q96 = 4e12                                 ✓ (the output we expect)
  const sqrtL = Q96;
  const sqrtP = 2n * Q96;
  const sqrtU = 4n * Q96;
  const AMOUNT0 = 10n ** 12n;
  const AMOUNT1 = 4n * 10n ** 12n;

  it('token0 input → the hand-computed token1 counterpart (exact)', () => {
    expect(
      counterpartAmount({ amountIn: AMOUNT0, inputIsToken0: true, sqrtPriceX96: sqrtP, sqrtLowerX96: sqrtL, sqrtUpperX96: sqrtU }),
    ).toBe(AMOUNT1);
  });

  it('token1 input → the hand-computed token0 counterpart (exact reverse)', () => {
    expect(
      counterpartAmount({ amountIn: AMOUNT1, inputIsToken0: false, sqrtPriceX96: sqrtP, sqrtLowerX96: sqrtL, sqrtUpperX96: sqrtU }),
    ).toBe(AMOUNT0);
  });

  it('live market sanity: 100 USDC into the narrow preset needs ~0.0016 cirBTC (same ballpark of value)', () => {
    const { tickLower, tickUpper } = presetTicks('narrow', LIVE_TICK, SPACING);
    const out = counterpartAmount({
      amountIn: 100_000_000n, // 100 USDC (token0, 6dp)
      inputIsToken0: true,
      sqrtPriceX96: LIVE_SQRT_P,
      sqrtLowerX96: sqrtRatioAtTick(tickLower),
      sqrtUpperX96: sqrtRatioAtTick(tickUpper),
    });
    // ~163.5k raw cirBTC (8dp) ≈ 0.0016 cirBTC ≈ $104 — assert the order of magnitude, not the digit.
    expect(out).toBeGreaterThan(100_000n);
    expect(out).toBeLessThan(300_000n);
  });

  it('is monotonic in the input amount', () => {
    const args = { inputIsToken0: true, sqrtPriceX96: LIVE_SQRT_P, sqrtLowerX96: sqrtRatioAtTick(-65_100), sqrtUpperX96: sqrtRatioAtTick(-64_080) };
    const small = counterpartAmount({ amountIn: 1_000_000n, ...args });
    const large = counterpartAmount({ amountIn: 2_000_000n, ...args });
    expect(large).toBeGreaterThanOrEqual(small * 2n - 1n); // floor rounding loses at most 1 unit
  });
});

describe('counterpartAmount — one-sided ranges and rounding', () => {
  const sqrtL = sqrtRatioAtTick(-64_020); // range ABOVE the live raw price (price below range)
  const sqrtU = sqrtRatioAtTick(-63_960);
  const sqrtL2 = sqrtRatioAtTick(-65_160); // range BELOW the live raw price (price above range)
  const sqrtU2 = sqrtRatioAtTick(-65_100);

  it('price below range (sqrtP ≤ sqrtL): all-token0 mint → token1 counterpart is exactly 0n', () => {
    expect(
      counterpartAmount({ amountIn: 10n ** 8n, inputIsToken0: true, sqrtPriceX96: LIVE_SQRT_P, sqrtLowerX96: sqrtL, sqrtUpperX96: sqrtU }),
    ).toBe(0n);
    // The inactive-side input (token1) also yields 0n — the caller gates on tickRangeStatus.
    expect(
      counterpartAmount({ amountIn: 10n ** 8n, inputIsToken0: false, sqrtPriceX96: LIVE_SQRT_P, sqrtLowerX96: sqrtL, sqrtUpperX96: sqrtU }),
    ).toBe(0n);
  });

  it('price above range (sqrtP ≥ sqrtU): all-token1 mint → token0 counterpart is exactly 0n', () => {
    expect(
      counterpartAmount({ amountIn: 10n ** 8n, inputIsToken0: false, sqrtPriceX96: LIVE_SQRT_P, sqrtLowerX96: sqrtL2, sqrtUpperX96: sqrtU2 }),
    ).toBe(0n);
    expect(
      counterpartAmount({ amountIn: 10n ** 8n, inputIsToken0: true, sqrtPriceX96: LIVE_SQRT_P, sqrtLowerX96: sqrtL2, sqrtUpperX96: sqrtU2 }),
    ).toBe(0n);
  });

  it('floor rounding never returns a negative (dust input floors to 0n, not below)', () => {
    const out = counterpartAmount({
      amountIn: 1n,
      inputIsToken0: true,
      sqrtPriceX96: LIVE_SQRT_P,
      sqrtLowerX96: sqrtRatioAtTick(-887_220),
      sqrtUpperX96: sqrtRatioAtTick(887_220),
    });
    expect(out >= 0n).toBe(true);
  });

  it('guards: zero input / degenerate bounds return 0n', () => {
    const base = { inputIsToken0: true, sqrtPriceX96: LIVE_SQRT_P, sqrtLowerX96: sqrtRatioAtTick(-65_100), sqrtUpperX96: sqrtRatioAtTick(-64_080) };
    expect(counterpartAmount({ amountIn: 0n, ...base })).toBe(0n);
    expect(counterpartAmount({ amountIn: 10n ** 8n, ...base, sqrtUpperX96: base.sqrtLowerX96 })).toBe(0n);
    expect(counterpartAmount({ amountIn: 10n ** 8n, ...base, sqrtPriceX96: 0n })).toBe(0n);
  });
});

describe('tickRangeStatus', () => {
  it('uses the V3 fee-earning convention: in-range iff tickLower ≤ tick < tickUpper', () => {
    expect(tickRangeStatus(LIVE_TICK, -65_100, -64_080)).toBe('in-range');
    expect(tickRangeStatus(-65_100, -65_100, -64_080)).toBe('in-range'); // lower bound inclusive
    expect(tickRangeStatus(-64_080, -65_100, -64_080)).toBe('above'); // upper bound exclusive
    expect(tickRangeStatus(-65_101, -65_100, -64_080)).toBe('below');
    expect(tickRangeStatus(-60_000, -65_100, -64_080)).toBe('above');
  });
});
