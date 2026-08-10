import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import { computeHealth, renderMetrics, startHealthServer, type HealthState } from '../src/health.js';
import { freshRuntime, type MarketRuntime } from '../src/backoff.js';

const POLL = 15_000;
const STALL = 3;

// A market runtime in a chosen condition.
function mkt(over: Partial<MarketRuntime> = {}): MarketRuntime {
  return { ...freshRuntime(), ...over };
}

function state(over: Partial<HealthState> = {}): HealthState {
  return {
    lastTickTs: 1_000_000,
    markets: [{ id: 'eth', runtime: mkt({ lastAction: 'NONE', lastActionTs: 1_000_000 }) }],
    ...over,
  };
}

describe('computeHealth — healthy', () => {
  it('fresh tick + no wedged market -> ok, not degraded, 200', () => {
    const now = 1_000_000 + POLL; // one interval later: well within stall window
    const h = computeHealth(state(), now, POLL, STALL);
    expect(h.ok).toBe(true);
    expect(h.degraded).toBe(false);
    expect(h.statusCode).toBe(200);
    expect(h.stalled).toBe(false);
    expect(h.anyWedged).toBe(false);
    expect(h.ageMs).toBe(POLL);
  });

  it('markets array shape mirrors the runtime fields', () => {
    const now = 1_000_001;
    const rt = mkt({ lastAction: 'SWEEP', lastActionTs: 999_000, consecutiveFailures: 2 });
    const h = computeHealth(state({ markets: [{ id: 'btc', runtime: rt }] }), now, POLL, STALL);
    expect(h.markets).toEqual([
      { id: 'btc', lastAction: 'SWEEP', lastActionTs: 999_000, consecutiveFailures: 2, wedged: false },
    ]);
  });
});

describe('computeHealth — degraded (503)', () => {
  it('a wedged market -> degraded, 503, anyWedged true', () => {
    const now = 1_000_000 + POLL;
    const h = computeHealth(
      state({ markets: [{ id: 'eth', runtime: mkt({ wedged: true, consecutiveFailures: 5 }) }] }),
      now,
      POLL,
      STALL,
    );
    expect(h.degraded).toBe(true);
    expect(h.ok).toBe(false);
    expect(h.statusCode).toBe(503);
    expect(h.anyWedged).toBe(true);
    expect(h.stalled).toBe(false);
    expect(h.markets[0]!.wedged).toBe(true);
  });

  it('stale lastTickTs beyond stallFactor*poll -> degraded, 503, stalled true', () => {
    // age = STALL*POLL + 1 -> just past the stall threshold.
    const now = 1_000_000 + STALL * POLL + 1;
    const h = computeHealth(state(), now, POLL, STALL);
    expect(h.stalled).toBe(true);
    expect(h.degraded).toBe(true);
    expect(h.statusCode).toBe(503);
    expect(h.anyWedged).toBe(false);
  });

  it('exactly at the stall threshold is NOT yet stalled (strict >)', () => {
    const now = 1_000_000 + STALL * POLL; // ageMs == threshold
    const h = computeHealth(state(), now, POLL, STALL);
    expect(h.stalled).toBe(false);
    expect(h.degraded).toBe(false);
  });

  it('lastTickTs null (never ticked) -> stalled/degraded', () => {
    const h = computeHealth(state({ lastTickTs: null }), 5_000_000, POLL, STALL);
    expect(h.stalled).toBe(true);
    expect(h.degraded).toBe(true);
    expect(h.statusCode).toBe(503);
  });
});

describe('renderMetrics — Prometheus text exposition', () => {
  it('emits the documented counters + gauges with labels', () => {
    const text = renderMetrics({
      ticksTotal: 12,
      actionsTotal: { SWEEP: 3, NONE: 9 },
      failuresTotal: { eth: 1, btc: 0 },
      revertsTotal: 2,
      balanceWei: 123_456n,
      lastTickTs: 1_700_000_000_000,
      marketWedged: { eth: 1, btc: 0 },
      restartsTotal: 4,
      processStartTimeSec: 1_700_000_000,
    });
    expect(text).toMatch(/^# HELP keeper_ticks_total/m);
    expect(text).toMatch(/^# TYPE keeper_ticks_total counter/m);
    expect(text).toMatch(/^keeper_ticks_total 12$/m);
    expect(text).toMatch(/keeper_actions_total\{action="SWEEP"\} 3/);
    expect(text).toMatch(/keeper_actions_total\{action="NONE"\} 9/);
    expect(text).toMatch(/keeper_failures_total\{market="eth"\} 1/);
    expect(text).toMatch(/keeper_reverts_total 2/);
    expect(text).toMatch(/keeper_balance_wei 123456/);
    expect(text).toMatch(/keeper_market_wedged\{market="eth"\} 1/);
    expect(text).toMatch(/keeper_last_tick_timestamp 1700000000000/);
    // TASK 4a — restart-safe signals.
    expect(text).toMatch(/^# TYPE keeper_restarts_total counter/m);
    expect(text).toMatch(/^keeper_restarts_total 4$/m);
    expect(text).toMatch(/^# TYPE process_start_time_seconds gauge/m);
    expect(text).toMatch(/^process_start_time_seconds 1700000000$/m);
    // Prometheus text format ends with a trailing newline.
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders zero-state cleanly (no markets/actions yet)', () => {
    const text = renderMetrics({
      ticksTotal: 0,
      actionsTotal: {},
      failuresTotal: {},
      revertsTotal: 0,
      balanceWei: 0n,
      lastTickTs: 0,
      marketWedged: {},
      restartsTotal: 1,
      processStartTimeSec: 1_700_000_000,
    });
    expect(text).toMatch(/keeper_ticks_total 0/);
    expect(text).toMatch(/keeper_reverts_total 0/);
    expect(text).toMatch(/keeper_balance_wei 0/);
    expect(text).toMatch(/keeper_restarts_total 1/);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 — a bind failure (port in use) must NOT leave the keeper running blind. It retries
// a bounded number of times, then exits the process so the supervisor restarts us cleanly.
// onFatal + scheduleRetry are injected so the test never kills the runner or waits on a timer.
// ---------------------------------------------------------------------------
const logs: Record<string, unknown>[] = [];
function baseOpts(over: Record<string, unknown> = {}) {
  return {
    host: '127.0.0.1',
    pollIntervalMs: 15_000,
    stallFactor: 3,
    getHealthState: () => state(),
    getMetrics: () => ({
      ticksTotal: 0,
      actionsTotal: {},
      failuresTotal: {},
      revertsTotal: 0,
      balanceWei: 0n,
      lastTickTs: 0,
      marketWedged: {},
      restartsTotal: 1,
      processStartTimeSec: 0,
    }),
    log: (o: Record<string, unknown>) => logs.push(o),
    // Run scheduled retries synchronously so the test is deterministic (no real timers).
    scheduleRetry: (fn: () => void) => fn(),
    ...over,
  };
}

// Grab a free port by binding a throwaway server, then keep it occupied for the test.
function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve) => {
    const blocker = http.createServer(() => {});
    blocker.listen(0, '127.0.0.1', () => {
      const port = (blocker.address() as { port: number }).port;
      resolve({ port, release: () => new Promise<void>((r) => blocker.close(() => r())) });
    });
  });
}

describe('startHealthServer — bind failure does not run blind (FIX 3)', () => {
  it('retries the bind a bounded number of times then calls onFatal(1)', async () => {
    logs.length = 0;
    const { port, release } = await occupyPort();
    const onFatal = vi.fn();

    const srv = startHealthServer(
      baseOpts({ port, maxBindRetries: 3, bindRetryDelayMs: 0, onFatal }) as never,
    );

    // The error event fires on the next tick; give the event loop a turn for the synchronous
    // retry chain to drain (each scheduleRetry runs inline, re-listen re-emits EADDRINUSE).
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(onFatal).toHaveBeenCalledWith(1);
    expect(onFatal).toHaveBeenCalledTimes(1);
    // It logged a bind error + attempted maxBindRetries rebinds before giving up.
    expect(logs.filter((l) => l.msg === 'keeper.http.rebind')).toHaveLength(3);
    expect(logs.some((l) => l.msg === 'keeper.http.bind-failed')).toBe(true);

    srv.close();
    await release();
  });

  it('binds cleanly on a free port (no retries, no fatal)', async () => {
    logs.length = 0;
    const onFatal = vi.fn();
    const srv = startHealthServer(baseOpts({ port: 0, onFatal }) as never);
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(onFatal).not.toHaveBeenCalled();
    expect(logs.some((l) => l.msg === 'keeper.http.listening')).toBe(true);
    expect(logs.some((l) => l.msg === 'keeper.http.rebind')).toBe(false);
    srv.close();
  });
});
