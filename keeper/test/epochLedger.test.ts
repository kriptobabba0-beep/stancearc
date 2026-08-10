import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freshEpochLedger,
  shouldActThisEpoch,
  recordEpochActed,
  serializeEpochLedger,
  parseEpochLedger,
  loadEpochLedger,
  saveEpochLedgerSync,
  type EpochLedger,
} from '../src/epochLedger.js';

describe('epochLedger — freshEpochLedger', () => {
  it('has never acted (lastEpochActed null)', () => {
    expect(freshEpochLedger()).toEqual({ lastEpochActed: null });
  });
});

describe('epochLedger — shouldActThisEpoch (fires at most once per epoch)', () => {
  it('a fresh ledger ALWAYS acts (never acted before)', () => {
    expect(shouldActThisEpoch(freshEpochLedger(), 0n)).toBe(true);
    expect(shouldActThisEpoch(freshEpochLedger(), 42n)).toBe(true);
  });

  it('does NOT act again in the same epoch after it stamped it', () => {
    const l = recordEpochActed(freshEpochLedger(), 7n);
    expect(shouldActThisEpoch(l, 7n)).toBe(false);
  });

  it('DOES act in the NEXT epoch (id advanced)', () => {
    const l = recordEpochActed(freshEpochLedger(), 7n);
    expect(shouldActThisEpoch(l, 8n)).toBe(true);
  });

  it('compares uint64 epoch ids exactly (beyond Number precision)', () => {
    const big = 18_446_744_073_709_551_000n; // near uint64 max, well past 2^53
    const l = recordEpochActed(freshEpochLedger(), big);
    expect(shouldActThisEpoch(l, big)).toBe(false); // same huge id -> don't re-fire
    expect(shouldActThisEpoch(l, big + 1n)).toBe(true); // the very next id -> fire
  });
});

describe('epochLedger — recordEpochActed (stamp + immutable)', () => {
  it('stamps the acted epoch as a decimal string and is pure (input untouched)', () => {
    const l0 = freshEpochLedger();
    const l1 = recordEpochActed(l0, 9n);
    expect(l1).toEqual({ lastEpochActed: '9' });
    expect(l0).toEqual({ lastEpochActed: null }); // input not mutated
  });

  it('overwrites the previous stamp (only the LAST epoch acted is tracked)', () => {
    let l = recordEpochActed(freshEpochLedger(), 3n);
    l = recordEpochActed(l, 4n);
    expect(l).toEqual({ lastEpochActed: '4' });
  });
});

describe('epochLedger — serialize / parse (corruption-tolerant)', () => {
  it('round-trips a stamped ledger', () => {
    const l: EpochLedger = { lastEpochActed: '123' };
    expect(parseEpochLedger(serializeEpochLedger(l))).toEqual(l);
  });

  it('round-trips a fresh (null) ledger', () => {
    expect(parseEpochLedger(serializeEpochLedger(freshEpochLedger()))).toEqual(freshEpochLedger());
  });

  it('emits a stable single-field shape', () => {
    expect(Object.keys(JSON.parse(serializeEpochLedger(freshEpochLedger())))).toEqual(['lastEpochActed']);
  });

  it('returns a fresh ledger on non-JSON garbage and non-object JSON', () => {
    expect(parseEpochLedger('{ not json')).toEqual(freshEpochLedger());
    expect(parseEpochLedger('')).toEqual(freshEpochLedger());
    expect(parseEpochLedger('42')).toEqual(freshEpochLedger());
    expect(parseEpochLedger('[1,2,3]')).toEqual(freshEpochLedger());
    expect(parseEpochLedger('null')).toEqual(freshEpochLedger());
  });

  it('reads a missing / malformed / non-canonical lastEpochActed back as null (never acted)', () => {
    expect(parseEpochLedger('{"foo": 1}')).toEqual({ lastEpochActed: null }); // missing
    expect(parseEpochLedger('{"lastEpochActed": "oops"}')).toEqual({ lastEpochActed: null }); // non-numeric
    expect(parseEpochLedger('{"lastEpochActed": "1.5"}')).toEqual({ lastEpochActed: null }); // non-integer
    expect(parseEpochLedger('{"lastEpochActed": -3}')).toEqual({ lastEpochActed: null }); // negative
    expect(parseEpochLedger('{"lastEpochActed": "0x5"}')).toEqual({ lastEpochActed: null }); // hex, not decimal
  });

  it('accepts a numeric lastEpochActed and canonicalizes it to a string', () => {
    expect(parseEpochLedger('{"lastEpochActed": 12}')).toEqual({ lastEpochActed: '12' });
  });
});

describe('epochLedger — load/save round-trip (RESTART safety: durable + best-effort)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'epoch-ledger-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a stamp survives a restart: save then load returns the same lastEpochActed', () => {
    const path = join(dir, 'epoch.json');
    const l = recordEpochActed(freshEpochLedger(), 55n);
    saveEpochLedgerSync(l, path);
    // Simulate a restart: a fresh process loads the persisted scalar and must NOT re-fire epoch 55.
    const reloaded = loadEpochLedger(path);
    expect(reloaded).toEqual({ lastEpochActed: '55' });
    expect(shouldActThisEpoch(reloaded, 55n)).toBe(false); // restart-safe: no double-fire
    expect(shouldActThisEpoch(reloaded, 56n)).toBe(true); // but the next epoch still fires
  });

  it('loadEpochLedger on a missing path returns a fresh ledger (no throw)', () => {
    expect(loadEpochLedger(join(dir, 'nope.json'))).toEqual(freshEpochLedger());
  });

  it('creates the parent directory and writes a parseable file', () => {
    const path = join(dir, 'nested', 'deeper', 'epoch.json');
    saveEpochLedgerSync(recordEpochActed(freshEpochLedger(), 1n), path);
    expect(parseEpochLedger(readFileSync(path, 'utf8'))).toEqual({ lastEpochActed: '1' });
  });

  it('corrupt file on load -> fresh ledger, never throws (operator can clear a stuck ledger)', () => {
    const path = join(dir, 'epoch.json');
    writeFileSync(path, '{ truncated', 'utf8');
    expect(loadEpochLedger(path)).toEqual(freshEpochLedger());
  });

  it('saveEpochLedgerSync swallows a write failure (never throws, returns void)', () => {
    const filePath = join(dir, 'iam-a-file');
    writeFileSync(filePath, 'x', 'utf8');
    const badPath = join(filePath, 'epoch.json'); // parent is not a directory
    expect(() => saveEpochLedgerSync(freshEpochLedger(), badPath)).not.toThrow();
  });
});
