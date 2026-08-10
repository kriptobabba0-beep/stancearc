import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadArbConfig } from '../src/config.js';

// loadArbConfig reads process.env. Set the minimal required arb vars, then exercise the
// validation paths (separate key, required market, required trade bounds, min<=max).

const ARENA = '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c';
const POOL = '0x184b90622535b024AD178730f39b75D26EF04826';
const BASE = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';
const QUOTE = '0x3600000000000000000000000000000000000000';
const ROUTER = '0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9';
const FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
const ARB_PK = `0x${'2'.repeat(64)}`;

const MARKET = JSON.stringify({
  id: 'cirbtc',
  label: 'cirBTC / USDC',
  arena: ARENA,
  pool: POOL,
  base: BASE,
  baseDecimals: 8,
  quote: QUOTE,
  quoteDecimals: 6,
  feedId: FEED,
  router: ROUTER,
  feeTier: 3000,
});

const BASE_ENV: Record<string, string> = {
  KEEPER_RPC_URL: 'https://rpc.testnet.arc.network',
  KEEPER_ARB_PRIVATE_KEY: ARB_PK,
  KEEPER_ARB_MARKET: MARKET,
  ARB_MAX_TRADE_BASE: '1000000',
  ARB_MIN_TRADE_BASE: '50000',
};

const MANAGED = [
  'KEEPER_RPC_URL',
  'KEEPER_RPC_URLS',
  'GAS_FLOOR_GWEI',
  'KEEPER_ARB_PRIVATE_KEY',
  'KEEPER_ARB_MARKET',
  'ARB_FEE_BPS',
  'ARB_THRESHOLD_BPS',
  'ARB_CLOSE_FRACTION',
  'ARB_MAX_TRADE_BASE',
  'ARB_MIN_TRADE_BASE',
  'ARB_MAX_REF_AGE_SEC',
  'ARB_SLIPPAGE_BPS',
  'ARB_REBALANCE_FLOOR_BPS',
  'ARB_REBALANCE_TARGET_BPS',
  'ARB_REBALANCE_MAX_BASE',
  'ARB_HEARTBEAT_ENABLED',
  'ARB_HEARTBEAT_INTERVAL_MS',
  'ARB_HEARTBEAT_DAILY_CAP_BASE',
  'ARB_HEARTBEAT_TRADE_BASE',
  'ARB_POLL_INTERVAL_MS',
  'KEEPER_ARB_HTTP_PORT',
  'KEEPER_ARB_HTTP_HOST',
  'ARB_STALL_FACTOR',
  'HERMES_URL',
  'ALERT_WEBHOOK_URL',
  'ALERT_HEARTBEAT_URL',
  'ALERT_DEDUPE_WINDOW_MS',
  'ALERT_HEARTBEAT_INTERVAL_MS',
  'ALERT_TIMEOUT_MS',
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of MANAGED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
});

afterEach(() => {
  for (const k of MANAGED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadArbConfig — happy path + defaults', () => {
  it('loads the market, key, and default params', () => {
    const cfg = loadArbConfig();
    expect(cfg.market.id).toBe('cirbtc');
    expect(cfg.market.baseDecimals).toBe(8);
    expect(cfg.market.quoteDecimals).toBe(6);
    expect(cfg.market.feeTier).toBe(3000);
    expect(cfg.privateKey).toBe(ARB_PK);
    // defaults
    expect(cfg.params.feeBps).toBe(30);
    expect(cfg.params.thresholdBps).toBe(25);
    expect(cfg.params.closeFraction).toBe(0.6);
    expect(cfg.params.maxRefAgeSec).toBe(60);
    expect(cfg.params.slippageBps).toBe(75);
    // required bigints parsed
    expect(cfg.params.maxTradeBase).toBe(1_000_000n);
    expect(cfg.params.minTradeBase).toBe(50_000n);
    // health-server defaults: OFF, loopback host, stallFactor 3
    expect(cfg.httpPort).toBe(0);
    expect(cfg.httpHost).toBe('127.0.0.1');
    expect(cfg.stallFactor).toBe(3);
    // TASK 3 — rebalancing + heartbeat default to OFF (behavior unchanged). rebalanceMaxBase
    // defaults to the arb cap; heartbeat budgets default to 0 (also OFF).
    expect(cfg.params.rebalanceFloorBps).toBe(0);
    expect(cfg.params.rebalanceTargetBps).toBe(5_000);
    expect(cfg.params.rebalanceMaxBase).toBe(cfg.params.maxTradeBase);
    expect(cfg.params.heartbeatEnabled).toBe(false);
    expect(cfg.params.heartbeatIntervalMs).toBe(3_600_000);
    expect(cfg.params.heartbeatDailyCapBase).toBe(0n);
    expect(cfg.params.heartbeatTradeBase).toBe(0n);
  });

  it('parses the optional health-server overrides', () => {
    process.env.KEEPER_ARB_HTTP_PORT = '9465';
    process.env.KEEPER_ARB_HTTP_HOST = '0.0.0.0';
    process.env.ARB_STALL_FACTOR = '4';
    const cfg = loadArbConfig();
    expect(cfg.httpPort).toBe(9465);
    expect(cfg.httpHost).toBe('0.0.0.0');
    expect(cfg.stallFactor).toBe(4);
  });

  it('alerting defaults to OFF (no webhook URL) and shares the keeper alert knobs', () => {
    const cfg = loadArbConfig();
    expect(cfg.alert.webhookUrl).toBeUndefined();
    expect(cfg.alert.heartbeatUrl).toBeUndefined();
    expect(cfg.alert.dedupeWindowMs).toBe(900_000);
    expect(cfg.alert.heartbeatIntervalMs).toBe(300_000);
  });

  it('picks up ALERT_WEBHOOK_URL / ALERT_HEARTBEAT_URL when set', () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.example/arb';
    process.env.ALERT_HEARTBEAT_URL = 'https://hc.example/ping/arb';
    const cfg = loadArbConfig();
    expect(cfg.alert.webhookUrl).toBe('https://hooks.example/arb');
    expect(cfg.alert.heartbeatUrl).toBe('https://hc.example/ping/arb');
  });

  it('checksums the market addresses', () => {
    const cfg = loadArbConfig();
    // getAddress checksums; base should match the canonical checksum of BASE.
    expect(cfg.market.base.toLowerCase()).toBe(BASE.toLowerCase());
    expect(cfg.market.router.toLowerCase()).toBe(ROUTER.toLowerCase());
  });
});

describe('loadArbConfig — validation', () => {
  it('requires KEEPER_ARB_PRIVATE_KEY', () => {
    delete process.env.KEEPER_ARB_PRIVATE_KEY;
    expect(() => loadArbConfig()).toThrow(/KEEPER_ARB_PRIVATE_KEY/);
  });

  it('requires KEEPER_ARB_MARKET', () => {
    delete process.env.KEEPER_ARB_MARKET;
    expect(() => loadArbConfig()).toThrow(/KEEPER_ARB_MARKET/);
  });

  it('rejects a non-object KEEPER_ARB_MARKET (array)', () => {
    process.env.KEEPER_ARB_MARKET = '[]';
    expect(() => loadArbConfig()).toThrow(/must be a JSON object/);
  });

  it('rejects a bad base address', () => {
    process.env.KEEPER_ARB_MARKET = JSON.stringify({ ...JSON.parse(MARKET), base: '0xnothex' });
    expect(() => loadArbConfig()).toThrow(/base must be a valid 0x address/);
  });

  it('rejects bad baseDecimals', () => {
    process.env.KEEPER_ARB_MARKET = JSON.stringify({ ...JSON.parse(MARKET), baseDecimals: 99 });
    expect(() => loadArbConfig()).toThrow(/baseDecimals must be an integer/);
  });

  it('requires ARB_MAX_TRADE_BASE', () => {
    delete process.env.ARB_MAX_TRADE_BASE;
    expect(() => loadArbConfig()).toThrow(/ARB_MAX_TRADE_BASE is required|ARB_MAX_TRADE_BASE must be/);
  });

  it('requires ARB_MIN_TRADE_BASE', () => {
    delete process.env.ARB_MIN_TRADE_BASE;
    expect(() => loadArbConfig()).toThrow(/ARB_MIN_TRADE_BASE is required|ARB_MIN_TRADE_BASE must be/);
  });

  it('rejects min > max', () => {
    process.env.ARB_MIN_TRADE_BASE = '2000000'; // > max 1000000
    expect(() => loadArbConfig()).toThrow(/ARB_MIN_TRADE_BASE must be <= ARB_MAX_TRADE_BASE/);
  });

  it('rejects a closeFraction outside (0,1]', () => {
    process.env.ARB_CLOSE_FRACTION = '1.5';
    expect(() => loadArbConfig()).toThrow(/ARB_CLOSE_FRACTION must be a number in \(0, 1\]/);
  });

  it('accepts a closeFraction of exactly 1', () => {
    process.env.ARB_CLOSE_FRACTION = '1';
    expect(loadArbConfig().params.closeFraction).toBe(1);
  });

  it('rejects a KEEPER_ARB_HTTP_PORT above the 16-bit range', () => {
    process.env.KEEPER_ARB_HTTP_PORT = '70000';
    expect(() => loadArbConfig()).toThrow(/KEEPER_ARB_HTTP_PORT must be a non-negative integer/);
  });
});

describe('loadArbConfig — cross-quoted market (quoteFeedId)', () => {
  const QUOTE_FEED = `0x${'a'.repeat(64)}`;

  it('single-feed market leaves quoteFeedId undefined (USDC arb unchanged)', () => {
    expect(loadArbConfig().market.quoteFeedId).toBeUndefined();
  });

  it('parses an optional quoteFeedId for a cross-quoted (cirBTC/EURC) market', () => {
    process.env.KEEPER_ARB_MARKET = JSON.stringify({ ...JSON.parse(MARKET), quoteFeedId: QUOTE_FEED });
    expect(loadArbConfig().market.quoteFeedId).toBe(QUOTE_FEED);
  });

  it('rejects a malformed quoteFeedId', () => {
    process.env.KEEPER_ARB_MARKET = JSON.stringify({ ...JSON.parse(MARKET), quoteFeedId: '0xtooshort' });
    expect(() => loadArbConfig()).toThrow(/quoteFeedId must be a 32-byte hex feed id/);
  });
});

describe('loadArbConfig — TASK 3a rebalancing config', () => {
  it('parses rebalance floor/target/max overrides', () => {
    process.env.ARB_REBALANCE_FLOOR_BPS = '1500';
    process.env.ARB_REBALANCE_TARGET_BPS = '5000';
    process.env.ARB_REBALANCE_MAX_BASE = '250000';
    const cfg = loadArbConfig();
    expect(cfg.params.rebalanceFloorBps).toBe(1500);
    expect(cfg.params.rebalanceTargetBps).toBe(5000);
    expect(cfg.params.rebalanceMaxBase).toBe(250_000n);
  });

  it('rejects a rebalance floor >= the target', () => {
    process.env.ARB_REBALANCE_FLOOR_BPS = '5000';
    process.env.ARB_REBALANCE_TARGET_BPS = '5000';
    expect(() => loadArbConfig()).toThrow(/ARB_REBALANCE_FLOOR_BPS must be < ARB_REBALANCE_TARGET_BPS/);
  });

  it('a 0 floor leaves rebalancing OFF and skips the floor<target check', () => {
    process.env.ARB_REBALANCE_FLOOR_BPS = '0';
    process.env.ARB_REBALANCE_TARGET_BPS = '0'; // would be invalid if checked, but floor=0 => OFF
    const cfg = loadArbConfig();
    expect(cfg.params.rebalanceFloorBps).toBe(0);
  });
});

describe('loadArbConfig — TASK 3b heartbeat config', () => {
  it('parses an enabled heartbeat with interval + budgets', () => {
    process.env.ARB_HEARTBEAT_ENABLED = 'true';
    process.env.ARB_HEARTBEAT_INTERVAL_MS = '120000';
    process.env.ARB_HEARTBEAT_DAILY_CAP_BASE = '1000000';
    process.env.ARB_HEARTBEAT_TRADE_BASE = '100000';
    const cfg = loadArbConfig();
    expect(cfg.params.heartbeatEnabled).toBe(true);
    expect(cfg.params.heartbeatIntervalMs).toBe(120_000);
    expect(cfg.params.heartbeatDailyCapBase).toBe(1_000_000n);
    expect(cfg.params.heartbeatTradeBase).toBe(100_000n);
  });

  it('accepts 1/0/yes/no booleans for ARB_HEARTBEAT_ENABLED', () => {
    process.env.ARB_HEARTBEAT_ENABLED = '0';
    expect(loadArbConfig().params.heartbeatEnabled).toBe(false);
    process.env.ARB_HEARTBEAT_ENABLED = 'yes';
    process.env.ARB_HEARTBEAT_DAILY_CAP_BASE = '1000000';
    process.env.ARB_HEARTBEAT_TRADE_BASE = '100000';
    expect(loadArbConfig().params.heartbeatEnabled).toBe(true);
  });

  it('rejects a non-boolean ARB_HEARTBEAT_ENABLED', () => {
    process.env.ARB_HEARTBEAT_ENABLED = 'maybe';
    expect(() => loadArbConfig()).toThrow(/ARB_HEARTBEAT_ENABLED must be a boolean/);
  });

  it('requires a positive trade base when heartbeat is enabled', () => {
    process.env.ARB_HEARTBEAT_ENABLED = 'true';
    process.env.ARB_HEARTBEAT_DAILY_CAP_BASE = '1000000';
    // ARB_HEARTBEAT_TRADE_BASE unset -> defaults to 0 -> invalid when enabled.
    expect(() => loadArbConfig()).toThrow(/ARB_HEARTBEAT_TRADE_BASE must be > 0 when ARB_HEARTBEAT_ENABLED/);
  });

  it('requires a positive daily cap when heartbeat is enabled', () => {
    process.env.ARB_HEARTBEAT_ENABLED = 'true';
    process.env.ARB_HEARTBEAT_TRADE_BASE = '100000';
    expect(() => loadArbConfig()).toThrow(/ARB_HEARTBEAT_DAILY_CAP_BASE must be > 0 when ARB_HEARTBEAT_ENABLED/);
  });

  it('rejects a per-leg trade larger than the daily cap', () => {
    process.env.ARB_HEARTBEAT_ENABLED = 'true';
    process.env.ARB_HEARTBEAT_DAILY_CAP_BASE = '100000';
    process.env.ARB_HEARTBEAT_TRADE_BASE = '200000'; // > cap
    expect(() => loadArbConfig()).toThrow(/ARB_HEARTBEAT_TRADE_BASE must be <= ARB_HEARTBEAT_DAILY_CAP_BASE/);
  });

  it('a disabled heartbeat with 0 budgets is valid (OFF)', () => {
    process.env.ARB_HEARTBEAT_ENABLED = 'false';
    const cfg = loadArbConfig();
    expect(cfg.params.heartbeatEnabled).toBe(false);
    expect(cfg.params.heartbeatTradeBase).toBe(0n);
  });
});
