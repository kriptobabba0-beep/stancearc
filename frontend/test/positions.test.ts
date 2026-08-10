import { describe, it, expect } from 'vitest';
import { filterArenaPositions, type RawPosition } from '@/lib/positions';

// Arena pool config: unordered {WETH, USDC} at fee 3000.
const WETH = '0x7777777777777777777777777777777777777777';
const USDC = '0x3600000000000000000000000000000000000000';
const cfg = { weth: WETH, usdc: USDC, feeTier: 3000 } as const;

// Minimal raw position: tokenId + the fields we read off positions(). Ticks default to the 0.3%-tier
// full range (±887220) — they pass through the filter untouched (range never affects stakeability).
function raw(p: Partial<RawPosition> & { tokenId: bigint }): RawPosition {
  return {
    token0: WETH,
    token1: USDC,
    fee: 3000,
    liquidity: 1000n,
    tickLower: -887220,
    tickUpper: 887220,
    ...p,
  };
}

describe('filterArenaPositions', () => {
  it('keeps a WETH/USDC position at the right fee tier with liquidity > 0', () => {
    const out = filterArenaPositions([raw({ tokenId: 1n })], cfg, []);
    expect(out).toEqual([{ tokenId: 1n, liquidity: 1000n, tickLower: -887220, tickUpper: 887220 }]);
  });

  it('passes a position’s ticks through unchanged (range badges need them; filter ignores them)', () => {
    const out = filterArenaPositions(
      [raw({ tokenId: 99n, tickLower: -65280, tickUpper: -63960 })],
      cfg,
      [],
    );
    expect(out).toEqual([{ tokenId: 99n, liquidity: 1000n, tickLower: -65280, tickUpper: -63960 }]);
  });

  it('matches the token pair UNORDERED (token0=USDC, token1=WETH)', () => {
    const out = filterArenaPositions([raw({ tokenId: 2n, token0: USDC, token1: WETH })], cfg, []);
    expect(out.map((p) => p.tokenId)).toEqual([2n]);
  });

  it('is case-insensitive on token addresses', () => {
    const out = filterArenaPositions(
      [raw({ tokenId: 3n, token0: WETH.toUpperCase(), token1: USDC.toLowerCase() })],
      cfg,
      [],
    );
    expect(out.map((p) => p.tokenId)).toEqual([3n]);
  });

  it('drops positions from a different pool (wrong token pair)', () => {
    const OTHER = '0x9999999999999999999999999999999999999999';
    const out = filterArenaPositions([raw({ tokenId: 4n, token1: OTHER })], cfg, []);
    expect(out).toEqual([]);
  });

  it('drops positions with the wrong fee tier', () => {
    const out = filterArenaPositions([raw({ tokenId: 5n, fee: 500 })], cfg, []);
    expect(out).toEqual([]);
  });

  it('drops positions with zero liquidity', () => {
    const out = filterArenaPositions([raw({ tokenId: 6n, liquidity: 0n })], cfg, []);
    expect(out).toEqual([]);
  });

  it('excludes tokenIds already staked by the user', () => {
    const positions = [raw({ tokenId: 7n }), raw({ tokenId: 8n }), raw({ tokenId: 9n })];
    const out = filterArenaPositions(positions, cfg, [8n]);
    expect(out.map((p) => p.tokenId)).toEqual([7n, 9n]);
  });

  it('filters a mixed batch end-to-end', () => {
    const OTHER = '0x9999999999999999999999999999999999999999';
    const positions = [
      raw({ tokenId: 10n }), // keep
      raw({ tokenId: 11n, token0: USDC, token1: WETH }), // keep (unordered)
      raw({ tokenId: 12n, fee: 500 }), // drop (fee)
      raw({ tokenId: 13n, liquidity: 0n }), // drop (no liquidity)
      raw({ tokenId: 14n, token1: OTHER }), // drop (pair)
      raw({ tokenId: 15n }), // drop (staked)
    ];
    const out = filterArenaPositions(positions, cfg, [15n]);
    expect(out.map((p) => p.tokenId)).toEqual([10n, 11n]);
  });

  it('returns an empty array for an empty input', () => {
    expect(filterArenaPositions([], cfg, [])).toEqual([]);
  });
});
