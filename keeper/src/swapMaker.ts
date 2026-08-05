// swapMaker.ts - the PURE sizing brain of the cirBTC/USDC "peg-band" market maker.
//
// This replaces the one-way arb "battery" that kept bleeding cirBTC: every tick it
// emits the single next maker leg given a pool-vs-Pyth snapshot, and it is built around
// ONE hard invariant - it must NEVER sell the bot's scarce cirBTC (base) inventory below
// floorBase. The caller (swapbot) reads the live pool + balances, calls decideMaker, and
// executes the returned tagged-union decision. No I/O, no clock - every input is passed
// in, so the whole state space is deterministic + unit-testable (mirrors decideArb's
// design).
//
// Price convention (same as decideArb): poolPrice18 and ref18 are BOTH USDC-per-base in
// 18dp, already decimals-adjusted by the caller for the 8dp base / 6dp quote pair. The
// signed deviation devBps is (pool - ref)/ref in bps: positive => pool too HIGH (sell base
// toward the peg), negative => pool too LOW (buy base toward the peg AND refill inventory).
//
// SIZING: the peg-correction size is derived from the pool's OWN in-range liquidity L via
// the V3 sqrt-price relationship (baseAmountToMovePrice) - we compute the base amount that
// moves the pool from its spot to a target that UNDERSHOOTS the ref by closeFraction (so we
// never overshoot the oracle). That raw size is then rationed by inventory: on a SELL it is
// skewed DOWN as inventory approaches the floor (and hard-capped at the sellable surplus so
// the floor is mathematically untouchable); on a BUY it is BOOSTED when inventory is short
// (skewK) so the bot refills aggressively, capped by the spendable USDC budget.

import { baseAmountToMovePrice } from './poolMath.js';

/** The pool/reference + inventory snapshot decideMaker needs. All amounts raw on-chain units. */
export interface MakerState {
  poolPrice18: bigint;   // pool spot, USDC/base 18dp
  ref18: bigint;         // Pyth reference, USDC/base 18dp
  invBase: bigint;       // bot's cirBTC balance (raw, baseDecimals)
  invQuote: bigint;      // bot's USDC balance (raw, quoteDecimals)
  liquidity: bigint;     // pool in-range liquidity L
  baseIsToken0: boolean;
}

/** Tunable maker parameters (from config). */
export interface MakerParams {
  deadbandBps: number;    // |dev| <= this => neutral volume; outside => peg-correct
  floorBase: bigint;      // HARD floor: never sell base below this (raw)
  targetBase: bigint;     // working inventory target (>= floorBase)
  reserveQuote: bigint;   // gas/USDC reserve: never spend quote below this on a BUY
  maxTradeBase: bigint;   // hard cap on a single trade (raw base)
  minTradeBase: bigint;   // dust floor: sizes below this => NONE/NEUTRAL
  closeFraction: number;  // fraction (0..1] of the price gap to close (undershoot ref)
  skewK: number;          // buy-boost aggressiveness when refilling (>= 0; e.g. 2.0)
  baseDecimals: number;
  quoteDecimals: number;
}

export type MakerKind = 'NONE' | 'NEUTRAL' | 'SELL_BASE' | 'BUY_BASE';

/** What the executor should do this tick. */
export interface MakerDecision {
  kind: MakerKind;
  sizeBase?: bigint;   // present for SELL_BASE / BUY_BASE / NEUTRAL (the leg size)
  devBps?: number;     // signed pool-vs-ref deviation, for logging
  reason: string;
}

const ONE18 = 10n ** 18n;

/** abs() for bigint. */
function babs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

/**
 * Scale a bigint by a JS float fraction deterministically, using 1e6 fixed-point so the
 * result is reproducible (no FP drift in the bigint domain). frac is clamped to [0, 1].
 * Signed-safe: the magnitude is scaled and the sign re-applied so undershoot works for a
 * negative gap (pool below ref) too. (Copied from decideArb so this module stays pure +
 * dependency-light.)
 */
function scaleByFraction(value: bigint, frac: number): bigint {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  // Round the fraction to 6 decimal places of fixed-point precision.
  const num = BigInt(Math.round(f * 1_000_000));
  return (value * num) / 1_000_000n;
}

/**
 * Convert a USDC budget (raw at quoteDecimals) into the BASE-token amount it can buy at
 * ref18, in the SAME raw base-decimals scale as maxTradeBase. Decimals-GENERIC:
 *   baseRaw = usdcRaw * 1e18 * 10^baseDec / (ref18 * 10^quoteDec)
 * (Copied from decideArb.)
 */
function usdcBudgetToBase(
  usdcRaw: bigint,
  ref18: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (ref18 <= 0n) return 0n;
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);
  return (usdcRaw * ONE18 * baseScale) / (ref18 * quoteScale);
}

/**
 * Decide the single next maker action for the peg-band MM. PURE - total over the state
 * space, no I/O, no clock read, no input mutation.
 */
export function decideMaker(state: MakerState, params: MakerParams): MakerDecision {
  // 1) Guards: a non-positive ref/pool price or an inert (zero-liquidity) pool means we
  //    can't compute a deviation or size a trade - do nothing.
  if (state.ref18 <= 0n) {
    return { kind: 'NONE', reason: 'reference price is non-positive - cannot compute deviation' };
  }
  if (state.poolPrice18 <= 0n) {
    return { kind: 'NONE', reason: 'pool price is non-positive - cannot size a trade' };
  }
  if (state.liquidity <= 0n) {
    return { kind: 'NONE', reason: 'pool liquidity is zero - inert pool, nothing to make against' };
  }

  // 2) Signed deviation in bps: (pool - ref) / ref. Positive => pool too high.
  const devBpsBig = ((state.poolPrice18 - state.ref18) * 10_000n) / state.ref18;
  const devBps = Number(devBpsBig);
  const absDev = babs(devBpsBig);

  // 3) Deadband: the pool is close enough to the peg that we don't want to push it - but
  //    we still want fee VOLUME, so emit a NEUTRAL round-trip. We hand the caller a small
  //    unit leg (minTradeBase); the swapbot decides the round-trip notional separately.
  if (absDev <= BigInt(params.deadbandBps)) {
    return {
      kind: 'NEUTRAL',
      sizeBase: params.minTradeBase,
      devBps,
      reason: `within deadband: |dev| ${absDev}bps <= ${params.deadbandBps}bps - peg-neutral round-trip for volume`,
    };
  }

  // 4) Peg-correction size from POOL DEPTH. Target a price that UNDERSHOOTS the ref by
  //    closeFraction of the gap (so we never overshoot the oracle), then ask the V3 sizing
  //    primitive for the base amount that moves the pool there. maxTradeBase is a hard CAP.
  const gap18 = state.ref18 - state.poolPrice18; // signed
  const target18 = state.poolPrice18 + scaleByFraction(gap18, params.closeFraction);
  const sizePeg = baseAmountToMovePrice(
    state.liquidity,
    state.poolPrice18,
    target18,
    params.baseDecimals,
    params.quoteDecimals,
    state.baseIsToken0,
  );
  const rawSize = sizePeg < params.maxTradeBase ? sizePeg : params.maxTradeBase;

  if (devBpsBig > 0n) {
    // 5) Pool HIGH -> SELL base toward the peg, INVENTORY-RATIONED. The sellable surplus is
    //    everything above the floor; the size is skewed down linearly as inventory falls
    //    toward the floor AND hard-capped at `sellable`, so applying it can NEVER push
    //    invBase below floorBase (the core no-deplete guarantee).
    const sellable = state.invBase > params.floorBase ? state.invBase - params.floorBase : 0n;
    const denom = params.targetBase - params.floorBase > 0n ? params.targetBase - params.floorBase : 1n;
    // Linear skew ramp 0->1 as invBase climbs floor->target (more inventory => sell more).
    const skewNum = sellable < denom ? sellable : denom;
    const skewed = (rawSize * skewNum) / denom;
    const size = skewed < sellable ? skewed : sellable;

    if (size >= params.minTradeBase) {
      return {
        kind: 'SELL_BASE',
        sizeBase: size,
        devBps,
        reason: `peg-correct SELL_BASE: dev ${devBps}bps (pool high), size ${size} base (sellable ${sellable}, skew ${skewNum}/${denom})`,
      };
    }
    return { kind: 'NONE', devBps, reason: 'cirBTC near floor - rationing (not selling below floor)' };
  }

  // 6) Pool LOW -> BUY base toward the peg AND REFILL inventory, BOOSTED when low. The buy
  //    is funded by the USDC spendable above the gas/USDC reserve, and the peg-correct size
  //    is multiplied by a refill boost (skewK) that grows with the inventory shortfall.
  const spendableUsdc = state.invQuote > params.reserveQuote ? state.invQuote - params.reserveQuote : 0n;
  const budgetBase = usdcBudgetToBase(spendableUsdc, state.ref18, params.baseDecimals, params.quoteDecimals);

  const shortfall = params.targetBase > state.invBase ? params.targetBase - state.invBase : 0n;
  const boostDenom = params.targetBase - params.floorBase > 0n ? params.targetBase - params.floorBase : 1n;
  const shortClamp = shortfall < boostDenom ? shortfall : boostDenom;
  // Refill boost in 1e6 fixed-point: 1.0 + skewK * (shortfall/denom). Bigger shortfall =>
  // bigger buy, so the bot restocks aggressively when its cirBTC runs low.
  const boost1e6 = 1_000_000n + (BigInt(Math.round(params.skewK * 1_000_000)) * shortClamp) / boostDenom;
  const boosted = (rawSize * boost1e6) / 1_000_000n;
  const size = boosted < budgetBase ? boosted : budgetBase;

  if (size >= params.minTradeBase) {
    return {
      kind: 'BUY_BASE',
      sizeBase: size,
      devBps,
      reason: `peg-correct BUY_BASE + refill: dev ${devBps}bps (pool low), size ${size} base (boost ${boost1e6}/1e6, budget ${budgetBase})`,
    };
  }
  return { kind: 'NONE', devBps, reason: 'no USDC budget / dust' };
}
