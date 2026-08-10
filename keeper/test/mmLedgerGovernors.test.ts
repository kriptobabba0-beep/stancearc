import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  utcDayStart,
  freshHeartbeatLedger,
  rollHeartbeatDay,
  recordHeartbeatSpend,
  recordHeartbeatAttempt,
  recordRebalanceAttempt,
  snapshotHeartbeat,
} from '../src/heartbeat.js';
import { applyLedgerUpdate } from '../src/arb.js';
import type { ArbTickLog } from '../src/arb.js';

// ---------------------------------------------------------------------------
// FINDING 3/4 — the MM ledger now tracks rebalance interval (lastRebalanceMs) + per-day
// ATTEMPT counters (heartbeatAttemptsToday / rebalanceAttemptsToday). The attempt + interval
// stamps advance REGARDLESS of success (recordHeartbeatAttempt / recordRebalanceAttempt),
// while the NOTIONAL spend (recordHeartbeatSpend) advances only on success — so a reverting
// leg can't retry unbounded.
// ---------------------------------------------------------------------------
const T0 = 1_700_000_000_000;
const DAY0 = utcDayStart(T0);

describe('freshHeartbeatLedger — includes the new governor fields', () => {
  it('starts with zero attempts and null lastRebalanceMs', () => {
    const l = freshHeartbeatLedger(T0);
    expect(l.heartbeatAttemptsToday).toBe(0);
    expect(l.rebalanceAttemptsToday).toBe(0);
    expect(l.lastRebalanceMs).toBeNull();
  });
});

describe('recordHeartbeatAttempt — stamps interval + bumps attempts (success OR revert)', () => {
  it('advances lastHeartbeatMs + heartbeatAttemptsToday without charging the notional cap', () => {
    let l = freshHeartbeatLedger(T0);
    l = recordHeartbeatAttempt(l, T0 + 100);
    expect(l.lastHeartbeatMs).toBe(T0 + 100);
    expect(l.heartbeatAttemptsToday).toBe(1);
    expect(l.spentTodayBase).toBe(0n); // a reverting attempt charges NO notional
    l = recordHeartbeatAttempt(l, T0 + 200);
    expect(l.heartbeatAttemptsToday).toBe(2);
  });

  it('is pure — returns a NEW ledger, preserves other fields', () => {
    const l0 = recordRebalanceAttempt(freshHeartbeatLedger(T0), T0 + 1); // pre-set a rebalance attempt
    const l1 = recordHeartbeatAttempt(l0, T0 + 2);
    expect(l1).not.toBe(l0);
    expect(l1.rebalanceAttemptsToday).toBe(l0.rebalanceAttemptsToday); // unchanged by a HB attempt
    expect(l0.heartbeatAttemptsToday).toBe(0); // input unchanged
  });
});

describe('recordRebalanceAttempt — stamps the rebalance interval + bumps rebalance attempts', () => {
  it('advances lastRebalanceMs + rebalanceAttemptsToday only (not the heartbeat counters)', () => {
    let l = freshHeartbeatLedger(T0);
    l = recordRebalanceAttempt(l, T0 + 500);
    expect(l.lastRebalanceMs).toBe(T0 + 500);
    expect(l.rebalanceAttemptsToday).toBe(1);
    expect(l.heartbeatAttemptsToday).toBe(0);
    expect(l.lastHeartbeatMs).toBeNull();
  });
});

describe('recordHeartbeatSpend — preserves the new governor fields', () => {
  it('charges notional + stamps lastHeartbeatMs while keeping the attempt counters intact', () => {
    let l = recordHeartbeatAttempt(freshHeartbeatLedger(T0), T0 + 1); // attempt first (count=1)
    l = recordHeartbeatSpend(l, 100n, T0 + 1); // then settle
    expect(l.spentTodayBase).toBe(100n);
    expect(l.heartbeatAttemptsToday).toBe(1); // NOT reset/clobbered by the spend record
    expect(l.lastRebalanceMs).toBeNull();
  });
});

describe('rollHeartbeatDay — resets per-day counters, preserves last-fire timestamps', () => {
  it('zeroes both attempt counters but keeps lastHeartbeatMs/lastRebalanceMs across midnight', () => {
    let l = freshHeartbeatLedger(T0);
    l = recordHeartbeatAttempt(l, T0 + 1);
    l = recordRebalanceAttempt(l, T0 + 2);
    l = recordHeartbeatSpend(l, 50n, T0 + 3);
    const rolled = rollHeartbeatDay(l, DAY0 + DAY_MS + 5);
    expect(rolled.heartbeatAttemptsToday).toBe(0);
    expect(rolled.rebalanceAttemptsToday).toBe(0);
    expect(rolled.spentTodayBase).toBe(0n);
    // Interval rate-limits still span midnight.
    expect(rolled.lastHeartbeatMs).toBe(T0 + 3);
    expect(rolled.lastRebalanceMs).toBe(T0 + 2);
  });
});

describe('snapshotHeartbeat — threads the governor fields into the decision snapshot', () => {
  it('exposes attempts + lastRebalanceMs for the pure governors', () => {
    let l = freshHeartbeatLedger(T0);
    l = recordRebalanceAttempt(l, T0 + 9);
    l = recordHeartbeatAttempt(l, T0 + 10);
    const snap = snapshotHeartbeat(l, T0 + 99);
    expect(snap.rebalanceAttemptsToday).toBe(1);
    expect(snap.lastRebalanceMs).toBe(T0 + 9);
    expect(snap.heartbeatAttemptsToday).toBe(1);
    expect(snap.lastHeartbeatMs).toBe(T0 + 10);
  });
});

// applyLedgerUpdate — the loop's per-tick ledger step (extracted PURE from main()). Proves
// FINDING 4's "stamp the rate-limit regardless of success" end-to-end at the wiring level.
describe('applyLedgerUpdate — per-tick MM ledger wiring', () => {
  const rec = (over: Partial<ArbTickLog>): ArbTickLog => ({
    ts: '2026-06-09T00:00:00.000Z',
    market: 'cirbtc',
    kind: 'SWAP',
    reason: 'test',
    ...over,
  });

  it('a SUCCESSFUL heartbeat stamps the interval+attempt AND charges the notional', () => {
    const l = applyLedgerUpdate(freshHeartbeatLedger(T0), rec({ purpose: 'heartbeat', amountInBase: '100' }), T0 + 5);
    expect(l.heartbeatAttemptsToday).toBe(1);
    expect(l.lastHeartbeatMs).toBe(T0 + 5);
    expect(l.spentTodayBase).toBe(100n);
  });

  it('a REVERTING heartbeat (rec.error set) stamps the interval+attempt but charges NO notional', () => {
    const l = applyLedgerUpdate(
      freshHeartbeatLedger(T0),
      rec({ purpose: 'heartbeat', amountInBase: '100', error: 'swap reverted: SPL' }),
      T0 + 5,
    );
    expect(l.heartbeatAttemptsToday).toBe(1); // rate-limit STILL advanced -> bounded retries
    expect(l.lastHeartbeatMs).toBe(T0 + 5);
    expect(l.spentTodayBase).toBe(0n); // a revert never charges the notional cap
  });

  it('a REVERTING rebalance stamps lastRebalanceMs + the rebalance attempt counter', () => {
    const l = applyLedgerUpdate(
      freshHeartbeatLedger(T0),
      rec({ purpose: 'rebalance', amountInBase: '5000', error: 'swap reverted: SPL' }),
      T0 + 9,
    );
    expect(l.rebalanceAttemptsToday).toBe(1);
    expect(l.lastRebalanceMs).toBe(T0 + 9);
    expect(l.spentTodayBase).toBe(0n); // rebalance never charges the heartbeat notional cap
  });

  it('a price-convergence ARB swap leaves the MM ledger UNCHANGED (governors are MM-only)', () => {
    const l0 = freshHeartbeatLedger(T0);
    const l1 = applyLedgerUpdate(l0, rec({ purpose: 'arb', amountInBase: '5000' }), T0 + 1);
    expect(l1).toBe(l0); // same reference — no change
  });

  it('a NON-swap tick (NONE/SKIP) leaves the ledger UNCHANGED', () => {
    const l0 = freshHeartbeatLedger(T0);
    expect(applyLedgerUpdate(l0, rec({ kind: 'NONE', purpose: undefined }), T0 + 1)).toBe(l0);
    expect(applyLedgerUpdate(l0, rec({ kind: 'SKIP', purpose: undefined }), T0 + 1)).toBe(l0);
  });
});

// The KEY FINDING-4 invariant at the ledger level: a series of REVERTING heartbeat legs
// (which charge no notional) still advances the attempt cap, so the bot stops retrying.
describe('FINDING 4 — reverting legs are bounded by the ATTEMPT cap even at zero spend', () => {
  it('reverting heartbeats hit the attempt cap with spentTodayBase still 0', () => {
    const CAP_ATTEMPTS = 5;
    let l = freshHeartbeatLedger(T0);
    let fired = 0;
    for (let i = 0; i < 100; i++) {
      if (l.heartbeatAttemptsToday >= CAP_ATTEMPTS) break; // the executor's decideHeartbeat gate
      l = recordHeartbeatAttempt(l, T0 + i); // every attempt REVERTS (no spend recorded)
      fired += 1;
    }
    expect(fired).toBe(CAP_ATTEMPTS); // bounded — NOT unbounded retries
    expect(l.heartbeatAttemptsToday).toBe(CAP_ATTEMPTS);
    expect(l.spentTodayBase).toBe(0n); // reverts charged nothing
  });
});
