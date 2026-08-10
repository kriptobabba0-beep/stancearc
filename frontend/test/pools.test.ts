import { describe, it, expect, vi } from 'vitest';

// lib/pools builds POOLS at module load from ENV (via lib/tokens), so ENV must be mocked BEFORE import.
// Addresses are chosen to exercise BOTH orientations: cirBTC(0xaa) < USDC(0xbb) < EURC(0xcc), so the
// cirBTC pairs sort base→token0 (baseIsToken0 = true) while EURC/USDC sorts quote→token0 (false).
vi.mock('@/lib/env', () => ({
  ENV: {
    WETH_ADDRESS: '0x00000000000000000000000000000000000000aa', // cirBTC base (8dp)
    USDC_ADDRESS: '0x00000000000000000000000000000000000000bb', // USDC (6dp)
    EURC_ADDRESS: '0x00000000000000000000000000000000000000cc', // EURC (6dp)
    POOL_ADDRESS: '0x0000000000000000000000000000000000000111', // cirBTC/USDC pool
    FEE_TIER: 3000,
  },
}));

import { POOLS, poolById, poolForPosition, poolLabel } from '@/lib/pools';

const CIRBTC = '0x00000000000000000000000000000000000000aa';
const USDC = '0x00000000000000000000000000000000000000bb';
const EURC = '0x00000000000000000000000000000000000000cc';

describe('lib/pools registry', () => {
  it('registers the three Arc pools with semantic base/quote (NOT "the non-USDC leg")', () => {
    expect(POOLS.map((p) => p.id)).toEqual(['cirbtc-usdc', 'eurc-usdc', 'cirbtc-eurc']);

    const byId = Object.fromEntries(POOLS.map((p) => [p.id, p]));
    // cirBTC/USDC: base cirBTC, quote USDC.
    expect(byId['cirbtc-usdc'].base.symbol).toBe('cirBTC');
    expect(byId['cirbtc-usdc'].quote.symbol).toBe('USDC');
    // EURC/USDC: base EURC, quote USDC (the volatile-vs-stable designation, not non-USDC).
    expect(byId['eurc-usdc'].base.symbol).toBe('EURC');
    expect(byId['eurc-usdc'].quote.symbol).toBe('USDC');
    // cirBTC/EURC: base cirBTC, quote EURC — has NO USDC leg at all (the case the old heuristic broke).
    expect(byId['cirbtc-eurc'].base.symbol).toBe('cirBTC');
    expect(byId['cirbtc-eurc'].quote.symbol).toBe('EURC');
  });

  it('derives token0/token1 by address sort and baseIsToken0 against it', () => {
    const byId = Object.fromEntries(POOLS.map((p) => [p.id, p]));
    // cirBTC(0xaa) < USDC(0xbb): cirBTC sorts token0 → base IS token0.
    expect(byId['cirbtc-usdc'].token0.symbol).toBe('cirBTC');
    expect(byId['cirbtc-usdc'].baseIsToken0).toBe(true);
    // USDC(0xbb) < EURC(0xcc): USDC (the quote) sorts token0 → base is NOT token0.
    expect(byId['eurc-usdc'].token0.symbol).toBe('USDC');
    expect(byId['eurc-usdc'].baseIsToken0).toBe(false);
    // cirBTC(0xaa) < EURC(0xcc): cirBTC (base) sorts token0 → base IS token0.
    expect(byId['cirbtc-eurc'].token0.symbol).toBe('cirBTC');
    expect(byId['cirbtc-eurc'].baseIsToken0).toBe(true);
  });

  it('poolLabel reads "base / quote"', () => {
    expect(poolLabel(poolById('cirbtc-eurc')!)).toBe('cirBTC / EURC');
    expect(poolLabel(poolById('eurc-usdc')!)).toBe('EURC / USDC');
  });

  it('poolById returns the pool or undefined', () => {
    expect(poolById('cirbtc-usdc')?.id).toBe('cirbtc-usdc');
    expect(poolById('nope')).toBeUndefined();
  });

  it('poolForPosition matches an enumerated position by unordered pair + fee tier', () => {
    // Ordered and reversed both resolve to the same registry pool.
    expect(poolForPosition(CIRBTC, USDC, 3000)?.id).toBe('cirbtc-usdc');
    expect(poolForPosition(USDC, CIRBTC, 3000)?.id).toBe('cirbtc-usdc');
    expect(poolForPosition(CIRBTC, EURC, 3000)?.id).toBe('cirbtc-eurc');
    expect(poolForPosition(EURC, USDC, 3000)?.id).toBe('eurc-usdc');
  });

  it('poolForPosition returns undefined for a wrong fee tier or an unknown pair', () => {
    expect(poolForPosition(CIRBTC, USDC, 500)).toBeUndefined();
    expect(poolForPosition(CIRBTC, '0x00000000000000000000000000000000000000dd', 3000)).toBeUndefined();
  });
});
