import { describe, it, expect } from 'vitest';
import { buildSwapArgs, splOffsetLimit, pegBoundedOffsetLimit } from '../src/arb.js';
import { price18ToSqrtPriceX96 } from '../src/poolMath.js';
import type { ArbConfig } from '../src/config.js';
import type { ArbDecision } from '../src/decideArb.js';

// ---------------------------------------------------------------------------
// FINDING 1 — the swap's sqrtPriceLimitX96 must be STRICTLY past the CURRENT pool price in
// the swap direction, or the vendored Uniswap-V3 pool reverts SPL. The vendored require is:
//   zeroForOne  (tokenIn == token0)  -> limit < slot0.sqrtPriceX96
//   !zeroForOne (tokenIn == token1)  -> limit > slot0.sqrtPriceX96
// where, for our market, zeroForOne = SELL_BASE ? baseIsToken0 : !baseIsToken0.
//
// The OLD buildSwapArgs pinned EVERY purpose (arb/rebalance/heartbeat) to the REF tick. But
// rebalance + heartbeat fire INSIDE the no-trade band (pool ~= ref) where the ref pin EQUALS
// (or sits on the wrong side of) the current sqrt => SPL revert. These tests prove the limit
// is now direction-correct + strictly-past-current for ALL three purposes.
// ---------------------------------------------------------------------------

const ONE18 = 10n ** 18n;
const REF = 100_000n * ONE18; // 100,000 USDC per base, 18dp

// cirBTC(8dp)/USDC(6dp): cirBTC sorts ABOVE USDC so token0=USDC, token1=cirBTC => false.
const market: ArbConfig['market'] = {
  id: 'cirbtc',
  label: 'cirBTC / USDC',
  arena: '0x000000000000000000000000000000000000dEaD',
  pool: '0x0000000000000000000000000000000000000001',
  base: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  baseDecimals: 8,
  quote: '0x3600000000000000000000000000000000000000',
  quoteDecimals: 6,
  feedId: '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  router: '0x0000000000000000000000000000000000000002',
  feeTier: 3000,
};

const swap = (over: Partial<ArbDecision>): ArbDecision & { kind: 'SWAP' } =>
  ({ kind: 'SWAP', direction: 'SELL_BASE', amountInBase: 10n ** 8n, reason: 'test', ...over }) as ArbDecision & {
    kind: 'SWAP';
  };

// The SPL direction predicate, in the exact form the vendored pool checks it.
function isStrictlyPast(limit: bigint, current: bigint, direction: 'SELL_BASE' | 'BUY_BASE', baseIsToken0: boolean): boolean {
  const zeroForOne = direction === 'SELL_BASE' ? baseIsToken0 : !baseIsToken0;
  return zeroForOne ? limit < current : limit > current;
}

describe('splOffsetLimit — direction-correct, strictly past current (pure)', () => {
  const CUR = price18ToSqrtPriceX96(REF, 8, 6, false); // a representative current sqrt

  for (const baseIsToken0 of [true, false]) {
    for (const direction of ['SELL_BASE', 'BUY_BASE'] as const) {
      it(`is strictly past current for ${direction} baseIsToken0=${baseIsToken0}`, () => {
        const limit = splOffsetLimit(CUR, direction, baseIsToken0, 75);
        expect(limit).not.toBe(CUR); // never EQUAL (that is the in-band SPL bug)
        expect(isStrictlyPast(limit, CUR, direction, baseIsToken0)).toBe(true);
      });
    }
  }

  it('clamps a 0/negative offset to a strictly-positive 1bp so the limit can never equal current', () => {
    // zeroForOne side (SELL_BASE w/ baseIsToken0=true): limit must be strictly BELOW current.
    expect(splOffsetLimit(CUR, 'SELL_BASE', true, 0)).toBeLessThan(CUR);
    // !zeroForOne side (SELL_BASE w/ baseIsToken0=false): strictly ABOVE current.
    expect(splOffsetLimit(CUR, 'SELL_BASE', false, 0)).toBeGreaterThan(CUR);
    expect(splOffsetLimit(CUR, 'SELL_BASE', false, -10)).toBeGreaterThan(CUR);
  });

  it('a larger offset moves the limit further from current (more room to fill)', () => {
    const small = splOffsetLimit(CUR, 'BUY_BASE', false, 10); // zeroForOne => below
    const big = splOffsetLimit(CUR, 'BUY_BASE', false, 200);
    expect(big).toBeLessThan(small); // further below current
  });
});

describe('buildSwapArgs — FINDING 1: rebalance/heartbeat limit is past CURRENT, not pinned to ref', () => {
  // Pool == ref (the in-band case): the OLD ref pin would EQUAL current => SPL revert.
  const CUR = price18ToSqrtPriceX96(REF, 8, 6, false);

  for (const purpose of ['rebalance', 'heartbeat'] as const) {
    for (const direction of ['SELL_BASE', 'BUY_BASE'] as const) {
      it(`${purpose} ${direction} at pool==ref: limit is strictly past current (NOT the ref pin)`, () => {
        const args = buildSwapArgs(swap({ direction, purpose }), market, REF, false, 75, CUR, 75);
        // The ref pin would be EXACTLY current here — proving the bug if it were used.
        const refPin = price18ToSqrtPriceX96(REF, 8, 6, false);
        expect(args.sqrtPriceLimitX96).not.toBe(refPin);
        expect(isStrictlyPast(args.sqrtPriceLimitX96, CUR, direction, false)).toBe(true);
        // Bounded by the supplied maxSlippageBps (75 bps) — within ~1% of current.
        const diff = args.sqrtPriceLimitX96 > CUR ? args.sqrtPriceLimitX96 - CUR : CUR - args.sqrtPriceLimitX96;
        expect(diff * 10_000n <= CUR * 100n).toBe(true);
      });
    }
  }

  it('rebalance/heartbeat limit is past current even when pool is slightly OFF ref (in-band, wrong-side direction)', () => {
    // Pool +10bps above ref, but the rebalance restocks the base leg => BUY_BASE (tokenIn=USDC=
    // token0 => zeroForOne => limit must be BELOW current). The ref pin (below current here) might
    // look ok, but a heartbeat selling the heavy base leg would need the OTHER side — prove both.
    const poolPrice = REF + (REF * 10n) / 10_000n;
    const cur = price18ToSqrtPriceX96(poolPrice, 8, 6, false);
    const buy = buildSwapArgs(swap({ direction: 'BUY_BASE', purpose: 'rebalance' }), market, REF, false, 75, cur, 75);
    expect(isStrictlyPast(buy.sqrtPriceLimitX96, cur, 'BUY_BASE', false)).toBe(true);
    const sell = buildSwapArgs(swap({ direction: 'SELL_BASE', purpose: 'heartbeat' }), market, REF, false, 75, cur, 75);
    expect(isStrictlyPast(sell.sqrtPriceLimitX96, cur, 'SELL_BASE', false)).toBe(true);
  });
});

describe('buildSwapArgs — FINDING 1: arb keeps pinning to ref (verified strictly past current)', () => {
  it('SELL_BASE arb (pool ABOVE ref) pins to the ref tick and it is strictly past current', () => {
    // Pool +1% above ref => SELL_BASE. baseIsToken0=false => !zeroForOne => limit must be ABOVE
    // current. For baseIsToken0=false the ref (lower price) maps to a HIGHER sqrt than the pool.
    const poolHigh = REF + REF / 100n;
    const cur = price18ToSqrtPriceX96(poolHigh, 8, 6, false);
    const refPin = price18ToSqrtPriceX96(REF, 8, 6, false);
    const args = buildSwapArgs(swap({ direction: 'SELL_BASE', purpose: 'arb' }), market, REF, false, 75, cur, 75);
    expect(args.sqrtPriceLimitX96).toBe(refPin); // arb still pins to ref by construction
    expect(isStrictlyPast(args.sqrtPriceLimitX96, cur, 'SELL_BASE', false)).toBe(true);
  });

  it('BUY_BASE arb (pool BELOW ref) pins to the ref tick and it is strictly past current', () => {
    const poolLow = REF - REF / 100n;
    const cur = price18ToSqrtPriceX96(poolLow, 8, 6, false);
    const refPin = price18ToSqrtPriceX96(REF, 8, 6, false);
    const args = buildSwapArgs(swap({ direction: 'BUY_BASE', purpose: 'arb' }), market, REF, false, 75, cur, 75);
    expect(args.sqrtPriceLimitX96).toBe(refPin);
    expect(isStrictlyPast(args.sqrtPriceLimitX96, cur, 'BUY_BASE', false)).toBe(true);
  });

  it('DEGENERATE arb (ref pin lands on/over current) falls back to a bounded offset past current', () => {
    // Force the pathological case: pool == ref so the ref pin EQUALS current. An arb shouldn't
    // fire here, but if a stale/degenerate input ever produced this, the limit must STILL be
    // strictly past current (never == current => never SPL). baseIsToken0=false, SELL_BASE =>
    // !zeroForOne => limit must be strictly ABOVE current.
    const cur = price18ToSqrtPriceX96(REF, 8, 6, false);
    const args = buildSwapArgs(swap({ direction: 'SELL_BASE', purpose: 'arb' }), market, REF, false, 75, cur, 75);
    expect(args.sqrtPriceLimitX96).not.toBe(cur);
    expect(isStrictlyPast(args.sqrtPriceLimitX96, cur, 'SELL_BASE', false)).toBe(true);
  });

  it('omitting currentSqrtPriceX96 preserves the legacy ref-pin behavior (back-compat)', () => {
    // The pre-FINDING-1 unit tests call buildSwapArgs without a current sqrt — arb must still
    // pin exactly to the ref tick for both token orderings.
    const a = buildSwapArgs(swap({ direction: 'SELL_BASE' }), market, REF, true, 75);
    expect(a.sqrtPriceLimitX96).toBe(price18ToSqrtPriceX96(REF, 8, 6, true));
    const b = buildSwapArgs(swap({ direction: 'BUY_BASE' }), market, REF, false, 75);
    expect(b.sqrtPriceLimitX96).toBe(price18ToSqrtPriceX96(REF, 8, 6, false));
  });

  it('amountOutMinimum slippage guard is unchanged by the limit fix (SELL_BASE)', () => {
    const cur = price18ToSqrtPriceX96(REF + REF / 100n, 8, 6, false);
    const args = buildSwapArgs(swap({ direction: 'SELL_BASE', amountInBase: 10n ** 8n }), market, REF, false, 75, cur, 75);
    // 1.0 base @ 100,000 USDC -> 100,000e6 raw, haircut 75bps.
    const usdcValue = 100_000n * 10n ** 6n;
    expect(args.amountOutMinimum).toBe((usdcValue * BigInt(10_000 - 75)) / 10_000n);
  });
});

// ---------------------------------------------------------------------------
// FINDING 1b — the rebalance/heartbeat leg overshoot. Their direction comes from INVENTORY, not the
// side of the ref, and they can fire when the pool sits slightly OFF the oracle. A plain offset limit
// is bounded only vs the CURRENT pool sqrt, so a fixed-notional leg fired at +49bps dragged the
// cirBTC/EURC pool ~7% PAST the oracle. pegBoundedOffsetLimit clamps the limit to the ref tick: a leg
// heading TOWARD the peg fills at most TO it, never past it — symmetric with the ref-pinned arb leg.
// ---------------------------------------------------------------------------
describe('pegBoundedOffsetLimit — clamps the offset to the ref tick (never crosses the peg, stays SPL-valid)', () => {
  const CUR = price18ToSqrtPriceX96(REF, 8, 6, false);

  for (const baseIsToken0 of [true, false]) {
    for (const direction of ['SELL_BASE', 'BUY_BASE'] as const) {
      it(`is always strictly past current for ${direction} baseIsToken0=${baseIsToken0} (any ref)`, () => {
        // Probe a ref on both sides of current + a wide offset; the result must never equal current.
        for (const refMul of [9_900n, 9_990n, 10_010n, 10_100n]) {
          const refLimit = (CUR * refMul) / 10_000n;
          const limit = pegBoundedOffsetLimit(CUR, refLimit, direction, baseIsToken0, 1000);
          expect(limit).not.toBe(CUR);
          expect(isStrictlyPast(limit, CUR, direction, baseIsToken0)).toBe(true);
        }
      });
    }
  }
});

describe('buildSwapArgs — FINDING 1b: rebalance/heartbeat limit is CLAMPED to the ref (cannot overshoot the peg)', () => {
  const refPin = price18ToSqrtPriceX96(REF, 8, 6, false);

  for (const purpose of ['rebalance', 'heartbeat'] as const) {
    it(`${purpose} SELL into a pool ABOVE ref clamps to the ref tick (no downside overshoot)`, () => {
      // pool +50bps above ref; a wide 1000bps offset would walk the pool far PAST ref — the clamp pins it.
      const cur = price18ToSqrtPriceX96(REF + (REF * 50n) / 10_000n, 8, 6, false);
      const args = buildSwapArgs(swap({ direction: 'SELL_BASE', purpose }), market, REF, false, 1000, cur, 1000);
      expect(args.sqrtPriceLimitX96).toBe(refPin); // clamped exactly to the peg
      expect(isStrictlyPast(args.sqrtPriceLimitX96, cur, 'SELL_BASE', false)).toBe(true); // still SPL-valid
    });

    it(`${purpose} BUY into a pool BELOW ref clamps to the ref tick (no upside overshoot)`, () => {
      const cur = price18ToSqrtPriceX96(REF - (REF * 50n) / 10_000n, 8, 6, false);
      const args = buildSwapArgs(swap({ direction: 'BUY_BASE', purpose }), market, REF, false, 1000, cur, 1000);
      expect(args.sqrtPriceLimitX96).toBe(refPin);
      expect(isStrictlyPast(args.sqrtPriceLimitX96, cur, 'BUY_BASE', false)).toBe(true);
    });
  }

  it('a SMALL offset that stops short of the ref is NOT clamped (the slippage bound still binds first)', () => {
    const cur = price18ToSqrtPriceX96(REF + (REF * 200n) / 10_000n, 8, 6, false); // +200bps; ref is far
    const args = buildSwapArgs(swap({ direction: 'SELL_BASE', purpose: 'rebalance' }), market, REF, false, 10, cur, 10);
    expect(args.sqrtPriceLimitX96).toBe(splOffsetLimit(cur, 'SELL_BASE', false, 10)); // offset binds => unchanged
    expect(args.sqrtPriceLimitX96 < refPin).toBe(true); // and it never reached the ref tick
  });

  it('a wrong-side restock (heads AWAY from ref) falls back to the plain offset (still SPL-valid)', () => {
    // Pool ABOVE ref but a BUY_BASE rebalance pushes price further UP, away from the ref => no clamp.
    const cur = price18ToSqrtPriceX96(REF + (REF * 50n) / 10_000n, 8, 6, false);
    const args = buildSwapArgs(swap({ direction: 'BUY_BASE', purpose: 'rebalance' }), market, REF, false, 75, cur, 75);
    expect(args.sqrtPriceLimitX96).toBe(splOffsetLimit(cur, 'BUY_BASE', false, 75));
    expect(isStrictlyPast(args.sqrtPriceLimitX96, cur, 'BUY_BASE', false)).toBe(true);
  });

  it('arb leg is UNCHANGED by the clamp (still pins exactly to the ref tick)', () => {
    const cur = price18ToSqrtPriceX96(REF + REF / 100n, 8, 6, false);
    const args = buildSwapArgs(swap({ direction: 'SELL_BASE', purpose: 'arb' }), market, REF, false, 75, cur, 75);
    expect(args.sqrtPriceLimitX96).toBe(refPin);
  });
});
