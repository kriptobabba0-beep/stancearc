// configV2.test.ts — the v2 (pinned) market config: the per-market version/pinned flag,
// the optional per-epoch subsidy (per-market + global), and the v2 timing knobs
// (KEEPER_V2_WINDOW_MARGIN_SEC / KEEPER_V2_POLL_INTERVAL_MS). v1 markets must default to
// 'v1' and keep their EXACT shape (back-compat).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

const ARENA = '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c';
const ARENA2 = '0xb9759858DD83658779Fb9E8CA113DCBd605Eea08';
const FEED = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
const PK = `0x${'1'.repeat(64)}`;
const PYTH = '0x2880aB155794e7179c9eE2e38200202908C17B43';

const MANAGED = [
  'KEEPER_RPC_URL',
  'KEEPER_PRIVATE_KEY',
  'PYTH_ADDRESS',
  'KEEPER_MARKETS',
  'KEEPER_V2_SUBSIDY_PER_EPOCH',
  'KEEPER_V2_WINDOW_MARGIN_SEC',
  'KEEPER_V2_POLL_INTERVAL_MS',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of MANAGED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
  process.env.KEEPER_PRIVATE_KEY = PK;
  process.env.PYTH_ADDRESS = PYTH;
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const setMarkets = (arr: unknown) => {
  process.env.KEEPER_MARKETS = JSON.stringify(arr);
};

describe('config — per-market version flag (v1 default / v2 / pinned)', () => {
  it('a market with NO version/pinned flag defaults to v1 (back-compat)', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED }]);
    const cfg = loadConfig();
    expect(cfg.markets[0]!.version).toBe('v1');
    expect(cfg.markets[0]!.subsidyPerEpoch).toBeUndefined();
  });

  it('"version":"v2" -> v2', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2' }]);
    expect(loadConfig().markets[0]!.version).toBe('v2');
  });

  it('version is case-insensitive ("V2" -> v2)', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'V2' }]);
    expect(loadConfig().markets[0]!.version).toBe('v2');
  });

  it('"pinned":true -> v2 (alias)', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, pinned: true }]);
    expect(loadConfig().markets[0]!.version).toBe('v2');
  });

  it('"pinned":false -> v1', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, pinned: false }]);
    expect(loadConfig().markets[0]!.version).toBe('v1');
  });

  it('explicit "version":"v1" -> v1', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v1' }]);
    expect(loadConfig().markets[0]!.version).toBe('v1');
  });

  it('mixed v1 + v2 markets are parsed independently', () => {
    setMarkets([
      { id: 'eth', arena: ARENA, feedId: FEED, version: 'v1' },
      { id: 'btc', arena: ARENA2, feedId: FEED, version: 'v2' },
    ]);
    const cfg = loadConfig();
    expect(cfg.markets[0]!.version).toBe('v1');
    expect(cfg.markets[1]!.version).toBe('v2');
  });

  it('parses a v3 (entry-anchored) market', () => {
    setMarkets([{ id: 'btc', arena: ARENA, feedId: FEED, version: 'v3' }]);
    const cfg = loadConfig();
    expect(cfg.markets[0]!.version).toBe('v3');
  });

  it('rejects a garbage version string (must not silently fall back to v1)', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v4' }]);
    expect(() => loadConfig()).toThrow(/version must be "v1", "v2" or "v3"/);
  });

  it('rejects a non-boolean pinned', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, pinned: 'yes' }]);
    expect(() => loadConfig()).toThrow(/pinned must be a boolean/);
  });
});

describe('config — v2 per-epoch subsidy (per-market + global default)', () => {
  it('per-market subsidyPerEpoch on a v2 market is parsed as a bigint', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2', subsidyPerEpoch: '150000000' }]);
    expect(loadConfig().markets[0]!.subsidyPerEpoch).toBe(150_000000n);
  });

  it('KEEPER_V2_SUBSIDY_PER_EPOCH global default applies to a v2 market with no per-market value', () => {
    process.env.KEEPER_V2_SUBSIDY_PER_EPOCH = '100000000';
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2' }]);
    expect(loadConfig().markets[0]!.subsidyPerEpoch).toBe(100_000000n);
  });

  it('per-market subsidy OVERRIDES the global default', () => {
    process.env.KEEPER_V2_SUBSIDY_PER_EPOCH = '100000000';
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2', subsidyPerEpoch: '50000000' }]);
    expect(loadConfig().markets[0]!.subsidyPerEpoch).toBe(50_000000n);
  });

  it('subsidy 0 (per-market or global) => undefined (OFF)', () => {
    process.env.KEEPER_V2_SUBSIDY_PER_EPOCH = '0';
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2', subsidyPerEpoch: '0' }]);
    expect(loadConfig().markets[0]!.subsidyPerEpoch).toBeUndefined();
  });

  it('no subsidy set anywhere => undefined (OFF)', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2' }]);
    expect(loadConfig().markets[0]!.subsidyPerEpoch).toBeUndefined();
  });

  it('a subsidy on a v1 market is a HARD error (fundSubsidy is v2-only)', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v1', subsidyPerEpoch: '150000000' }]);
    expect(() => loadConfig()).toThrow(/v2-only|v1 market/i);
  });

  it('a GLOBAL subsidy does NOT leak onto v1 markets (they default to no subsidy, no error)', () => {
    // The global default only applies to v2 markets; a v1 market in the same config must not
    // pick it up (else loadConfig would throw the v1+subsidy error spuriously).
    process.env.KEEPER_V2_SUBSIDY_PER_EPOCH = '100000000';
    setMarkets([
      { id: 'eth', arena: ARENA, feedId: FEED, version: 'v1' },
      { id: 'btc', arena: ARENA2, feedId: FEED, version: 'v2' },
    ]);
    const cfg = loadConfig();
    expect(cfg.markets[0]!.subsidyPerEpoch).toBeUndefined(); // v1: no subsidy
    expect(cfg.markets[1]!.subsidyPerEpoch).toBe(100_000000n); // v2: global default
  });

  it('rejects a negative / non-integer subsidy', () => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2', subsidyPerEpoch: '-1' }]);
    expect(() => loadConfig()).toThrow(/subsidyPerEpoch/);
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2', subsidyPerEpoch: '1.5' }]);
    expect(() => loadConfig()).toThrow(/subsidyPerEpoch/);
  });
});

describe('config — v2 timing knobs', () => {
  beforeEach(() => {
    setMarkets([{ id: 'eth', arena: ARENA, feedId: FEED, version: 'v2' }]);
  });

  it('v2WindowMarginSec defaults to 2', () => {
    expect(loadConfig().v2WindowMarginSec).toBe(2n);
  });

  it('KEEPER_V2_WINDOW_MARGIN_SEC overrides (including 0)', () => {
    process.env.KEEPER_V2_WINDOW_MARGIN_SEC = '5';
    expect(loadConfig().v2WindowMarginSec).toBe(5n);
    process.env.KEEPER_V2_WINDOW_MARGIN_SEC = '0';
    expect(loadConfig().v2WindowMarginSec).toBe(0n);
  });

  it('rejects a negative KEEPER_V2_WINDOW_MARGIN_SEC', () => {
    process.env.KEEPER_V2_WINDOW_MARGIN_SEC = '-1';
    expect(() => loadConfig()).toThrow(/KEEPER_V2_WINDOW_MARGIN_SEC/);
  });

  it('v2PollIntervalMs defaults to 4000', () => {
    expect(loadConfig().v2PollIntervalMs).toBe(4_000);
  });

  it('KEEPER_V2_POLL_INTERVAL_MS overrides and must be a positive int', () => {
    process.env.KEEPER_V2_POLL_INTERVAL_MS = '2000';
    expect(loadConfig().v2PollIntervalMs).toBe(2_000);
    process.env.KEEPER_V2_POLL_INTERVAL_MS = '0';
    expect(() => loadConfig()).toThrow(/KEEPER_V2_POLL_INTERVAL_MS/);
  });
});
