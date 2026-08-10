// metricsState.ts — restart-safe COUNTER persistence. PROBLEM: index.ts / arb.ts hold the
// Prometheus counters (ticksTotal / actionsTotal / failuresTotal / revertsTotal) in process
// memory, so every restart zeroes them. Prometheus `rate()` / `increase()` treat a counter
// that goes DOWN as a reset and silently drop the interval — so under a crash-loop the
// alerting curves go quiet exactly when the keeper is least healthy.
//
// FIX (this module): persist the cumulative counters to a tiny JSON state file and, at
// startup, SEED the in-memory counters from it so the exported series only ever increases
// across restarts. We additionally surface a `process_start_time_seconds` gauge (so an
// operator can compute uptime + document the gauge reset) and a `*_restarts_total` counter
// (bumped once per boot) so a crash-loop is itself an observable, alertable signal even
// though the other counters now look continuous.
//
// PURE by design (mirrors backoff.ts / heartbeat.ts): all the merge/serialize/parse math is
// clock- and I/O-free and unit-tested; loadMetricsState/saveMetricsState are the only
// functions that touch the filesystem, and both are best-effort — a missing/corrupt/locked
// state file degrades to "start from zero" and is logged, never thrown, so persistence can
// NEVER wedge the loop it is meant to make more reliable.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The cumulative, restart-surviving counters. Deliberately a FLAT, additive shape so the
 * merge is a trivial element-wise sum — gauges (balance, lastTickTs, wedged) are NOT here
 * because a gauge's current value is re-derived each tick and must never be carried across a
 * restart. `restartsTotal` counts process boots (incremented by recordRestart at startup).
 */
export interface PersistedMetrics {
  ticksTotal: number;
  actionsTotal: Record<string, number>;
  failuresTotal: Record<string, number>;
  revertsTotal: number;
  restartsTotal: number;
}

/** A zeroed counter set — the seed when no prior state file exists (first ever boot). */
export function freshPersistedMetrics(): PersistedMetrics {
  return { ticksTotal: 0, actionsTotal: {}, failuresTotal: {}, revertsTotal: 0, restartsTotal: 0 };
}

/** Sum two label maps element-wise (used to merge actionsTotal / failuresTotal). PURE. */
function mergeCounterMap(
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) out[k] = (out[k] ?? 0) + v;
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
}

/** Coerce an unknown into a finite, non-negative integer counter (defensive parse). */
function coerceCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Coerce an unknown into a {label: count} counter map, dropping any malformed entries. */
function coerceCounterMap(v: unknown): Record<string, number> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = coerceCount(raw);
    if (n > 0) out[k] = n; // a 0 entry carries no information across a restart
  }
  return out;
}

/**
 * Parse the raw JSON text of a state file into a PersistedMetrics, tolerating ANY corruption
 * (truncated write, hand-edit, schema drift): every field is individually coerced and a
 * missing/garbage field falls back to its zero. PURE — no I/O. A parse failure is signalled
 * by returning null so the caller can log it; a structurally-valid-but-partial object is
 * salvaged field-by-field.
 */
export function parsePersistedMetrics(text: string): PersistedMetrics | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    ticksTotal: coerceCount(r.ticksTotal),
    actionsTotal: coerceCounterMap(r.actionsTotal),
    failuresTotal: coerceCounterMap(r.failuresTotal),
    revertsTotal: coerceCount(r.revertsTotal),
    restartsTotal: coerceCount(r.restartsTotal),
  };
}

/**
 * Increment the restart counter by one boot. PURE — returns a NEW object. Called once at
 * startup AFTER the prior state is loaded so `restartsTotal` reflects the boot we're in:
 * the very first boot (fresh, restartsTotal 0) becomes 1, and each subsequent boot adds 1,
 * making a crash-loop a monotonically-rising, alertable counter (`increase(...[1h])`).
 */
export function recordRestart(prev: PersistedMetrics): PersistedMetrics {
  return { ...prev, restartsTotal: prev.restartsTotal + 1 };
}

/**
 * Serialize counters for persistence. PURE. We only ever persist the CUMULATIVE counters
 * (so the file is the source of truth the next boot seeds from); gauges are intentionally
 * excluded. Stable key order keeps diffs/readability sane for an operator inspecting the
 * file. The current in-memory `ticks/actions/failures/reverts` are passed straight through
 * because the loop already seeded them from the prior file at boot — they ARE the running
 * cumulative total.
 */
export function serializeMetricsState(m: PersistedMetrics): string {
  return JSON.stringify(
    {
      ticksTotal: m.ticksTotal,
      revertsTotal: m.revertsTotal,
      restartsTotal: m.restartsTotal,
      actionsTotal: m.actionsTotal,
      failuresTotal: m.failuresTotal,
    },
    null,
    2,
  );
}

/**
 * Load the prior cumulative counters from `path`, recording the new boot. Best-effort:
 *   - no file / unreadable  -> a FRESH zeroed set (this is the first boot or the dir is new),
 *   - corrupt JSON          -> a FRESH zeroed set (a single bad file must not lose the keeper),
 * and in BOTH cases the failure is logged via `log` rather than thrown. The returned set has
 * already had recordRestart applied, so the caller seeds its in-memory counters directly
 * from it. Returns `{ metrics, loaded }` so the caller can log whether prior state was found.
 */
export function loadMetricsState(
  path: string,
  log: (o: Record<string, unknown>) => void,
): { metrics: PersistedMetrics; loaded: boolean } {
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is the normal first-boot case — log at info; anything else is worth surfacing.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      log({ msg: 'metrics.state.read.error', path, error: err instanceof Error ? err.message : String(err) });
    }
    return { metrics: recordRestart(freshPersistedMetrics()), loaded: false };
  }
  const parsed = parsePersistedMetrics(text);
  if (parsed === null) {
    log({ msg: 'metrics.state.parse.error', path });
    return { metrics: recordRestart(freshPersistedMetrics()), loaded: false };
  }
  return { metrics: recordRestart(parsed), loaded: true };
}

/**
 * Persist the current cumulative counters to `path` atomically (write a temp file then
 * rename, so a crash mid-write can't leave a truncated file the next boot would discard).
 * Best-effort: any failure (read-only FS, ENOSPC, perms) is logged and swallowed — a failed
 * metrics save must never crash the keeper. Creates the parent dir if needed. Returns true
 * on success so a test/caller can assert the persist happened.
 */
export function saveMetricsState(
  path: string,
  m: PersistedMetrics,
  log: (o: Record<string, unknown>) => void,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serializeMetricsState(m), 'utf8');
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log({ msg: 'metrics.state.write.error', path, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
