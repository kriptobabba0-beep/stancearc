import { describe, it, expect } from 'vitest';
import { decideArb, type ArbState, type ArbParams, type HeartbeatState } from '../src/decideArb.js';

// ---------------------------------------------------------------------------
// FINDING 3 — decideRebalance had NO rate-limit / daily budget (it fired every ~15s poll
// while a leg sat below the floor). It now has the SAME governors as the heartbeat:
//   - a minimum interval between rebalance legs (rebalanceIntervalMs), and
//   - a per-day cap on rebalance ATTEMPTS (rebalanceDailyMaxAttempts).
// FINDING 4 — the heartbeat gained a per-day ATTEMPT cap (heartbeatDailyMaxAttempts) so a
// reverting leg (which never charges the notional cap) can't retry unbounded.
//
// All decisions are PURE: the executor injects the ledger snapshot (lastRebalanceMs /
// rebalanceAttemptsToday / heartbeatAttemptsToday / nowMs) so the governors are testable.
// Market: cirBTC(8dp)/USDC(6dp), baseIsToken0=false, ref=100e18.
// ---------------------------------------------------------------------------
const ONE = 10n ** 18n;
const REF = 100n * ONE;
const DEEP_L = 10n ** 14n;
const baseRaw = (whole: number): bigint => BigInt(Math.round(whole * 1e8));
const usdcRaw = (whole: number): bigint => BigInt(Math.round(whole * 1e6));
const NOW = 1_000_000_000_000;

const baseState: ArbState = {
  poolPrice18: REF, // pool == ref => inside the band
  ref18: REF,
  refAgeSec: 5,
  liquidity: DEEP_L,
  baseIsToken0: false,
  inventoryBase: baseRaw(50),
  inventoryUsdc: usdcRaw(5000),
};
const baseParams: ArbParams = {
  feeBps: 30,
  thresholdBps: 25,
  closeFraction: 0.6,
  maxTradeBase: baseRaw(1000),
  minTradeBase: baseRaw(0.01),
  maxRefAgeSec: 60,
  baseDecimals: 8,
  quoteDecimals: 6,
};
const st = (over: Partial<ArbState>): ArbState => ({ ...baseState, ...over });
const pr = (over: Partial<ArbParams>): ArbParams => ({ ...baseParams, ...over });
const hb = (over: Partial<HeartbeatState>): HeartbeatState => ({
  nowMs: NOW,
  lastHeartbeatMs: null,
  spentTodayBase: 0n,
  heartbeatAttemptsToday: 0,
  lastRebalanceMs: null,
  rebalanceAttemptsToday: 0,
  ...over,
});

// A depleted-base book so a rebalance is otherwise actionable (BUY_BASE to restock base).
const depleted = { inventoryBase: baseRaw(1), inventoryUsdc: usdcRaw(9900) };

describe('decideArb — FINDING 3: rebalance interval rate-limit', () => {
  const rebParams = pr({ rebalanceFloorBps: 1500, rebalanceTargetBps: 5000, rebalanceIntervalMs: 60_000 });

  it('rebalances when no ledger is injected (interval guard is a no-op without a ledger)', () => {
    const d = decideArb(st({ ...depleted }), rebParams);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });

  it('rebalances on the FIRST leg (lastRebalanceMs null) even with the interval set', () => {
    const d = decideArb(st({ ...depleted, heartbeat: hb({ lastRebalanceMs: null }) }), rebParams);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });

  it('does NOT rebalance again before the interval elapses -> NONE', () => {
    const d = decideArb(
      st({ ...depleted, heartbeat: hb({ lastRebalanceMs: NOW - 30_000 }) }), // 30s < 60s
      rebParams,
    );
    expect(d.kind).toBe('NONE');
  });

  it('rebalances once the interval has elapsed exactly', () => {
    const d = decideArb(
      st({ ...depleted, heartbeat: hb({ lastRebalanceMs: NOW - 60_000 }) }), // exactly the interval
      rebParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });

  it('interval 0 (or unset) preserves the legacy fire-every-poll behavior', () => {
    const noInterval = pr({ rebalanceFloorBps: 1500, rebalanceTargetBps: 5000, rebalanceIntervalMs: 0 });
    const d = decideArb(st({ ...depleted, heartbeat: hb({ lastRebalanceMs: NOW - 1 }) }), noInterval);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });
});

describe('decideArb — FINDING 4: rebalance per-day attempt cap', () => {
  const cappedParams = pr({
    rebalanceFloorBps: 1500,
    rebalanceTargetBps: 5000,
    rebalanceIntervalMs: 0, // isolate the attempt cap from the interval
    rebalanceDailyMaxAttempts: 3,
  });

  it('rebalances while under the daily attempt cap', () => {
    const d = decideArb(st({ ...depleted, heartbeat: hb({ rebalanceAttemptsToday: 2 }) }), cappedParams);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });

  it('STOPS rebalancing once the daily attempt cap is hit -> NONE (bounds reverting retries)', () => {
    const d = decideArb(st({ ...depleted, heartbeat: hb({ rebalanceAttemptsToday: 3 }) }), cappedParams);
    expect(d.kind).toBe('NONE');
  });

  it('attempt cap 0 (unset) => uncapped', () => {
    const uncapped = pr({ rebalanceFloorBps: 1500, rebalanceTargetBps: 5000, rebalanceDailyMaxAttempts: 0 });
    const d = decideArb(st({ ...depleted, heartbeat: hb({ rebalanceAttemptsToday: 999 }) }), uncapped);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('rebalance');
  });
});

describe('decideArb — FINDING 4: heartbeat per-day attempt cap', () => {
  const hbParams = pr({
    heartbeatEnabled: true,
    heartbeatIntervalMs: 60_000,
    heartbeatDailyCapBase: baseRaw(1),
    heartbeatTradeBase: baseRaw(0.1),
    heartbeatDailyMaxAttempts: 2,
  });

  it('emits a heartbeat while under the attempt cap', () => {
    const d = decideArb(st({ heartbeat: hb({ heartbeatAttemptsToday: 1 }) }), hbParams);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
  });

  it('STOPS once the attempt cap is hit, even with NOTIONAL budget remaining -> NONE', () => {
    // spentTodayBase is 0 (a series of reverts charged nothing) but attempts == cap.
    const d = decideArb(st({ heartbeat: hb({ heartbeatAttemptsToday: 2, spentTodayBase: 0n }) }), hbParams);
    expect(d.kind).toBe('NONE');
  });

  it('attempt cap 0 (unset) => uncapped (only the notional cap bounds it)', () => {
    const uncapped = pr({
      heartbeatEnabled: true,
      heartbeatIntervalMs: 60_000,
      heartbeatDailyCapBase: baseRaw(1),
      heartbeatTradeBase: baseRaw(0.1),
      heartbeatDailyMaxAttempts: 0,
    });
    const d = decideArb(st({ heartbeat: hb({ heartbeatAttemptsToday: 999 }) }), uncapped);
    expect(d.kind).toBe('SWAP');
    expect(d.purpose).toBe('heartbeat');
  });
});

describe('decideArb — governors are pure (no input mutation)', () => {
  it('does not mutate state/params when the interval/attempt guards fire', () => {
    const state = st({ ...depleted, heartbeat: hb({ lastRebalanceMs: NOW - 1 }) });
    const params = pr({ rebalanceFloorBps: 1500, rebalanceTargetBps: 5000, rebalanceIntervalMs: 60_000 });
    const sCopy = JSON.parse(JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    decideArb(state, params);
    expect(JSON.parse(JSON.stringify(state, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))).toEqual(sCopy);
  });
});
