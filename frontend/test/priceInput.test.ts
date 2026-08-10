import { describe, it, expect } from 'vitest';
import { parsePrice, toPlainPrice, validPriceBand } from '@/lib/priceInput';

describe('priceInput — parsePrice (fail-closed)', () => {
  it('accepts plain decimals (incl. leading/trailing whitespace, ".5", "5.")', () => {
    expect(parsePrice('58000')).toBe(58000);
    expect(parsePrice('  58000  ')).toBe(58000);
    expect(parsePrice('63750.5')).toBeCloseTo(63750.5, 9);
    expect(parsePrice('.5')).toBeCloseTo(0.5, 9);
    expect(parsePrice('5.')).toBe(5);
  });
  it('REJECTS grouped / exponent / hex / letters / empty / double-dot / negative → NaN', () => {
    for (const bad of ['52,515', '1e5', '5e4', '0x1f', '70k', '', '  ', '1.2.3', '-5', 'abc', '$5', '1,0']) {
      expect(Number.isNaN(parsePrice(bad)), `expected NaN for "${bad}"`).toBe(true);
    }
  });
});

describe('priceInput — toPlainPrice', () => {
  it("returns '' for 0 / negative / non-finite", () => {
    expect(toPlainPrice(0)).toBe('');
    expect(toPlainPrice(-5)).toBe('');
    expect(toPlainPrice(Number.NaN)).toBe('');
    expect(toPlainPrice(Number.POSITIVE_INFINITY)).toBe('');
  });
  it('strips trailing zeros and uses the 2/4/8 dp tiers by magnitude', () => {
    expect(toPlainPrice(58000)).toBe('58000');
    expect(toPlainPrice(63750.5)).toBe('63750.5');
    expect(toPlainPrice(12345.678)).toBe('12345.68'); // ≥1000 → 2dp
    expect(toPlainPrice(0.0001)).toBe('0.0001'); // <1 → 8dp
    expect(toPlainPrice(1.5)).toBe('1.5');
  });
  it('round-trips through parsePrice within its rounding precision (no commas/exponent)', () => {
    for (const p of [58000, 63750.5, 0.0001, 12345.678, 1.23456]) {
      const s = toPlainPrice(p);
      expect(/[,e]/i.test(s)).toBe(false); // never grouped / exponential
      const back = parsePrice(s);
      expect(Number.isFinite(back)).toBe(true);
      expect(Math.abs(back - p)).toBeLessThan(Math.max(p * 1e-4, 1e-8));
    }
  });
});

describe('priceInput — validPriceBand', () => {
  it('is true only for a plain 0 < min < max pair', () => {
    expect(validPriceBand('58000', '69622')).toBe(true);
    expect(validPriceBand('0.5', '1.5')).toBe(true);
  });
  it('is false for the full-range sentinels, equal/reversed bounds, and any non-plain input', () => {
    expect(validPriceBand('0', '∞')).toBe(false); // full-range display
    expect(validPriceBand('0', '69622')).toBe(false); // min must be > 0
    expect(validPriceBand('70000', '60000')).toBe(false); // min >= max
    expect(validPriceBand('60000', '60000')).toBe(false);
    expect(validPriceBand('52,515', '69622')).toBe(false); // grouped → rejected
    expect(validPriceBand('', '69622')).toBe(false);
  });
});
