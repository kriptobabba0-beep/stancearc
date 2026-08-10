import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

// loadConfig reads process.env. We set the minimal required vars then exercise the
// new Phase-4 reliability knobs (multi-RPC, HTTP endpoint, stall factor) in isolation.

const ARENA = '0xEcb0161E74ad9381e42f3f9d51Bb08324bD17D5c';
const FEED = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
const PK = `0x${'1'.repeat(64)}`;
const PYTH = '0x2880aB155794e7179c9eE2e38200202908C17B43';
const MARKETS = JSON.stringify([{ id: 'eth', label: 'ETH / USDC', arena: ARENA, feedId: FEED }]);

const BASE_ENV: Record<string, string> = {
  KEEPER_PRIVATE_KEY: PK,
  PYTH_ADDRESS: PYTH,
  KEEPER_MARKETS: MARKETS,
};

// Keys this suite mutates — cleared before each test so cases don't leak into each other.
const MANAGED = [
  'KEEPER_RPC_URL',
  'KEEPER_RPC_URLS',
  'KEEPER_PRIVATE_KEY',
  'KEEPER_PRIVATE_KEY_FILE',
  'KEEPER_OWNER_PRIVATE_KEY',
  'PYTH_ADDRESS',
  'KEEPER_MARKETS',
  'KEEPER_HTTP_PORT',
  'KEEPER_HTTP_HOST',
  'STALL_FACTOR',
  'RECEIPT_TIMEOUT_MS',
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

describe('config — multi-RPC fallback (KEEPER_RPC_URLS)', () => {
  it('single KEEPER_RPC_URL: rpcUrls is a 1-element list, rpcUrl back-compat preserved', () => {
    process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
    const cfg = loadConfig();
    expect(cfg.rpcUrl).toBe('https://rpc.testnet.arc.network');
    expect(cfg.rpcUrls).toEqual(['https://rpc.testnet.arc.network']);
  });

  it('KEEPER_RPC_URLS parses a comma-separated list and trims whitespace', () => {
    process.env.KEEPER_RPC_URLS = ' https://a.example , https://b.example ,https://c.example ';
    const cfg = loadConfig();
    expect(cfg.rpcUrls).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
    // rpcUrl (the probe / back-compat single) is the first of the list.
    expect(cfg.rpcUrl).toBe('https://a.example');
  });

  it('KEEPER_RPC_URLS takes precedence; KEEPER_RPC_URL appended if not already present', () => {
    process.env.KEEPER_RPC_URL = 'https://single.example';
    process.env.KEEPER_RPC_URLS = 'https://a.example,https://b.example';
    const cfg = loadConfig();
    // The explicit single is included (de-duped) so it is never silently dropped.
    expect(cfg.rpcUrls).toContain('https://a.example');
    expect(cfg.rpcUrls).toContain('https://b.example');
    expect(cfg.rpcUrls).toContain('https://single.example');
  });

  it('de-dupes repeated URLs in KEEPER_RPC_URLS', () => {
    process.env.KEEPER_RPC_URLS = 'https://a.example,https://a.example,https://b.example';
    const cfg = loadConfig();
    expect(cfg.rpcUrls).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects when neither KEEPER_RPC_URL nor KEEPER_RPC_URLS is set', () => {
    expect(() => loadConfig()).toThrow(/KEEPER_RPC_URL/);
  });

  it('rejects an empty / all-blank KEEPER_RPC_URLS', () => {
    process.env.KEEPER_RPC_URLS = '  ,  , ';
    expect(() => loadConfig()).toThrow(/KEEPER_RPC_URLS/);
  });

  it('rejects a non-http(s) entry in KEEPER_RPC_URLS', () => {
    process.env.KEEPER_RPC_URLS = 'https://ok.example,ftp://nope.example';
    expect(() => loadConfig()).toThrow(/KEEPER_RPC_URLS/);
  });
});

describe('config — HTTP endpoint + stall factor', () => {
  beforeEach(() => {
    process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
  });

  it('defaults: httpPort 0 (off), host 127.0.0.1, stallFactor 3', () => {
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(0);
    expect(cfg.httpHost).toBe('127.0.0.1');
    expect(cfg.stallFactor).toBe(3);
  });

  it('KEEPER_HTTP_PORT parses to a number', () => {
    process.env.KEEPER_HTTP_PORT = '9464';
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(9464);
  });

  it('KEEPER_HTTP_PORT=0 means OFF', () => {
    process.env.KEEPER_HTTP_PORT = '0';
    const cfg = loadConfig();
    expect(cfg.httpPort).toBe(0);
  });

  it('rejects a non-numeric or negative KEEPER_HTTP_PORT', () => {
    process.env.KEEPER_HTTP_PORT = 'nope';
    expect(() => loadConfig()).toThrow(/KEEPER_HTTP_PORT/);
  });

  it('rejects a KEEPER_HTTP_PORT above 65535', () => {
    process.env.KEEPER_HTTP_PORT = '70000';
    expect(() => loadConfig()).toThrow(/KEEPER_HTTP_PORT/);
  });

  it('KEEPER_HTTP_HOST overrides the default bind host', () => {
    process.env.KEEPER_HTTP_HOST = '0.0.0.0';
    const cfg = loadConfig();
    expect(cfg.httpHost).toBe('0.0.0.0');
  });

  it('STALL_FACTOR overrides the default and must be a positive integer', () => {
    process.env.STALL_FACTOR = '5';
    expect(loadConfig().stallFactor).toBe(5);
    process.env.STALL_FACTOR = '0';
    expect(() => loadConfig()).toThrow(/STALL_FACTOR/);
  });

  it('RECEIPT_TIMEOUT_MS defaults to 90000, overrides, and rejects non-positive ints', () => {
    process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
    expect(loadConfig().receiptTimeoutMs).toBe(90_000); // default
    process.env.RECEIPT_TIMEOUT_MS = '120000';
    expect(loadConfig().receiptTimeoutMs).toBe(120_000); // override
    process.env.RECEIPT_TIMEOUT_MS = '0';
    expect(() => loadConfig()).toThrow(/RECEIPT_TIMEOUT_MS/); // must be a positive int
    process.env.RECEIPT_TIMEOUT_MS = 'nope';
    expect(() => loadConfig()).toThrow(/RECEIPT_TIMEOUT_MS/);
  });
});

// ---------------------------------------------------------------------------
// KEEPER_PRIVATE_KEY_FILE — file-based secret source (2d)
// ---------------------------------------------------------------------------
describe('config — KEEPER_PRIVATE_KEY_FILE secret source', () => {
  // Temp dir scoped to this describe block; each test creates its own file.
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'keeper-test-'));
    process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
    // The beforeEach above already set BASE_ENV (KEEPER_PRIVATE_KEY); clear it so these
    // tests start with neither key source set by default.
    delete process.env.KEEPER_PRIVATE_KEY;
  });

  it('reads the private key from a file (with trailing newline)', () => {
    const keyFile = join(tmpDir, 'keeper.key');
    writeFileSync(keyFile, `${PK}\n`, 'utf8');
    process.env.KEEPER_PRIVATE_KEY_FILE = keyFile;
    const cfg = loadConfig();
    expect(cfg.privateKey).toBe(PK);
  });

  it('reads the private key from a file without 0x prefix', () => {
    const keyFile = join(tmpDir, 'keeper.key');
    // Write WITHOUT the 0x prefix — config must normalise it.
    writeFileSync(keyFile, `${'1'.repeat(64)}\n`, 'utf8');
    process.env.KEEPER_PRIVATE_KEY_FILE = keyFile;
    const cfg = loadConfig();
    expect(cfg.privateKey).toBe(`0x${'1'.repeat(64)}`);
  });

  it('rejects when neither KEEPER_PRIVATE_KEY nor KEEPER_PRIVATE_KEY_FILE is set', () => {
    // Both are unset (KEEPER_PRIVATE_KEY already deleted in beforeEach).
    expect(() => loadConfig()).toThrow(/KEEPER_PRIVATE_KEY/);
  });

  it('rejects when both KEEPER_PRIVATE_KEY and KEEPER_PRIVATE_KEY_FILE are set', () => {
    const keyFile = join(tmpDir, 'keeper.key');
    writeFileSync(keyFile, `${PK}\n`, 'utf8');
    process.env.KEEPER_PRIVATE_KEY = PK;
    process.env.KEEPER_PRIVATE_KEY_FILE = keyFile;
    expect(() => loadConfig()).toThrow(/EXACTLY ONE/);
  });

  it('rejects a KEEPER_PRIVATE_KEY_FILE that does not exist', () => {
    process.env.KEEPER_PRIVATE_KEY_FILE = join(tmpDir, 'does-not-exist.key');
    expect(() => loadConfig()).toThrow(/KEEPER_PRIVATE_KEY_FILE/);
  });

  it('rejects a KEEPER_PRIVATE_KEY_FILE containing a malformed key', () => {
    const keyFile = join(tmpDir, 'bad.key');
    writeFileSync(keyFile, 'not-a-valid-hex-key\n', 'utf8');
    process.env.KEEPER_PRIVATE_KEY_FILE = keyFile;
    expect(() => loadConfig()).toThrow(/KEEPER_PRIVATE_KEY_FILE/);
  });

  it('KEEPER_PRIVATE_KEY alone still works (back-compat)', () => {
    // Set only KEEPER_PRIVATE_KEY — no FILE — must succeed.
    process.env.KEEPER_PRIVATE_KEY = PK;
    const cfg = loadConfig();
    expect(cfg.privateKey).toBe(PK);
  });
});

// ---------------------------------------------------------------------------
// KEEPER_OWNER_PRIVATE_KEY — OPTIONAL owner key for wedge auto-recovery.
// Absent => undefined (recovery OFF, behavior unchanged). Present => validated.
// ---------------------------------------------------------------------------
describe('config — KEEPER_OWNER_PRIVATE_KEY (optional wedge recovery)', () => {
  const OWNER_PK = `0x${'2'.repeat(64)}`;

  beforeEach(() => {
    process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
  });

  it('absent -> ownerPrivateKey is undefined (recovery disabled, behavior unchanged)', () => {
    const cfg = loadConfig();
    expect(cfg.ownerPrivateKey).toBeUndefined();
  });

  it('blank/whitespace -> treated as unset (undefined)', () => {
    process.env.KEEPER_OWNER_PRIVATE_KEY = '   ';
    const cfg = loadConfig();
    expect(cfg.ownerPrivateKey).toBeUndefined();
  });

  it('valid 0x key -> parsed into ownerPrivateKey', () => {
    process.env.KEEPER_OWNER_PRIVATE_KEY = OWNER_PK;
    const cfg = loadConfig();
    expect(cfg.ownerPrivateKey).toBe(OWNER_PK);
  });

  it('valid key WITHOUT 0x prefix -> normalised', () => {
    process.env.KEEPER_OWNER_PRIVATE_KEY = '2'.repeat(64);
    const cfg = loadConfig();
    expect(cfg.ownerPrivateKey).toBe(OWNER_PK);
  });

  it('malformed key -> fail-fast at boot', () => {
    process.env.KEEPER_OWNER_PRIVATE_KEY = 'not-a-valid-hex-key';
    expect(() => loadConfig()).toThrow(/KEEPER_OWNER_PRIVATE_KEY/);
  });

  it('the keeper key and owner key are independent (both set is fine)', () => {
    process.env.KEEPER_PRIVATE_KEY = PK;
    process.env.KEEPER_OWNER_PRIVATE_KEY = OWNER_PK;
    const cfg = loadConfig();
    expect(cfg.privateKey).toBe(PK);
    expect(cfg.ownerPrivateKey).toBe(OWNER_PK);
  });
});

// ---------------------------------------------------------------------------
// Alerting (dead-man's-switch) config. OFF when no webhook URL is set; tunable
// dedupe window + heartbeat interval; shared by the keeper AND the arb config.
// ---------------------------------------------------------------------------
describe('config — alerting (ALERT_WEBHOOK_URL / ALERT_HEARTBEAT_URL)', () => {
  beforeEach(() => {
    process.env.KEEPER_RPC_URL = 'https://rpc.testnet.arc.network';
  });

  it('defaults: no URLs (alerting off), default dedupe window + heartbeat interval', () => {
    const cfg = loadConfig();
    expect(cfg.alert.webhookUrl).toBeUndefined();
    expect(cfg.alert.heartbeatUrl).toBeUndefined();
    expect(cfg.alert.dedupeWindowMs).toBe(900_000); // 15 min default
    expect(cfg.alert.heartbeatIntervalMs).toBe(300_000); // 5 min default
    expect(cfg.alert.timeoutMs).toBe(5_000);
  });

  it('ALERT_WEBHOOK_URL is parsed and trimmed', () => {
    process.env.ALERT_WEBHOOK_URL = '  https://hooks.example/keeper  ';
    const cfg = loadConfig();
    expect(cfg.alert.webhookUrl).toBe('https://hooks.example/keeper');
  });

  it('ALERT_HEARTBEAT_URL is independent of the webhook URL', () => {
    process.env.ALERT_HEARTBEAT_URL = 'https://hc.example/ping/abc';
    const cfg = loadConfig();
    expect(cfg.alert.heartbeatUrl).toBe('https://hc.example/ping/abc');
    expect(cfg.alert.webhookUrl).toBeUndefined();
  });

  it('blank URLs are treated as unset (alerting stays off)', () => {
    process.env.ALERT_WEBHOOK_URL = '   ';
    process.env.ALERT_HEARTBEAT_URL = '';
    const cfg = loadConfig();
    expect(cfg.alert.webhookUrl).toBeUndefined();
    expect(cfg.alert.heartbeatUrl).toBeUndefined();
  });

  it('rejects a non-http(s) ALERT_WEBHOOK_URL', () => {
    process.env.ALERT_WEBHOOK_URL = 'ftp://nope.example';
    expect(() => loadConfig()).toThrow(/ALERT_WEBHOOK_URL/);
  });

  it('rejects a non-http(s) ALERT_HEARTBEAT_URL', () => {
    process.env.ALERT_HEARTBEAT_URL = 'not-a-url';
    expect(() => loadConfig()).toThrow(/ALERT_HEARTBEAT_URL/);
  });

  it('tunable dedupe window / heartbeat interval / timeout (positive ints)', () => {
    process.env.ALERT_DEDUPE_WINDOW_MS = '60000';
    process.env.ALERT_HEARTBEAT_INTERVAL_MS = '120000';
    process.env.ALERT_TIMEOUT_MS = '3000';
    const cfg = loadConfig();
    expect(cfg.alert.dedupeWindowMs).toBe(60_000);
    expect(cfg.alert.heartbeatIntervalMs).toBe(120_000);
    expect(cfg.alert.timeoutMs).toBe(3_000);
  });

  it('rejects a non-positive ALERT_DEDUPE_WINDOW_MS', () => {
    process.env.ALERT_DEDUPE_WINDOW_MS = '0';
    expect(() => loadConfig()).toThrow(/ALERT_DEDUPE_WINDOW_MS/);
  });
});
