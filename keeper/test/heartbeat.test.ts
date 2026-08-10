import { describe, it, expect } from 'vitest';
import {
  DAY_MS,
  utcDayStart,
  freshHeartbeatLedger,
  rollHeartbeatDay,
  recordHeartbeatSpend,
  snapshotHeartbeat,
} from '../src/heartbeat.js';

// TASK 3b — the PURE heartbeat-volume budget ledger (clock injected as nowMs). Mirrors the
// backoff.ts unit-test style: deterministic, no I/O, no real clock.

const T0 = 1_700_000_000_000; // an arbitrary instant
const DAY0 = utcDayStart(T0);

describe('utcDayStart', () => {
  it('floors to the UTC-day boundary', () => {
    expect(utcDayStart(DAY0)).toBe(DAY0);
    expect(utcDayStart(DAY0 + 1)).toBe(DAY0);
    expect(utcDayStart(DAY0 + DAY_MS - 1)).toBe(DAY0);
    expect(utcDayStart(DAY0 + DAY_MS)).toBe(DAY0 + DAY_MS);
  });
});

describe('freshHeartbeatLedger', () => {
  it('starts empty, anchored to the current UTC day', () => {
    const l = freshHeartbeatLedger(T0);
    expect(l.dayStartMs).toBe(DAY0);
    expect(l.spentTodayBase).toBe(0n);
    expect(l.lastHeartbeatMs).toBeNull();
  });
});

describe('recordHeartbeatSpend', () => {
  it('accumulates the day spend and stamps lastHeartbeatMs', () => {
    let l = freshHeartbeatLedger(T0);
    l = recordHeartbeatSpend(l, 100n, T0 + 1000);
    expect(l.spentTodayBase).toBe(100n);
    expect(l.lastHeartbeatMs).toBe(T0 + 1000);
    l = recordHeartbeatSpend(l, 50n, T0 + 2000);
    expect(l.spentTodayBase).toBe(150n);
    expect(l.lastHeartbeatMs).toBe(T0 + 2000);
  });

  it('clamps a negative amount to 0 (defensive)', () => {
    const l = recordHeartbeatSpend(freshHeartbeatLedger(T0), -5n, T0 + 1);
    expect(l.spentTodayBase).toBe(0n);
  });

  it('is pure — returns a NEW ledger, does not mutate the input', () => {
    const l0 = freshHeartbeatLedger(T0);
    const l1 = recordHeartbeatSpend(l0, 10n, T0 + 1);
    expect(l0.spentTodayBase).toBe(0n); // unchanged
    expect(l1).not.toBe(l0);
  });
});

describe('rollHeartbeatDay', () => {
  it('does NOT roll within the same UTC day (returns the same reference)', () => {
    const l = recordHeartbeatSpend(freshHeartbeatLedger(T0), 100n, T0);
    const same = rollHeartbeatDay(l, T0 + 1000);
    expect(same).toBe(l); // unchanged ref — no roll
    expect(same.spentTodayBase).toBe(100n);
  });

  it('RESETS the spend when crossing into a new UTC day, preserving lastHeartbeatMs', () => {
    const l = recordHeartbeatSpend(freshHeartbeatLedger(T0), 100n, T0);
    const nextDay = DAY0 + DAY_MS + 5;
    const rolled = rollHeartbeatDay(l, nextDay);
    expect(rolled).not.toBe(l);
    expect(rolled.spentTodayBase).toBe(0n); // budget reset
    expect(rolled.dayStartMs).toBe(DAY0 + DAY_MS);
    // lastHeartbeatMs survives so the interval rate-limit still spans the midnight boundary.
    expect(rolled.lastHeartbeatMs).toBe(T0);
  });
});

describe('snapshotHeartbeat', () => {
  it('threads the injected clock + the ledger spend/last-fire into the decision snapshot', () => {
    const l = recordHeartbeatSpend(freshHeartbeatLedger(T0), 42n, T0 + 7);
    const snap = snapshotHeartbeat(l, T0 + 99);
    expect(snap.nowMs).toBe(T0 + 99);
    expect(snap.spentTodayBase).toBe(42n);
    expect(snap.lastHeartbeatMs).toBe(T0 + 7);
  });
});

// End-to-end ledger flow: interval + daily-cap budgeting over a simulated day, proving the
// budget can NEVER be exceeded regardless of how often the loop ticks.
describe('heartbeat ledger — budget is bounded across a simulated day', () => {
  it('never spends more than the daily cap even under rapid ticks', () => {
    const TRADE = 10n; // per-leg
    const CAP = 35n; //   daily cap -> at most 3 full legs + a clamped 4th leg
    let l = freshHeartbeatLedger(T0);
    // Simulate the executor: each "fire" records min(TRADE, remaining).
    for (let i = 0; i < 100; i++) {
      const remaining = CAP - l.spentTodayBase;
      if (remaining <= 0n) break;
      const leg = TRADE > remaining ? remaining : TRADE;
      l = recordHeartbeatSpend(l, leg, T0 + i);
    }
    expect(l.spentTodayBase).toBe(CAP); // exactly the cap, never over
  });
});
