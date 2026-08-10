import { describe, it, expect } from 'vitest';
import {
  decideArb,
  type ArbState,
  type ArbParams,
  type HeartbeatState,
} from '../src/decideArb.js';

// ---------------------------------------------------------------------------
// TASK 3 — decideArb as a TWO-SIDED rebalancing MM + budgeted heartbeat volume.
//
// These tests cover the PURE decision additions on top of the existing arb path:
//   (a) REBALANCE — a depleted leg (below the value floor) triggers a bounded swap toward
//       the target ratio; a balanced book does NOT (it falls through to normal arb / NONE).
//   (b) HEARTBEAT — a budgeted, rate-limited round-trip leg respects the interval + daily
//       cap and skips when exhausted; clearly bounded so it can't burn the budget.
//   (c) NEVER-STAKES — decideArb only ever emits SWAP/NONE/SKIP/ALERT; it has no concept of
//       staking the arena (the executor enforces it structurally), proven here at the
//       decision level: no decision kind/field can target the arena.
//
// Market: cirBTC(8dp)/USDC(6dp), token0=USDC, token1=cirBTC => baseIsToken0=false.
// ref18 = 100e18 ("$100" per base). Band = feeBps(30)+thresholdBps(25) = 55 bps.
// ---------------------------------------------------------------------------
const ONE = 10n ** 18n;
const REF = 100n * ONE; // 100e18 USDC-per-base
const DEEP_L = 10n ** 14n;

// Inventory helpers in WHOLE-token terms, converted to raw units.
const baseRaw = (whole: number): bigint => BigInt(Math.round(whole * 1e8)); // 8dp
const usdcRaw = (whole: number): bigint => BigInt(Math.round(whole * 1e6)); // 6dp

const baseState: ArbState = {
  poolPrice18: REF, // pool == ref => inside the band (no arb)
  ref18: REF,
  refAgeSec: 5,
  liquidity: DEEP_L,
  baseIsToken0: false,
  inventoryBase: baseRaw(50), // 50 base @ $100 = $5000
  inventoryUsdc: usdcRaw(5000), // $5000 — perfectly balanced 50/50 by value
};

// Rebalancing + heartbeat default to OFF unless the params below turn them on.
const baseParams: ArbParams = {
  feeBps: 30,
  thresholdBps: 25,
  closeFraction: 0.6,
  maxTradeBase: baseRaw(1000), // generous cap so rebalance sizing isn't clamped by it
  minTradeBase: baseRaw(0.01),
  maxRefAgeSec: 60,
  baseDecimals: 8,
  quoteDecimals: 6,
};

const st = (over: Partial<ArbState>): ArbState => ({ ...baseState, ...over });
const pr = (over: Partial<ArbParams>): ArbParams => ({ ...baseParams, ...over });
const poolAtBps = (bps: number): bigint => REF + (REF * BigInt(bps)) / 10_000n;

// ---------------------------------------------------------------------------
// (a) REBALANCING
// ---------------------------------------------------------------------------
describe('decideArb — TASK 3a inventory rebalancing', () => {
  const rebParams = pr({ rebalanceFloorBps: 1500, rebalanceTargetBps: 5000 });

  it('does NOTHING extra when rebalancing is OFF (no rebalance params) — balanced book -> NONE', () => {
    const d = decideArb(st({}), baseParams);
    expect(d.kind).toBe('NONE');
    expect(d.purpose).toBeUndefined();
  });

  it('a BALANCED book (50/50 by value) does NOT rebalance even when enabled -> NONE', () => {
    const d = decideArb(st({}), rebParams);
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/band/i);
  });

  it('a DEPLETED base leg triggers a BUY_BASE rebalance (restock base by spending USDC)', () => {
    // Base almost gone: 1 base ($100) vs $9900 USDC -> base ~1% of value, below the 15% floor.
    const d = decideArb(
      st({ inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900) }),
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
    expect(d.direction).toBe('BUY_BASE');
    expect(d.amountInBase!).toBeGreaterThan(0n);
  });

  it('a DEPLETED USDC leg triggers a SELL_BASE rebalance (replenish USDC by selling base)', () => {
    // USDC almost gone: $100 USDC vs 99 base ($9900) -> USDC ~1% of value, below floor.
    const d = decideArb(
      st({ inventoryBase: baseRaw(99), inventoryUsdc: usdcRaw(100) }),
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
    expect(d.direction).toBe('SELL_BASE');
  });

  it('rebalance moves toward — but NOT past — the target (bounded half-gap step)', () => {
    // Base depleted to ~1% of a $10,000 book. Target 50% => $5000 of base value.
    // Half-gap step moves ~ ($5000 - $100)/2 = $2450 of value => 24.5 base @ $100.
    const d = decideArb(
      st({ inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900) }),
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
    // ~24.5 base = 24.5e8 raw. Assert it sits in a sane band (well under a full 49-base flip).
    expect(d.amountInBase!).toBeGreaterThan(baseRaw(20));
    expect(d.amountInBase!).toBeLessThan(baseRaw(30));
  });

  it('rebalance is CAPPED by rebalanceMaxBase', () => {
    const capped = pr({ rebalanceFloorBps: 1500, rebalanceTargetBps: 5000, rebalanceMaxBase: baseRaw(5) });
    const d = decideArb(
      st({ inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900) }),
      capped,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.amountInBase).toBe(baseRaw(5)); // clamped at the rebalance cap
  });

  it('rebalance never spends more than the FUNDING leg holds (BUY bounded by USDC inventory)', () => {
    // Base depleted to ~3% of value; the BUY_BASE rebalance can never buy more base than the
    // USDC inventory could fund at ref. Funding leg = $9900 USDC -> at most 99 base.
    const d = decideArb(
      st({ inventoryBase: baseRaw(3), inventoryUsdc: usdcRaw(9700) }),
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
    // 99 base = the absolute funding ceiling; the half-gap step is far below it.
    expect(d.amountInBase!).toBeLessThanOrEqual(baseRaw(97)); // <= USDC-funded base ceiling
    expect(d.amountInBase!).toBeGreaterThan(0n);
  });

  it('a sub-dust rebalance is skipped -> NONE (not worth the gas)', () => {
    // Funding leg so thin the half-gap move is below minTradeBase (0.01 base).
    const d = decideArb(
      st({ inventoryBase: baseRaw(0.0001), inventoryUsdc: usdcRaw(0.5) }),
      rebParams,
    );
    expect(d.kind).toBe('NONE');
  });

  it('does NOT revert-loop the battery-death case: arb out of base while pool is ABOVE the band -> ALERT, not a doomed BUY rebalance', () => {
    // Pool 300bps HIGH (arb wants SELL_BASE) but base inventory is gone, so the arb size collapses
    // under the dust floor and the depleted-leg rebalance would BUY base. Buying INTO a pool 300bps
    // above ref fills worse than the ref-priced amountOutMinimum and REVERTS -> the executor piles
    // up consecutive-failure backoff (the real "arb keeps running out of cirBTC" loop). The guard
    // skips the doomed buy and surfaces ALERT so an operator refills; the leg restocks once the pool
    // comes back inside the band.
    const d = decideArb(
      st({ poolPrice18: poolAtBps(300), inventoryBase: 0n, inventoryUsdc: usdcRaw(10000) }),
      rebParams,
    );
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/deplet/i);
  });

  it('still restocks a depleted base leg via BUY rebalance when the pool is IN-BAND (executable)', () => {
    // Same depletion but pool == ref: the BUY fills within the ref haircut, so the rescue DOES fire.
    const d = decideArb(
      st({ poolPrice18: REF, inventoryBase: 0n, inventoryUsdc: usdcRaw(10000) }),
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
    expect(d.direction).toBe('BUY_BASE');
  });

  it('does NOT revert-loop the mirror case: arb out of USDC while pool is BELOW the band -> ALERT, not a doomed SELL rebalance', () => {
    // Pool 300bps LOW (arb wants BUY_BASE) but USDC is gone, so the rebalance would SELL base to
    // restock USDC. Selling INTO a pool 300bps below ref fills worse than the ref-priced minimum and
    // reverts. The guard skips it -> ALERT.
    const d = decideArb(
      st({ poolPrice18: poolAtBps(-300), inventoryBase: baseRaw(100), inventoryUsdc: 0n }),
      rebParams,
    );
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/deplet/i);
  });

  it('a normal price-divergence arb still WINS over rebalancing when actionable', () => {
    // Pool 300bps high, base fully stocked -> a normal arb SELL_BASE, NOT a rebalance.
    const d = decideArb(
      st({ poolPrice18: poolAtBps(300) }),
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('arb');
    expect(d.direction).toBe('SELL_BASE');
  });

  it('is pure — does not mutate its inputs', () => {
    const state = st({ inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900) });
    const params = rebParams;
    const sCopy = { ...state };
    const pCopy = { ...params };
    decideArb(state, params);
    expect(state).toEqual(sCopy);
    expect(params).toEqual(pCopy);
  });
});

// ---------------------------------------------------------------------------
// (a2) cirBTC RESERVE FLOOR — the arb never sells its last base, so it can't zero out.
// ---------------------------------------------------------------------------
describe('decideArb — cirBTC reserve floor', () => {
  it('never sells more base than (inventory − reserve)', () => {
    // Pool 300bps high -> arb wants a (potentially large) SELL, but only 1 base is spendable
    // above the 9-base reserve, so the trade is capped at 1 base and the reserve is untouched.
    const d = decideArb(
      st({ poolPrice18: poolAtBps(300), inventoryBase: baseRaw(10), inventoryUsdc: usdcRaw(0) }),
      pr({ reserveBase: baseRaw(9) }),
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
    expect(d.amountInBase!).toBeGreaterThan(0n);
    expect(d.amountInBase!).toBeLessThanOrEqual(baseRaw(1)); // 10 − 9 reserve
  });

  it('at the reserve, a wanted SELL idles -> ALERT (never dumps the reserve)', () => {
    // inventory == reserve -> spendable base is 0 -> the convergence trade collapses to ALERT
    // instead of selling the protected reserve.
    const d = decideArb(
      st({ poolPrice18: poolAtBps(300), inventoryBase: baseRaw(10), inventoryUsdc: usdcRaw(0) }),
      pr({ reserveBase: baseRaw(10) }),
    );
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/deplet/i);
  });

  it('reserve omitted (legacy) => may spend the full base inventory as before', () => {
    const d = decideArb(
      st({ poolPrice18: poolAtBps(300), inventoryBase: baseRaw(0.5), inventoryUsdc: usdcRaw(0) }),
      baseParams, // no reserveBase
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
    expect(d.amountInBase!).toBeGreaterThan(0n);
    expect(d.amountInBase!).toBeLessThanOrEqual(baseRaw(0.5));
  });

  it('QUOTE/GAS reserve caps a BUY: never spends quote below reserveQuote (protects gas)', () => {
    // Pool 300bps LOW -> arb wants to BUY base with USDC, but only $10 is spendable above the
    // $9990 reserve, so the trade is capped to ~$10-worth of base and the gas reserve is untouched.
    const d = decideArb(
      st({ poolPrice18: poolAtBps(-300), inventoryBase: baseRaw(0), inventoryUsdc: usdcRaw(10000) }),
      pr({ reserveQuote: usdcRaw(9990) }),
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
    expect(d.amountInBase!).toBeGreaterThan(0n);
    // $10 spendable at the $100 ref -> at most 0.1 base; the gas reserve ($9990) is never spent.
    expect(d.amountInBase!).toBeLessThanOrEqual(baseRaw(0.1));
  });

  it('at the QUOTE reserve, a wanted BUY idles -> ALERT (never spends the gas reserve)', () => {
    const d = decideArb(
      st({ poolPrice18: poolAtBps(-300), inventoryBase: baseRaw(0), inventoryUsdc: usdcRaw(10000) }),
      pr({ reserveQuote: usdcRaw(10000) }),
    );
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/deplet/i);
  });
});

// ---------------------------------------------------------------------------
// (b) HEARTBEAT VOLUME
// ---------------------------------------------------------------------------
describe('decideArb — TASK 3b heartbeat volume', () => {
  const NOW = 1_000_000_000_000; // fixed injected wall-clock (ms)
  const hbParams = pr({
    heartbeatEnabled: true,
    heartbeatIntervalMs: 60_000, // 1 leg / minute
    heartbeatDailyCapBase: baseRaw(1), // 1 base/day budget
    heartbeatTradeBase: baseRaw(0.1), // 0.1 base/leg
  });
  const hbLedger = (over: Partial<HeartbeatState>): HeartbeatState => ({
    nowMs: NOW,
    lastHeartbeatMs: null,
    spentTodayBase: 0n,
    ...over,
  });

  it('emits a heartbeat leg when enabled, interval elapsed, budget available (zero divergence)', () => {
    const d = decideArb(st({ heartbeat: hbLedger({}) }), hbParams);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
    expect(d.amountInBase).toBe(baseRaw(0.1));
  });

  it('does NOT emit a heartbeat when the mode is OFF (default params) -> NONE', () => {
    const d = decideArb(st({ heartbeat: hbLedger({}) }), baseParams);
    expect(d.kind).toBe('NONE');
  });

  it('does NOT emit a heartbeat when the executor injected no ledger -> NONE', () => {
    const d = decideArb(st({ heartbeat: undefined }), hbParams);
    expect(d.kind).toBe('NONE');
  });

  it('RESPECTS the interval: too soon since the last leg -> NONE', () => {
    const d = decideArb(
      st({ heartbeat: hbLedger({ lastHeartbeatMs: NOW - 30_000 }) }), // 30s < 60s interval
      hbParams,
    );
    expect(d.kind).toBe('NONE');
  });

  it('fires once the interval has elapsed exactly', () => {
    const d = decideArb(
      st({ heartbeat: hbLedger({ lastHeartbeatMs: NOW - 60_000 }) }), // exactly the interval
      hbParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
  });

  it('SKIPS when the daily budget is exhausted -> NONE', () => {
    const d = decideArb(
      st({ heartbeat: hbLedger({ spentTodayBase: baseRaw(1) }) }), // spent == cap
      hbParams,
    );
    expect(d.kind).toBe('NONE');
  });

  it('CLAMPS the final leg to the remaining budget (cannot exceed the daily cap)', () => {
    // 0.95 base already spent, 0.1 wanted -> only 0.05 remains. Leg clamps to 0.05.
    const d = decideArb(
      st({ heartbeat: hbLedger({ spentTodayBase: baseRaw(0.95) }) }),
      hbParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
    expect(d.amountInBase).toBe(baseRaw(0.05));
  });

  it('sells the HEAVIER leg (soft rebalance) — heavy base -> SELL_BASE', () => {
    const d = decideArb(
      st({ heartbeat: hbLedger({}), inventoryBase: baseRaw(100), inventoryUsdc: usdcRaw(1000) }),
      hbParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
    expect(d.direction).toBe('SELL_BASE');
  });

  it('sells the HEAVIER leg — heavy USDC -> BUY_BASE', () => {
    const d = decideArb(
      st({ heartbeat: hbLedger({}), inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(100_000) }),
      hbParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
    expect(d.direction).toBe('BUY_BASE');
  });

  it('a price-divergence arb takes priority over the heartbeat', () => {
    const d = decideArb(
      st({ poolPrice18: poolAtBps(300), heartbeat: hbLedger({}) }),
      hbParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('arb');
  });

  it('REBALANCE takes priority over the heartbeat when a leg is depleted', () => {
    const both = pr({
      rebalanceFloorBps: 1500,
      rebalanceTargetBps: 5000,
      heartbeatEnabled: true,
      heartbeatIntervalMs: 60_000,
      heartbeatDailyCapBase: baseRaw(1),
      heartbeatTradeBase: baseRaw(0.1),
    });
    const d = decideArb(
      st({ inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900), heartbeat: hbLedger({}) }),
      both,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });

  it('is pure + deterministic (same injected ledger -> same decision)', () => {
    const state = st({ heartbeat: hbLedger({}) });
    const d1 = decideArb(state, hbParams);
    const d2 = decideArb(state, hbParams);
    expect(d1).toEqual(d2);
  });
});

// ---------------------------------------------------------------------------
// (c) HARD INVARIANT — decideArb NEVER stakes the arena.
// ---------------------------------------------------------------------------
describe('decideArb — TASK 3c never stakes the arena (decision level)', () => {
  const everything = pr({
    rebalanceFloorBps: 1500,
    rebalanceTargetBps: 5000,
    heartbeatEnabled: true,
    heartbeatIntervalMs: 60_000,
    heartbeatDailyCapBase: baseRaw(1),
    heartbeatTradeBase: baseRaw(0.1),
  });

  it('every reachable decision is one of SKIP/NONE/ALERT/SWAP — no stake concept exists', () => {
    const NOW = 1_000_000_000_000;
    const ledger: HeartbeatState = { nowMs: NOW, lastHeartbeatMs: null, spentTodayBase: 0n };
    const scenarios: ArbState[] = [
      st({ poolPrice18: poolAtBps(300), heartbeat: ledger }), // arb
      st({ inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900), heartbeat: ledger }), // rebalance
      st({ heartbeat: ledger }), // heartbeat
      st({ refAgeSec: 999 }), // SKIP
      st({ liquidity: 0n, poolPrice18: poolAtBps(300) }), // ALERT
    ];
    for (const s of scenarios) {
      const d = decideArb(s, everything);
      expect(['SKIP', 'NONE', 'ALERT', 'SWAP']).toContain(d.kind);
      // A SWAP only ever carries a direction + a base amount + an arb/rebalance/heartbeat
      // purpose — never any arena/stake target. (The executor routes ALL of them at the
      // SwapRouter, never the arena.)
      if (d.kind === 'SWAP') {
        expect(['SELL_BASE', 'BUY_BASE']).toContain(d.direction);
        expect(['arb', 'rebalance', 'heartbeat']).toContain(d.purpose);
      }
    }
  });
});
