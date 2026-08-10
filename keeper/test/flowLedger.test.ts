import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freshFlowLedger,
  recordFlow,
  pruneWindow,
  netSoldInWindow,
  sellBudgetRemaining,
  buildFlowState,
  serializeFlowLedger,
  parseFlowLedger,
  loadFlowLedger,
  saveFlowLedgerSync,
  type FlowLedger,
} from '../src/flowLedger.js';

// One hour of rolling window for most of the cases below.
const WINDOW = 3_600_000;

// A representative cap: 0.5 cirBTC net sold per window (raw 8dp -> 50_000_000).
const MAX = 50_000_000n;

describe('flowLedger — freshFlowLedger', () => {
  it('is empty (no events)', () => {
    expect(freshFlowLedger()).toEqual({ events: [] });
  });
});

describe('flowLedger — recordFlow (append + immutable)', () => {
  it('appends a signed event and is pure (input untouched)', () => {
    const l0 = freshFlowLedger();
    const l1 = recordFlow(l0, 1_000, 5n);
    expect(l1.events).toEqual([{ ts: 1_000, deltaBase: '5' }]);
    expect(l0.events).toEqual([]); // input not mutated
  });

  it('records a BUY (negative delta) as a signed decimal string', () => {
    const l = recordFlow(freshFlowLedger(), 2_000, -7n);
    expect(l.events).toEqual([{ ts: 2_000, deltaBase: '-7' }]);
  });

  it('appends in order without dropping anything (recordFlow does not prune)', () => {
    let l = freshFlowLedger();
    l = recordFlow(l, 1_000, 10n);
    l = recordFlow(l, 2_000, -4n);
    l = recordFlow(l, 3_000, 6n);
    expect(l.events).toEqual([
      { ts: 1_000, deltaBase: '10' },
      { ts: 2_000, deltaBase: '-4' },
      { ts: 3_000, deltaBase: '6' },
    ]);
  });
});

describe('flowLedger — pruneWindow', () => {
  it('drops only stale events; keeps events strictly inside the window (pure)', () => {
    const l: FlowLedger = {
      events: [
        { ts: 100, deltaBase: '1' },
        { ts: 200, deltaBase: '2' },
        { ts: 300, deltaBase: '4' },
      ],
    };
    // window of 150 ending at 300 -> cutoff = 150, so ts 100 drops, 200 & 300 stay.
    const pruned = pruneWindow(l, 300, 150);
    expect(pruned.events).toEqual([
      { ts: 200, deltaBase: '2' },
      { ts: 300, deltaBase: '4' },
    ]);
    // input untouched
    expect(l.events).toHaveLength(3);
  });

  it('boundary: ts exactly at now - windowMs is DROPPED, ts just inside is KEPT', () => {
    const l: FlowLedger = {
      events: [
        { ts: 100, deltaBase: '7' }, // exactly at now - windowMs -> aged out
        { ts: 101, deltaBase: '3' }, // one ms inside -> kept
      ],
    };
    const pruned = pruneWindow(l, 200, 100); // cutoff = 100
    expect(pruned.events).toEqual([{ ts: 101, deltaBase: '3' }]);
  });
});

describe('flowLedger — netSoldInWindow', () => {
  it('sums signed deltas inside (now - windowMs, now]', () => {
    const l: FlowLedger = {
      events: [
        { ts: 100, deltaBase: '10' },
        { ts: 200, deltaBase: '20' },
        { ts: 300, deltaBase: '40' },
      ],
    };
    // window 150 ending at 300 -> cutoff 150, so 100 excluded, 20 + 40 = 60.
    const got = netSoldInWindow(l, 300, 150);
    expect(got).toBe(60n);
    expect(typeof got).toBe('bigint');
  });

  it('nets NEGATIVE when buys outweigh sells in the window', () => {
    const l: FlowLedger = {
      events: [
        { ts: 1_000, deltaBase: '30' }, // sold
        { ts: 2_000, deltaBase: '-100' }, // bought
        { ts: 3_000, deltaBase: '20' }, // sold
      ],
    };
    expect(netSoldInWindow(l, 3_000, WINDOW)).toBe(-50n); // 30 - 100 + 20
  });

  it('excludes events outside the window (both stale and exactly at the lower edge)', () => {
    const l: FlowLedger = {
      events: [
        { ts: 100, deltaBase: '999' }, // exactly at cutoff -> excluded
        { ts: 150, deltaBase: '5' },
        { ts: 200, deltaBase: '11' },
      ],
    };
    // cutoff = 200 - 100 = 100, so ts 100 excluded, 5 + 11 = 16.
    expect(netSoldInWindow(l, 200, 100)).toBe(16n);
  });

  it('is zero on an empty ledger', () => {
    expect(netSoldInWindow(freshFlowLedger(), 1_000, WINDOW)).toBe(0n);
  });
});

describe('flowLedger — sellBudgetRemaining', () => {
  it('returns the FULL cap when net sold is zero', () => {
    expect(sellBudgetRemaining(0n, MAX)).toBe(MAX);
  });

  it('returns the FULL cap (clamped) when net sold is NEGATIVE (a net buyer)', () => {
    // max - (-big) would exceed max; the clamp pins it at max so a long buy history
    // can never grant more than one window's worth of sell budget.
    expect(sellBudgetRemaining(-1_000_000_000n, MAX)).toBe(MAX);
  });

  it('returns the partial remainder when 0 < net sold < cap', () => {
    expect(sellBudgetRemaining(20_000_000n, MAX)).toBe(30_000_000n);
  });

  it('returns ZERO when net sold equals the cap', () => {
    expect(sellBudgetRemaining(MAX, MAX)).toBe(0n);
  });

  it('returns ZERO (never negative) when net sold exceeds the cap', () => {
    expect(sellBudgetRemaining(MAX + 12_345n, MAX)).toBe(0n);
  });
});

describe('flowLedger — buildFlowState', () => {
  it('packs nowMs/windowMs/cap and computes netSoldBase from the window', () => {
    const l: FlowLedger = {
      events: [
        { ts: 1_000, deltaBase: '40' },
        { ts: 2_000, deltaBase: '-15' },
      ],
    };
    const s = buildFlowState(l, 2_000, WINDOW, MAX);
    expect(s).toEqual({
      nowMs: 2_000,
      windowMs: WINDOW,
      netSoldBase: 25n, // 40 - 15
      maxNetSoldPerWindowBase: MAX,
    });
  });

  it('netSoldBase can be negative (net buyer) — no floor applied', () => {
    const l: FlowLedger = { events: [{ ts: 1_000, deltaBase: '-80' }] };
    const s = buildFlowState(l, 1_000, WINDOW, MAX);
    expect(s.netSoldBase).toBe(-80n);
  });
});

describe('flowLedger — serialize / parse (corruption-tolerant)', () => {
  it('round-trips a serialized ledger', () => {
    const l: FlowLedger = {
      events: [
        { ts: 1, deltaBase: '100000000' },
        { ts: 2, deltaBase: '-5' },
      ],
    };
    expect(parseFlowLedger(serializeFlowLedger(l))).toEqual(l);
  });

  it('emits a stable top-level shape (events array)', () => {
    const text = serializeFlowLedger(freshFlowLedger());
    expect(Object.keys(JSON.parse(text))).toEqual(['events']);
  });

  it('returns a fresh ledger on non-JSON garbage and non-object JSON', () => {
    expect(parseFlowLedger('{ not json')).toEqual(freshFlowLedger());
    expect(parseFlowLedger('')).toEqual(freshFlowLedger());
    expect(parseFlowLedger('42')).toEqual(freshFlowLedger());
    expect(parseFlowLedger('[1,2,3]')).toEqual(freshFlowLedger());
    expect(parseFlowLedger('null')).toEqual(freshFlowLedger());
  });

  it('salvages partial JSON (missing events -> empty)', () => {
    expect(parseFlowLedger('{"foo": 1}')).toEqual(freshFlowLedger());
  });

  it('drops malformed events but keeps the good ones (signs preserved)', () => {
    const text = JSON.stringify({
      events: [
        { ts: 1, deltaBase: '10' }, // good
        { ts: 2, deltaBase: '-5' }, // good (negative is valid here)
        { ts: 3, deltaBase: 'oops' }, // bad delta (non-numeric) -> dropped
        { ts: -1, deltaBase: '4' }, // bad ts -> dropped
        { ts: 5, deltaBase: '1.5' }, // bad delta (non-integer) -> dropped
        'nope', // not an object -> dropped
      ],
    });
    expect(parseFlowLedger(text).events).toEqual([
      { ts: 1, deltaBase: '10' },
      { ts: 2, deltaBase: '-5' },
    ]);
  });
});

describe('flowLedger — load/save round-trip (filesystem, durable + best-effort)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-ledger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('saveFlowLedgerSync then loadFlowLedger round-trips the ledger', () => {
    const path = join(dir, 'flow.json');
    let l = recordFlow(freshFlowLedger(), 1_000, 40_000_000n);
    l = recordFlow(l, 2_000, -10_000_000n);
    saveFlowLedgerSync(l, path);
    expect(loadFlowLedger(path)).toEqual(l);
  });

  it('loadFlowLedger on a missing path returns a fresh ledger (no throw)', () => {
    expect(loadFlowLedger(join(dir, 'nope.json'))).toEqual(freshFlowLedger());
  });

  it('creates the parent directory and writes a parseable file', () => {
    const path = join(dir, 'nested', 'deeper', 'flow.json');
    saveFlowLedgerSync(freshFlowLedger(), path);
    expect(parseFlowLedger(readFileSync(path, 'utf8'))).toEqual(freshFlowLedger());
  });

  it('corrupt file on load -> fresh ledger, never throws', () => {
    const path = join(dir, 'flow.json');
    writeFileSync(path, '{ truncated', 'utf8');
    expect(loadFlowLedger(path)).toEqual(freshFlowLedger());
  });

  it('a malformed event in an otherwise-valid file is dropped on load', () => {
    const path = join(dir, 'flow.json');
    writeFileSync(
      path,
      JSON.stringify({
        events: [
          { ts: 1, deltaBase: '10' },
          { ts: 2, deltaBase: 'bad' },
          { ts: 3, deltaBase: '-3' },
        ],
      }),
      'utf8',
    );
    expect(loadFlowLedger(path)).toEqual({
      events: [
        { ts: 1, deltaBase: '10' },
        { ts: 3, deltaBase: '-3' },
      ],
    });
  });

  it('saveFlowLedgerSync swallows a write failure (never throws, returns void)', () => {
    // Make the would-be parent a regular file so mkdir/open fails.
    const filePath = join(dir, 'iam-a-file');
    writeFileSync(filePath, 'x', 'utf8');
    const badPath = join(filePath, 'flow.json'); // parent is not a directory
    expect(() => saveFlowLedgerSync(freshFlowLedger(), badPath)).not.toThrow();
  });
});
