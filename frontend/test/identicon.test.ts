// identicon.test.ts — deterministic on-chain avatars + compact money formatting.
import { describe, it, expect } from 'vitest';
import { identiconFor, IDENTICON_COLORS, compactUsd6, signedCompactUsd6 } from '@/lib/identicon';

const ADDR = '0x891bbabB7d9ab43aBDb2cEE2a24A25C97D80eFFE';

describe('identiconFor', () => {
  it('is deterministic for the same address (case-insensitive)', () => {
    const a = identiconFor(ADDR);
    const b = identiconFor(ADDR.toLowerCase());
    expect(a.cells).toEqual(b.cells);
    expect(a.color).toBe(b.color);
  });

  it('is vertically mirrored (col 0 == col 4, col 1 == col 3)', () => {
    const { cells } = identiconFor(ADDR);
    for (let row = 0; row < 5; row++) {
      expect(cells[row * 5]).toBe(cells[row * 5 + 4]);
      expect(cells[row * 5 + 1]).toBe(cells[row * 5 + 3]);
    }
  });

  it('differs across addresses and always shows a visible mark from the palette', () => {
    const a = identiconFor(ADDR);
    const b = identiconFor('0x02c9b7310000000000000000000000000000ABCD');
    expect(a.cells.join()).not.toBe(b.cells.join());
    expect(a.cells.some(Boolean)).toBe(true);
    expect(b.cells.some(Boolean)).toBe(true);
    expect(IDENTICON_COLORS).toContain(a.color);
  });

  it('survives malformed input with a stable fallback', () => {
    const junk = identiconFor('not-an-address');
    expect(junk.cells).toHaveLength(25);
    expect(junk.cells.some(Boolean)).toBe(true);
  });
});

describe('compactUsd6', () => {
  it('formats cents, thousands and millions like the standings expect', () => {
    expect(compactUsd6(807_700_000n)).toBe('$807.70');
    expect(compactUsd6(22_500_000_000_000n)).toBe('$22.5M');
    expect(compactUsd6(7_200_000_000_000n)).toBe('$7.2M');
    expect(compactUsd6(355_700_000_000n)).toBe('$355.7k');
    expect(compactUsd6(0n)).toBe('$0.00');
    expect(compactUsd6(1_000_000n, '€')).toBe('€1.00');
    expect(compactUsd6(4_328n)).toBe('$0.0043'); // sub-cent testnet dust stays visible
  });

  it('keeps the sign on negatives', () => {
    expect(compactUsd6(-4_100_000n)).toBe('−$4.10');
  });
});

describe('signedCompactUsd6', () => {
  it('adds an explicit + for gains and − for losses', () => {
    expect(signedCompactUsd6(12_300_000_000n)).toBe('+$12.3k');
    expect(signedCompactUsd6(-4_100_000n)).toBe('−$4.10');
    expect(signedCompactUsd6(0n)).toBe('$0.00');
  });
});
