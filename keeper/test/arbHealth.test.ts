import { describe, it, expect } from 'vitest';
import { computeArbHealth, renderArbMetrics, type ArbHealthState } from '../src/arbHealth.js';
import { freshRuntime, type MarketRuntime } from '../src/backoff.js';

// The arb bot's /health probe mirrors keeper/src/health.ts but for the SINGLE arb market:
// DEGRADED (503) iff (a) the single market is wedged (consecutive failures crossed the
// WEDGED threshold), OR (b) the loop is STALLED — now - lastTickTs exceeds
// stallFactor * pollIntervalMs (strict >). A null lastTickTs (never ticked) is stalled.

const POLL = 15_000;
const STALL = 3;

function mkt(over: Partial<MarketRuntime> = {}): MarketRuntime {
  return { ...freshRuntime(), ...over };
}

function state(over: Partial<ArbHealthState> = {}): ArbHealthState {
  return {
    lastTickTs: 1_000_000,
    market: { id: 'cirbtc', runtime: mkt({ lastAction: 'NONE', lastActionTs: 1_000_000 }) },
    ...over,
  };
}

describe('computeArbHealth — healthy', () => {
  it('fresh tick + not wedged -> ok, not degraded, 200', () => {
    const now = 1_000_000 + POLL; // one interval later: well within stall window
    const h = computeArbHealth(state(), now, POLL, STALL);
    expect(h.ok).toBe(true);
    expect(h.degraded).toBe(false);
    expect(h.statusCode).toBe(200);
    expect(h.stalled).toBe(false);
    expect(h.wedged).toBe(false);
    expect(h.ageMs).toBe(POLL);
  });

  it('market shape mirrors the runtime fields', () => {
    const now = 1_000_001;
    const rt = mkt({ lastAction: 'SWAP', lastActionTs: 999_000, consecutiveFailures: 2 });
    const h = computeArbHealth(state({ market: { id: 'cirbtc', runtime: rt } }), now, POLL, STALL);
    expect(h.market).toEqual({
      id: 'cirbtc',
      lastAction: 'SWAP',
      lastActionTs: 999_000,
      consecutiveFailures: 2,
      wedged: false,
    });
  });
});

describe('computeArbHealth — degraded (503)', () => {
  it('a wedged market -> degraded, 503, wedged true', () => {
    const now = 1_000_000 + POLL;
    const h = computeArbHealth(
      state({ market: { id: 'cirbtc', runtime: mkt({ wedged: true, consecutiveFailures: 5 }) } }),
      now,
      POLL,
      STALL,
    );
    expect(h.degraded).toBe(true);
    expect(h.ok).toBe(false);
    expect(h.statusCode).toBe(503);
    expect(h.wedged).toBe(true);
    expect(h.stalled).toBe(false);
    expect(h.market.wedged).toBe(true);
  });

  it('stale lastTickTs beyond stallFactor*poll -> degraded, 503, stalled true', () => {
    const now = 1_000_000 + STALL * POLL + 1; // just past the stall threshold
    const h = computeArbHealth(state(), now, POLL, STALL);
    expect(h.stalled).toBe(true);
    expect(h.degraded).toBe(true);
    expect(h.statusCode).toBe(503);
    expect(h.wedged).toBe(false);
  });

  it('exactly at the stall threshold is NOT yet stalled (strict >)', () => {
    const now = 1_000_000 + STALL * POLL; // ageMs == threshold
    const h = computeArbHealth(state(), now, POLL, STALL);
    expect(h.stalled).toBe(false);
    expect(h.degraded).toBe(false);
  });

  it('lastTickTs null (never ticked) -> stalled/degraded, ageMs Infinity', () => {
    const h = computeArbHealth(state({ lastTickTs: null }), 5_000_000, POLL, STALL);
    expect(h.stalled).toBe(true);
    expect(h.degraded).toBe(true);
    expect(h.statusCode).toBe(503);
    expect(h.ageMs).toBe(Infinity);
  });
});

describe('renderArbMetrics — Prometheus text exposition (TASK 4a)', () => {
  it('emits the arb_* counters/gauges incl. the restart-safe signals', () => {
    const text = renderArbMetrics({
      ticksTotal: 40,
      swapsTotal: { arb: 7, rebalance: 2, heartbeat: 1 },
      failuresTotal: 3,
      revertsTotal: 1,
      balanceWei: 987_654n,
      lastTickTs: 1_700_000_000_000,
      wedged: 1,
      restartsTotal: 5,
      processStartTimeSec: 1_700_000_000,
    });
    expect(text).toMatch(/^# TYPE arb_ticks_total counter/m);
    expect(text).toMatch(/^arb_ticks_total 40$/m);
    expect(text).toMatch(/arb_swaps_total\{purpose="arb"\} 7/);
    expect(text).toMatch(/arb_swaps_total\{purpose="rebalance"\} 2/);
    expect(text).toMatch(/arb_swaps_total\{purpose="heartbeat"\} 1/);
    expect(text).toMatch(/^arb_failures_total 3$/m);
    expect(text).toMatch(/^arb_reverts_total 1$/m);
    expect(text).toMatch(/^arb_balance_wei 987654$/m);
    expect(text).toMatch(/^arb_market_wedged 1$/m);
    expect(text).toMatch(/^arb_last_tick_timestamp 1700000000000$/m);
    // Restart-safe signals.
    expect(text).toMatch(/^# TYPE arb_restarts_total counter/m);
    expect(text).toMatch(/^arb_restarts_total 5$/m);
    expect(text).toMatch(/^# TYPE process_start_time_seconds gauge/m);
    expect(text).toMatch(/^process_start_time_seconds 1700000000$/m);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders zero-state cleanly (no swaps yet)', () => {
    const text = renderArbMetrics({
      ticksTotal: 0,
      swapsTotal: {},
      failuresTotal: 0,
      revertsTotal: 0,
      balanceWei: 0n,
      lastTickTs: 0,
      wedged: 0,
      restartsTotal: 1,
      processStartTimeSec: 1_700_000_000,
    });
    expect(text).toMatch(/^arb_ticks_total 0$/m);
    expect(text).toMatch(/^arb_restarts_total 1$/m);
    expect(text).toMatch(/^arb_market_wedged 0$/m);
  });
});
