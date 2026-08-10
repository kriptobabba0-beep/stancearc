import { describe, it, expect } from 'vitest';
import {
  freshRuntime,
  nextBackoffMs,
  shouldSkip,
  recordFailure,
  recordSuccess,
  type MarketRuntime,
} from '../src/backoff.js';

const BASE = 5_000;
const MAX = 300_000;

describe('nextBackoffMs — exponential with a cap', () => {
  it('no failures (<=0) -> 0 (no backoff)', () => {
    expect(nextBackoffMs(0, BASE, MAX)).toBe(0);
    expect(nextBackoffMs(-3, BASE, MAX)).toBe(0);
  });

  it('first failure -> base', () => {
    expect(nextBackoffMs(1, BASE, MAX)).toBe(5_000);
  });

  it('doubles each consecutive failure: base * 2^(n-1)', () => {
    expect(nextBackoffMs(2, BASE, MAX)).toBe(10_000);
    expect(nextBackoffMs(3, BASE, MAX)).toBe(20_000);
    expect(nextBackoffMs(4, BASE, MAX)).toBe(40_000);
    expect(nextBackoffMs(5, BASE, MAX)).toBe(80_000);
    expect(nextBackoffMs(6, BASE, MAX)).toBe(160_000);
  });

  it('caps at maxMs and never exceeds it (incl. very large failure counts)', () => {
    expect(nextBackoffMs(7, BASE, MAX)).toBe(MAX); // 320_000 raw -> capped
    expect(nextBackoffMs(50, BASE, MAX)).toBe(MAX);
    expect(nextBackoffMs(1000, BASE, MAX)).toBe(MAX); // exponent clamp avoids Infinity
  });
});

describe('shouldSkip — true inside the backoff window, false after', () => {
  it('false when not backing off (backoffUntilMs 0)', () => {
    expect(shouldSkip(freshRuntime(), 1_000)).toBe(false);
  });

  it('true strictly before backoffUntilMs, false at/after', () => {
    const state: MarketRuntime = { consecutiveFailures: 2, backoffUntilMs: 10_000, lastSweptEpochId: null };
    expect(shouldSkip(state, 9_999)).toBe(true);
    expect(shouldSkip(state, 10_000)).toBe(false); // boundary: eligible again
    expect(shouldSkip(state, 10_001)).toBe(false);
  });
});

describe('recordFailure — bumps the count + arms the next window (pure)', () => {
  it('first failure arms a base-length window from now', () => {
    const next = recordFailure(freshRuntime(), 1_000, BASE, MAX);
    expect(next.consecutiveFailures).toBe(1);
    expect(next.backoffUntilMs).toBe(1_000 + 5_000);
  });

  it('compounds across failures (window doubles)', () => {
    let s = freshRuntime();
    s = recordFailure(s, 0, BASE, MAX); // f1 -> 5_000
    expect(s).toEqual({ consecutiveFailures: 1, backoffUntilMs: 5_000, lastSweptEpochId: null });
    s = recordFailure(s, 5_000, BASE, MAX); // f2 -> +10_000
    expect(s).toEqual({ consecutiveFailures: 2, backoffUntilMs: 15_000, lastSweptEpochId: null });
    s = recordFailure(s, 15_000, BASE, MAX); // f3 -> +20_000
    expect(s).toEqual({ consecutiveFailures: 3, backoffUntilMs: 35_000, lastSweptEpochId: null });
  });

  it('does not mutate the input state', () => {
    const input = freshRuntime();
    const snapshot = { ...input };
    recordFailure(input, 1_000, BASE, MAX);
    expect(input).toEqual(snapshot);
  });

  it('preserves lastSweptEpochId across failures', () => {
    const initial: MarketRuntime = { consecutiveFailures: 0, backoffUntilMs: 0, lastSweptEpochId: 5n };
    const next = recordFailure(initial, 1_000, BASE, MAX);
    expect(next.lastSweptEpochId).toBe(5n);
  });
});

describe('recordSuccess — resets the breaker', () => {
  it('clears failures + backoff so the market is immediately eligible', () => {
    const reset = recordSuccess(freshRuntime());
    expect(reset).toEqual({ consecutiveFailures: 0, backoffUntilMs: 0, lastSweptEpochId: null });
    expect(shouldSkip(reset, 0)).toBe(false);
  });

  it('a failure streak followed by success fully resets', () => {
    let s = freshRuntime();
    s = recordFailure(s, 0, BASE, MAX);
    s = recordFailure(s, 5_000, BASE, MAX);
    expect(s.consecutiveFailures).toBe(2);
    s = recordSuccess(s);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.backoffUntilMs).toBe(0);
  });

  it('preserves lastSweptEpochId across success (not wiped on reset)', () => {
    const withSweep: MarketRuntime = { consecutiveFailures: 3, backoffUntilMs: 99_999, lastSweptEpochId: 7n };
    const reset = recordSuccess(withSweep);
    expect(reset.consecutiveFailures).toBe(0);
    expect(reset.backoffUntilMs).toBe(0);
    expect(reset.lastSweptEpochId).toBe(7n);
  });
});
