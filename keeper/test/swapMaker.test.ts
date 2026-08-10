import { describe, it, expect } from 'vitest';
import { decideMaker, type MakerState, type MakerParams } from '../src/swapMaker.js';

// ---------------------------------------------------------------------------
// Realistic cirBTC(8dp)/USDC(6dp) numbers. ref ~ $60,750 -> ref18 = 60750e18.
// The market is token0=USDC, token1=cirBTC, so baseIsToken0=false.
//
// Inventory is in 8dp base units: 1 cirBTC = 1e8 raw. The floor/target below are
// chosen so the rationing + boost math exercises the genuine paths (not just clamps).
// ---------------------------------------------------------------------------
const ONE = 10n ** 18n;
const REF = 60_750n * ONE; // ~$60,750 in 18dp
const L = 611_423_746n; // realistic in-range liquidity for the thin pool

// Inventory anchors (8dp): floor 0.5 cirBTC, target 2.0 cirBTC.
const FLOOR = 50_000_000n; //   0.5 cirBTC
const TARGET = 200_000_000n; // 2.0 cirBTC

const baseState: MakerState = {
  poolPrice18: REF,
  ref18: REF,
  invBase: TARGET, // sitting on target by default
  invQuote: 1_000_000n * 10n ** 6n, // 1,000,000 USDC (ample)
  liquidity: L,
  baseIsToken0: false,
};

const baseParams: MakerParams = {
  deadbandBps: 30,
  floorBase: FLOOR,
  targetBase: TARGET,
  reserveQuote: 100n * 10n ** 6n, // keep 100 USDC for gas
  maxTradeBase: 10n ** 8n, //        1.0 cirBTC hard cap
  minTradeBase: 1_000n, //           dust floor (0.00001 cirBTC) — tiny so rationing shows
  closeFraction: 0.6,
  skewK: 2.0,
  baseDecimals: 8,
  quoteDecimals: 6,
};

const st = (over: Partial<MakerState>): MakerState => ({ ...baseState, ...over });
const pr = (over: Partial<MakerParams>): MakerParams => ({ ...baseParams, ...over });

// bps -> a pool price `bps` basis points above (positive) / below (negative) the ref.
const poolAtBps = (bps: number): bigint => REF + (REF * BigInt(bps)) / 10_000n;

describe('decideMaker — guards (NONE)', () => {
  it('NONE when ref18 is zero', () => {
    const d = decideMaker(st({ ref18: 0n, poolPrice18: poolAtBps(500) }), baseParams);
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/reference/i);
  });

  it('NONE when liquidity is zero (inert pool)', () => {
    const d = decideMaker(st({ liquidity: 0n, poolPrice18: poolAtBps(500) }), baseParams);
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/liquidit/i);
  });

  it('NONE when pool price is non-positive', () => {
    const d = decideMaker(st({ poolPrice18: 0n }), baseParams);
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/pool price/i);
  });
});

describe('decideMaker — deadband (NEUTRAL)', () => {
  it('pool within deadbandBps of ref -> NEUTRAL with a minTradeBase leg', () => {
    const d = decideMaker(st({ poolPrice18: poolAtBps(10) }), baseParams); // 10 bps < 30 band
    expect(d.kind).toBe('NEUTRAL');
    expect(d.sizeBase).toBe(baseParams.minTradeBase);
    expect(d.reason).toMatch(/deadband|neutral/i);
  });

  it('exact deadband boundary (|dev| == deadbandBps) -> NEUTRAL (inclusive)', () => {
    const d = decideMaker(st({ poolPrice18: poolAtBps(30) }), baseParams);
    expect(d.kind).toBe('NEUTRAL');
  });

  it('pool == ref (dev 0) -> NEUTRAL', () => {
    const d = decideMaker(st({ poolPrice18: REF }), baseParams);
    expect(d.kind).toBe('NEUTRAL');
  });
});

describe('decideMaker — SELL_BASE (pool high)', () => {
  it('full inventory, pool high -> SELL_BASE with size in (0, maxTradeBase]', () => {
    // invBase well above target so the skew ramp is saturated (full rawSize allowed).
    const d = decideMaker(
      st({ poolPrice18: poolAtBps(500), invBase: TARGET * 10n }),
      baseParams,
    );
    expect(d.kind).toBe('SELL_BASE');
    expect(d.sizeBase!).toBeGreaterThan(0n);
    expect(d.sizeBase!).toBeLessThanOrEqual(baseParams.maxTradeBase);
  });

  it('SELL size never exceeds maxTradeBase even with deep liquidity + huge inventory', () => {
    const d = decideMaker(
      st({
        poolPrice18: poolAtBps(2_000),
        invBase: TARGET * 1_000n,
        liquidity: 10n ** 14n, // very deep -> liquidity size would dwarf the cap
      }),
      baseParams,
    );
    expect(d.kind).toBe('SELL_BASE');
    expect(d.sizeBase).toBe(baseParams.maxTradeBase);
  });
});

describe('decideMaker — HARD FLOOR GUARANTEE (the core invariant)', () => {
  it('the returned SELL size is ALWAYS <= invBase - floorBase across floor..2x target', () => {
    // Pool HIGH (so the path is SELL_BASE) at a strong divergence, and a deep pool so the
    // liquidity-derived rawSize is large enough that ONLY the floor cap can bind.
    const poolHigh = poolAtBps(3_000);
    const deepL = 10n ** 14n;
    const step = TARGET / 50n; // 50 samples from floor up to 2x target

    for (let inv = FLOOR; inv <= TARGET * 2n; inv += step) {
      const d = decideMaker(st({ poolPrice18: poolHigh, invBase: inv, liquidity: deepL }), baseParams);
      const sellable = inv > FLOOR ? inv - FLOOR : 0n;
      const sold = d.kind === 'SELL_BASE' ? d.sizeBase! : 0n;
      // Applying the sale can NEVER cross the floor: sold <= invBase - floorBase.
      expect(sold).toBeLessThanOrEqual(sellable);
      // And of course it never goes negative.
      expect(sold).toBeGreaterThanOrEqual(0n);
    }
  });

  it('at invBase == floorBase -> NONE (never sells), size 0', () => {
    const d = decideMaker(
      st({ poolPrice18: poolAtBps(3_000), invBase: FLOOR, liquidity: 10n ** 14n }),
      baseParams,
    );
    expect(d.kind).toBe('NONE');
    expect(d.sizeBase ?? 0n).toBe(0n);
    expect(d.reason).toMatch(/floor/i);
  });

  it('just above the floor -> tiny SELL (if any), still <= invBase - floorBase', () => {
    // Use a min dust floor of 1 so even a 1-unit sellable surplus can return a leg, and a
    // surplus just barely above min so we land on a SELL, not a NONE.
    const params = pr({ minTradeBase: 1n });
    const justAbove = FLOOR + 10n; // 10 raw units of cirBTC above the floor
    const d = decideMaker(
      st({ poolPrice18: poolAtBps(3_000), invBase: justAbove, liquidity: 10n ** 14n }),
      params,
    );
    const sellable = justAbove - FLOOR; // == 10n
    if (d.kind === 'SELL_BASE') {
      expect(d.sizeBase!).toBeLessThanOrEqual(sellable);
      expect(d.sizeBase!).toBeGreaterThan(0n);
    } else {
      // If it rationed to NONE that's also floor-safe (sold nothing).
      expect(d.kind).toBe('NONE');
    }
  });
});

describe('decideMaker — skew monotonicity (more inventory -> larger allowed sell)', () => {
  it('SELL size is non-decreasing as invBase rises from floor to target', () => {
    const poolHigh = poolAtBps(3_000);
    const deepL = 10n ** 14n; // deep so the skew ramp (not the liquidity size) is what moves
    const params = pr({ minTradeBase: 1n }); // expose the ramp without a dust cutoff

    let prev = -1n;
    const step = (TARGET - FLOOR) / 40n;
    for (let inv = FLOOR; inv <= TARGET; inv += step) {
      const d = decideMaker(st({ poolPrice18: poolHigh, invBase: inv, liquidity: deepL }), params);
      const size = d.kind === 'SELL_BASE' ? d.sizeBase! : 0n;
      expect(size).toBeGreaterThanOrEqual(prev);
      prev = size;
    }
    // And the top of the ramp (at target) actually sold something.
    expect(prev).toBeGreaterThan(0n);
  });
});

describe('decideMaker — BUY_BASE (pool low) + refill boost', () => {
  it('pool low, invBase below target -> BUY_BASE', () => {
    const d = decideMaker(
      st({ poolPrice18: poolAtBps(-500), invBase: FLOOR }),
      baseParams,
    );
    expect(d.kind).toBe('BUY_BASE');
    expect(d.sizeBase!).toBeGreaterThan(0n);
  });

  it('the refill boost makes the BUY LARGER than the same computation with skewK=0', () => {
    // Same low pool + same shortfall, but skewK 2.0 vs 0.0. The liquidity-derived rawSize
    // must be the BINDING constraint (not the cap, not the USDC budget) so the boost
    // multiplier shows through; we pick the realistic thin-pool L (rawSize is small) and a
    // generous cap + ample USDC so neither clamp masks the difference.
    const lowPool = poolAtBps(-500);
    const lowInv = FLOOR + (TARGET - FLOOR) / 4n; // well below target -> real shortfall
    const state = st({ poolPrice18: lowPool, invBase: lowInv, liquidity: L }); // thin pool L

    const boosted = decideMaker(state, pr({ skewK: 2.0, maxTradeBase: 10n ** 18n }));
    const flat = decideMaker(state, pr({ skewK: 0.0, maxTradeBase: 10n ** 18n }));

    expect(boosted.kind).toBe('BUY_BASE');
    expect(flat.kind).toBe('BUY_BASE');
    expect(boosted.sizeBase!).toBeGreaterThan(flat.sizeBase!);
  });

  it('pool low, invQuote at/below reserveQuote -> NONE (no budget)', () => {
    const d = decideMaker(
      st({ poolPrice18: poolAtBps(-500), invQuote: baseParams.reserveQuote }),
      baseParams,
    );
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/budget|dust/i);
  });

  it('pool low, invQuote below reserveQuote -> NONE (no budget)', () => {
    const d = decideMaker(
      st({ poolPrice18: poolAtBps(-500), invQuote: baseParams.reserveQuote - 1n }),
      baseParams,
    );
    expect(d.kind).toBe('NONE');
  });
});

describe('decideMaker — purity', () => {
  it('does not mutate its inputs', () => {
    const state = st({ poolPrice18: poolAtBps(500) });
    const params = pr({});
    const stateCopy = { ...state };
    const paramsCopy = { ...params };
    decideMaker(state, params);
    expect(state).toEqual(stateCopy);
    expect(params).toEqual(paramsCopy);
  });

  it('is deterministic (same inputs -> same decision)', () => {
    const state = st({ poolPrice18: poolAtBps(-500), invBase: FLOOR });
    const d1 = decideMaker(state, baseParams);
    const d2 = decideMaker(state, baseParams);
    expect(d1).toEqual(d2);
  });
});
