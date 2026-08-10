import { describe, it, expect } from 'vitest';
import { buildSwapArgs, divergenceBps } from '../src/arb.js';
import { price18ToSqrtPriceX96 } from '../src/poolMath.js';
import type { ArbConfig } from '../src/config.js';
import type { ArbDecision } from '../src/decideArb.js';

const ONE18 = 10n ** 18n;
const REF = 100_000n * ONE18; // 100,000 USDC per base (BTC), 18dp

// A cirBTC(8dp)/USDC(6dp) market fixture.
const market: ArbConfig['market'] = {
  id: 'cirbtc',
  label: 'cirBTC / USDC',
  arena: '0x000000000000000000000000000000000000dEaD',
  pool: '0x0000000000000000000000000000000000000001',
  base: '0x00000000000000000000000000000000000000Ba5e',
  baseDecimals: 8,
  quote: '0x3600000000000000000000000000000000000000',
  quoteDecimals: 6,
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  router: '0x0000000000000000000000000000000000000002',
  feeTier: 3000,
};

const swapDecision = (over: Partial<ArbDecision>): ArbDecision & { kind: 'SWAP' } => ({
  kind: 'SWAP',
  direction: 'SELL_BASE',
  amountInBase: 10n ** 8n, // 1.0 base
  reason: 'test',
  ...over,
}) as ArbDecision & { kind: 'SWAP' };

describe('divergenceBps', () => {
  it('is 0 when pool == ref', () => {
    expect(divergenceBps(REF, REF)).toBe(0);
  });
  it('is positive when pool > ref', () => {
    expect(divergenceBps(REF + REF / 100n, REF)).toBe(100); // +1%
  });
  it('is negative when pool < ref', () => {
    expect(divergenceBps(REF - REF / 100n, REF)).toBe(-100); // -1%
  });
  it('guards a non-positive ref', () => {
    expect(divergenceBps(REF, 0n)).toBe(0);
  });
});

describe('buildSwapArgs — SELL_BASE (base -> USDC)', () => {
  const swap = buildSwapArgs(swapDecision({ direction: 'SELL_BASE', amountInBase: 10n ** 8n }), market, REF, true, 75);

  it('routes base in, USDC out', () => {
    expect(swap.tokenIn).toBe(market.base);
    expect(swap.tokenOut).toBe(market.quote);
  });

  it('amountIn is the base amount directly', () => {
    expect(swap.amountIn).toBe(10n ** 8n);
  });

  it('amountOutMinimum is the USDC value at ref, haircut by slippage (75 bps)', () => {
    // 1.0 base @ 100,000 USDC -> 100,000 USDC = 100_000e6 raw. Haircut 75bps.
    const usdcValue = 100_000n * 10n ** 6n;
    const expected = (usdcValue * BigInt(10_000 - 75)) / 10_000n;
    expect(swap.amountOutMinimum).toBe(expected);
  });

  it('pins sqrtPriceLimitX96 to the ref price', () => {
    expect(swap.sqrtPriceLimitX96).toBe(price18ToSqrtPriceX96(REF, 8, 6, true));
  });
});

describe('buildSwapArgs — BUY_BASE (USDC -> base)', () => {
  const swap = buildSwapArgs(swapDecision({ direction: 'BUY_BASE', amountInBase: 10n ** 8n }), market, REF, true, 75);

  it('routes USDC in, base out', () => {
    expect(swap.tokenIn).toBe(market.quote);
    expect(swap.tokenOut).toBe(market.base);
  });

  it('amountIn is the USDC value of the base target at ref', () => {
    // 1.0 base @ 100,000 USDC -> 100,000 USDC = 100_000e6 raw.
    expect(swap.amountIn).toBe(100_000n * 10n ** 6n);
  });

  it('amountOutMinimum is the base target haircut by slippage', () => {
    const expected = (10n ** 8n * BigInt(10_000 - 75)) / 10_000n;
    expect(swap.amountOutMinimum).toBe(expected);
  });

  it('pins sqrtPriceLimitX96 to the ref price', () => {
    expect(swap.sqrtPriceLimitX96).toBe(price18ToSqrtPriceX96(REF, 8, 6, true));
  });
});

describe('buildSwapArgs — token ordering', () => {
  it('uses the inverted sqrt limit when base is token1', () => {
    const a = buildSwapArgs(swapDecision({}), market, REF, true, 75);
    const b = buildSwapArgs(swapDecision({}), market, REF, false, 75);
    expect(a.sqrtPriceLimitX96).not.toBe(b.sqrtPriceLimitX96);
    expect(b.sqrtPriceLimitX96).toBe(price18ToSqrtPriceX96(REF, 8, 6, false));
  });
});
