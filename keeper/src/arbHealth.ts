// arbHealth.ts — arb-bot observability, mirroring keeper/src/health.ts. A PURE
// health/degraded computation + an optional lightweight node:http server that exposes
// /health for the price-keeper ARB bot. The arb bot drives a SINGLE market (one pool, one
// key), so unlike the lifecycle keeper's per-market array this tracks just one runtime.
// The pure function holds no clock and no I/O (`nowMs` is injected) so it's unit-tested
// without ever opening a socket; the server is a thin shell over it.
import http from 'node:http';
import type { MarketRuntime } from './backoff.js';

/** The single arb market's snapshot the loop feeds into computeArbHealth (runtime + id). */
export interface ArbMarketHealthInput {
  id: string;
  runtime: MarketRuntime;
}

/** The slice of loop state the arb health computation needs (no clock — `nowMs` is passed). */
export interface ArbHealthState {
  /** Wall-clock ms of the last completed arb tick; null if the loop hasn't ticked yet. */
  lastTickTs: number | null;
  market: ArbMarketHealthInput;
}

/** Flattened market health row surfaced in the /health JSON. */
export interface ArbMarketHealth {
  id: string;
  lastAction: string | null;
  lastActionTs: number | null;
  consecutiveFailures: number;
  wedged: boolean;
}

/** Result of computeArbHealth: the booleans + HTTP status + the market row. */
export interface ArbHealthResult {
  ok: boolean;
  degraded: boolean;
  statusCode: 200 | 503;
  /** True iff the loop hasn't ticked within stallFactor * pollIntervalMs. */
  stalled: boolean;
  /** True iff the arb market is wedged (failure streak crossed the WEDGED threshold). */
  wedged: boolean;
  /** now - lastTickTs (or Infinity if it never ticked). */
  ageMs: number;
  lastTickTs: number | null;
  market: ArbMarketHealth;
}

/**
 * Compute arb-bot health. PURE: no clock read (nowMs injected), no I/O. DEGRADED (503)
 * iff (a) the market is wedged, OR (b) the loop is stalled — now - lastTickTs exceeds
 * stallFactor * pollIntervalMs (strict >). A null lastTickTs (never ticked) is stalled.
 * Mirrors keeper/src/health.ts computeHealth, collapsed to the arb bot's single market.
 */
export function computeArbHealth(
  state: ArbHealthState,
  nowMs: number,
  pollIntervalMs: number,
  stallFactor: number,
): ArbHealthResult {
  const ageMs = state.lastTickTs === null ? Infinity : nowMs - state.lastTickTs;
  const stalled = ageMs > stallFactor * pollIntervalMs;

  const { id, runtime } = state.market;
  const market: ArbMarketHealth = {
    id,
    lastAction: runtime.lastAction ?? null,
    lastActionTs: runtime.lastActionTs ?? null,
    consecutiveFailures: runtime.consecutiveFailures,
    wedged: runtime.wedged ?? false,
  };

  const wedged = market.wedged;
  const degraded = wedged || stalled;

  return {
    ok: !degraded,
    degraded,
    statusCode: degraded ? 503 : 200,
    stalled,
    wedged,
    ageMs,
    lastTickTs: state.lastTickTs,
    market,
  };
}

/**
 * In-memory counters/gauges the arb loop maintains and renders for /metrics (TASK 4a). The
 * arb bot drives a single market so the counters are scalar (no per-market label map). The
 * cumulative counters (ticks/swaps/failures/restarts) are restart-safe (seeded from the
 * persisted state file); the gauges (balance, lastTickTs, wedged) always reflect the live
 * tick. `swapsTotal` is keyed by purpose ('arb' | 'rebalance' | 'heartbeat') so an operator
 * can see WHY the bot is trading.
 */
export interface ArbMetricsSnapshot {
  ticksTotal: number;
  /** Swaps broadcast, by purpose ('arb' | 'rebalance' | 'heartbeat'). */
  swapsTotal: Record<string, number>;
  /** Failing ticks (RPC error, reverted swap, non-shrinking watchdog). */
  failuresTotal: number;
  /** Mined-but-reverted swaps. */
  revertsTotal: number;
  balanceWei: bigint;
  lastTickTs: number;
  /** 1 if the arb market is wedged, else 0. */
  wedged: number;
  /** Process boots (incremented once per start) — a crash-loop signal. */
  restartsTotal: number;
  /** Unix seconds of this process's start (the standard uptime gauge; resets on restart). */
  processStartTimeSec: number;
}

/** Escape a Prometheus label value (\\, ", and newlines per the exposition format). */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Render an ArbMetricsSnapshot as Prometheus text exposition (v0.0.4). PURE — no I/O.
 * Mirrors keeper/src/health.ts renderMetrics, namespaced `arb_*`. Counters: arb_ticks_total,
 * arb_swaps_total{purpose}, arb_failures_total, arb_reverts_total, arb_restarts_total.
 * Gauges: arb_balance_wei, arb_market_wedged, arb_last_tick_timestamp,
 * process_start_time_seconds.
 */
export function renderArbMetrics(m: ArbMetricsSnapshot): string {
  const lines: string[] = [];

  lines.push('# HELP arb_ticks_total Total completed arb ticks.');
  lines.push('# TYPE arb_ticks_total counter');
  lines.push(`arb_ticks_total ${m.ticksTotal}`);

  lines.push('# HELP arb_swaps_total Swaps broadcast, by purpose.');
  lines.push('# TYPE arb_swaps_total counter');
  for (const [purpose, n] of Object.entries(m.swapsTotal)) {
    lines.push(`arb_swaps_total{purpose="${escapeLabel(purpose)}"} ${n}`);
  }

  lines.push('# HELP arb_failures_total Failing/reverted/non-shrinking ticks.');
  lines.push('# TYPE arb_failures_total counter');
  lines.push(`arb_failures_total ${m.failuresTotal}`);

  lines.push('# HELP arb_reverts_total Mined-but-reverted swaps.');
  lines.push('# TYPE arb_reverts_total counter');
  lines.push(`arb_reverts_total ${m.revertsTotal}`);

  lines.push('# HELP arb_balance_wei Arb signer native balance (wei).');
  lines.push('# TYPE arb_balance_wei gauge');
  lines.push(`arb_balance_wei ${m.balanceWei.toString()}`);

  lines.push('# HELP arb_market_wedged 1 if the arb market is wedged, else 0.');
  lines.push('# TYPE arb_market_wedged gauge');
  lines.push(`arb_market_wedged ${m.wedged}`);

  lines.push('# HELP arb_last_tick_timestamp Unix ms of the last completed arb tick.');
  lines.push('# TYPE arb_last_tick_timestamp gauge');
  lines.push(`arb_last_tick_timestamp ${m.lastTickTs}`);

  lines.push('# HELP arb_restarts_total Process boots (incremented once per start).');
  lines.push('# TYPE arb_restarts_total counter');
  lines.push(`arb_restarts_total ${m.restartsTotal}`);

  lines.push('# HELP process_start_time_seconds Start time of the process since unix epoch in seconds.');
  lines.push('# TYPE process_start_time_seconds gauge');
  lines.push(`process_start_time_seconds ${m.processStartTimeSec}`);

  return lines.join('\n') + '\n';
}

/** Handle to the running arb health server so the loop can close it on shutdown. */
export interface ArbHealthServer {
  close(): void;
}

/**
 * Start the optional /health HTTP server on host:port using node:http (no new deps). The
 * caller passes a getArbHealthState accessor so the server always reflects LIVE loop state.
 * Returns a handle with close(). Only call when port > 0. Mirrors startHealthServer in
 * keeper/src/health.ts; binds to the loopback host by default (KEEPER_ARB_HTTP_HOST).
 *
 * TASK 4a — when `getMetrics` is supplied the server also serves GET /metrics (Prometheus
 * text), mirroring the lifecycle keeper's /metrics. It's OPTIONAL so existing callers/tests
 * that only pass getArbHealthState keep working (the /metrics route 404s without it).
 */
export function startArbHealthServer(opts: {
  host: string;
  port: number;
  pollIntervalMs: number;
  stallFactor: number;
  getArbHealthState: () => ArbHealthState;
  getMetrics?: () => ArbMetricsSnapshot;
  log: (o: Record<string, unknown>) => void;
}): ArbHealthServer {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (req.method === 'GET' && path === '/health') {
      const h = computeArbHealth(opts.getArbHealthState(), Date.now(), opts.pollIntervalMs, opts.stallFactor);
      const body = JSON.stringify({
        ok: h.ok,
        lastTickTs: h.lastTickTs,
        ageMs: h.ageMs === Infinity ? null : h.ageMs,
        stalled: h.stalled,
        wedged: h.wedged,
        market: h.market,
      });
      res.writeHead(h.statusCode, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && path === '/metrics' && opts.getMetrics) {
      const text = renderArbMetrics(opts.getMetrics());
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(text);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  server.on('error', (err) => {
    opts.log({ msg: 'arb.http.error', error: err instanceof Error ? err.message : String(err) });
  });

  server.listen(opts.port, opts.host, () => {
    opts.log({ msg: 'arb.http.listening', host: opts.host, port: opts.port });
  });

  return { close: () => server.close() };
}
