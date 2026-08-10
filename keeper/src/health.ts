// health.ts — keeper observability: a PURE health/degraded computation + a PURE
// Prometheus text renderer + an optional lightweight node:http server that exposes
// /health and /metrics. The pure functions hold no clock and no I/O so they're
// unit-tested without ever opening a socket; the server is a thin shell over them.
import http from 'node:http';
import type { MarketRuntime } from './backoff.js';

/** Per-market snapshot the loop feeds into computeHealth (the live runtime + its id). */
export interface MarketHealthInput {
  id: string;
  runtime: MarketRuntime;
}

/** The slice of loop state the health computation needs (no clock — `nowMs` is passed). */
export interface HealthState {
  /** Wall-clock ms of the last completed poll pass; null if the loop hasn't ticked yet. */
  lastTickTs: number | null;
  markets: MarketHealthInput[];
}

/** Flattened per-market health row surfaced in the /health JSON. */
export interface MarketHealth {
  id: string;
  lastAction: string | null;
  lastActionTs: number | null;
  consecutiveFailures: number;
  wedged: boolean;
}

/** Result of computeHealth: the booleans + HTTP status + the per-market rows. */
export interface HealthResult {
  ok: boolean;
  degraded: boolean;
  statusCode: 200 | 503;
  /** True iff the loop hasn't ticked within stallFactor * pollIntervalMs. */
  stalled: boolean;
  /** True iff any market is wedged. */
  anyWedged: boolean;
  /** now - lastTickTs (or Infinity if it never ticked). */
  ageMs: number;
  lastTickTs: number | null;
  markets: MarketHealth[];
}

/**
 * Compute keeper health. PURE: no clock read (nowMs injected), no I/O. DEGRADED (503)
 * iff (a) any market is wedged, OR (b) the loop is stalled — now - lastTickTs exceeds
 * stallFactor * pollIntervalMs (strict >). A null lastTickTs (never ticked) is stalled.
 */
export function computeHealth(
  state: HealthState,
  nowMs: number,
  pollIntervalMs: number,
  stallFactor: number,
): HealthResult {
  const ageMs = state.lastTickTs === null ? Infinity : nowMs - state.lastTickTs;
  const stalled = ageMs > stallFactor * pollIntervalMs;

  const markets: MarketHealth[] = state.markets.map(({ id, runtime }) => ({
    id,
    lastAction: runtime.lastAction ?? null,
    lastActionTs: runtime.lastActionTs ?? null,
    consecutiveFailures: runtime.consecutiveFailures,
    wedged: runtime.wedged ?? false,
  }));

  const anyWedged = markets.some((m) => m.wedged);
  const degraded = anyWedged || stalled;

  return {
    ok: !degraded,
    degraded,
    statusCode: degraded ? 503 : 200,
    stalled,
    anyWedged,
    ageMs,
    lastTickTs: state.lastTickTs,
    markets,
  };
}

/** In-memory counters/gauges maintained by the loop and rendered for /metrics. */
export interface MetricsSnapshot {
  ticksTotal: number;
  actionsTotal: Record<string, number>;
  failuresTotal: Record<string, number>;
  revertsTotal: number;
  balanceWei: bigint;
  lastTickTs: number;
  marketWedged: Record<string, number>;
  /**
   * Restart-safe counters (TASK 4a). `restartsTotal` is bumped once per process boot, so a
   * crash-loop shows up as a rising counter even though ticks/actions/failures/reverts now
   * survive restarts (seeded from the persisted state file). `processStartTimeSec` is the
   * Unix-seconds gauge of THIS process's start — the conventional `process_start_time_seconds`
   * Prometheus exporters publish, letting an operator compute uptime + see a reset directly.
   */
  restartsTotal: number;
  processStartTimeSec: number;
}

/** Escape a Prometheus label value (\\, ", and newlines per the exposition format). */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render a MetricsSnapshot as Prometheus text exposition (v0.0.4). PURE — no I/O.
 * Counters: keeper_ticks_total, keeper_actions_total{action}, keeper_failures_total{market},
 * keeper_reverts_total. Gauges: keeper_balance_wei, keeper_market_wedged{market},
 * keeper_last_tick_timestamp.
 */
export function renderMetrics(m: MetricsSnapshot): string {
  const lines: string[] = [];

  lines.push('# HELP keeper_ticks_total Total completed poll passes.');
  lines.push('# TYPE keeper_ticks_total counter');
  lines.push(`keeper_ticks_total ${m.ticksTotal}`);

  lines.push('# HELP keeper_actions_total Lifecycle actions executed, by action type.');
  lines.push('# TYPE keeper_actions_total counter');
  for (const [action, n] of Object.entries(m.actionsTotal)) {
    lines.push(`keeper_actions_total{action="${escapeLabel(action)}"} ${n}`);
  }

  lines.push('# HELP keeper_failures_total Failing/STUCK/reverted ticks, by market.');
  lines.push('# TYPE keeper_failures_total counter');
  for (const [market, n] of Object.entries(m.failuresTotal)) {
    lines.push(`keeper_failures_total{market="${escapeLabel(market)}"} ${n}`);
  }

  lines.push('# HELP keeper_reverts_total Mined-but-reverted transactions.');
  lines.push('# TYPE keeper_reverts_total counter');
  lines.push(`keeper_reverts_total ${m.revertsTotal}`);

  lines.push('# HELP keeper_balance_wei Keeper signer native balance (wei).');
  lines.push('# TYPE keeper_balance_wei gauge');
  lines.push(`keeper_balance_wei ${m.balanceWei.toString()}`);

  lines.push('# HELP keeper_market_wedged 1 if the market is wedged, else 0.');
  lines.push('# TYPE keeper_market_wedged gauge');
  for (const [market, v] of Object.entries(m.marketWedged)) {
    lines.push(`keeper_market_wedged{market="${escapeLabel(market)}"} ${v}`);
  }

  lines.push('# HELP keeper_last_tick_timestamp Unix ms of the last completed poll pass.');
  lines.push('# TYPE keeper_last_tick_timestamp gauge');
  lines.push(`keeper_last_tick_timestamp ${m.lastTickTs}`);

  // TASK 4a — restart-safe signals. keeper_restarts_total rises once per boot so a crash-loop
  // is alertable even though the counters above now survive restarts (seeded from the state
  // file). process_start_time_seconds is the conventional uptime gauge — it RESETS on each
  // restart, which is exactly the documented way to detect a process bounce in Prometheus.
  lines.push('# HELP keeper_restarts_total Process boots (incremented once per start).');
  lines.push('# TYPE keeper_restarts_total counter');
  lines.push(`keeper_restarts_total ${m.restartsTotal}`);

  lines.push('# HELP process_start_time_seconds Start time of the process since unix epoch in seconds.');
  lines.push('# TYPE process_start_time_seconds gauge');
  lines.push(`process_start_time_seconds ${m.processStartTimeSec}`);

  return lines.join('\n') + '\n';
}

/** Handle to the running health server so the loop can close it on shutdown. */
export interface HealthServer {
  close(): void;
}

/**
 * Start the optional /health + /metrics HTTP server on host:port using node:http (no
 * new deps). The caller passes accessor callbacks so the server always reflects LIVE
 * loop state. Returns a handle with close(). Only call when port > 0.
 */
export function startHealthServer(opts: {
  host: string;
  port: number;
  pollIntervalMs: number;
  stallFactor: number;
  getHealthState: () => HealthState;
  getMetrics: () => MetricsSnapshot;
  log: (o: Record<string, unknown>) => void;
  /** Max rebind attempts after a bind error (e.g. EADDRINUSE) before giving up. Default 5. */
  maxBindRetries?: number;
  /** Backoff between rebind attempts (ms). Default 1000. */
  bindRetryDelayMs?: number;
  /**
   * Called when the bind ultimately fails — defaults to process.exit(1) so the container
   * supervisor restarts the keeper cleanly (running blind, with NO health endpoint, defeats
   * the healthcheck-driven restart). Injectable so tests don't kill the runner.
   */
  onFatal?: (code: number) => void;
  /** Schedules a retry. Injectable so tests don't sit on a real timer. Default setTimeout. */
  scheduleRetry?: (fn: () => void, ms: number) => void;
}): HealthServer {
  const maxBindRetries = opts.maxBindRetries ?? 5;
  const bindRetryDelayMs = opts.bindRetryDelayMs ?? 1_000;
  const onFatal = opts.onFatal ?? ((code: number) => process.exit(code));
  const scheduleRetry = opts.scheduleRetry ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  let bindAttempts = 0;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      const h = computeHealth(opts.getHealthState(), Date.now(), opts.pollIntervalMs, opts.stallFactor);
      const body = JSON.stringify({
        ok: h.ok,
        lastTickTs: h.lastTickTs,
        ageMs: h.ageMs === Infinity ? null : h.ageMs,
        stalled: h.stalled,
        markets: h.markets,
      });
      res.writeHead(h.statusCode, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && path === '/metrics') {
      const text = renderMetrics(opts.getMetrics());
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(text);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  // A bind failure (esp. EADDRINUSE) means we'd run with NO health endpoint — the worst case,
  // since the healthcheck-driven restart can never fire. Retry the bind a bounded number of
  // times, then exit(1) so the supervisor restarts us cleanly rather than running blind.
  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    opts.log({ msg: 'keeper.http.error', error: err instanceof Error ? err.message : String(err), code, attempt: bindAttempts });
    if (bindAttempts < maxBindRetries) {
      bindAttempts += 1;
      opts.log({ msg: 'keeper.http.rebind', attempt: bindAttempts, maxBindRetries, delayMs: bindRetryDelayMs });
      scheduleRetry(() => server.listen(opts.port, opts.host), bindRetryDelayMs);
      return;
    }
    opts.log({ msg: 'keeper.http.bind-failed', host: opts.host, port: opts.port, attempts: bindAttempts });
    onFatal(1);
  });

  server.listen(opts.port, opts.host, () => {
    opts.log({ msg: 'keeper.http.listening', host: opts.host, port: opts.port });
  });

  return { close: () => server.close() };
}
