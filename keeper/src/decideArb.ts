// decideArb.ts - the PURE decision function at the heart of the price-keeper arb bot.
//
// Given a snapshot of one market's pool vs the live Pyth reference, it returns the
// single next arb action: SKIP (stale ref), ALERT (inert pool), NONE (inside the
// no-trade band or the trade would be dust), or SWAP (trade the pool back toward the
// reference so the AMM's REAL 0.3% fee accrues to the pot). It performs NO I/O and
// reads NO clock - every input (including refAgeSec) is passed in - so it is trivially
// unit-testable across the whole state space and deterministic.
//
// Price convention: poolPrice18 and ref18 are BOTH the USDC-per-base price in 18dp
// (1e18 == 1 USDC per 1 whole base token), already decimals-adjusted by the caller for
// the 8dp base / 6dp quote pair. divBps is the signed pool-vs-ref divergence in basis
// points: positive => pool too HIGH (sell base to push it down), negative => pool too
// LOW (buy base to push it up). The no-trade band is feeBps + thresholdBps so we never
// trade inside the round-trip fee cost (the AMM fee would eat the edge).
//
// SIZING (the heart of the HIGH-1/HIGH-2 fix): the trade is sized from the POOL'S OWN
// LIQUIDITY via the Uniswap-V3 sqrt-price relationship - NOT from a divergence-scaled
// fraction of maxTradeBase. We compute the base-token amount that moves the pool price
// from poolPrice18 to a target that UNDERSHOOTS the reference by closeFraction (so the
// AMM fully consumes amountIn before reaching the ref tick - no partial fill, so the
// executor's amountOutMinimum computed from the expected fill stays valid). maxTradeBase
// is now a hard CAP only (never the anchor), so the bot activates right at the band edge
// (feeBps+thresholdBps) instead of ~8x it.

import {
  price18ToSqrtPriceX96,
  baseAmountToMovePrice,
  poolDeliverableQuote,
  poolDeliverableBase,
  maxBaseSellForUsdcOut,
} from './poolMath.js';
// Type-only import - no runtime dependency on the ledger's IO, so decideArb stays pure.
import type { FlowState } from './flowLedger.js';

/** The pool/reference snapshot decideArb needs. All amounts are raw on-chain units. */
export interface ArbState {
  /** Pool spot price as USDC-per-base in 18dp (decimals-adjusted by the caller). */
  poolPrice18: bigint;
  /** Pyth reference price as USDC-per-base in 18dp. */
  ref18: bigint;
  /** Age (seconds) of the Pyth reference at decision time. Injected; never read here. */
  refAgeSec: number;
  /** Pool in-range liquidity (slot0/liquidity()). 0 => inert pool, cannot arb. */
  liquidity: bigint;
  /**
   * Whether the BASE token is token0 of the address-sorted pool. Resolved once at
   * startup by the executor and threaded in so the sizing math (and the sqrt-price
   * conversions it uses) pick the correct V3 amount formula. For the cirBTC/USDC market
   * cirBTC(0xf0C4) > USDC(0x3600) so token0=USDC, token1=cirBTC => baseIsToken0=false.
   */
  baseIsToken0: boolean;
  /** Bot's spendable BASE-token balance, raw at baseDecimals (caps a SELL_BASE). */
  inventoryBase: bigint;
  /** Bot's spendable USDC balance, raw at quoteDecimals (caps a BUY_BASE, via ref). */
  inventoryUsdc: bigint;
  /**
   * The POOL's real USDC balance (balanceOf(quote, pool), raw at quoteDecimals). The hard ceiling
   * on what a SELL_BASE can extract - at the range edge the constant-L estimate over-counts, so a
   * SELL is capped at a safety fraction of THIS so it can never revert "Too little received".
   * Optional: omitted => the deliverable cap is OFF (legacy behavior).
   */
  poolQuoteBal?: bigint;
  /** The POOL's real cirBTC balance (balanceOf(base, pool), raw). The ceiling on a BUY_BASE. Optional. */
  poolBaseBal?: bigint;
  /**
   * INJECTED rolling-window FLOW BUDGET snapshot. Caps the NET cirBTC sold per window so a relentless
   * trend can't bleed the battery in a day; a BUY credits the budget back (recycle is never capped).
   * Owned + persisted by the executor (like heartbeat). Omitted => flow budget OFF (legacy). PURE here.
   */
  flow?: FlowState;
  /**
   * INJECTED heartbeat-volume bookkeeping (TASK 3b). Like refAgeSec, decideArb reads NO
   * clock - the executor passes the current wall-clock + the day's running spend so the
   * decision stays PURE and deterministic. Omitted (undefined) => heartbeat mode is OFF
   * for this call (behavior unchanged). The executor owns the budget ledger (interval +
   * daily-cap accounting); decideArb only judges whether THIS tick is eligible to emit a
   * heartbeat round-trip leg.
   */
  heartbeat?: HeartbeatState;
}

/**
 * The injected heartbeat ledger (TASK 3b). The arb executor tracks the day's spend + the
 * last heartbeat timestamp across ticks (resetting the day at a UTC-day boundary) and
 * threads a snapshot in here so the decision is a pure function of its inputs.
 */
export interface HeartbeatState {
  /** Current wall-clock (ms) at decision time. Injected; never read from a clock here. */
  nowMs: number;
  /** Wall-clock (ms) of the last heartbeat leg the bot emitted, or null if none yet. */
  lastHeartbeatMs: number | null;
  /** Base-notional (raw at baseDecimals) already spent on heartbeat volume in the CURRENT day. */
  spentTodayBase: bigint;
  /**
   * FINDING 4 - heartbeat ATTEMPTS made in the current day (NOT just settled notional). A
   * reverting leg (FINDING 1) never charges the notional cap, so without an attempt cap it
   * could retry unbounded; the executor stamps this on EVERY heartbeat attempt regardless of
   * success and decideHeartbeat refuses once it hits heartbeatDailyMaxAttempts. Optional so
   * pre-existing callers/snapshots (without the field) keep working (treated as 0 => uncapped
   * unless the param is set).
   */
  heartbeatAttemptsToday?: number;
  /**
   * FINDING 3 - wall-clock (ms) of the last REBALANCE leg, or null if none yet. The rebalance
   * path had NO rate limit (it fired every ~15s poll while a leg was below the floor); this
   * gives it the same interval governor as the heartbeat. Optional for back-compat.
   */
  lastRebalanceMs?: number | null;
  /**
   * FINDING 3/4 - REBALANCE attempts in the current day, stamped on every attempt regardless
   * of success so a reverting rebalance can't retry unbounded. Optional (=> 0 => uncapped
   * unless rebalanceDailyMaxAttempts is set).
   */
  rebalanceAttemptsToday?: number;
}

/** Tunable arb parameters (from config). */
export interface ArbParams {
  /** Pool fee in bps (30 for the 0.3% tier) - half the no-trade band. */
  feeBps: number;
  /** Extra edge (bps) required beyond the fee before trading (e.g. 25). */
  thresholdBps: number;
  /** Fraction (0..1] of the price gap to close per trade - UNDER-shoot, never overshoot. */
  closeFraction: number;
  /** Hard CAP on a single trade's base-token notional (raw at baseDecimals). */
  maxTradeBase: bigint;
  /** Floor: a capped size below this is dust -> NONE (gas would dominate). */
  minTradeBase: bigint;
  /**
   * cirBTC RESERVE (raw base units) the arb will NEVER sell below - so its base leg can't zero out
   * and seize. Omitted/0 => no reserve (legacy behavior). When sitting at the reserve it idles +
   * alerts (no doomed trades) and restocks once the pool dips to/below ref. Optional for back-compat.
   */
  reserveBase?: bigint;
  /**
   * QUOTE/GAS RESERVE (raw quote units) the arb will NEVER spend below on a BUY_BASE - so it can't
   * burn the last of the balance it needs to PAY GAS (on Arc the ERC20 USDC quote is a facade over
   * the native gas balance, so spending quote IS spending gas). A BUY's funding cap is
   * (inventoryUsdc − reserveQuote); at the reserve a BUY collapses to idle/ALERT instead of bricking
   * the wallet. Omitted/0 => no reserve (legacy). Symmetric to reserveBase. Optional for back-compat.
   */
  reserveQuote?: bigint;
  /**
   * TARGET-BAND INVENTORY GATE (the mean-reversion cure). The target cirBTC share of total
   * inventory VALUE, in bps (5000 = a 50/50 book). When set (>0), a peg-correcting SELL_BASE fires
   * ONLY while cirBTC is HEAVY (share > target) and a BUY_BASE ONLY while cirBTC is LIGHT (share <
   * target); the off-target leg is DECLINED so the peg drifts (the deliberate, cirBTC-conserving
   * release valve) instead of ratcheting the finite battery to a floor. Inventory then oscillates
   * around the target - sells in a downtrend are matched by buy-backs on the bounce. Omitted/0 => the
   * gate is OFF (legacy one-directional-until-floor behavior). Independent of the reserveBase floor,
   * which remains the untouchable last resort BELOW this gate.
   */
  targetBaseShareBps?: number;
  /**
   * TWO-SIDED PEG DEFENSE (opt-in). When true, the target-band gate NO LONGER declines a peg-correcting
   * BUY_BASE while cirBTC is heavy - so the keeper actively defends the DOWNSIDE of the peg (buys base to
   * lift a pool that is below the oracle) up to its quote reserve, instead of letting the pool sit under
   * peg. This is the SAFE direction to relax: a BUY *refills* the finite, non-mintable cirBTC battery and
   * spends the (refillable) quote leg, which stays bounded by reserveQuote + the deliverability cap. The
   * SELL gate is deliberately UNCHANGED - selling drains the battery, so it stays conserved (sell only
   * while cirBTC-heavy). Omitted/false => legacy one-directional gate (BUY declined while cirBTC-heavy).
   */
  buyDefendsPeg?: boolean;
  /**
   * DELIVERABILITY SAFETY (bps). A leg is capped at this fraction of the pool's REAL token balance
   * (poolQuoteBal for a SELL, poolBaseBal for a BUY) so the realized fill clears its ref-priced
   * amountOutMinimum and never reverts "Too little received". e.g. 7000 => never ask the pool for
   * more than 70% of what it holds. Omitted/0 (or no poolQuoteBal/poolBaseBal supplied) => OFF.
   */
  poolDeliverableSafetyBps?: number;
  /** Reject (SKIP) a reference older than this many seconds - never arb on a stale ref. */
  maxRefAgeSec: number;
  /**
   * Base token decimals (cirBTC = 8). Threaded in so the USDC->base inventory conversion
   * and the V3 sizing math are decimals-generic instead of hardcoding the 8/6 pair.
   */
  baseDecimals: number;
  /** Quote token decimals (USDC = 6). */
  quoteDecimals: number;

  // ---- TASK 3a: inventory rebalancing (OPTIONAL - omit/0 => OFF, behavior unchanged) ---
  /**
   * Rebalance trigger floor in bps of total inventory VALUE. When a leg's value falls below
   * this fraction of the bot's total inventory value (so it can no longer arb in the
   * direction that spends that leg), a bounded rebalancing swap toward the target ratio is
   * allowed even with NO price divergence. Omitted/0 disables rebalancing (behavior
   * unchanged). e.g. 1500 => rebalance once a leg drops below 15% of total value.
   */
  rebalanceFloorBps?: number;
  /**
   * Target inventory split in bps of total value for the leg being topped up (e.g. 5000 =>
   * aim for a 50/50-by-value book). The rebalance trade is sized to move the depleted leg
   * UP toward this share - never past it (so a rebalance can't itself flip the imbalance).
   */
  rebalanceTargetBps?: number;
  /** Hard CAP on a single rebalancing swap's base notional (raw at baseDecimals). */
  rebalanceMaxBase?: bigint;
  /**
   * FINDING 3 - minimum spacing (ms) between REBALANCE legs (rate-limit, like the heartbeat).
   * Omitted/0 => no interval guard (legacy behavior: a rebalance could fire every poll). The
   * executor injects state.heartbeat.lastRebalanceMs so this stays PURE.
   */
  rebalanceIntervalMs?: number;
  /**
   * FINDING 4 - per-day cap on rebalance ATTEMPTS (not just settled notional). Omitted/0 =>
   * uncapped. Bounds retries of a reverting rebalance leg.
   */
  rebalanceDailyMaxAttempts?: number;

  // ---- TASK 3b: heartbeat volume (OPTIONAL - omit/false => OFF, behavior unchanged) ----
  /** Master switch for heartbeat-volume mode. Omitted/false => OFF (behavior unchanged). */
  heartbeatEnabled?: boolean;
  /** Minimum spacing (ms) between heartbeat legs - rate-limits baseline volume. */
  heartbeatIntervalMs?: number;
  /** Per-day budget cap on heartbeat base notional (raw at baseDecimals). */
  heartbeatDailyCapBase?: bigint;
  /** Base notional (raw at baseDecimals) per heartbeat leg - small + bounded. */
  heartbeatTradeBase?: bigint;
  /**
   * FINDING 4 - per-day cap on heartbeat ATTEMPTS (not just settled notional). A reverting
   * heartbeat leg never charges the notional cap, so this bounds its retries. Omitted/0 =>
   * uncapped (the notional cap is still enforced).
   */
  heartbeatDailyMaxAttempts?: number;
}

/**
 * Why a SWAP is being issued. 'arb' is the price-convergence trade (the original behavior);
 * 'rebalance' restocks a depleted leg toward the target inventory ratio (TASK 3a); 'heartbeat'
 * is budgeted baseline volume at zero divergence (TASK 3b). An 'arb' swap is pinned to the ref
 * tick (cannot push the pool past the oracle); 'rebalance'/'heartbeat' fire inside (or near) the
 * band, so they pin to a small bounded offset past the live pool price that is ALSO clamped to the
 * ref tick (pegBoundedOffsetLimit) - so they fill toward the peg but, like 'arb', can never push the
 * pool past the oracle. Their amountOutMinimum (priced at ref) bounds the average realized fill.
 */
export type ArbPurpose = 'arb' | 'rebalance' | 'heartbeat';

/** What the executor should do this tick. */
export type ArbDecision = {
  kind: 'SKIP' | 'NONE' | 'ALERT' | 'SWAP';
  /** Present only when kind==='SWAP'. */
  direction?: 'SELL_BASE' | 'BUY_BASE';
  /** Present only when kind==='SWAP': the base-token amount that bounds the swap (raw). */
  amountInBase?: bigint;
  /** Present only when kind==='SWAP'. Defaults conceptually to 'arb' for the convergence trade. */
  purpose?: ArbPurpose;
  reason: string;
};

/** abs() for bigint. */
function babs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

const ONE18 = 10n ** 18n;

/**
 * Scale a bigint by a JS float fraction deterministically, using 1e6 fixed-point so the
 * result is reproducible (no FP drift in the bigint domain). frac is clamped to [0, 1].
 * Signed-safe: the magnitude is scaled and the sign re-applied so undershoot works for a
 * negative gap (pool below ref) too.
 */
function scaleByFraction(value: bigint, frac: number): bigint {
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  // Round the fraction to 6 decimal places of fixed-point precision.
  const num = BigInt(Math.round(f * 1_000_000));
  return (value * num) / 1_000_000n;
}

/**
 * Decide the single next arb action for a market given its pool-vs-ref snapshot.
 * PURE - total over the state space, no I/O, no clock read, no input mutation.
 */
export function decideArb(state: ArbState, params: ArbParams): ArbDecision {
  // 1) Stale reference: NEVER arb toward an old oracle value - the pool may already be
  //    correct relative to the live market. Skip until a fresh ref arrives.
  if (state.refAgeSec > params.maxRefAgeSec) {
    return {
      kind: 'SKIP',
      reason: `stale ref: age ${state.refAgeSec}s > max ${params.maxRefAgeSec}s`,
    };
  }

  // 2) Inert pool: with zero in-range liquidity there is nothing to trade against, so
  //    we can never move the price back to the ref. Surface loudly for the operator.
  if (state.liquidity <= 0n) {
    return { kind: 'ALERT', reason: 'pool liquidity is zero - cannot arbitrage (inert pool)' };
  }

  // Guard against a non-positive reference (shouldn't happen for a live feed) - treat as
  // un-actionable rather than dividing by zero.
  if (state.ref18 <= 0n) {
    return { kind: 'ALERT', reason: 'reference price is non-positive - cannot compute divergence' };
  }
  if (state.poolPrice18 <= 0n) {
    return { kind: 'ALERT', reason: 'pool price is non-positive - cannot size a trade' };
  }

  // 3) Signed divergence in bps: (pool - ref) / ref. Positive => pool too high.
  const divBps = ((state.poolPrice18 - state.ref18) * 10_000n) / state.ref18;
  const absDivBps = babs(divBps);
  const bandBps = BigInt(params.feeBps + params.thresholdBps);

  // Inside the no-trade band (inclusive): the divergence doesn't clear the round-trip
  // fee + required edge, so a price-convergence arb would lose money. But the bot must not
  // go fully idle - TASK 3 turns a one-way battery into a two-sided MM: first try a bounded
  // inventory REBALANCE (restock a depleted leg so both directions stay tradable), then a
  // budgeted HEARTBEAT round-trip leg (baseline volume -> real fees at zero divergence).
  if (absDivBps <= bandBps) {
    return decideRebalanceOrHeartbeat(
      state,
      params,
      `inside no-trade band: |div| ${absDivBps}bps <= band ${bandBps}bps`,
    );
  }

  // 4) Direction: if the pool is ABOVE the ref, SELL base into the pool to push the
  //    price DOWN toward the ref; if BELOW, BUY base to push it UP.
  const direction: 'SELL_BASE' | 'BUY_BASE' = divBps > 0n ? 'SELL_BASE' : 'BUY_BASE';

  // 4b) TARGET-BAND INVENTORY GATE (the mean-reversion cure for the cirBTC drain). Only SELL cirBTC
  //     while cirBTC-HEAVY vs the target, only BUY while cirBTC-LIGHT - so the finite, non-mintable
  //     battery oscillates around the target instead of ratcheting one-way to a floor in a trend.
  //     The declined leg lets the peg DRIFT (the deliberate, conserving release valve); its buy-back
  //     counterpart fires on the bounce, so over a down->up cycle sells and buys cancel. Falls through
  //     to a (toward-target) rebalance/heartbeat - which the executability guard turns into idle when
  //     the wrong-direction restock can't fill, so a declined SELL simply lets the pool stay high.
  const targetShare = params.targetBaseShareBps ?? 0;
  if (targetShare > 0) {
    const shareBps = baseShareBps(state, params);
    if (direction === 'SELL_BASE' && shareBps <= BigInt(targetShare)) {
      return decideRebalanceOrHeartbeat(
        state,
        params,
        `SELL declined: cirBTC share ${shareBps}bps <= target ${targetShare}bps - conserving (peg drifts down)`,
      );
    }
    if (direction === 'BUY_BASE' && shareBps >= BigInt(targetShare) && !params.buyDefendsPeg) {
      // Legacy conserve-the-quote behavior: decline the BUY while cirBTC-heavy and let the peg drift
      // up. With buyDefendsPeg ON we DON'T decline - the keeper defends the downside (buys base up to
      // the ref, bounded by reserveQuote + the deliverable cap) so a pool can't sit under peg. The SELL
      // gate above is never relaxed (selling drains the finite battery), so the relaxation is one-sided.
      return decideRebalanceOrHeartbeat(
        state,
        params,
        `BUY declined: cirBTC share ${shareBps}bps >= target ${targetShare}bps - conserving USDC (peg drifts up)`,
      );
    }
  }

  // 5) Size from POOL LIQUIDITY (root-cause fix for HIGH-1 + HIGH-2).
  //    Target a price that UNDERSHOOTS the reference by closeFraction of the gap:
  //      target = pool + closeFraction * (ref - pool)
  //    so the pool ends up SHORT of the ref. Then compute, from the live in-range
  //    liquidity L and the V3 sqrt-price relationship, the BASE-token amount that moves
  //    the pool from poolPrice18 to that target. Because target is short of ref, the swap
  //    FULLY consumes amountIn before reaching the ref-pinned sqrtPriceLimit (no partial
  //    fill), so the executor's amountOutMinimum - computed from the expected fill - is
  //    valid and the swap doesn't revert on a partial-fill mismatch.
  const gap18 = state.ref18 - state.poolPrice18; // signed
  const targetPrice18 = state.poolPrice18 + scaleByFraction(gap18, params.closeFraction);

  // Defensive: if rounding collapsed the target back onto the pool price there is nothing
  // to move - treat as dust rather than computing a zero-width trade.
  let size = baseAmountToMovePrice(
    state.liquidity,
    state.poolPrice18,
    targetPrice18,
    params.baseDecimals,
    params.quoteDecimals,
    state.baseIsToken0,
  );

  // Cap by the per-trade max (maxTradeBase is now a CAP, never the size anchor).
  if (size > params.maxTradeBase) size = params.maxTradeBase;

  // Cap by the inventory available for this direction.
  //  - SELL_BASE spends base inventory directly (raw base units).
  //  - BUY_BASE spends USDC; convert the USDC budget into the base amount it can buy at
  //    the ref price, so the cap is expressed in the same base units as `size`.
  let inventoryCapBase: bigint;
  if (direction === 'SELL_BASE') {
    // Keep a cirBTC RESERVE: never sell the last of it, so the arb can't zero out + seize. At the
    // reserve the cap is 0 -> falls through to ALERT/idle (and the pool dipping to ref restocks it).
    const reserve = params.reserveBase ?? 0n;
    inventoryCapBase = state.inventoryBase > reserve ? state.inventoryBase - reserve : 0n;
  } else {
    // Keep a QUOTE/GAS reserve: never spend the last of the quote leg (= native gas on Arc) on a
    // BUY, so the wallet can always still pay for txs. At the reserve the cap is 0 -> idle/ALERT.
    const reserveQ = params.reserveQuote ?? 0n;
    const spendableUsdc = state.inventoryUsdc > reserveQ ? state.inventoryUsdc - reserveQ : 0n;
    inventoryCapBase = usdcBudgetToBase(
      spendableUsdc,
      state.ref18,
      params.baseDecimals,
      params.quoteDecimals,
    );
  }
  if (size > inventoryCapBase) size = inventoryCapBase;

  // 5b) DELIVERABILITY + FLOW caps. Cap by what the pool can physically pay (so the fill clears the
  //     ref-priced min-out - no "Too little received"; on a one-sided pool this drives `size` to ~0
  //     -> the dust floor idles the bot instead of firing a doomed swap), then a SELL by the rolling-
  //     window net-sold budget (a BUY is uncapped - recycling is always allowed).
  size = deliverableCap(size, direction, state, params);
  size = flowCap(size, direction, state);

  // 6) Dust floor: a capped size below the minimum trade isn't worth the gas. This is the
  //    "battery death" path: in a trend the arb keeps spending one leg until its inventory
  //    cap drives `size` under minTradeBase and the bot would otherwise return NONE forever.
  //    Instead fall through to a bounded rebalance (restock the depleted leg) / heartbeat.
  if (size < params.minTradeBase) {
    const fallback = decideRebalanceOrHeartbeat(
      state,
      params,
      `trade size ${size} below minTradeBase ${params.minTradeBase} (div ${divBps}bps, ${direction})`,
    );
    // DEPLETION DETECTION. We're PAST the no-trade band (this is the convergence path), so the bot
    // genuinely WANTS to trade. If neither rebalance nor heartbeat can act AND the funding leg can't
    // even cover a minimum trade, the bot is OUT of the inventory it needs to correct this
    // divergence - surface LOUDLY (ALERT) so an operator refills, instead of silently idling while
    // the pool runs away (the exact failure that let the pool drift to +221%). Preserves the
    // rebalance/heartbeat fallthrough whenever it CAN act.
    if (fallback.kind === 'NONE' && inventoryCapBase < params.minTradeBase) {
      const leg = direction === 'SELL_BASE' ? 'base (cirBTC)' : 'quote (USDC)';
      return {
        kind: 'ALERT',
        reason: `depleted: out of ${leg} inventory - cannot correct ${divBps}bps divergence (${direction}); refill the arb wallet`,
      };
    }
    return fallback;
  }

  return {
    kind: 'SWAP',
    direction,
    amountInBase: size,
    purpose: 'arb',
    reason: `arb ${direction}: div ${divBps}bps, size ${size} base (close ${params.closeFraction}, L ${state.liquidity})`,
  };
}

/**
 * Convert a USDC budget (raw at quoteDecimals) into the BASE-token amount it can buy at
 * ref18, in the SAME raw base-decimals scale as maxTradeBase. Decimals-GENERIC (no baked
 * 1e20): ref18 is USDC-per-base in 18dp, so
 *
 *   wholeBase = (usdcRaw / 10^quoteDec) / (ref18 / 1e18)
 *   baseRaw   = wholeBase * 10^baseDec
 *             = usdcRaw * 1e18 * 10^baseDec / (ref18 * 10^quoteDec)
 *
 * For cirBTC(8dp)/USDC(6dp) this reduces to usdcRaw * 1e20 / ref18 (the old hardcoded
 * value) - proven by the decimals-parameterised test - but it is now correct for any pair.
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
 * Value (in USDC raw, at quoteDecimals) of a BASE-token amount at the ref price. Inverse of
 * usdcBudgetToBase. Decimals-generic:
 *   usdcRaw = baseRaw / 10^baseDec * (ref18 / 1e18) * 10^quoteDec
 *           = baseRaw * ref18 * 10^quoteDec / (10^baseDec * 1e18)
 */
function baseToUsdcValue(
  baseRaw: bigint,
  ref18: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (ref18 <= 0n) return 0n;
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);
  return (baseRaw * ref18 * quoteScale) / (baseScale * ONE18);
}

/** cirBTC share of total inventory VALUE in bps (baseValue / total). 0 when there's no inventory. */
function baseShareBps(state: ArbState, params: ArbParams): bigint {
  const baseVal = baseToUsdcValue(state.inventoryBase, state.ref18, params.baseDecimals, params.quoteDecimals);
  const total = baseVal + state.inventoryUsdc;
  if (total <= 0n) return 0n;
  return (baseVal * 10_000n) / total;
}

/**
 * Cap a base-size leg by what the pool can PHYSICALLY deliver for that direction so the fill clears
 * its ref-priced amountOutMinimum (no "Too little received"): a SELL by the base-equivalent of a
 * safety fraction of the pool's USDC, a BUY by a safety fraction of the pool's cirBTC. No-op when the
 * safety bps or the relevant pool balance is absent (legacy OFF). PURE.
 */
function deliverableCap(
  size: bigint,
  direction: 'SELL_BASE' | 'BUY_BASE',
  state: ArbState,
  params: ArbParams,
): bigint {
  const safety = params.poolDeliverableSafetyBps ?? 0;
  if (safety <= 0) return size;
  if (direction === 'SELL_BASE' && state.poolQuoteBal !== undefined) {
    const cap = maxBaseSellForUsdcOut(
      poolDeliverableQuote(state.poolQuoteBal, safety),
      state.ref18,
      params.baseDecimals,
      params.quoteDecimals,
    );
    return size < cap ? size : cap;
  }
  if (direction === 'BUY_BASE' && state.poolBaseBal !== undefined) {
    const cap = poolDeliverableBase(state.poolBaseBal, safety);
    return size < cap ? size : cap;
  }
  return size;
}

/**
 * Cap a SELL by the remaining net-cirBTC-sold budget for the rolling window (clamped to [0, max]).
 * A BUY is never flow-capped - recycling cirBTC back is always allowed and credits the budget. No-op
 * when no flow snapshot is injected (legacy OFF). PURE.
 */
function flowCap(size: bigint, direction: 'SELL_BASE' | 'BUY_BASE', state: ArbState): bigint {
  if (direction !== 'SELL_BASE' || state.flow === undefined) return size;
  const { netSoldBase, maxNetSoldPerWindowBase } = state.flow;
  let remaining = maxNetSoldPerWindowBase - netSoldBase;
  if (remaining < 0n) remaining = 0n;
  if (remaining > maxNetSoldPerWindowBase) remaining = maxNetSoldPerWindowBase;
  return size < remaining ? size : remaining;
}

/**
 * TASK 3a/3b - the in-band fallback. Reached when no price-convergence arb is actionable
 * (inside the no-trade band OR the arb size collapsed under the dust floor because a leg is
 * depleted). It keeps the bot a TWO-SIDED MM instead of a one-way battery:
 *   1) REBALANCE: if a leg's value has fallen below rebalanceFloorBps of total inventory
 *      value, emit a bounded swap that restocks it toward rebalanceTargetBps (so both
 *      directions stay tradable). Sized to move the depleted leg UP toward - never past -
 *      the target, capped by rebalanceMaxBase + the funding leg's own inventory, and only
 *      if it clears minTradeBase. The executor clamps its sqrtPriceLimit to the ref tick
 *      (pegBoundedOffsetLimit) so the restock fills toward the peg but never overshoots past it.
 *   2) HEARTBEAT: else, if heartbeat mode is on and the interval + daily budget allow, emit
 *      one small heartbeat leg (baseline volume -> real fees even at zero divergence). The
 *      direction gently favors selling the HEAVIER leg so heartbeat doubles as soft
 *      rebalancing; size is the fixed heartbeatTradeBase, clamped by the daily cap remainder
 *      and the funding leg's inventory.
 *   3) Otherwise NONE (carrying the caller's reason).
 *
 * PURE - uses only injected inputs (incl. state.heartbeat.nowMs); no clock, no I/O.
 */
function decideRebalanceOrHeartbeat(
  state: ArbState,
  params: ArbParams,
  noneReason: string,
): ArbDecision {
  const reb = decideRebalance(state, params);
  if (reb !== null) return reb;

  const hb = decideHeartbeat(state, params);
  if (hb !== null) return hb;

  return { kind: 'NONE', reason: noneReason };
}

/**
 * TASK 3a - bounded inventory rebalance. Returns a SWAP that restocks the depleted leg, or
 * null when rebalancing is disabled / not needed / not fundable / would be dust.
 *
 * Value-by-leg in USDC terms (so the 8dp base vs 6dp quote scales are comparable):
 *   baseValue = value(inventoryBase) ; usdcValue = inventoryUsdc ; total = baseValue + usdcValue.
 * A leg is "depleted" when its share < rebalanceFloorBps. We then BUY the depleted leg by
 * selling the heavy one, sized so the depleted leg's share rises toward rebalanceTargetBps
 * (half the value gap is moved - the standard 2-sided rebalance step that lands ON target
 * for a 50/50 goal without overshooting), then clamped by rebalanceMaxBase, the funding
 * leg's inventory, and the minTradeBase dust floor.
 */
function decideRebalance(state: ArbState, params: ArbParams): ArbDecision | null {
  const floorBps = params.rebalanceFloorBps ?? 0;
  if (floorBps <= 0) return null; // disabled (omitted/0)
  if (state.ref18 <= 0n) return null;

  // FINDING 3/4 - rate-limit + daily-attempt governors (mirror the heartbeat). These read
  // ONLY the injected snapshot (state.heartbeat) so the decision stays PURE; the executor
  // owns the ledger and stamps lastRebalanceMs + rebalanceAttemptsToday on EVERY attempt
  // (regardless of success) so a reverting rebalance can't retry every poll forever.
  const hb = state.heartbeat;
  const intervalMs = params.rebalanceIntervalMs ?? 0;
  if (intervalMs > 0 && hb !== undefined) {
    const last = hb.lastRebalanceMs ?? null;
    if (last !== null && hb.nowMs - last < intervalMs) return null; // too soon since last leg
  }
  const maxAttempts = params.rebalanceDailyMaxAttempts ?? 0;
  if (maxAttempts > 0 && hb !== undefined) {
    if ((hb.rebalanceAttemptsToday ?? 0) >= maxAttempts) return null; // day's attempts exhausted
  }

  // Target defaults to 5000 (50/50 by value); the rebalance max defaults to the arb cap.
  const targetBps = params.rebalanceTargetBps ?? 5_000;
  const rebalanceMaxBase = params.rebalanceMaxBase ?? params.maxTradeBase;

  const baseValue = baseToUsdcValue(
    state.inventoryBase,
    state.ref18,
    params.baseDecimals,
    params.quoteDecimals,
  );
  const usdcValue = state.inventoryUsdc;
  const total = baseValue + usdcValue;
  if (total <= 0n) return null; // nothing to rebalance

  const floor = BigInt(floorBps);
  const target = BigInt(targetBps);
  const baseShareBps = (baseValue * 10_000n) / total;
  const usdcShareBps = (usdcValue * 10_000n) / total;

  let direction: 'SELL_BASE' | 'BUY_BASE';
  let depletedValue: bigint; // current USDC-value of the depleted leg
  if (baseShareBps < floor) {
    // Base leg is starved -> BUY base (spend the heavy USDC leg).
    direction = 'BUY_BASE';
    depletedValue = baseValue;
  } else if (usdcShareBps < floor) {
    // USDC leg is starved -> SELL base (replenish USDC).
    direction = 'SELL_BASE';
    depletedValue = usdcValue;
  } else {
    return null; // both legs above the floor - balanced enough, no rebalance
  }

  // EXECUTABILITY GUARD (kills the revert/backoff loop). A rebalance's amountOutMinimum is priced
  // at the REF, so a BUY into a pool trading ABOVE ref (or a SELL into one BELOW ref) by more than
  // the no-trade band fills worse than the ref haircut and REVERTS - then the executor's
  // consecutive-failure backoff piles up (the exact symptom seen when the arb was out of cirBTC
  // above ref). Outside the band on the wrong side is ARB territory anyway; skip the doomed
  // rebalance (the depleted leg restocks once the pool comes back inside the band). Inside the band
  // (pool ~= ref) the trade fills within the haircut, so we let it through.
  if (state.ref18 > 0n) {
    const band = BigInt(params.feeBps + params.thresholdBps);
    const divBps = ((state.poolPrice18 - state.ref18) * 10_000n) / state.ref18;
    if (direction === 'BUY_BASE' && divBps > band) return null;
    if (direction === 'SELL_BASE' && divBps < -band) return null;
  }

  // Move HALF the value gap to target so a 50/50 goal lands ON target without overshoot.
  const targetValue = (total * target) / 10_000n;
  const valueGap = targetValue - depletedValue; // > 0 (depleted is below target)
  if (valueGap <= 0n) return null;
  const moveValue = valueGap / 2n; // USDC-value to shift this step
  if (moveValue <= 0n) return null;

  // Express the move as a BASE notional (raw) - the unit decideArb sizes/caps everything in.
  let size = usdcBudgetToBase(moveValue, state.ref18, params.baseDecimals, params.quoteDecimals);

  // Cap by the rebalance per-trade max.
  if (size > rebalanceMaxBase) size = rebalanceMaxBase;

  // Cap by the FUNDING leg's SPENDABLE inventory (the heavy leg we spend), net of the reserves:
  //  - BUY_BASE spends USDC (= native gas on Arc): keep reserveQuote so it can't burn the gas it needs.
  //  - SELL_BASE spends base: keep reserveBase so a restock can't sell the protected cirBTC leg.
  const rebReserveQ = params.reserveQuote ?? 0n;
  const rebReserveB = params.reserveBase ?? 0n;
  const rebSpendableUsdc = state.inventoryUsdc > rebReserveQ ? state.inventoryUsdc - rebReserveQ : 0n;
  const rebSpendableBase = state.inventoryBase > rebReserveB ? state.inventoryBase - rebReserveB : 0n;
  const fundingCapBase =
    direction === 'BUY_BASE'
      ? usdcBudgetToBase(rebSpendableUsdc, state.ref18, params.baseDecimals, params.quoteDecimals)
      : rebSpendableBase;
  if (size > fundingCapBase) size = fundingCapBase;

  // Cap by what the pool can physically deliver + the flow budget (same as the convergence path), so
  // a restock can never revert on a thin/one-sided pool and a restock-SELL still counts against the
  // window's net-sold budget.
  size = deliverableCap(size, direction, state, params);
  size = flowCap(size, direction, state);

  // Dust floor - a sub-minTradeBase rebalance isn't worth the gas.
  if (size < params.minTradeBase) return null;

  return {
    kind: 'SWAP',
    direction,
    amountInBase: size,
    purpose: 'rebalance',
    reason: `rebalance ${direction}: base ${baseShareBps}bps / usdc ${usdcShareBps}bps of value (floor ${floorBps}, target ${targetBps}), size ${size} base`,
  };
}

/**
 * TASK 3b - budgeted, rate-limited heartbeat leg. Returns a small SWAP when heartbeat mode
 * is enabled AND the interval has elapsed AND the daily cap has headroom AND the funding leg
 * can cover it; otherwise null (so the caller falls through to NONE). The direction sells
 * whichever leg is HEAVIER (by value) so the heartbeat also nudges inventory toward balance.
 *
 * Bounded by construction: at most one heartbeatTradeBase leg per heartbeatIntervalMs, and
 * the cumulative day spend (tracked by the executor + injected as spentTodayBase) can never
 * exceed heartbeatDailyCapBase - the size is clamped to the cap remainder, so it can't burn
 * the budget.
 */
function decideHeartbeat(state: ArbState, params: ArbParams): ArbDecision | null {
  if (params.heartbeatEnabled !== true) return null; // omitted/false => OFF
  const hb = state.heartbeat;
  if (hb === undefined) return null; // executor didn't inject the ledger => OFF
  if (state.ref18 <= 0n) return null;
  const tradeBase = params.heartbeatTradeBase ?? 0n;
  const dailyCap = params.heartbeatDailyCapBase ?? 0n;
  const intervalMs = params.heartbeatIntervalMs ?? 0;
  if (tradeBase <= 0n || dailyCap <= 0n) return null;

  // Rate limit: respect the configured spacing between legs.
  if (hb.lastHeartbeatMs !== null && hb.nowMs - hb.lastHeartbeatMs < intervalMs) {
    return null;
  }

  // FINDING 4 - per-day ATTEMPT cap (not just settled notional). A reverting heartbeat leg
  // never charges spentTodayBase, so the notional cap alone can't bound retries; this does.
  // Omitted/0 => uncapped (the notional cap still applies).
  const maxAttempts = params.heartbeatDailyMaxAttempts ?? 0;
  if (maxAttempts > 0 && (hb.heartbeatAttemptsToday ?? 0) >= maxAttempts) return null;

  // Daily cap: clamp this leg to the remaining budget; skip when exhausted.
  const remaining = dailyCap - hb.spentTodayBase;
  if (remaining <= 0n) return null;
  let size = tradeBase;
  if (size > remaining) size = remaining;

  // Direction: sell the heavier leg (soft rebalance). Tie/empty -> default SELL_BASE.
  const baseValue = baseToUsdcValue(
    state.inventoryBase,
    state.ref18,
    params.baseDecimals,
    params.quoteDecimals,
  );
  const direction: 'SELL_BASE' | 'BUY_BASE' = baseValue >= state.inventoryUsdc ? 'SELL_BASE' : 'BUY_BASE';

  // Fund the leg from the spending side's SPENDABLE inventory, net of the reserves (a heartbeat
  // must never spend the gas reserve or the protected cirBTC reserve either).
  const hbReserveQ = params.reserveQuote ?? 0n;
  const hbReserveB = params.reserveBase ?? 0n;
  const hbSpendableUsdc = state.inventoryUsdc > hbReserveQ ? state.inventoryUsdc - hbReserveQ : 0n;
  const hbSpendableBase = state.inventoryBase > hbReserveB ? state.inventoryBase - hbReserveB : 0n;
  const fundingCapBase =
    direction === 'BUY_BASE'
      ? usdcBudgetToBase(hbSpendableUsdc, state.ref18, params.baseDecimals, params.quoteDecimals)
      : hbSpendableBase;
  if (size > fundingCapBase) size = fundingCapBase;

  // Pool-deliverability + flow caps (a heartbeat must also never revert on a thin pool nor blow the
  // sell budget). On a one-sided pool this idles the heartbeat instead of firing a doomed swap.
  size = deliverableCap(size, direction, state, params);
  size = flowCap(size, direction, state);

  // Even a heartbeat must clear the dust floor (gas) and stay positive after clamping.
  if (size <= 0n || size < params.minTradeBase) return null;

  return {
    kind: 'SWAP',
    direction,
    amountInBase: size,
    purpose: 'heartbeat',
    reason: `heartbeat ${direction}: size ${size} base (spentToday ${hb.spentTodayBase}/${dailyCap}, interval ${intervalMs}ms)`,
  };
}
