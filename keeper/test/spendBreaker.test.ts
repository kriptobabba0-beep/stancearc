import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freshLedger,
  recordSpend,
  windowSpendWei,
  evaluateCap,
  markTripped,
  parseLedger,
  serializeLedger,
  loadLedger,
  saveLedgerSync,
  type SpendLedger,
  type SpendCaps,
} from '../src/spendBreaker.js';

const noop = () => {};

const HOUR = 3_600_000;
const BURST = 600_000;

// A representative cap set: 1 ether sustained / hour, 0.3 ether burst / 10 min.
const caps: SpendCaps = {
  hourCapWei: 1_000_000_000_000_000_000n,
  hourWindowMs: HOUR,
  burstCapWei: 300_000_000_000_000_000n,
  burstWindowMs: BURST,
};

describe('spendBreaker — freshLedger', () => {
  it('is empty and healthy (no events, not tripped)', () => {
    expect(freshLedger()).toEqual({ events: [], trippedAt: null, trippedReason: null });
  });
});

describe('spendBreaker — recordSpend (append + prune)', () => {
  it('appends a positive spend and is pure (input untouched)', () => {
    const l0 = freshLedger();
    const l1 = recordSpend(l0, 1000, 5n, HOUR);
    expect(l1.events).toEqual([{ ts: 1000, wei: '5' }]);
    expect(l0.events).toEqual([]); // input not mutated
  });

  it('prunes events older than now - retainMs', () => {
    let l = freshLedger();
    l = recordSpend(l, 1_000, 10n, HOUR); // old
    l = recordSpend(l, 2_000, 20n, HOUR); // old
    // Now record well past the retain window; the two old events must drop out.
    const now = 1_000 + HOUR + 1; // cutoff = now - HOUR = 1; events at ts<=1 drop, ts 1000/2000 survive only if > cutoff
    const after = recordSpend(l, now, 30n, HOUR);
    // cutoff = now - HOUR = 1001 -> ts 1000 pruned, ts 2000 kept, new ts kept.
    expect(after.events.map((e) => e.ts)).toEqual([2_000, now]);
  });

  it('skips the append for wei <= 0 but STILL prunes', () => {
    let l = freshLedger();
    l = recordSpend(l, 1_000, 10n, HOUR);
    // A zero-spend tick at a much later ts: no new event, and the old one prunes out.
    const now = 1_000 + HOUR + 5;
    const after = recordSpend(l, now, 0n, HOUR);
    expect(after.events).toEqual([]); // old event pruned, zero not appended
  });

  it('carries the trip latch through untouched', () => {
    let l = markTripped(freshLedger(), 500, 'burst-cap');
    l = recordSpend(l, 1_000, 10n, HOUR);
    expect(l.trippedAt).toBe(500);
    expect(l.trippedReason).toBe('burst-cap');
  });
});

describe('spendBreaker — windowSpendWei', () => {
  it('sums only events inside (now - windowMs, now]', () => {
    const l: SpendLedger = {
      events: [
        { ts: 100, wei: '1' },
        { ts: 200, wei: '2' },
        { ts: 300, wei: '4' },
      ],
      trippedAt: null,
      trippedReason: null,
    };
    // window of 150 ending at 300 -> lower bound = 150, so ts 100 excluded, 200 + 300 in.
    expect(windowSpendWei(l, 300, 150)).toBe(6n);
  });

  it('excludes the event exactly at the lower edge (strictly greater than now - windowMs)', () => {
    const l: SpendLedger = {
      events: [
        { ts: 100, wei: '7' }, // exactly at now - windowMs -> aged out
        { ts: 101, wei: '3' },
      ],
      trippedAt: null,
      trippedReason: null,
    };
    expect(windowSpendWei(l, 200, 100)).toBe(3n); // lower bound = 100, ts 100 excluded
  });

  it('includes the event exactly at now (upper bound inclusive) and returns bigint', () => {
    const l: SpendLedger = { events: [{ ts: 200, wei: '9' }], trippedAt: null, trippedReason: null };
    const got = windowSpendWei(l, 200, 100);
    expect(got).toBe(9n);
    expect(typeof got).toBe('bigint');
  });
});

describe('spendBreaker — evaluateCap', () => {
  it('is healthy when both windows are under cap', () => {
    let l = freshLedger();
    l = recordSpend(l, 1_000, 100n, HOUR);
    expect(evaluateCap(l, 1_000, caps)).toEqual({ tripped: false, reason: null });
  });

  it('trips on hour-cap exceed (sustained burn under the burst cap)', () => {
    // One spend just over the hour cap but spread so the burst window (last 10 min) is empty.
    const l: SpendLedger = {
      events: [{ ts: 1_000, wei: (caps.hourCapWei + 1n).toString() }],
      trippedAt: null,
      trippedReason: null,
    };
    // Evaluate far enough past 1_000 that it's outside the burst window but inside the hour.
    const now = 1_000 + BURST + 1; // burst lower bound passes ts 1_000, hour still covers it
    expect(evaluateCap(l, now, caps)).toEqual({ tripped: true, reason: 'hour-cap' });
  });

  it('trips on burst-cap exceed and names burst-cap', () => {
    // A storm just over the burst cap but under the hour cap, all inside the burst window.
    const l: SpendLedger = {
      events: [{ ts: 1_000, wei: (caps.burstCapWei + 1n).toString() }],
      trippedAt: null,
      trippedReason: null,
    };
    // burst+1 < hourCap, so only the burst window is exceeded.
    expect(caps.burstCapWei + 1n <= caps.hourCapWei).toBe(true);
    expect(evaluateCap(l, 1_000, caps)).toEqual({ tripped: true, reason: 'burst-cap' });
  });

  it('STICKY: stays tripped with the stored reason even after the window empties', () => {
    let l = markTripped(freshLedger(), 1_000, 'burst-cap');
    // No events at all now (the spend has long since aged out), yet the latch holds.
    const now = 1_000 + HOUR * 10;
    expect(evaluateCap(l, now, caps)).toEqual({ tripped: true, reason: 'burst-cap' });
  });
});

describe('spendBreaker — markTripped', () => {
  it('latches with the given ts/reason (pure, input untouched)', () => {
    const l0 = freshLedger();
    const l1 = markTripped(l0, 1_234, 'hour-cap');
    expect(l1.trippedAt).toBe(1_234);
    expect(l1.trippedReason).toBe('hour-cap');
    expect(l0.trippedAt).toBeNull(); // input not mutated
  });

  it('keeps the FIRST trippedAt/reason on a re-trip (idempotent, first-write-wins)', () => {
    let l = markTripped(freshLedger(), 1_000, 'burst-cap');
    l = markTripped(l, 5_000, 'hour-cap'); // a later re-trip must not overwrite
    expect(l.trippedAt).toBe(1_000);
    expect(l.trippedReason).toBe('burst-cap');
  });
});

describe('spendBreaker — parseLedger (corruption-tolerant)', () => {
  it('round-trips a serialized ledger', () => {
    const l: SpendLedger = {
      events: [
        { ts: 1, wei: '1000000000000000000' },
        { ts: 2, wei: '5' },
      ],
      trippedAt: 99,
      trippedReason: 'hour-cap',
    };
    expect(parseLedger(serializeLedger(l))).toEqual(l);
  });

  it('returns null on non-JSON garbage and on non-object JSON', () => {
    expect(parseLedger('{ not json')).toBeNull();
    expect(parseLedger('')).toBeNull();
    expect(parseLedger('42')).toBeNull();
    expect(parseLedger('[1,2,3]')).toBeNull();
    expect(parseLedger('null')).toBeNull();
  });

  it('salvages partial JSON (missing events -> empty, no trip)', () => {
    expect(parseLedger('{"trippedAt": null}')).toEqual({
      events: [],
      trippedAt: null,
      trippedReason: null,
    });
  });

  it('drops malformed events but keeps the good ones', () => {
    const text = JSON.stringify({
      events: [
        { ts: 1, wei: '10' }, // good
        { ts: 2, wei: '-5' }, // bad wei (negative) -> dropped
        { ts: 3, wei: 'oops' }, // bad wei (non-numeric) -> dropped
        { ts: -1, wei: '4' }, // bad ts -> dropped
        { ts: 4, wei: '7' }, // good
        'nope', // not an object -> dropped
      ],
      trippedAt: null,
      trippedReason: null,
    });
    expect(parseLedger(text)!.events).toEqual([
      { ts: 1, wei: '10' },
      { ts: 4, wei: '7' },
    ]);
  });

  it('reads as healthy when trippedAt is garbage even if a reason is present', () => {
    const text = JSON.stringify({ events: [], trippedAt: 'soon', trippedReason: 'hour-cap' });
    expect(parseLedger(text)).toEqual({ events: [], trippedAt: null, trippedReason: null });
  });
});

describe('spendBreaker — serializeLedger', () => {
  it('emits stable top-level key order', () => {
    const text = serializeLedger(freshLedger());
    expect(Object.keys(JSON.parse(text))).toEqual(['events', 'trippedAt', 'trippedReason']);
  });
});

describe('spendBreaker — load/save round-trip (filesystem, durable + best-effort)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spend-breaker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadLedger on a missing path returns a fresh ledger and logs nothing', () => {
    const log = vi.fn();
    const l = loadLedger(join(dir, 'ledger.json'), log);
    expect(l).toEqual(freshLedger());
    expect(log).not.toHaveBeenCalled(); // ENOENT is the normal first-boot case
  });

  it('saveLedgerSync then loadLedger round-trips a TRIPPED ledger (the latch survives a restart)', () => {
    const path = join(dir, 'ledger.json');
    const log = vi.fn();
    let l = recordSpend(freshLedger(), 1_000, 1_000_000_000_000_000_000n, HOUR);
    l = markTripped(l, 1_000, 'hour-cap');
    expect(saveLedgerSync(path, l, log)).toBe(true);

    const loaded = loadLedger(path, log);
    expect(loaded).toEqual(l);
    // And the loaded ledger still reads as tripped — a crash-loop can't reset it.
    expect(evaluateCap(loaded, 1_000 + HOUR * 10, caps)).toEqual({ tripped: true, reason: 'hour-cap' });
  });

  it('creates the parent directory and writes a parseable file', () => {
    const path = join(dir, 'nested', 'deeper', 'ledger.json');
    const log = vi.fn();
    expect(saveLedgerSync(path, freshLedger(), log)).toBe(true);
    expect(parseLedger(readFileSync(path, 'utf8'))).not.toBeNull();
  });

  it('corrupt file on load -> fresh ledger + logged parse error, never throws', () => {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, '{ truncated', 'utf8');
    const log = vi.fn();
    const l = loadLedger(path, log);
    expect(l).toEqual(freshLedger());
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'spend.ledger.parse.error' }));
  });

  it('save failure is swallowed + logged (returns false), never throws', () => {
    const log = vi.fn();
    // Make the would-be parent a regular file so mkdir/open fails.
    const filePath = join(dir, 'iam-a-file');
    writeFileSync(filePath, 'x', 'utf8');
    const badPath = join(filePath, 'ledger.json'); // parent is not a directory
    expect(saveLedgerSync(badPath, freshLedger(), log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'spend.ledger.write.error' }));
  });
});
