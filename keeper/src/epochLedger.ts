// epochLedger.ts - a restart-surviving record of the LAST arena epoch the swap bot already
// fired its once-per-epoch balanced pair into. PROBLEM: the epoch-mode swap bot must fire
// exactly ONE peg-neutral pair per epoch - no more (or it churns fees pointlessly and re-risks
// the peg) and no fewer (or a Stance win in a swap-less epoch earns nothing). In-memory state
// isn't enough: a crash + restart mid-epoch would forget it already acted and double-fire. So we
// persist a single scalar - the id of the last epoch we successfully acted in - and only fire
// when the live arena epoch differs from it.
//
// PURE by design (mirrors flowLedger.ts): parse/serialize/shouldActThisEpoch are clock- and
// I/O-free and unit-tested; loadEpochLedger/saveEpochLedgerSync are the only functions that touch
// the filesystem, and both are best-effort - a missing or corrupt file reads back as a fresh
// ledger and a failed write is swallowed, so the ledger can never itself wedge the loop. The one
// subtlety vs the flow ledger: fresh (lastEpochActed=null) MUST act (any epoch differs from "never
// acted"), and a stamped id must be compared as a STRING so a uint64 epochId that overflows Number
// precision still round-trips exactly.
import { readFileSync, mkdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** The persisted ledger: just the id of the last epoch the bot successfully fired its pair into. */
export interface EpochLedger {
  lastEpochActed: string | null; // epochId as a decimal string (uint64-safe); null = never acted
}

/** A fresh ledger - the seed when no prior file exists (first ever boot): has never acted. */
export function freshEpochLedger(): EpochLedger {
  return { lastEpochActed: null };
}

/**
 * Coerce an unknown into a canonical decimal epoch-id string, or null if it isn't a clean
 * non-negative integer. Defensive: a hand-edited or truncated ledger must never throw. We keep the
 * id as a STRING (never a Number) so a uint64 epochId beyond 2^53 round-trips exactly - the whole
 * point of comparing epochs as strings.
 */
function coerceEpochId(v: unknown): string | null {
  let s: string;
  if (typeof v === 'string') s = v.trim();
  else if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
    s = String(v);
  } else return null;
  // A clean non-negative base-10 integer only - BigInt() would also accept '0x..' / whitespace,
  // but we want the canonical decimal form so the persisted value round-trips byte-for-byte.
  if (!/^\d+$/.test(s)) return null;
  return s;
}

/**
 * PURE idempotency test: has the bot NOT yet acted in `epochId`? True => fire the pair this tick.
 * A fresh ledger (lastEpochActed=null) always returns true (it has never acted, so any epoch is
 * new). Comparison is string-vs-string so a uint64 epochId is exact. The caller stamps
 * lastEpochActed=epochId only AFTER a successful pair, so a reverted attempt retries next tick but
 * still fires at most one SUCCESS per epoch.
 */
export function shouldActThisEpoch(ledger: EpochLedger, epochId: bigint): boolean {
  return ledger.lastEpochActed !== epochId.toString();
}

/**
 * Record that the bot acted in `epochId`, returning a NEW ledger (PURE - the input is never
 * mutated). The id is stored as its canonical decimal string.
 */
export function recordEpochActed(_ledger: EpochLedger, epochId: bigint): EpochLedger {
  return { lastEpochActed: epochId.toString() };
}

/**
 * Serialize a ledger to pretty JSON with a stable single-field shape so an operator inspecting /
 * diffing the file sees a consistent layout. PURE. lastEpochActed is already a decimal string (or
 * null), so there's no bigint to encode here.
 */
export function serializeEpochLedger(l: EpochLedger): string {
  return JSON.stringify({ lastEpochActed: l.lastEpochActed }, null, 2);
}

/**
 * Parse the raw JSON text of a ledger file into an EpochLedger, tolerating ANY corruption
 * (truncated write, hand-edit, schema drift). PURE - no I/O. A malformed or missing lastEpochActed
 * reads back as null (never acted) rather than failing the whole parse. Anything that isn't a JSON
 * object - non-JSON, a bare number, an array, null - reads back as a FRESH ledger (never throws),
 * so the IO layer has nothing to special-case.
 */
export function parseEpochLedger(s: string): EpochLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch {
    return freshEpochLedger();
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return freshEpochLedger();
  const r = raw as Record<string, unknown>;
  const id = coerceEpochId(r.lastEpochActed);
  return { lastEpochActed: id };
}

/**
 * Load the ledger from `path`. Best-effort and NEVER throws: a missing/unreadable file or corrupt
 * JSON both yield a FRESH ledger. NOTE this means a destroyed ledger reads as "never acted" - which
 * is the intended recovery path (an operator clearing a stuck ledger just deletes the file, so the
 * bot fires once for the current epoch), and a genuine stamp is durable because saveEpochLedgerSync
 * fsync's it.
 */
export function loadEpochLedger(path: string): EpochLedger {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return freshEpochLedger();
  }
  return parseEpochLedger(text);
}

/**
 * Persist the ledger to `path` atomically AND durably. Mirrors the flow ledger: openSync a temp
 * file, writeSync the bytes, fsyncSync the fd to flush the OS page cache to the device, closeSync,
 * THEN renameSync over the real path (rename is atomic, so a crash mid-write can't leave a
 * half-written ledger the next boot would discard). The parent dir is created if needed.
 * Best-effort and log-free: any failure (read-only FS, ENOSPC, perms, parent-not-a-dir) is
 * swallowed and the function returns void - a failed save must never crash the swap bot. Worst
 * case a lost write re-fires ONE extra pair after a restart, which is peg-neutral and harmless.
 */
export function saveEpochLedgerSync(l: EpochLedger, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, serializeEpochLedger(l));
      fsyncSync(fd); // flush to the device BEFORE the rename so the stamp is truly durable
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch {
    // best-effort: a failed write is swallowed (at worst one extra peg-neutral pair after a restart).
  }
}
