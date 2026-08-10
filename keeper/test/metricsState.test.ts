import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freshPersistedMetrics,
  parsePersistedMetrics,
  serializeMetricsState,
  recordRestart,
  loadMetricsState,
  saveMetricsState,
  type PersistedMetrics,
} from '../src/metricsState.js';

const noop = () => {};

describe('metricsState — freshPersistedMetrics', () => {
  it('is fully zeroed (first-ever boot seed)', () => {
    expect(freshPersistedMetrics()).toEqual({
      ticksTotal: 0,
      actionsTotal: {},
      failuresTotal: {},
      revertsTotal: 0,
      restartsTotal: 0,
    });
  });
});

describe('metricsState — recordRestart', () => {
  it('bumps restartsTotal by one and is pure (does not mutate the input)', () => {
    const prev = freshPersistedMetrics();
    const next = recordRestart(prev);
    expect(next.restartsTotal).toBe(1);
    expect(prev.restartsTotal).toBe(0); // input untouched
    expect(recordRestart(next).restartsTotal).toBe(2); // each boot adds one
  });

  it('preserves the cumulative counters across a boot', () => {
    const prev: PersistedMetrics = {
      ticksTotal: 100,
      actionsTotal: { SWEEP: 3 },
      failuresTotal: { eth: 1 },
      revertsTotal: 2,
      restartsTotal: 4,
    };
    const next = recordRestart(prev);
    expect(next).toEqual({ ...prev, restartsTotal: 5 });
  });
});

describe('metricsState — parsePersistedMetrics (corruption-tolerant)', () => {
  it('round-trips a serialized state', () => {
    const m: PersistedMetrics = {
      ticksTotal: 12,
      actionsTotal: { SWEEP: 3, NONE: 9 },
      failuresTotal: { eth: 1 },
      revertsTotal: 2,
      restartsTotal: 7,
    };
    const parsed = parsePersistedMetrics(serializeMetricsState(m));
    expect(parsed).toEqual(m);
  });

  it('returns null on non-JSON garbage (truncated write)', () => {
    expect(parsePersistedMetrics('{ this is not json')).toBeNull();
    expect(parsePersistedMetrics('')).toBeNull();
  });

  it('returns null when the JSON is not an object', () => {
    expect(parsePersistedMetrics('42')).toBeNull();
    expect(parsePersistedMetrics('[1,2,3]')).toBeNull();
    expect(parsePersistedMetrics('null')).toBeNull();
  });

  it('salvages a partial object field-by-field (missing fields -> zero)', () => {
    const parsed = parsePersistedMetrics('{"ticksTotal": 5}');
    expect(parsed).toEqual({
      ticksTotal: 5,
      actionsTotal: {},
      failuresTotal: {},
      revertsTotal: 0,
      restartsTotal: 0,
    });
  });

  it('coerces negative / non-integer / NaN counts to a safe value', () => {
    const parsed = parsePersistedMetrics(
      '{"ticksTotal": -3, "revertsTotal": 2.9, "restartsTotal": "oops", "actionsTotal": {"SWEEP": -1, "OPEN": 4}}',
    );
    expect(parsed!.ticksTotal).toBe(0); // negative -> 0
    expect(parsed!.revertsTotal).toBe(2); // 2.9 floored
    expect(parsed!.restartsTotal).toBe(0); // non-numeric -> 0
    expect(parsed!.actionsTotal).toEqual({ OPEN: 4 }); // negative map entry dropped
  });
});

describe('metricsState — serializeMetricsState', () => {
  it('emits valid JSON containing exactly the cumulative counters (no gauges)', () => {
    const text = serializeMetricsState({
      ticksTotal: 1,
      actionsTotal: { OPEN: 1 },
      failuresTotal: {},
      revertsTotal: 0,
      restartsTotal: 1,
    });
    const obj = JSON.parse(text);
    expect(Object.keys(obj).sort()).toEqual(
      ['actionsTotal', 'failuresTotal', 'restartsTotal', 'revertsTotal', 'ticksTotal'].sort(),
    );
    // No gauge fields leak into the persisted file.
    expect(obj).not.toHaveProperty('balanceWei');
    expect(obj).not.toHaveProperty('lastTickTs');
    expect(obj).not.toHaveProperty('marketWedged');
  });
});

describe('metricsState — load/save round-trip (filesystem, best-effort)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metrics-state-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('first boot (no file) -> fresh + restartsTotal 1, loaded=false, no error logged', () => {
    const log = vi.fn();
    const { metrics, loaded } = loadMetricsState(join(dir, 'state.json'), log);
    expect(loaded).toBe(false);
    expect(metrics.restartsTotal).toBe(1);
    expect(metrics.ticksTotal).toBe(0);
    // ENOENT is the normal first-boot case — it must NOT be logged as an error.
    expect(log).not.toHaveBeenCalled();
  });

  it('saves then loads, carrying counters forward and bumping restartsTotal', () => {
    const path = join(dir, 'state.json');
    const log = vi.fn();
    const saved: PersistedMetrics = {
      ticksTotal: 50,
      actionsTotal: { SWEEP: 2 },
      failuresTotal: { btc: 1 },
      revertsTotal: 3,
      restartsTotal: 2,
    };
    expect(saveMetricsState(path, saved, log)).toBe(true);
    const { metrics, loaded } = loadMetricsState(path, log);
    expect(loaded).toBe(true);
    expect(metrics.ticksTotal).toBe(50); // carried across the restart
    expect(metrics.actionsTotal).toEqual({ SWEEP: 2 });
    expect(metrics.failuresTotal).toEqual({ btc: 1 });
    expect(metrics.revertsTotal).toBe(3);
    expect(metrics.restartsTotal).toBe(3); // bumped on load (the new boot)
  });

  it('creates the parent directory atomically (write a nested path)', () => {
    const path = join(dir, 'nested', 'deeper', 'state.json');
    const log = vi.fn();
    expect(saveMetricsState(path, freshPersistedMetrics(), log)).toBe(true);
    // The file exists + parses back.
    expect(parsePersistedMetrics(readFileSync(path, 'utf8'))).not.toBeNull();
  });

  it('corrupt file on load -> fresh + logged parse error, never throws', () => {
    const path = join(dir, 'state.json');
    writeFileSync(path, '{ truncated', 'utf8');
    const log = vi.fn();
    const { metrics, loaded } = loadMetricsState(path, log);
    expect(loaded).toBe(false);
    expect(metrics.ticksTotal).toBe(0);
    expect(metrics.restartsTotal).toBe(1);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'metrics.state.parse.error' }));
  });

  it('save failure is swallowed + logged (returns false), never throws', () => {
    const log = vi.fn();
    // Point at a path whose "parent" is a regular file -> mkdirSync/write fails.
    const filePath = join(dir, 'iam-a-file');
    writeFileSync(filePath, 'x', 'utf8');
    const badPath = join(filePath, 'state.json'); // parent is not a directory
    const ok = saveMetricsState(badPath, freshPersistedMetrics(), log);
    expect(ok).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'metrics.state.write.error' }));
  });
});
