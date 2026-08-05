// spendBreaker.ts - the absolute, restart-surviving backstop on keeper gas SPEND. PROBLEM:
// every other guard (gas floor, escalation cap, per-tx ceilings) bounds a SINGLE broadcast,
// but nothing bounds the AGGREGATE drain across many broadcasts - a stuck market, a bad
// price feed, or a crash-loop that re-broadcasts on every boot can quietly burn the signer's
// whole balance one "reasonable" tx at a time. This module is the circuit-breaker that caps
// the TOTAL native wei spent in a rolling window and, once that cap is blown, STOPS all
// cranking.
//
// Two windows so we catch both shapes of drain: a long "hour" window (a sustained-burn cap)
// and a short "burst" window (a storm cap that trips fast when something hammers the chain).
//
// The trip is STICKY and PERSISTED. Once tripped we write trippedAt/trippedReason to the
// ledger file and NEVER clear them on our own - so a crash-loop cannot reset the breaker by
// restarting (the whole point of the backstop is to survive the failure mode that triggered
// it). Recovery is a deliberate operator action: delete the ledger file. The loop must call
// saveLedgerSync (fsync'd) immediately BEFORE each broadcast so the spend is durable on disk
// even if the broadcast is the thing that kills the process.
//
// PURE by design (mirrors metricsState.ts): all the record/window/evaluate/parse/serialize
// math is clock- and I/O-free and unit-tested; loadLedger/saveLedgerSync are the only
// functions that touch the filesystem, and both are best-effort - every IO failure is logged
// via the injected `log` and swallowed, never thrown, so the breaker can't itself wedge the
// loop. BIGINT-SAFETY: native spend is wei (a bigint); JSON can't carry bigint, so we persist
// every wei value as a DECIMAL STRING and parse it back with BigInt(). All public math stays
// in bigint.
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** One broadcast's spend. `wei` is a DECIMAL STRING because JSON has no bigint. */
export interface SpendEvent {
  ts: number;
  wei: string;
}

/**
 * The persisted ledger: the rolling window of spend events plus the STICKY trip latch. When
 * `trippedAt` is non-null the breaker is open (cranking stopped) and stays that way across
 * restarts until an operator deletes the file - `trippedReason` records which cap blew first
 * so the trip is self-explanatory in logs/metrics.
 */
export interface SpendLedger {
  events: SpendEvent[];
  trippedAt: number | null;
  trippedReason: string | null;
}

/**
 * The caps the loop enforces. Two independent (window, cap) pairs: `hour*` bounds sustained
 * spend, `burst*` bounds a short storm. Both are checked every evaluate - exceeding EITHER
 * trips. Caps are bigint wei; windows are milliseconds.
 */
export interface SpendCaps {
  hourCapWei: bigint;
  hourWindowMs: number;
  burstCapWei: bigint;
  burstWindowMs: number;
}

/** A healthy, empty ledger - the seed when no prior file exists (first ever boot). */
export function freshLedger(): SpendLedger {
  return { events: [], trippedAt: null, trippedReason: null };
}

/**
 * Coerce an unknown into a non-negative wei bigint, or null if it isn't a clean decimal wei
 * string/number. Defensive: a hand-edited or truncated ledger must never throw here - a bad
 * value is dropped (returns null) so the caller can skip that event rather than crash. We
 * reject negatives because spend is never negative and a negative entry could mask a real
 * drain by cancelling out the sum.
 */
function coerceWei(v: unknown): bigint | null {
  let s: string;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return null;
    s = String(v);
  } else return null;
  // A clean non-negative integer in base 10 - BigInt() would accept '0x..' / whitespace but
  // we want only canonical decimal so the persisted form is unambiguous and round-trips.
  if (!/^\d+$/.test(s)) return null;
  try {
    return BigInt(s);
  } catch {
    return null;
  }
}

/**
 * Coerce an unknown into a finite, non-negative integer ms timestamp, or null. We accept only
 * a number or a numeric string - crucially NOT null/undefined/boolean, because Number(null) is
 * 0 and a healthy `trippedAt: null` must read back as null (healthy), never as 0 (tripped at
 * the epoch). That distinction is the whole point of the latch.
 */
function coerceTs(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  else return null;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Append a spend event at `ts` and PRUNE everything older than `now - retainMs`, returning a
 * NEW ledger (PURE - the input is never mutated). Pruning keeps the file bounded; `retainMs`
 * MUST be >= the longest window (hourWindowMs) or the window sums would lose still-relevant
 * events. A non-positive `wei` carries no spend, so we skip the append but STILL prune (the
 * call is also our natural housekeeping tick). The trip latch is carried through untouched.
 */
export function recordSpend(ledger: SpendLedger, ts: number, wei: bigint, retainMs: number): SpendLedger {
  const cutoff = ts - retainMs;
  const kept = ledger.events.filter((e) => e.ts > cutoff);
  if (wei > 0n) kept.push({ ts, wei: wei.toString() });
  return { events: kept, trippedAt: ledger.trippedAt, trippedReason: ledger.trippedReason };
}

/**
 * Sum the wei of every event whose ts falls in the half-open window `(now - windowMs, now]`.
 * PURE, all-bigint. The lower bound is STRICTLY greater than `now - windowMs` so an event
 * exactly at the window edge has aged out - that keeps the window a true "last windowMs" and
 * makes the boundary deterministic for tests. A malformed persisted wei can't reach here
 * because parseLedger already dropped it.
 */
export function windowSpendWei(ledger: SpendLedger, now: number, windowMs: number): bigint {
  const lower = now - windowMs;
  let sum = 0n;
  for (const e of ledger.events) {
    if (e.ts > lower && e.ts <= now) sum += BigInt(e.wei);
  }
  return sum;
}

/**
 * Decide whether the breaker is OPEN right now, honoring the sticky latch. PURE. Order
 * matters: if the ledger is already tripped we report that immediately with the STORED
 * reason - a window that has since drained back under the cap must NOT silently re-arm the
 * keeper, because the trip is a deliberate, operator-cleared latch. Otherwise we check the
 * live windows: hour first (the sustained cap), then burst (the storm cap), and trip on the
 * first cap that is strictly exceeded.
 */
export function evaluateCap(
  ledger: SpendLedger,
  now: number,
  caps: SpendCaps,
): { tripped: boolean; reason: string | null } {
  if (ledger.trippedAt !== null) {
    return { tripped: true, reason: ledger.trippedReason };
  }
  if (windowSpendWei(ledger, now, caps.hourWindowMs) > caps.hourCapWei) {
    return { tripped: true, reason: 'hour-cap' };
  }
  if (windowSpendWei(ledger, now, caps.burstWindowMs) > caps.burstCapWei) {
    return { tripped: true, reason: 'burst-cap' };
  }
  return { tripped: false, reason: null };
}

/**
 * Latch the breaker OPEN, returning a NEW ledger (PURE). Idempotent and FIRST-write-wins: if
 * the ledger is already tripped we keep the original trippedAt/trippedReason - the first trip
 * is the one that matters (it records when/why the drain was first caught), and re-trips on
 * later ticks must not overwrite that history or move the timestamp forward.
 */
export function markTripped(ledger: SpendLedger, now: number, reason: string): SpendLedger {
  if (ledger.trippedAt !== null) return ledger;
  return { events: ledger.events, trippedAt: now, trippedReason: reason };
}

/**
 * Parse the raw JSON text of a ledger file into a SpendLedger, tolerating ANY corruption
 * (truncated write, hand-edit, schema drift). PURE - no I/O. Each event is individually
 * coerced and any malformed one (bad ts or bad wei) is DROPPED rather than failing the whole
 * parse - losing one spend record is far safer than discarding the entire ledger (which would
 * also drop a persisted trip). The trip latch is coerced field-by-field. Returns null ONLY
 * when the text isn't a JSON object (so the caller can fall back to a fresh ledger and log).
 */
export function parseLedger(text: string): SpendLedger | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const events: SpendEvent[] = [];
  if (Array.isArray(r.events)) {
    for (const item of r.events) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const ts = coerceTs(e.ts);
      const wei = coerceWei(e.wei);
      if (ts === null || wei === null) continue; // drop the malformed event, keep the rest
      events.push({ ts, wei: wei.toString() });
    }
  }

  // The trip latch: trippedAt must be a real ms timestamp to count as tripped; anything else
  // (missing, null, garbage) reads as healthy. The reason is kept only when actually tripped.
  const trippedAt = coerceTs(r.trippedAt);
  const trippedReason =
    trippedAt !== null && typeof r.trippedReason === 'string' ? r.trippedReason : null;

  return { events, trippedAt, trippedReason };
}

/**
 * Serialize a ledger to pretty JSON with a STABLE top-level key order (events, trippedAt,
 * trippedReason) so an operator inspecting / diffing the file sees a consistent layout. PURE.
 * Wei is already a decimal string inside each event, so there's no bigint to encode here.
 */
export function serializeLedger(l: SpendLedger): string {
  return JSON.stringify(
    {
      events: l.events.map((e) => ({ ts: e.ts, wei: e.wei })),
      trippedAt: l.trippedAt,
      trippedReason: l.trippedReason,
    },
    null,
    2,
  );
}

/**
 * Load the ledger from `path`. Best-effort:
 *   - no file / unreadable -> a FRESH healthy ledger (first boot, or the dir is new),
 *   - corrupt JSON         -> a FRESH healthy ledger (a single bad file must not wedge boot),
 * and in BOTH cases the failure is logged via `log` rather than thrown. NOTE this means a
 * truly destroyed ledger reads as healthy - that's the intended recovery path (an operator
 * who wants to clear a stuck trip deletes the file), and a genuine trip is durable because
 * saveLedgerSync fsync's it to disk before each broadcast.
 */
export function loadLedger(path: string, log: (o: Record<string, unknown>) => void): SpendLedger {
  let text: string | undefined;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    // ENOENT is the normal first-boot case - log at info level only; anything else surfaces.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      log({ msg: 'spend.ledger.read.error', path, error: err instanceof Error ? err.message : String(err) });
    }
    return freshLedger();
  }
  const parsed = parseLedger(text);
  if (parsed === null) {
    log({ msg: 'spend.ledger.parse.error', path });
    return freshLedger();
  }
  return parsed;
}

/**
 * Persist the ledger to `path` atomically AND durably, returning true on success. The loop
 * calls this immediately BEFORE each broadcast, so the spend must be on disk before we return
 * - otherwise a broadcast that kills the process (OOM, SIGKILL, power loss) could leave the
 * spend unrecorded and let the breaker under-count the drain. We therefore openSync the temp
 * file, writeSync the bytes, fsyncSync the fd to flush the OS page cache to the physical
 * device, closeSync, THEN renameSync over the real path (rename is atomic, so a crash mid-
 * write can't leave a half-written ledger the next boot would discard). Best-effort: any
 * failure (read-only FS, ENOSPC, perms) is logged and swallowed - a failed save must never
 * crash the keeper, though it does mean THIS spend may be lost from the window.
 */
export function saveLedgerSync(
  path: string,
  ledger: SpendLedger,
  log: (o: Record<string, unknown>) => void,
): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, serializeLedger(ledger));
      fsyncSync(fd); // flush to the device BEFORE the rename so the spend is truly durable
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    return true;
  } catch (err) {
    log({ msg: 'spend.ledger.write.error', path, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
