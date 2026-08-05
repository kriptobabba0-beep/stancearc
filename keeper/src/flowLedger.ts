// flowLedger.ts - a restart-surviving bound on the NET cirBTC the arb bot sells over a rolling
// window. PROBLEM: every single arb leg is sized/sanity-checked on its own, but nothing bounds
// the AGGREGATE one-way flow - a stuck price, a wide oracle gap, or a crash-loop that re-arms
// the sell on every boot can quietly bleed the whole cirBTC battery out one "reasonable" leg at
// a time, and that one-way drain is exactly what breaks the peg. This module is the ledger that
// tracks signed base flow (sells minus buys) and lets the decision module refuse once the net
// sold in the window hits a hard cap.
//
// Signed by design: a leg's deltaBase is +base when we SELL cirBTC and −base when we BUY it
// back, so a round-trip (sell then buy) nets to ~0 and doesn't eat the budget - only a true
// one-way drain does. The window is the same half-open `(now - window, now]` shape the spend
// breaker uses, so the boundary is deterministic and an event aged out exactly at the edge.
//
// PURE by design (mirrors spendBreaker.ts): all the record/prune/window/build/parse/serialize
// math is clock- and I/O-free and unit-tested; loadFlowLedger/saveFlowLedgerSync are the only
// functions that touch the filesystem, and both are best-effort - a missing or corrupt file
// reads back as a fresh ledger and a failed write is swallowed, so the ledger can never itself
// wedge the loop. BIGINT-SAFETY: base notional is raw 8dp cirBTC (a bigint); JSON has no
// bigint, so every event's deltaBase is persisted as a SIGNED DECIMAL STRING and parsed back
// with BigInt(). All public math stays in bigint.
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** One recorded swap leg: signed base notional (raw 8dp cirBTC). +sold (SELL_BASE), −bought (BUY_BASE). */
export interface FlowEvent {
  ts: number;
  deltaBase: string; // bigint stored as decimal string for JSON
}

/** The persisted ledger: just the rolling window of signed flow events. */
export interface FlowLedger {
  events: FlowEvent[];
}

/** The PURE snapshot injected into the arb decision (mirrors HeartbeatState in decideArb.ts). */
export interface FlowState {
  nowMs: number;
  windowMs: number;
  netSoldBase: bigint; // Σ deltaBase over events within (now-window, now]; can be negative if net buyer (no floor applied)
  maxNetSoldPerWindowBase: bigint; // the hard cap (raw cirBTC)
}

/** An empty ledger - the seed when no prior file exists (first ever boot). */
export function freshFlowLedger(): FlowLedger {
  return { events: [] };
}

/**
 * Coerce an unknown into a SIGNED base bigint, or null if it isn't a clean decimal integer
 * string/number. Defensive: a hand-edited or truncated ledger must never throw - a bad value is
 * dropped (returns null) so the caller can skip that event. Unlike the spend breaker we ACCEPT
 * negatives here, because a buy leg is a legitimate negative delta (that's the whole point - net
 * flow nets buys against sells).
 */
function coerceDelta(v: unknown): bigint | null {
  let s: string;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v)) return null;
    s = String(v);
  } else return null;
  // A clean (optionally negative) base-10 integer - BigInt() would also accept '0x..' /
  // whitespace, but we want only canonical decimal so the persisted form round-trips exactly.
  if (!/^-?\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/**
 * Coerce an unknown into a finite, non-negative integer ms timestamp, or null. Accepts only a
 * number or a non-empty numeric string - NOT null/undefined/boolean (Number(null) is 0, which
 * would silently resurrect a dropped event at the epoch).
 */
function coerceTs(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return null;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Append a signed flow event at `ts`, returning a NEW ledger (PURE - the input is never
 * mutated). deltaBase is signed: positive = cirBTC SOLD this leg, negative = cirBTC BOUGHT.
 * recordFlow does NOT prune - pruning is a separate, explicit step (pruneWindow) so the caller
 * controls when the file is trimmed; this keeps record append-only and trivially correct.
 */
export function recordFlow(ledger: FlowLedger, ts: number, deltaBase: bigint): FlowLedger {
  return { events: [...ledger.events, { ts, deltaBase: deltaBase.toString() }] };
}

/**
 * Drop every event that has aged out of the window, returning a NEW ledger (PURE). We keep only
 * events with `ts > nowMs - windowMs` - strictly greater, so an event sitting exactly at the
 * lower edge is gone. This is the housekeeping that keeps the file bounded; it's intentionally
 * the same cutoff netSoldInWindow uses, so pruning never changes the in-window sum.
 */
export function pruneWindow(ledger: FlowLedger, nowMs: number, windowMs: number): FlowLedger {
  const cutoff = nowMs - windowMs;
  return { events: ledger.events.filter((e) => e.ts > cutoff) };
}

/**
 * Sum the signed deltaBase of every event in the half-open window `(now - windowMs, now]`.
 * PURE, all-bigint. The lower bound is STRICTLY greater than `now - windowMs` so an event at the
 * edge has aged out. The result CAN be negative - that just means the bot has been a net buyer
 * over the window (more cirBTC bought back than sold), and that's a healthy state, not an error.
 * A malformed persisted delta can't reach here because parseFlowLedger already dropped it.
 */
export function netSoldInWindow(ledger: FlowLedger, nowMs: number, windowMs: number): bigint {
  const lower = nowMs - windowMs;
  let sum = 0n;
  for (const e of ledger.events) {
    if (e.ts > lower && e.ts <= nowMs) sum += BigInt(e.deltaBase);
  }
  return sum;
}

/**
 * How much MORE base the bot may still sell this window before hitting the cap. PURE, bigint.
 *
 * The naive answer is `max - net`. Two clamps make it safe:
 *   - LOWER clamp at 0: once net sold has met or passed the cap there's no budget left, and a
 *     negative "budget" is meaningless - so `max(0, max - net)`.
 *   - UPPER clamp at `max`: when the bot is a net BUYER (net < 0), `max - net` exceeds `max`,
 *     which would hand out a sell budget LARGER than one window's cap. We must NOT let a long
 *     history of buys bank extra sell allowance - the cap is a per-window ceiling, not a
 *     credit line - so we pin the result at `max`.
 * Hence: clamp(max - net, 0, max). A net-buyer or net-flat state yields exactly the full cap.
 */
export function sellBudgetRemaining(netSoldBase: bigint, maxNetSoldPerWindowBase: bigint): bigint {
  const raw = maxNetSoldPerWindowBase - netSoldBase;
  const floored = raw > 0n ? raw : 0n; // max(0, max - net)
  return floored < maxNetSoldPerWindowBase ? floored : maxNetSoldPerWindowBase; // min(that, max)
}

/**
 * Convenience: compute the in-window net sold and pack a FlowState snapshot for the decision
 * module. PURE - netSoldBase is whatever netSoldInWindow returns (NO floor; can be negative),
 * because the floor logic belongs in sellBudgetRemaining, not in the raw snapshot.
 */
export function buildFlowState(
  ledger: FlowLedger,
  nowMs: number,
  windowMs: number,
  maxNetSoldPerWindowBase: bigint,
): FlowState {
  return {
    nowMs,
    windowMs,
    netSoldBase: netSoldInWindow(ledger, nowMs, windowMs),
    maxNetSoldPerWindowBase,
  };
}

/**
 * Serialize a ledger to pretty JSON with a stable shape (a single `events` array) so an
 * operator inspecting / diffing the file sees a consistent layout. PURE. deltaBase is already a
 * signed decimal string inside each event, so there's no bigint to encode here.
 */
export function serializeFlowLedger(l: FlowLedger): string {
  return JSON.stringify(
    {
      events: l.events.map((e) => ({ ts: e.ts, deltaBase: e.deltaBase })),
    },
    null,
    2,
  );
}

/**
 * Parse the raw JSON text of a ledger file into a FlowLedger, tolerating ANY corruption
 * (truncated write, hand-edit, schema drift). PURE - no I/O. Each event is individually coerced
 * and any malformed one (bad ts or bad delta) is DROPPED rather than failing the whole parse.
 * Anything that isn't a JSON object - non-JSON, a bare number, an array, null - reads back as a
 * FRESH ledger (never throws), so the IO layer has nothing to special-case.
 */
export function parseFlowLedger(s: string): FlowLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    return freshFlowLedger();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return freshFlowLedger();
  const r = raw as Record<string, unknown>;

  const events: FlowEvent[] = [];
  if (Array.isArray(r.events)) {
    for (const item of r.events) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const ts = coerceTs(e.ts);
      const delta = coerceDelta(e.deltaBase);
      if (ts === null || delta === null) continue; // drop the malformed event, keep the rest
      events.push({ ts, deltaBase: delta.toString() });
    }
  }
  return { events };
}

/**
 * Load the ledger from `path`. Best-effort and NEVER throws: a missing/unreadable file or
 * corrupt JSON both yield a FRESH ledger. NOTE this means a destroyed ledger reads as empty -
 * which is the intended recovery path (an operator clearing a stuck/poisoned ledger just deletes
 * the file), and a genuine flow record is durable because saveFlowLedgerSync fsync's it.
 */
export function loadFlowLedger(path: string): FlowLedger {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return freshFlowLedger();
  }
  return parseFlowLedger(text);
}

/**
 * Persist the ledger to `path` atomically AND durably. Mirrors the spend breaker: openSync a
 * temp file, writeSync the bytes, fsyncSync the fd to flush the OS page cache to the device,
 * closeSync, THEN renameSync over the real path (rename is atomic, so a crash mid-write can't
 * leave a half-written ledger the next boot would discard). The parent dir is created if needed.
 * Best-effort and log-free: any failure (read-only FS, ENOSPC, perms, parent-not-a-dir) is
 * swallowed and the function returns void - a failed save must never crash the keeper.
 */
export function saveFlowLedgerSync(l: FlowLedger, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, serializeFlowLedger(l));
      fsyncSync(fd); // flush to the device BEFORE the rename so the record is truly durable
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch {
    // best-effort: a failed write is swallowed (this record may be lost from the window).
  }
}
