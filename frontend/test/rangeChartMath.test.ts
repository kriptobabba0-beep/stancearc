import { describe, it, expect } from 'vitest';
import {
  makeDomain,
  priceToX,
  xToPrice,
  priceToFraction,
  pctFromCurrent,
  depthBars,
  concentrationBoost,
  rangeAprEstimate,
} from '@/lib/rangeChartMath';
import { maxUsableTick, presetTicks } from '@/lib/rangeMath';

describe('rangeChartMath — domain', () => {
  it('builds a ratio-symmetric window around the current price', () => {
    const d = makeDomain(100, 0.4);
    expect(d.min).toBeCloseTo(100 / 1.4, 6);
    expect(d.max).toBeCloseTo(140, 6);
  });
  it('falls back to a unit window for a non-positive current (loading)', () => {
    expect(makeDomain(0, 0.4)).toEqual({ min: 0, max: 1 });
  });
});

describe('rangeChartMath — price ↔ x', () => {
  const domain = { min: 50, max: 150 };
  it('maps price to x linearly and clamps to the width', () => {
    expect(priceToX(100, domain, 200)).toBeCloseTo(100, 6); // midpoint
    expect(priceToX(0, domain, 200)).toBe(0); // below domain → clamped
    expect(priceToX(999, domain, 200)).toBe(200); // above domain → clamped
  });
  it('round-trips x → price → x', () => {
    const x = 73;
    const p = xToPrice(x, domain, 200);
    expect(priceToX(p, domain, 200)).toBeCloseTo(x, 6);
  });
  it('priceToFraction is 0..1 across the domain', () => {
    expect(priceToFraction(50, domain)).toBeCloseTo(0, 6);
    expect(priceToFraction(150, domain)).toBeCloseTo(1, 6);
    expect(priceToFraction(100, domain)).toBeCloseTo(0.5, 6);
  });
});

describe('rangeChartMath — handle % labels', () => {
  it('signs the % distance from current', () => {
    expect(pctFromCurrent(90, 100)).toBeCloseTo(-10, 9);
    expect(pctFromCurrent(110, 100)).toBeCloseTo(10, 9);
    expect(pctFromCurrent(100, 100)).toBeCloseTo(0, 9);
  });
});

describe('rangeChartMath — depth backdrop', () => {
  it('returns `bars` heights, peak normalised to 1, taller at the center than the edges', () => {
    const bars = depthBars({ min: 50, max: 150 }, 100, 21);
    expect(bars).toHaveLength(21);
    expect(Math.max(...bars)).toBeCloseTo(1, 6);
    const center = bars[10];
    expect(center).toBeGreaterThan(bars[0]);
    expect(center).toBeGreaterThan(bars[20]);
  });
  it('is deterministic (stable across calls)', () => {
    const a = depthBars({ min: 50, max: 150 }, 100, 12);
    const b = depthBars({ min: 50, max: 150 }, 100, 12);
    expect(a).toEqual(b);
  });
});

describe('rangeChartMath — concentration / APR estimate', () => {
  const spacing = 60;
  it('full range has boost ~1', () => {
    const max = maxUsableTick(spacing);
    expect(concentrationBoost(-max, max, spacing)).toBeCloseTo(1, 6);
  });
  it('a tighter band concentrates more (boost > 1), clamped to the cap', () => {
    const narrow = presetTicks('narrow', 0, spacing);
    expect(concentrationBoost(narrow.tickLower, narrow.tickUpper, spacing)).toBeGreaterThan(1);
    // A 1-spacing band would blow up — must clamp to the cap, not Infinity.
    expect(concentrationBoost(0, spacing, spacing, 1000)).toBe(1000);
  });
  it('rangeAprEstimate scales the pool APR by the boost (full range = pool APR)', () => {
    const max = maxUsableTick(spacing);
    expect(rangeAprEstimate(10, -max, max, spacing)).toBeCloseTo(10, 4);
    const narrow = presetTicks('narrow', 0, spacing);
    expect(rangeAprEstimate(10, narrow.tickLower, narrow.tickUpper, spacing)).toBeGreaterThan(10);
    expect(rangeAprEstimate(0, narrow.tickLower, narrow.tickUpper, spacing)).toBe(0);
  });
});
