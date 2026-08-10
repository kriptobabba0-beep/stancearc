// config.ts — load + validate the keeper environment. Throws on any missing/invalid
// value so a misconfigured keeper fails fast at boot rather than mid-loop. Pure-ish:
// loadConfig() reads process.env (after dotenv) and returns a frozen typed config.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getAddress, isHex, parseEther, type Address, type Hex } from 'viem';
import type { AlertConfig } from './alert.js';
import type { GasEscalationConfig } from './gasEscalation.js';
import type { SpendCaps } from './spendBreaker.js';
import { DEFAULT_V2_WINDOW_MARGIN_SEC } from './decideV2.js';

/** Persisted spend-cap configuration (the drain backstop). Disabled unless a cap is set. */
export interface SpendCapConfig {
  enabled: boolean;
  /** REQUIRED when enabled — the breaker must persist so a crash-loop can't reset it. */
  ledgerFile?: string;
  caps: SpendCaps;
  /** Retain window for ledger events (>= caps.hourWindowMs). */
  retainMs: number;
}

/** Owner-reserve drawdown governor configuration. Enabled when an owner key is configured. */
export interface ReserveGovConfig {
  enabled: boolean;
  floorWei: bigint;
  throttleWei: bigint;
  warnDrawdownWeiPerHour: bigint;
  projectDryWarnMs: number;
  retainMs: number;
}

/**
 * A market's contract generation. v1 = the original FeeArena (non-pinned start/end:
 * post any fresh Hermes blob once the endpoint passes). v2 = FeeArenaV2 (PINNED
 * start/end: the contract forces the blob's publishTime into a tight window
 * [endpointTime, endpointTime+settleWindow], so the keeper must crank promptly inside
 * that window). v2 ALSO supports the OPTIONAL owner-key `fundSubsidy` per epoch.
 * v3 = FeeArenaV3 (ENTRY-ANCHORED: no startEpoch at all; the keeper samples a short
 * settlement average off-chain and submits it via submitSettlementPrice, then drives
 * processPositions/finalizeEpoch/unstakeBatch — see decideV3.ts/keeperV3.ts).
 * Defaults to 'v1' when a market omits the flag (back-compat — existing markets keep
 * their EXACT behavior).
 */
export type MarketVersion = 'v1' | 'v2' | 'v3';

/** One market the keeper drives: its own FeeArena + Pyth feed id. */
export interface MarketConfig {
  id: string;
  label: string;
  arena: Address;
  feedId: Hex;
  /**
   * OPTIONAL second Pyth feed for a CROSS-quoted market. When set, the market settles on the cross rate
   * `feedId / quoteFeedId` (e.g. cirBTC/EURC: feedId=BTC/USD, quoteFeedId=EUR/USD → BTC/EUR), matching a
   * CompositePythOracle on-chain. The keeper samples both feeds + divides, and posts a blob covering
   * BOTH. Absent → single-feed market (unchanged).
   */
  quoteFeedId?: Hex;
  /**
   * Contract generation for this market. 'v1' (default) uses the EXACT existing
   * non-pinned start/end path. 'v2' switches to the pinned start/end window logic
   * (decideV2.ts) and enables the optional per-epoch subsidy below. A market may set
   * either `"version":"v2"` or, equivalently, `"pinned":true` in KEEPER_MARKETS.
   */
  version: MarketVersion;
  /**
   * OPTIONAL per-epoch subsidy (v2 ONLY), in RAW USDC units (6-dp; 150 USDC = 150_000000).
   * When set (> 0) AND an owner key is configured, the keeper calls the owner-only
   * `fundSubsidy(epochId, amount)` ONCE per epoch while the epoch's phase < Resolved
   * (needs a USDC approve to the arena first). This injects external value so staking is
   * +EV. Must be <= the arena's `maxSubsidyPerEpoch` (the contract hard-caps it, default
   * 150 USDC). Undefined/0 => subsidy OFF for this market (behavior unchanged). Ignored
   * for v1 markets (the v1 contract has no fundSubsidy). Set per-market via
   * `"subsidyPerEpoch":"150000000"` in KEEPER_MARKETS, or globally via KEEPER_V2_SUBSIDY_PER_EPOCH.
   */
  subsidyPerEpoch?: bigint;
}

/** Fully-validated keeper configuration. */
export interface KeeperConfig {
  /**
   * The primary RPC URL (the first of `rpcUrls`). Kept as a single field for
   * back-compat (used to probe the chainId) — multi-RPC clients should use `rpcUrls`.
   */
  rpcUrl: string;
  /**
   * All RPC URLs to wire into a viem `fallback([...])` transport so one RPC outage
   * doesn't stall the keeper. Always non-empty; a lone `KEEPER_RPC_URL` yields a
   * 1-element list (back-compat).
   */
  rpcUrls: string[];
  privateKey: Hex;
  /**
   * OPTIONAL owner key for wedge auto-recovery (KEEPER_OWNER_PRIVATE_KEY). When
   * set, the keeper can self-heal a wedged epoch by calling the onlyOwner
   * `emergencySettle` with a SEPARATE owner signer; when undefined, behavior is
   * UNCHANGED (detect wedge -> log -> STUCK, as today). This is a TESTNET
   * operational convenience — on mainnet, keep the owner key cold and recover
   * manually/via multisig rather than loading a hot owner key into the keeper.
   */
  ownerPrivateKey?: Hex;
  pythAddress: Address;
  hermesUrl: string;
  markets: MarketConfig[];
  pollIntervalMs: number;
  sweepBatch: number;
  /**
   * The RPC's hard per-tx / eth_estimateGas cap (2^24 = 16,777,216 on Arc). The v3 position
   * cranks (processPositions/unstakeBatch) shrink their batch + submit with an explicit gas-limit
   * clamped to this so a heavy position can never push a crank over the cap and wedge the keeper.
   */
  txGasCap: bigint;
  gasFloorWei: bigint;
  /** Abort a hung Hermes fetch after this many ms so it can't wedge the whole loop. */
  hermesTimeoutMs: number;
  /**
   * Cap (ms) on how long to wait for a tx receipt before viem throws
   * WaitForTransactionReceiptTimeoutError. Bounds a stuck/dropped tx so it can't hang
   * the sequential market loop forever (heartbeat + per-market backoff sit after the
   * await). On timeout the tick is recorded as a FAILURE and the breaker backs off.
   */
  receiptTimeoutMs: number;
  /** Warn when the signer's native balance drops below this many wei. */
  lowBalanceWei: bigint;
  /**
   * TASK 4b — bounded gas-tip escalation. Attempt 0 always uses `gasFloorWei`; on a
   * receipt-wait timeout the write is re-sent with a higher (capped) tip, up to
   * `maxAttempts` times. maxAttempts === 0 (default) => OFF (only the floor-priced send,
   * behavior unchanged). See gasEscalation.ts.
   */
  gasEscalation: GasEscalationConfig;
  /** First backoff step (ms) for a failing market; doubles each consecutive failure. */
  baseBackoffMs: number;
  /** Cap (ms) on the exponential backoff window. */
  maxBackoffMs: number;
  /** Consecutive failures after which the loop emits one loud WEDGED alert. */
  wedgedAlertThreshold: number;
  /**
   * Port for the optional health/metrics HTTP server. 0 (default) = OFF — no server
   * is started. >0 starts a `node:http` server on `httpHost`:`httpPort`.
   */
  httpPort: number;
  /** Bind host for the health/metrics server. Default 127.0.0.1 (loopback only). */
  httpHost: string;
  /**
   * Multiplier on pollIntervalMs after which a silent loop (no tick) is treated as
   * STALLED -> /health reports DEGRADED. Default 3.
   */
  stallFactor: number;
  /**
   * TASK 4a — path to the restart-safe metrics state file. When set, the cumulative
   * counters (ticks/actions/failures/reverts/restarts) are seeded from it at boot and
   * persisted as the loop runs, so a restart/crash-loop doesn't zero the Prometheus series.
   * Empty (default) => persistence OFF: counters are in-memory only (unchanged behavior),
   * and the loop instead documents the reset via process_start_time_seconds + restarts.
   */
  metricsStateFile?: string;
  /** TASK 4a — how often (ms) to flush the metrics state file while running. */
  metricsPersistIntervalMs: number;
  /**
   * Real-alerting (dead-man's-switch) config. Both channel URLs are OFF unless set, so the
   * default is the unchanged log-only behavior. See alert.ts + README "Alerting".
   */
  alert: AlertConfig;
  /**
   * v2 ONLY — seconds shaved off the TAIL of the pinned start/end window so a fresh Hermes
   * blob's publishTime (~= now) plus the fetch->mine latency still lands inside
   * [endpointTime, endpointTime+settleWindow]. Default 2s. Irrelevant to v1 markets. See
   * decideV2.ts (DEFAULT_V2_WINDOW_MARGIN_SEC) and KEEPER_V2_WINDOW_MARGIN_SEC.
   */
  v2WindowMarginSec: bigint;
  /**
   * v2 ONLY — the loop's poll interval (ms) used WHENEVER ≥1 market is v2. The pinned
   * start/end window is tight (settleWindow default ~12s), so a 15s default poll could step
   * clean OVER the whole window and never attempt -> the epoch wedges. With ≥1 v2 market the
   * loop polls at min(pollIntervalMs, this) so it re-checks several times inside the window
   * (4s default => ~2-3 attempts across a 12s window). No effect when all markets are v1.
   */
  v2PollIntervalMs: number;
  /**
   * v3 ONLY — the settlement-average sampling window (seconds). At the settlement moment
   * the keeper samples the live Pyth price for this long, averages, and submits the
   * result as the epoch's finalPrice (anchored on-chain within settleSanityBps of a
   * fresh Pyth read). The PDF's recommended window is 60s.
   */
  v3SampleSec: number;
  /** v3 ONLY — interval between settlement samples (ms). Default 2000. */
  v3SampleIntervalMs: number;
  /**
   * v3 ONLY — PRE-SAMPLE the settlement average over [settlementTime - v3SampleSec, settlementTime]
   * (the contract's documented "last 60s of Pyth prices") in the background, so the submit fires
   * within ~2s of the settlement moment instead of blocking the tick for the whole window AFTER it.
   * The legacy post-settlement window stays as the fallback (keeper restarted mid-window, sparse
   * samples, or a submit the sanity anchor rejected after a violent last-minute move). Default ON;
   * KEEPER_V3_PRESAMPLE=false restores the exact legacy sampling.
   */
  v3PreSampleEnabled?: boolean;
  /**
   * v3 ONLY — wall-clock budget (ms) for CHAINING settlement-pipeline cranks back-to-back inside a
   * single tick (SETTLE -> PROCESS.. -> FINALIZE -> UNSTAKE.. -> CREATE -> OPEN) instead of paying
   * a full poll gap between every step. Each chained step is still simulated, spend-capped and
   * receipt-awaited exactly like a lone action, and the FIRST failure breaks the chain into the
   * normal backoff path. 0 disables chaining (legacy one-action-per-tick). The tick-deadline
   * default grows by this budget so a mid-chain deadline kill can't orphan an in-flight step.
   */
  v3ChainBudgetMs?: number;
  /** v3 ONLY — hard cap on chained steps per tick (backstop against a pathological loop). */
  v3ChainMaxSteps?: number;
  /**
   * v3 ONLY — anchor-freshness margin (seconds). The contract rejects a settle whose anchor blob
   * is stamped BEFORE settlementTime (SettlePriceTooOld); the adaptive wake lands the SETTLE tick
   * essentially AT that moment, when Hermes's freshest blob can still be a second older. The
   * SETTLE crank waits out this bounded margin past settlementTime before fetching the anchor, so
   * the first attempt qualifies instead of burning a sim-skip + a backoff cycle. Default 2.
   */
  v3AnchorMarginSec?: number;
  /**
   * Per-market tick DEADLINE (ms): a single market's crank is raced against this, so a black-holed
   * RPC/Hermes await (one that never resolves AND never trips viem's transport timeout) can never
   * freeze the whole sequential loop — the tick fails fast, the breaker backs off, the next market
   * runs. Defaults comfortably above the v3 settlement-sample window so a normal settle never trips it.
   */
  tickDeadlineMs: number;
  /**
   * Hard liveness backstop (ms): if the loop completes NO full pass within this window (a freeze the
   * per-tick deadline can't unblock, or a hung top-of-loop balance read), the keeper exits so its
   * supervisor restarts a truly frozen process. The dead-man's-switch of last resort.
   */
  stallExitMs: number;
  /**
   * DRAIN-ELIMINATION knobs (all optional so existing fixtures keep compiling; loadConfig always
   * sets them). simPreflight: simulate every keeper write before broadcasting so a doomed crank
   * never mines+reverts (zero gas) — default ON. fallbackGasLimit: worst-case gas units used to
   * estimate a timed-out tx's spend for the cap. v3MineLatencySec: a SETTLE is deferred (not
   * burned) when the on-chain maxPriceAge is below this, since no posted price could survive to the
   * mine block. spendCap: the persisted, sticky spend circuit-breaker. reserve: the owner-reserve
   * drawdown governor (rate alert + throttle/stop).
   */
  simPreflight?: boolean;
  fallbackGasLimit?: bigint;
  v3MineLatencySec?: number;
  spendCap?: SpendCapConfig;
  reserve?: ReserveGovConfig;
  /** Path to the refill-safe sentinel the keeper rewrites each pass and the gas-watchdog reads to
   *  decide whether to refill the signer (fresh + refillSafe:true) or fail closed. Optional. */
  refillSafeFile?: string;
}

const DEFAULTS = {
  HERMES_URL: 'https://hermes.pyth.network',
  POLL_INTERVAL_MS: 15_000,
  SWEEP_BATCH: 50,
  TX_GAS_CAP: 16_777_216n, // 2^24 — the Arc RPC's hard per-tx / estimate ceiling
  GAS_FLOOR_GWEI: 20,
  HERMES_TIMEOUT_MS: 8_000,
  RECEIPT_TIMEOUT_MS: 90_000,
  BASE_BACKOFF_MS: 5_000,
  MAX_BACKOFF_MS: 300_000,
  WEDGED_ALERT_THRESHOLD: 5,
  HTTP_PORT: 0, // 0 = health/metrics server OFF
  HTTP_HOST: '127.0.0.1',
  STALL_FACTOR: 3,
  // v2 fast poll (ms) used when ≥1 market is v2 — well under the ~12s pin window so the loop
  // attempts the pinned start/end multiple times across it (else a 15s poll could skip it).
  V2_POLL_INTERVAL_MS: 4_000,
  // v3 settlement-average sampling: 60s window (the PDF's recommendation), one sample / 2s.
  V3_SAMPLE_SEC: 60,
  V3_SAMPLE_INTERVAL_MS: 2_000,
  // TASK 4a — restart-safe metrics. Path empty => persistence OFF (in-memory only). When a
  // path IS set, flush the counters this often so a crash loses at most one interval's worth.
  METRICS_PERSIST_INTERVAL_MS: 30_000,
  // TASK 4b — bounded gas escalation. ATTEMPTS 0 => OFF (only the floor-priced send,
  // behavior unchanged). When ON, each retry multiplies the prior price by MULTIPLIER_BPS
  // (1.25x) up to MAX_FEE_GWEI. MAX_FEE_GWEI 0 => default the cap to 5x the floor.
  GAS_ESCALATION_ATTEMPTS: 0,
  GAS_ESCALATION_MULTIPLIER_BPS: 12_500, // 1.25x per step
  GAS_MAX_FEE_GWEI: 0, // 0 => derived cap (5x floor)
  // Alerting (dead-man's-switch). URLs OFF by default (log-only, unchanged). A 15-min
  // dedupe window keeps a persistent WEDGE from spamming the webhook every tick; a 5-min
  // heartbeat ping suits a Healthchecks.io-style monitor with a generous grace period.
  ALERT_DEDUPE_WINDOW_MS: 900_000, // 15 min
  ALERT_HEARTBEAT_INTERVAL_MS: 300_000, // 5 min
  ALERT_TIMEOUT_MS: 5_000,
  // ~enough native gas for 50 cranks: 50 * 500k gas * 20 gwei = 0.5 native (1e18 wei
  // units; Arc native is 18-dec). A conservative floor that triggers a refill warning
  // well before the keeper actually runs dry.
  LOW_BALANCE_WEI: 500_000_000_000_000_000n, // 0.5 * 1e18
} as const;

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') throw new Error(`[config] ${name} is required`);
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

/** An OPTIONAL string env var: blank/unset -> undefined (the feature stays OFF). */
function optStr(name: string): string | undefined {
  const v = (process.env[name] ?? '').trim();
  return v === '' ? undefined : v;
}

function reqAddress(name: string): Address {
  const v = req(name);
  try {
    return getAddress(v); // checksums + validates
  } catch {
    throw new Error(`[config] ${name} must be a valid 0x address, got "${v}"`);
  }
}

function reqPrivateKey(name: string): Hex {
  const raw = req(name);
  const v = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!isHex(v) || v.length !== 66) {
    throw new Error(`[config] ${name} must be a 32-byte hex private key (0x + 64 hex chars)`);
  }
  return v as Hex;
}

/**
 * Validate a raw private key string (with or without 0x prefix) and return it as a Hex.
 * Throws a descriptive error if the key is malformed.
 */
function validatePrivateKey(raw: string, source: string): Hex {
  const v = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!isHex(v) || v.length !== 66) {
    throw new Error(`[config] ${source} must be a 32-byte hex private key (0x + 64 hex chars), got a ${v.length - 2}-char hex value`);
  }
  return v as Hex;
}

/**
 * Resolve the keeper private key from EXACTLY ONE of:
 *   - KEEPER_PRIVATE_KEY      — inline hex value (testnet / simple deployments)
 *   - KEEPER_PRIVATE_KEY_FILE — path to a file containing the hex key (Docker secrets,
 *                               secret-manager mounts, chmod-400 files on bare metal).
 *                               The file content is trimmed before validation.
 *
 * Both set OR neither set is a hard startup error (fail-fast).
 *
 * NOTE: full KMS / encrypted-keystore support (HSM, cloud KMS, Foundry keystore unlock)
 * is documented as a mainnet hardening item — see README "Key handling on mainnet".
 */
function resolvePrivateKey(): Hex {
  const hasEnv = (process.env.KEEPER_PRIVATE_KEY ?? '').trim() !== '';
  const hasFile = (process.env.KEEPER_PRIVATE_KEY_FILE ?? '').trim() !== '';

  if (hasEnv && hasFile) {
    throw new Error(
      '[config] Set EXACTLY ONE of KEEPER_PRIVATE_KEY or KEEPER_PRIVATE_KEY_FILE — both are set. ' +
      'Remove the one you do not want to use.',
    );
  }
  if (!hasEnv && !hasFile) {
    throw new Error(
      '[config] KEEPER_PRIVATE_KEY (inline hex) or KEEPER_PRIVATE_KEY_FILE (path to key file) is required.',
    );
  }

  if (hasFile) {
    const filePath = process.env.KEEPER_PRIVATE_KEY_FILE!.trim();
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      throw new Error(
        `[config] KEEPER_PRIVATE_KEY_FILE: could not read "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return validatePrivateKey(raw, 'KEEPER_PRIVATE_KEY_FILE');
  }

  // hasEnv path — back-compat with the original reqPrivateKey logic.
  return reqPrivateKey('KEEPER_PRIVATE_KEY');
}

/**
 * Resolve the OPTIONAL owner key for wedge auto-recovery from
 * KEEPER_OWNER_PRIVATE_KEY. Returns undefined when unset/blank (recovery OFF —
 * behavior unchanged). When set, it must be a valid 32-byte hex key, else boot
 * fails fast. The key is used SOLELY for the onlyOwner `emergencySettle`
 * recovery crank — never for any normal lifecycle action.
 *
 * TESTNET convenience: an always-loaded hot owner key is acceptable on a
 * testnet to keep the market self-sustaining across keeper downtime. On
 * mainnet, prefer a cold owner key + manual/multisig emergencySettle.
 */
function resolveOwnerPrivateKey(): Hex | undefined {
  const raw = (process.env.KEEPER_OWNER_PRIVATE_KEY ?? '').trim();
  if (raw === '') return undefined; // unset/blank => recovery disabled (unchanged behavior)
  return validatePrivateKey(raw, 'KEEPER_OWNER_PRIVATE_KEY');
}

function posInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[config] ${name} must be a positive integer, got "${v}"`);
  }
  return n;
}

/** Like posInt but allows 0 (used for the HTTP port where 0 means "off"). */
function nonNegInt(name: string, fallback: number, max?: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || (max !== undefined && n > max)) {
    const bound = max !== undefined ? ` (0..${max})` : '';
    throw new Error(`[config] ${name} must be a non-negative integer${bound}, got "${v}"`);
  }
  return n;
}

/**
 * Resolve the keeper's RPC URL list from `KEEPER_RPC_URLS` (comma-separated, preferred)
 * and/or the single back-compat `KEEPER_RPC_URL`. Trims, validates each is http(s),
 * de-dupes (order-preserving), and includes the single URL if it isn't already present
 * so it's never silently dropped. Throws if the result is empty. Returns a non-empty list
 * whose first element is the primary (probe) URL.
 */
function parseRpcUrls(): string[] {
  const single = (process.env.KEEPER_RPC_URL ?? '').trim();
  const multiRaw = (process.env.KEEPER_RPC_URLS ?? '').trim();

  const fromMulti = multiRaw === ''
    ? []
    : multiRaw.split(',').map((s) => s.trim()).filter((s) => s !== '');

  // Order: the explicit comma list first, then the single (if distinct).
  const ordered = [...fromMulti];
  if (single !== '' && !ordered.includes(single)) ordered.push(single);

  // De-dupe, order-preserving.
  const urls = [...new Set(ordered)];

  if (urls.length === 0) {
    if (multiRaw !== '') throw new Error('[config] KEEPER_RPC_URLS had no usable URLs');
    throw new Error('[config] KEEPER_RPC_URL is required (or set KEEPER_RPC_URLS)');
  }

  for (const u of urls) {
    let ok = false;
    try {
      const proto = new URL(u).protocol;
      ok = proto === 'http:' || proto === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) {
      const src = multiRaw !== '' ? 'KEEPER_RPC_URLS' : 'KEEPER_RPC_URL';
      throw new Error(`[config] ${src} entry must be an http(s) URL, got "${u}"`);
    }
  }
  return urls;
}

function posBigInt(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  let n: bigint;
  try {
    n = BigInt(v.trim());
  } catch {
    throw new Error(`[config] ${name} must be a non-negative integer (wei), got "${v}"`);
  }
  if (n < 0n) throw new Error(`[config] ${name} must be a non-negative integer (wei), got "${v}"`);
  return n;
}

/**
 * Resolve an OPTIONAL http(s) URL env var. Blank/unset -> undefined (the feature stays OFF).
 * When set it must be a valid http(s) URL, else boot fails fast (a typo'd alert URL silently
 * dropping pages would be worse than a hard error).
 */
function optUrl(name: string): string | undefined {
  const v = (process.env[name] ?? '').trim();
  if (v === '') return undefined;
  let ok = false;
  try {
    const proto = new URL(v).protocol;
    ok = proto === 'http:' || proto === 'https:';
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`[config] ${name} must be an http(s) URL, got "${v}"`);
  return v;
}

/**
 * Load + validate the alerting (dead-man's-switch) config from the environment. Shared by BOTH
 * the lifecycle keeper and the arb bot (same env vars -> same alert routing). Both channel
 * URLs are optional: unset => that channel is OFF and behavior is unchanged (log-only).
 */
export function loadAlertConfig(): AlertConfig {
  return {
    webhookUrl: optUrl('ALERT_WEBHOOK_URL'),
    heartbeatUrl: optUrl('ALERT_HEARTBEAT_URL'),
    dedupeWindowMs: posInt('ALERT_DEDUPE_WINDOW_MS', DEFAULTS.ALERT_DEDUPE_WINDOW_MS),
    heartbeatIntervalMs: posInt('ALERT_HEARTBEAT_INTERVAL_MS', DEFAULTS.ALERT_HEARTBEAT_INTERVAL_MS),
    timeoutMs: posInt('ALERT_TIMEOUT_MS', DEFAULTS.ALERT_TIMEOUT_MS),
  };
}

/**
 * Load + validate the bounded gas-escalation policy (TASK 4b), shared by the lifecycle keeper
 * and the arb bot. `gasFloorWei` is the static floor every attempt-0 send uses. The cap
 * (GAS_MAX_FEE_GWEI) defaults to 5x the floor when 0/unset; the multiplier must be >= 1.0x
 * (10_000 bps) so escalation only ever raises the price. ATTEMPTS 0 => OFF (only the floor
 * send). Cross-checks: cap must be >= floor, else a single escalated retry could bid BELOW
 * the floor — a hard startup error.
 */
export function loadGasEscalation(gasFloorWei: bigint): GasEscalationConfig {
  const maxAttempts = nonNegInt('GAS_ESCALATION_ATTEMPTS', DEFAULTS.GAS_ESCALATION_ATTEMPTS);
  const multiplierBps = posInt('GAS_ESCALATION_MULTIPLIER_BPS', DEFAULTS.GAS_ESCALATION_MULTIPLIER_BPS);
  if (multiplierBps < 10_000) {
    throw new Error('[config] GAS_ESCALATION_MULTIPLIER_BPS must be >= 10000 (escalation only raises the price)');
  }
  const maxFeeGwei = nonNegInt('GAS_MAX_FEE_GWEI', DEFAULTS.GAS_MAX_FEE_GWEI);
  // Cap default: 5x the floor when unset (0). Otherwise the explicit ceiling in gwei.
  const capWei = maxFeeGwei === 0 ? gasFloorWei * 5n : BigInt(maxFeeGwei) * 1_000_000_000n;
  if (capWei < gasFloorWei) {
    throw new Error(`[config] GAS_MAX_FEE_GWEI cap (${capWei} wei) must be >= GAS_FLOOR_GWEI (${gasFloorWei} wei)`);
  }
  return { floorWei: gasFloorWei, capWei, multiplierBps, maxAttempts };
}

/**
 * Resolve a single market's contract version from its `version` / `pinned` JSON fields.
 * Precedence: an explicit `version` string ('v1'|'v2', case-insensitive) wins; else a
 * boolean `pinned:true` => 'v2'; else default 'v1' (back-compat — an existing market with
 * neither flag keeps its EXACT v1 behavior). Any other value is a hard error (a typo'd
 * "version":"V2x" must NOT silently fall back to v1 and crank the wrong path).
 */
function parseMarketVersion(r: Record<string, unknown>, name: string, i: number): MarketVersion {
  const vRaw = r.version;
  if (vRaw !== undefined && vRaw !== null && String(vRaw).trim() !== '') {
    const v = String(vRaw).trim().toLowerCase();
    if (v === 'v1' || v === 'v2' || v === 'v3') return v;
    throw new Error(`[config] ${name}[${i}].version must be "v1", "v2" or "v3", got "${String(vRaw)}"`);
  }
  if (r.pinned !== undefined) {
    if (typeof r.pinned !== 'boolean') {
      throw new Error(`[config] ${name}[${i}].pinned must be a boolean, got "${String(r.pinned)}"`);
    }
    return r.pinned ? 'v2' : 'v1';
  }
  return 'v1';
}

/**
 * Parse an OPTIONAL per-market subsidy (raw USDC units, 6-dp) from the market JSON's
 * `subsidyPerEpoch` field, falling back to the global default. Returns undefined when
 * neither is set OR the resolved amount is 0 (subsidy OFF). A non-integer / negative value
 * is a hard error. Only meaningful for v2 markets; v1 markets ignore it (no fundSubsidy).
 */
function parseMarketSubsidy(
  r: Record<string, unknown>,
  name: string,
  i: number,
  globalDefault: bigint | undefined,
): bigint | undefined {
  const raw = r.subsidyPerEpoch;
  let amount: bigint | undefined;
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    try {
      amount = BigInt(String(raw).trim());
    } catch {
      throw new Error(`[config] ${name}[${i}].subsidyPerEpoch must be a non-negative integer (raw USDC units), got "${String(raw)}"`);
    }
    if (amount < 0n) {
      throw new Error(`[config] ${name}[${i}].subsidyPerEpoch must be a non-negative integer (raw USDC units), got "${String(raw)}"`);
    }
  } else {
    amount = globalDefault;
  }
  if (amount === undefined || amount === 0n) return undefined;
  return amount;
}

function parseMarkets(name: string, globalSubsidy: bigint | undefined): MarketConfig[] {
  const raw = req(name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[config] ${name} is not valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`[config] ${name} must be a non-empty JSON array`);
  }

  const seen = new Set<string>();
  return parsed.map((m, i) => {
    if (typeof m !== 'object' || m === null) {
      throw new Error(`[config] ${name}[${i}] must be an object`);
    }
    const r = m as Record<string, unknown>;
    const id = String(r.id ?? '').trim();
    if (id === '') throw new Error(`[config] ${name}[${i}].id must be a non-empty string`);
    if (seen.has(id)) throw new Error(`[config] ${name} has duplicate market id "${id}"`);
    seen.add(id);

    const arenaStr = String(r.arena ?? '').trim();
    let arena: Address;
    try {
      arena = getAddress(arenaStr);
    } catch {
      throw new Error(`[config] ${name}[${i}].arena must be a valid 0x address, got "${arenaStr}"`);
    }

    let feed = String(r.feedId ?? '').trim();
    if (!feed.startsWith('0x')) feed = `0x${feed}`;
    if (!isHex(feed) || feed.length !== 66) {
      throw new Error(`[config] ${name}[${i}].feedId must be a 32-byte hex feed id (0x + 64 hex chars)`);
    }

    // OPTIONAL second feed for a cross-quoted market (e.g. EUR/USD for a cirBTC/EURC = BTC/EUR market).
    let quoteFeed: Hex | undefined;
    if (r.quoteFeedId !== undefined && r.quoteFeedId !== null && String(r.quoteFeedId).trim() !== '') {
      let qf = String(r.quoteFeedId).trim();
      if (!qf.startsWith('0x')) qf = `0x${qf}`;
      if (!isHex(qf) || qf.length !== 66) {
        throw new Error(`[config] ${name}[${i}].quoteFeedId must be a 32-byte hex feed id (0x + 64 hex chars)`);
      }
      quoteFeed = qf as Hex;
    }

    const version = parseMarketVersion(r, name, i);
    // The GLOBAL default only applies to v2 markets (v1 has no fundSubsidy), so a global
    // subsidy never leaks onto v1 markets in a mixed config. An EXPLICIT per-market subsidy on
    // a v1 market is still a hard error below (a deliberate config mistake worth surfacing).
    const hasPerMarketSubsidy =
      r.subsidyPerEpoch !== undefined && r.subsidyPerEpoch !== null && String(r.subsidyPerEpoch).trim() !== '';
    const subsidy = parseMarketSubsidy(r, name, i, version === 'v2' ? globalSubsidy : undefined);
    // An EXPLICIT subsidy on a non-v2 market is a config mistake (only v2 has fundSubsidy) —
    // fail fast so it's never silently dropped, rather than crank a market the operator thinks is funded.
    if (version !== 'v2' && hasPerMarketSubsidy && subsidy !== undefined) {
      throw new Error(`[config] ${name}[${i}] sets subsidyPerEpoch but is a ${version} market (fundSubsidy is v2-only) — set "version":"v2" or remove the subsidy`);
    }

    return {
      id,
      label: String(r.label ?? id).trim() || id,
      arena,
      feedId: feed as Hex,
      ...(quoteFeed ? { quoteFeedId: quoteFeed } : {}),
      version,
      ...(subsidy !== undefined ? { subsidyPerEpoch: subsidy } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Arb (price-keeper) configuration. The arb bot is a SEPARATE process with a
// SEPARATE key (KEEPER_ARB_PRIVATE_KEY) so its nonces never collide with the
// lifecycle keeper. It reads the pool + Pyth ref and trades the pool back toward
// the reference so the AMM's real 0.3% fee funds the pot.
// ---------------------------------------------------------------------------

/** The single market the arb bot trades (its pool + the tokens + the Pyth feed). */
export interface ArbMarketConfig {
  id: string;
  label: string;
  /** The market's FeeArena (for context/labelling; the bot trades the pool, not the arena). */
  arena: Address;
  /** The Uniswap-V3 pool to read slot0()/liquidity() from and to trade against. */
  pool: Address;
  /** The base token (e.g. cirBTC). */
  base: Address;
  /** The base token's decimals (cirBTC = 8). */
  baseDecimals: number;
  /** The quote token (USDC, 6dp native) — the other leg of the pool. */
  quote: Address;
  /** The quote token's decimals (USDC = 6). */
  quoteDecimals: number;
  /** The Pyth 32-byte price-feed id for the base/USD reference (read-only via Hermes). */
  feedId: Hex;
  /**
   * OPTIONAL second Pyth feed for a CROSS-quoted market (e.g. cirBTC/EURC settles on BTC/EUR =
   * BTC/USD ÷ EUR/USD). When set, the arb reads the cross rate `feedId / quoteFeedId` as its peg
   * reference (matching the on-chain CompositePythOracle) instead of the single `feedId`. Absent =>
   * single-feed market — the existing cirBTC/USDC behavior is byte-for-byte unchanged.
   */
  quoteFeedId?: Hex;
  /** The Uniswap-V3 SwapRouter used to execute exactInputSingle. */
  router: Address;
  /** The pool fee tier (3000 = 0.3%). */
  feeTier: number;
}

/** Tunable arb decision params (mirrors decideArb's ArbParams; bigints are raw base units). */
export interface ArbParamsConfig {
  feeBps: number;
  thresholdBps: number;
  closeFraction: number;
  maxTradeBase: bigint;
  minTradeBase: bigint;
  /** cirBTC reserve the arb never sells below (raw base units; 0 => no reserve). */
  reserveBase: bigint;
  /** Quote/gas reserve the arb never spends below on a BUY (raw quote units; 0 => no reserve). */
  reserveQuote: bigint;
  maxRefAgeSec: number;
  /** Slippage (bps) used to set amountOutMinimum on the swap (50-100 bps typical). */
  slippageBps: number;

  // ---- inventory mean-reversion + deliverability (0/omitted => OFF, behavior unchanged) ----
  /**
   * TARGET cirBTC share of total inventory VALUE in bps (5000 = 50/50). >0 turns ON the target-band
   * gate: sell cirBTC only while heavy, buy only while light, so the finite battery mean-reverts
   * instead of ratcheting to a floor in a trend. Omitted/0 => OFF.
   */
  targetBaseShareBps?: number;
  /**
   * DELIVERABILITY safety (bps): cap every leg at this fraction of the pool's real token balance so
   * it never reverts "Too little received". Omitted/0 => OFF.
   */
  poolDeliverableSafetyBps?: number;
  /**
   * TWO-SIDED PEG DEFENSE (opt-in). When true, the target-band gate no longer declines a peg-correcting
   * BUY while cirBTC-heavy — so the keeper defends the DOWNSIDE of the peg (buys base to lift a sub-peg
   * pool) up to its quote reserve, rather than letting the pool sit under peg. Safe one-sided relaxation:
   * a BUY refills the finite battery and is bounded by reserveQuote; the SELL (battery-draining) gate is
   * untouched. Omitted/false => legacy one-directional gate. Defaults OFF so the USDC arb is unchanged.
   */
  buyDefendsPeg?: boolean;

  // ---- TASK 3a: inventory rebalancing (0 floor => OFF, behavior unchanged) ----
  /** Rebalance trigger floor in bps of total inventory VALUE (0 = OFF). */
  rebalanceFloorBps: number;
  /** Target inventory split in bps of total value (5000 = 50/50). */
  rebalanceTargetBps: number;
  /** Hard CAP on a single rebalancing swap's base notional (raw base units). */
  rebalanceMaxBase: bigint;
  /**
   * FINDING 3 — minimum spacing (ms) between REBALANCE legs (rate-limit, like the heartbeat).
   * 0 => no interval guard. Defaults to the poll interval so a rebalance fires at most once
   * per poll batch instead of every tick while a leg sits below the floor.
   */
  rebalanceIntervalMs: number;
  /** FINDING 4 — per-day cap on rebalance ATTEMPTS (not just settled notional). 0 => uncapped. */
  rebalanceDailyMaxAttempts: number;

  // ---- TASK 3b: heartbeat volume (disabled => OFF, behavior unchanged) ----
  /** Master switch for heartbeat-volume mode. */
  heartbeatEnabled: boolean;
  /** Minimum spacing (ms) between heartbeat legs. */
  heartbeatIntervalMs: number;
  /** Per-day budget cap on heartbeat base notional (raw base units). */
  heartbeatDailyCapBase: bigint;
  /** Base notional per heartbeat leg (raw base units). */
  heartbeatTradeBase: bigint;
  /** FINDING 4 — per-day cap on heartbeat ATTEMPTS (not just settled notional). 0 => uncapped. */
  heartbeatDailyMaxAttempts: number;
}

/** Fully-validated arb-bot configuration (separate process + separate key). */
export interface ArbConfig {
  rpcUrl: string;
  rpcUrls: string[];
  /** The arb signer key — SEPARATE from the lifecycle keeper key (KEEPER_ARB_PRIVATE_KEY). */
  privateKey: Hex;
  hermesUrl: string;
  market: ArbMarketConfig;
  params: ArbParamsConfig;
  /**
   * FLOW BUDGET — the rolling-window cap on NET cirBTC the arb may sell (raw base units), with the
   * window length and a persisted ledger file. 0 budget OR 0 window => OFF. The executor maintains
   * the ledger across ticks + restarts and injects a FlowState snapshot into the pure decision.
   * Omitted => OFF (legacy; existing fixtures unaffected). loadArbConfig always sets them.
   */
  flowBudgetBase?: bigint;
  flowWindowMs?: number;
  flowLedgerFile?: string;
  pollIntervalMs: number;
  gasFloorWei: bigint;
  hermesTimeoutMs: number;
  receiptTimeoutMs: number;
  lowBalanceWei: bigint;
  /** TASK 4b — bounded gas-tip escalation (shared with the lifecycle keeper). See above. */
  gasEscalation: GasEscalationConfig;
  baseBackoffMs: number;
  maxBackoffMs: number;
  wedgedAlertThreshold: number;
  /**
   * Port for the arb bot's optional health HTTP server. 0 = OFF (no server). >0 starts
   * a `node:http` server on `httpHost`:`httpPort` exposing GET /health (200 healthy /
   * 503 degraded). Distinct default (9465) from the lifecycle keeper (9464) so both can
   * run on one host without a port clash. Bound to loopback by default.
   */
  httpPort: number;
  /** Bind host for the arb health server. Default 127.0.0.1 (loopback only). */
  httpHost: string;
  /**
   * Multiplier on pollIntervalMs after which a silent arb loop (no tick) is treated as
   * STALLED -> /health reports DEGRADED. Default 3.
   */
  stallFactor: number;
  /**
   * TASK 4a — path to the arb bot's restart-safe metrics state file (SEPARATE from the
   * lifecycle keeper's so the two processes never clobber each other's counters). Empty
   * (default) => persistence OFF (in-memory only). See KeeperConfig.metricsStateFile.
   */
  metricsStateFile?: string;
  /** TASK 4a — how often (ms) to flush the arb metrics state file while running. */
  metricsPersistIntervalMs: number;
  /** Real-alerting (dead-man's-switch) config — same env vars as the lifecycle keeper. */
  alert: AlertConfig;
}

const ARB_DEFAULTS = {
  FEE_BPS: 30,
  THRESHOLD_BPS: 25,
  CLOSE_FRACTION: 0.6,
  MAX_REF_AGE_SEC: 60,
  SLIPPAGE_BPS: 75,
  POLL_INTERVAL_MS: 15_000,
  FEE_TIER: 3000,
  HTTP_PORT: 0, // 0 = health server OFF
  HTTP_HOST: '127.0.0.1',
  STALL_FACTOR: 3,
  // TASK 3a — rebalancing. Floor 0 => OFF (behavior unchanged). Target 50/50 by value.
  REBALANCE_FLOOR_BPS: 0,
  REBALANCE_TARGET_BPS: 5_000,
  // FINDING 3/4 — rebalance governors. 0 interval => no guard (resolved to the poll interval
  // below when unset, so a rebalance fires at most once per poll, not every tick). 0 attempts
  // => uncapped (the interval guard still applies).
  REBALANCE_INTERVAL_MS: 0,
  REBALANCE_DAILY_MAX_ATTEMPTS: 0,
  // TASK 3b — heartbeat volume. Disabled by default; a 1h spacing is a sane baseline.
  HEARTBEAT_ENABLED: false,
  HEARTBEAT_INTERVAL_MS: 3_600_000, // 1 hour
  // FINDING 4 — per-day heartbeat ATTEMPT cap. 0 => uncapped (the notional cap still applies).
  HEARTBEAT_DAILY_MAX_ATTEMPTS: 0,
} as const;

/** Resolve the SEPARATE arb signer key (env only — keep it isolated from the lifecycle key). */
function resolveArbPrivateKey(): Hex {
  return reqPrivateKey('KEEPER_ARB_PRIVATE_KEY');
}

/** A REQUIRED positive bigint (raw token units). Throws if missing or <= 0. */
function reqPosBigInt(name: string): bigint {
  const raw = req(name);
  let n: bigint;
  try {
    n = BigInt(raw);
  } catch {
    throw new Error(`[config] ${name} must be a positive integer (raw units), got "${raw}"`);
  }
  if (n <= 0n) throw new Error(`[config] ${name} must be a positive integer (raw units), got "${raw}"`);
  return n;
}

/** A fraction strictly in (0, 1]. */
function fraction01(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new Error(`[config] ${name} must be a number in (0, 1], got "${v}"`);
  }
  return n;
}

/** A boolean env var. Accepts true/false/1/0/yes/no (case-insensitive); blank => fallback. */
function boolEnv(name: string, fallback: boolean): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(`[config] ${name} must be a boolean (true/false/1/0/yes/no), got "${process.env[name]}"`);
}

/**
 * An OPTIONAL non-negative bigint (raw token units) with a fallback. Blank/unset => fallback.
 * Used for the rebalance/heartbeat budgets, which are OFF by their feature switch when 0.
 */
function optBigInt(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return fallback;
  let n: bigint;
  try {
    n = BigInt(v.trim());
  } catch {
    throw new Error(`[config] ${name} must be a non-negative integer (raw units), got "${v}"`);
  }
  if (n < 0n) throw new Error(`[config] ${name} must be a non-negative integer (raw units), got "${v}"`);
  return n;
}

/** Parse the single arb market from KEEPER_ARB_MARKET (a JSON object). */
function parseArbMarket(name: string): ArbMarketConfig {
  const raw = req(name);
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error(`[config] ${name} is not valid JSON`);
  }
  if (typeof m !== 'object' || m === null || Array.isArray(m)) {
    throw new Error(`[config] ${name} must be a JSON object`);
  }
  const r = m as Record<string, unknown>;

  const id = String(r.id ?? '').trim();
  if (id === '') throw new Error(`[config] ${name}.id must be a non-empty string`);

  const addr = (field: string): Address => {
    const v = String(r[field] ?? '').trim();
    try {
      return getAddress(v);
    } catch {
      throw new Error(`[config] ${name}.${field} must be a valid 0x address, got "${v}"`);
    }
  };
  const dec = (field: string): number => {
    const n = Number(r[field]);
    if (!Number.isInteger(n) || n < 0 || n > 36) {
      throw new Error(`[config] ${name}.${field} must be an integer 0..36, got "${String(r[field])}"`);
    }
    return n;
  };

  let feed = String(r.feedId ?? '').trim();
  if (!feed.startsWith('0x')) feed = `0x${feed}`;
  if (!isHex(feed) || feed.length !== 66) {
    throw new Error(`[config] ${name}.feedId must be a 32-byte hex feed id (0x + 64 hex chars)`);
  }

  // OPTIONAL second feed for a CROSS-quoted arb market (e.g. EUR/USD for a cirBTC/EURC = BTC/EUR
  // market). Absent => single-feed (the existing cirBTC/USDC arb is unchanged). Mirrors parseMarkets.
  let quoteFeed: Hex | undefined;
  if (r.quoteFeedId !== undefined && r.quoteFeedId !== null && String(r.quoteFeedId).trim() !== '') {
    let qf = String(r.quoteFeedId).trim();
    if (!qf.startsWith('0x')) qf = `0x${qf}`;
    if (!isHex(qf) || qf.length !== 66) {
      throw new Error(`[config] ${name}.quoteFeedId must be a 32-byte hex feed id (0x + 64 hex chars)`);
    }
    quoteFeed = qf as Hex;
  }

  const feeTier = r.feeTier === undefined ? ARB_DEFAULTS.FEE_TIER : Number(r.feeTier);
  if (!Number.isInteger(feeTier) || feeTier <= 0) {
    throw new Error(`[config] ${name}.feeTier must be a positive integer, got "${String(r.feeTier)}"`);
  }

  return {
    id,
    label: String(r.label ?? id).trim() || id,
    arena: addr('arena'),
    pool: addr('pool'),
    base: addr('base'),
    baseDecimals: dec('baseDecimals'),
    quote: addr('quote'),
    quoteDecimals: dec('quoteDecimals'),
    feedId: feed as Hex,
    ...(quoteFeed ? { quoteFeedId: quoteFeed } : {}),
    router: addr('router'),
    feeTier,
  };
}

/**
 * Load + validate the arb-bot config from the environment (throws on any problem). Shares
 * the RPC / Hermes / gas-floor plumbing with the lifecycle keeper but uses its OWN key and
 * its OWN single market + tunable params. Separate process => separate nonces.
 */
export function loadArbConfig(): ArbConfig {
  const gasFloorGwei = posInt('GAS_FLOOR_GWEI', DEFAULTS.GAS_FLOOR_GWEI);
  const rpcUrls = parseRpcUrls();
  const cfg: ArbConfig = {
    rpcUrl: rpcUrls[0]!,
    rpcUrls,
    privateKey: resolveArbPrivateKey(),
    hermesUrl: opt('HERMES_URL', DEFAULTS.HERMES_URL).replace(/\/$/, ''),
    market: parseArbMarket('KEEPER_ARB_MARKET'),
    params: {
      feeBps: posInt('ARB_FEE_BPS', ARB_DEFAULTS.FEE_BPS),
      thresholdBps: posInt('ARB_THRESHOLD_BPS', ARB_DEFAULTS.THRESHOLD_BPS),
      closeFraction: fraction01('ARB_CLOSE_FRACTION', ARB_DEFAULTS.CLOSE_FRACTION),
      maxTradeBase: reqPosBigInt('ARB_MAX_TRADE_BASE'),
      minTradeBase: reqPosBigInt('ARB_MIN_TRADE_BASE'),
      reserveBase: optBigInt('ARB_RESERVE_BASE', 0n), // cirBTC the arb never sells below (0 => off)
      reserveQuote: optBigInt('ARB_RESERVE_QUOTE', 0n), // quote/gas the arb never spends below on a BUY (0 => off)
      maxRefAgeSec: posInt('ARB_MAX_REF_AGE_SEC', ARB_DEFAULTS.MAX_REF_AGE_SEC),
      slippageBps: posInt('ARB_SLIPPAGE_BPS', ARB_DEFAULTS.SLIPPAGE_BPS),
      // Inventory mean-reversion + deliverability. Both 0 => OFF (legacy behavior).
      targetBaseShareBps: nonNegInt('ARB_TARGET_BASE_SHARE_BPS', 0, 10_000),
      poolDeliverableSafetyBps: nonNegInt('ARB_POOL_DELIVERABLE_SAFETY_BPS', 0, 10_000),
      // Two-sided peg defense (opt-in). false => legacy one-directional gate (USDC arb unchanged).
      buyDefendsPeg: boolEnv('ARB_BUY_DEFENDS_PEG', false),
      // TASK 3a — inventory rebalancing. Floor 0 => OFF. rebalanceMaxBase defaults to the arb cap.
      rebalanceFloorBps: nonNegInt('ARB_REBALANCE_FLOOR_BPS', ARB_DEFAULTS.REBALANCE_FLOOR_BPS, 10_000),
      rebalanceTargetBps: nonNegInt('ARB_REBALANCE_TARGET_BPS', ARB_DEFAULTS.REBALANCE_TARGET_BPS, 10_000),
      rebalanceMaxBase: optBigInt('ARB_REBALANCE_MAX_BASE', 0n), // 0 => fall back to maxTradeBase below
      // FINDING 3/4 — rebalance governors. Interval 0 => resolved to the poll interval below.
      rebalanceIntervalMs: nonNegInt('ARB_REBALANCE_INTERVAL_MS', ARB_DEFAULTS.REBALANCE_INTERVAL_MS),
      rebalanceDailyMaxAttempts: nonNegInt('ARB_REBALANCE_DAILY_MAX_ATTEMPTS', ARB_DEFAULTS.REBALANCE_DAILY_MAX_ATTEMPTS),
      // TASK 3b — heartbeat volume. Disabled by default; budgets default to 0 (also OFF).
      heartbeatEnabled: boolEnv('ARB_HEARTBEAT_ENABLED', ARB_DEFAULTS.HEARTBEAT_ENABLED),
      heartbeatIntervalMs: posInt('ARB_HEARTBEAT_INTERVAL_MS', ARB_DEFAULTS.HEARTBEAT_INTERVAL_MS),
      heartbeatDailyCapBase: optBigInt('ARB_HEARTBEAT_DAILY_CAP_BASE', 0n),
      heartbeatTradeBase: optBigInt('ARB_HEARTBEAT_TRADE_BASE', 0n),
      // FINDING 4 — per-day heartbeat attempt cap. 0 => uncapped (notional cap still applies).
      heartbeatDailyMaxAttempts: nonNegInt('ARB_HEARTBEAT_DAILY_MAX_ATTEMPTS', ARB_DEFAULTS.HEARTBEAT_DAILY_MAX_ATTEMPTS),
    },
    // FLOW BUDGET (rolling-window net cirBTC sold). A positive budget REQUIRES a positive window.
    flowBudgetBase: optBigInt('ARB_FLOW_BUDGET_BASE', 0n),
    flowWindowMs: nonNegInt('ARB_FLOW_WINDOW_MS', 0),
    flowLedgerFile: optStr('ARB_FLOW_LEDGER_FILE'),
    pollIntervalMs: posInt('ARB_POLL_INTERVAL_MS', ARB_DEFAULTS.POLL_INTERVAL_MS),
    gasFloorWei: BigInt(gasFloorGwei) * 1_000_000_000n,
    hermesTimeoutMs: posInt('HERMES_TIMEOUT_MS', DEFAULTS.HERMES_TIMEOUT_MS),
    receiptTimeoutMs: posInt('RECEIPT_TIMEOUT_MS', DEFAULTS.RECEIPT_TIMEOUT_MS),
    lowBalanceWei: posBigInt('LOW_BALANCE_WEI', DEFAULTS.LOW_BALANCE_WEI),
    gasEscalation: loadGasEscalation(BigInt(gasFloorGwei) * 1_000_000_000n),
    baseBackoffMs: posInt('BASE_BACKOFF_MS', DEFAULTS.BASE_BACKOFF_MS),
    maxBackoffMs: posInt('MAX_BACKOFF_MS', DEFAULTS.MAX_BACKOFF_MS),
    wedgedAlertThreshold: posInt('WEDGED_ALERT_THRESHOLD', DEFAULTS.WEDGED_ALERT_THRESHOLD),
    httpPort: nonNegInt('KEEPER_ARB_HTTP_PORT', ARB_DEFAULTS.HTTP_PORT, 65535),
    httpHost: opt('KEEPER_ARB_HTTP_HOST', ARB_DEFAULTS.HTTP_HOST),
    stallFactor: posInt('ARB_STALL_FACTOR', ARB_DEFAULTS.STALL_FACTOR),
    metricsStateFile: optStr('KEEPER_ARB_METRICS_STATE_FILE'),
    metricsPersistIntervalMs: posInt('KEEPER_ARB_METRICS_PERSIST_INTERVAL_MS', DEFAULTS.METRICS_PERSIST_INTERVAL_MS),
    alert: loadAlertConfig(),
  };
  // Cross-field sanity: min must not exceed max.
  if (cfg.params.minTradeBase > cfg.params.maxTradeBase) {
    throw new Error('[config] ARB_MIN_TRADE_BASE must be <= ARB_MAX_TRADE_BASE');
  }

  // TASK 3a — default the rebalance cap to the arb cap when unset (0), so an enabled
  // rebalance is bounded by the same per-trade ceiling as a normal arb unless overridden.
  if (cfg.params.rebalanceMaxBase === 0n) {
    cfg.params.rebalanceMaxBase = cfg.params.maxTradeBase;
  }
  // When rebalancing is ON, the floor must sit strictly below the target (a leg below the
  // floor is topped up toward the target — an inverted pair would be nonsensical).
  if (cfg.params.rebalanceFloorBps > 0 && cfg.params.rebalanceFloorBps >= cfg.params.rebalanceTargetBps) {
    throw new Error('[config] ARB_REBALANCE_FLOOR_BPS must be < ARB_REBALANCE_TARGET_BPS');
  }
  // FINDING 3 — default the rebalance interval to the poll interval when unset (0) and
  // rebalancing is enabled, so the rebalance leg is rate-limited to at most once per poll
  // instead of firing every tick (the old unbounded-per-poll behavior). An explicit value
  // (incl. a longer spacing) is honored as-is.
  if (cfg.params.rebalanceFloorBps > 0 && cfg.params.rebalanceIntervalMs === 0) {
    cfg.params.rebalanceIntervalMs = cfg.pollIntervalMs;
  }

  // TASK 3b — when heartbeat mode is ON, the per-leg trade + daily cap must be positive and
  // the leg must not exceed the daily cap (else a single leg would blow the whole budget).
  if (cfg.params.heartbeatEnabled) {
    if (cfg.params.heartbeatTradeBase <= 0n) {
      throw new Error('[config] ARB_HEARTBEAT_TRADE_BASE must be > 0 when ARB_HEARTBEAT_ENABLED');
    }
    if (cfg.params.heartbeatDailyCapBase <= 0n) {
      throw new Error('[config] ARB_HEARTBEAT_DAILY_CAP_BASE must be > 0 when ARB_HEARTBEAT_ENABLED');
    }
    if (cfg.params.heartbeatTradeBase > cfg.params.heartbeatDailyCapBase) {
      throw new Error('[config] ARB_HEARTBEAT_TRADE_BASE must be <= ARB_HEARTBEAT_DAILY_CAP_BASE');
    }
  }
  // A flow budget without a window can't be evaluated (the window defines "per window").
  if ((cfg.flowBudgetBase ?? 0n) > 0n && (cfg.flowWindowMs ?? 0) <= 0) {
    throw new Error('[config] ARB_FLOW_WINDOW_MS must be > 0 when ARB_FLOW_BUDGET_BASE is set');
  }
  return Object.freeze(cfg);
}

// ---------------------------------------------------------------------------
// Swap bot — a SEPARATE process + key (SWAPBOT_PRIVATE_KEY) whose ONLY job is to
// generate continuous trading VOLUME so LP positions (staked or not) accrue claimable
// fees even in quiet rounds. It does small balance-aware round-trip swaps on the SAME
// pool the arb trades; the arb keeps the price pegged to Pyth, the swap bot just makes
// volume. Reuses the arb market config (KEEPER_ARB_MARKET) so pool/tokens/router/decimals
// are defined once.
// ---------------------------------------------------------------------------

export interface SwapbotConfig {
  rpcUrl: string;
  rpcUrls: string[];
  /** The swap-bot signer key — SEPARATE from the keeper + arb keys (SWAPBOT_PRIVATE_KEY). */
  privateKey: Hex;
  /** Reuses the arb market (pool/base/quote/router/decimals/feeTier). */
  market: ArbMarketConfig;
  /** Base-denominated size of each swap (raw base units; e.g. cirBTC 8dp). */
  tradeBase: bigint;
  /** Target swaps per minute (the user asked for 15). */
  swapsPerMin: number;
  /** Derived: the spacing between swaps in ms (60000 / swapsPerMin, floored, min 200ms). */
  intervalMs: number;
  /** Slippage (bps) for amountOutMinimum + the bounded sqrtPriceLimit offset. */
  slippageBps: number;
  gasFloorWei: bigint;
  /**
   * Bounded gas-tip escalation (reuses the shared GAS_ESCALATION_* keys, same as the arb). On a
   * receipt-wait TIMEOUT the same swap is re-sent at a higher (capped) tip — viem replaces the
   * still-pending nonce — so an under-priced/stuck tx gets unstuck instead of dropping the minute.
   */
  gasEscalation: GasEscalationConfig;
  /** Receipt-wait timeout (ms). Kept BELOW the swap interval so one stuck tx can't block the loop. */
  receiptTimeoutMs: number;
  lowBalanceWei: bigint;
  httpPort: number;
  httpHost: string;
  /** Hermes endpoint for the PEG GATE's live Pyth reference (reuses the arb's feed). */
  hermesUrl: string;
  /** Abort a hung Hermes fetch after this many ms (the gate fails CLOSED for that tick). */
  hermesTimeoutMs: number;
  /**
   * ROUND-TRIP mode (the peg-neutral volume generator). When true, each tick BUYS `tradeBase`-worth of
   * base then immediately SELLS it back down to `targetBase` — two back-to-back swaps with ~zero net
   * position + ~zero net price impact, so volume/fees accrue WITHOUT moving the peg (the arb rarely
   * intervenes). Only the QUOTE (USDC) leg needs funding. false => legacy strict-alternation.
   */
  roundTrip: boolean;
  /** Flat base inventory the round-trip returns to each tick (raw base units; default 0 = sell it all). */
  targetBase: bigint;
  /**
   * DELIVERABILITY safety (bps): cap every SELL leg (round-trip recovery + buy-back, maker correct)
   * at this fraction of the pool's real USDC balance so it never reverts "Too little received" on a
   * thin/one-sided pool — it idles instead. Omitted/0 => OFF (legacy behavior).
   */
  poolDeliverableSafetyBps?: number;
  /**
   * MARKET-MAKER mode (the peg-band MM that replaces the one-way arb battery). When enabled the bot
   * stops PAUSING off-peg and instead trades TOWARD the peg (sell base when the pool is high, buy when
   * low), inventory-skewed with a HARD cirBTC floor so it can never deplete, and refills aggressively
   * on dips. Inside the deadband it falls back to a peg-neutral round-trip for volume. Disabled =>
   * legacy round-trip/alternate behavior (unchanged). See swapMaker.ts.
   */
  maker?: {
    enabled: boolean;
    deadbandBps: number;
    floorBase: bigint;
    targetBase: bigint;
    reserveQuote: bigint;
    skewK: number;
    maxTradeBase: bigint;
    minTradeBase: bigint;
    closeFraction: number;
  };
  /**
   * PEG GATE (the swap-bot↔arb sync fix). The swap bot pauses volume whenever the pool's distance
   * from the live Pyth reference exceeds this many bps — so it never pumps volume into an off-peg
   * pool the arb is still re-pegging (or can't, when depleted), which is what let the pool run away.
   * 0 => gate OFF (legacy strict-alternation behavior). Set > 0 (e.g. 200 = 2%) to enable.
   */
  maxPegDeviationBps: number;
  /**
   * EPOCH mode — the per-epoch balanced peg-NEUTRAL pair (the drift-proof replacement for the
   * continuous round-trip). When enabled it SUPERSEDES maker/roundTrip/alternate: instead of firing
   * ~15 round-trips a minute (which ratchet a thin pool up), the bot fires exactly ONE atomic
   * multicall([SELL tradeBase, BUY tradeBase]) at the start of each NEW arena epoch — SELL-first,
   * both legs' sqrtPriceLimit pinned to the live oracle so neither can push the pool past the peg,
   * sized to land the pool AT the oracle. Atomicity makes it structurally impossible to leave a
   * residual long or a pushed pool; a persisted lastEpochActed scalar makes it fire at most once per
   * epoch and restart-safe. Also fixes "0-swap epochs earn no Stance fees" — every epoch gets one
   * guaranteed fee-generating pair. Disabled => legacy behavior is byte-for-byte unchanged.
   */
  epoch?: {
    enabled: boolean;
    /** The v3 ENTRY-ANCHORED arena to read currentEpochId() from (NOT market.arena, the v1 addr). */
    arena: Address;
    /** Persisted lastEpochActed ledger path (REQUIRED when epoch mode is on — restart safety). */
    ledgerFile: string;
    /** Base-denominated notional of EACH leg of the pair, before depth/dust sizing (raw base). */
    pairTradeBase: bigint;
    /** Hard CAP on a single leg's notional (raw base). */
    pairMaxTradeBase: bigint;
    /** Dust floor: a sized notional below this => skip the pair this epoch (raw base). */
    pairMinTradeBase: bigint;
    /** Fraction (0..1] of the pool→oracle gap to close when sizing the pair; 1.0 lands AT the oracle. */
    pairCloseFraction: number;
    /**
     * Documentation only: the one-time cirBTC working reserve the bot must hold to fund the SELL-first
     * leg (leg B buys it straight back atomically, so it round-trips and is NOT consumed). Logged at
     * boot so an operator funds the wallet; not otherwise enforced (a short balance just reverts the
     * atomic pair, which is safe — nothing happens).
     */
    workingReserveBase: bigint;
  };
}

/** Load + validate the swap-bot config from the environment (throws on any problem). */
export function loadSwapbotConfig(): SwapbotConfig {
  const gasFloorGwei = posInt('GAS_FLOOR_GWEI', DEFAULTS.GAS_FLOOR_GWEI);
  const rpcUrls = parseRpcUrls();
  const swapsPerMin = posInt('SWAPBOT_SWAPS_PER_MIN', 15);
  const tradeBase = optBigInt('SWAPBOT_TRADE_BASE', 3_000n); // 0.00003 cirBTC default
  if (tradeBase <= 0n) throw new Error('[config] SWAPBOT_TRADE_BASE must be > 0');
  const cfg: SwapbotConfig = {
    rpcUrl: rpcUrls[0]!,
    rpcUrls,
    privateKey: reqPrivateKey('SWAPBOT_PRIVATE_KEY'),
    // The pool the swap bot trades. Defaults to the arb's market (KEEPER_ARB_MARKET) so the existing
    // single bot is unchanged; set SWAPBOT_MARKET to run a SECOND swap bot on another pool (e.g. a
    // cirBTC/EURC volume bot independent of the cirBTC/USDC one).
    market: parseArbMarket(optStr('SWAPBOT_MARKET') ? 'SWAPBOT_MARKET' : 'KEEPER_ARB_MARKET'),
    tradeBase,
    swapsPerMin,
    intervalMs: Math.max(200, Math.floor(60_000 / swapsPerMin)),
    slippageBps: posInt('SWAPBOT_SLIPPAGE_BPS', 200), // 2% — generous for tiny round-trips
    gasFloorWei: BigInt(gasFloorGwei) * 1_000_000_000n,
    gasEscalation: loadGasEscalation(BigInt(gasFloorGwei) * 1_000_000_000n),
    // Default 25s — comfortably below the 60s/1-swap interval so a stuck tx times out + escalates
    // (or drops at most THIS minute) instead of blocking the loop for the arb's 90s default.
    receiptTimeoutMs: posInt('SWAPBOT_RECEIPT_TIMEOUT_MS', 25_000),
    lowBalanceWei: posBigInt('LOW_BALANCE_WEI', DEFAULTS.LOW_BALANCE_WEI),
    httpPort: nonNegInt('SWAPBOT_HTTP_PORT', 0, 65535),
    httpHost: opt('SWAPBOT_HTTP_HOST', '127.0.0.1'),
    hermesUrl: opt('HERMES_URL', DEFAULTS.HERMES_URL).replace(/\/$/, ''),
    hermesTimeoutMs: posInt('HERMES_TIMEOUT_MS', DEFAULTS.HERMES_TIMEOUT_MS),
    // Peg gate (swap-bot↔arb sync). 0 => OFF (legacy). On the live deployment set
    // SWAPBOT_MAX_PEG_DEVIATION_BPS=200 so the swap bot defers to the arb when the pool is off-peg.
    maxPegDeviationBps: nonNegInt('SWAPBOT_MAX_PEG_DEVIATION_BPS', 0),
    // Round-trip (peg-neutral) volume mode. Set SWAPBOT_ROUNDTRIP=true on the live deployment.
    roundTrip: boolEnv('SWAPBOT_ROUNDTRIP', false),
    targetBase: optBigInt('SWAPBOT_TARGET_BASE', 0n),
    // Deliverability safety: cap SELL legs at this fraction of the pool's real USDC so they idle
    // (not revert) on a one-sided pool. 0 => OFF. Set SWAPBOT_POOL_DELIVERABLE_SAFETY_BPS=7000 live.
    poolDeliverableSafetyBps: nonNegInt('SWAPBOT_POOL_DELIVERABLE_SAFETY_BPS', 0, 10_000),
    // MARKET-MAKER mode — OFF unless SWAPBOT_MAKER=true (then it supersedes roundTrip/alternate).
    maker: boolEnv('SWAPBOT_MAKER', false)
      ? {
          enabled: true,
          deadbandBps: posInt('SWAPBOT_MAKER_DEADBAND_BPS', 40),
          floorBase: optBigInt('SWAPBOT_MAKER_FLOOR_BASE', 300_000n), // 0.003 cirBTC — never sold below
          targetBase: optBigInt('SWAPBOT_MAKER_TARGET_BASE', 1_000_000n), // 0.01 cirBTC working inventory
          reserveQuote: optBigInt('SWAPBOT_MAKER_RESERVE_QUOTE', 5_000_000n), // 5 USDC gas reserve
          skewK: posInt('SWAPBOT_MAKER_SKEW_K', 2), // buy-boost when low: up to (1+K)x => 3x by default
          maxTradeBase: optBigInt('SWAPBOT_MAKER_MAX_TRADE_BASE', 200_000n), // 0.002 cirBTC/trade cap
          minTradeBase: optBigInt('SWAPBOT_MAKER_MIN_TRADE_BASE', 100n),
          closeFraction: fraction01('SWAPBOT_MAKER_CLOSE_FRACTION', 0.5),
        }
      : undefined,
    // EPOCH mode — the once-per-epoch balanced peg-neutral pair. OFF unless SWAPBOT_EPOCH_MODE=true;
    // when ON it supersedes maker/roundTrip/alternate. Requires the v3 arena (to read currentEpochId)
    // and a ledger file (the lastEpochActed scalar MUST persist across restarts or a crash mid-epoch
    // could double-fire — hard-fail boot if it's missing, exactly like KEEPER_SPEND_LEDGER_FILE).
    epoch: boolEnv('SWAPBOT_EPOCH_MODE', false)
      ? (() => {
          const ledgerFile = optStr('SWAPBOT_EPOCH_LEDGER_FILE');
          if (ledgerFile === undefined) {
            throw new Error(
              '[config] SWAPBOT_EPOCH_LEDGER_FILE is REQUIRED when SWAPBOT_EPOCH_MODE=true — the ' +
                'lastEpochActed scalar must persist across restarts or a crash mid-epoch could double-fire.',
            );
          }
          const pairTradeBase = optBigInt('SWAPBOT_PAIR_TRADE_BASE', tradeBase);
          if (pairTradeBase <= 0n) throw new Error('[config] SWAPBOT_PAIR_TRADE_BASE must be > 0');
          return {
            enabled: true,
            arena: reqAddress('SWAPBOT_EPOCH_ARENA'),
            ledgerFile,
            pairTradeBase,
            pairMaxTradeBase: optBigInt('SWAPBOT_PAIR_MAX_TRADE_BASE', pairTradeBase),
            pairMinTradeBase: optBigInt('SWAPBOT_PAIR_MIN_TRADE_BASE', 100n),
            pairCloseFraction: fraction01('SWAPBOT_PAIR_CLOSE_FRACTION', 1.0), // land AT the oracle
            workingReserveBase: optBigInt('SWAPBOT_WORKING_RESERVE_BASE', pairTradeBase),
          };
        })()
      : undefined,
  };
  return Object.freeze(cfg);
}

// ---------------------------------------------------------------------------
// Staker bots: THREE wallets that each add liquidity (mint a full-range LP) and auto-stake it into
// the v3 entry-anchored Arena every epoch on a FIXED side (UP / DOWN / RANGE), so the Arena always
// has a participant on each side. Reuses the arb market (KEEPER_ARB_MARKET) for pool/tokens/
// decimals/feedId/feeTier, but stakes into the SEPARATE v3 arena (STAKERBOT_ARENA — the arb market's
// `arena` is the v1 address) and mints via the NPM (STAKERBOT_NPM).
// ---------------------------------------------------------------------------
export interface StakerConfig {
  /** Contract Side enum: 1=UP, 2=DOWN, 3=RANGE. */
  side: number;
  sideLabel: 'UP' | 'DOWN' | 'RANGE';
  /** This staker's signer key (SEPARATE per side; STAKERBOT_<SIDE>_PRIVATE_KEY). */
  privateKey: Hex;
}

export interface StakerbotConfig {
  rpcUrl: string;
  rpcUrls: string[];
  /** Reuses the arb market for pool/base/quote/decimals/feedId/feeTier. */
  market: ArbMarketConfig;
  /** The v3 ENTRY-ANCHORED arena to stake into (NOT market.arena, which is v1). */
  arena: Address;
  /** The Uniswap-V3 NonfungiblePositionManager used to mint LP positions. */
  npm: Address;
  /** Pyth contract for getUpdateFee (the value paid into stakeWithSide; excess refunds). */
  pythAddress: Address;
  hermesUrl: string;
  hermesTimeoutMs: number;
  /** The three side-bound stakers (UP/DOWN/RANGE). */
  stakers: StakerConfig[];
  /** cirBTC amount (raw base 8dp) to mint into each full-range LP. */
  mintBase: bigint;
  /** USDC amount (raw 6dp) to mint into each full-range LP. */
  mintUsdc: bigint;
  /** Entry-price deviation guard (bps) passed to stakeWithSide. */
  maxDeviationBps: bigint;
  pollIntervalMs: number;
  gasFloorWei: bigint;
  receiptTimeoutMs: number;
  lowBalanceWei: bigint;
}

/** Load + validate the staker-bot config from the environment (throws on any problem). */
// ─── Limen Agent (ACT layer) ─────────────────────────────────────────────────────────────
// The policy-bounded, signal-driven epoch participant. OFF unless LIMEN_AGENT_ENABLED=true;
// its mandate (allowed views, confidence floor, expiry, budget) comes from LIMEN_AGENT_POLICY
// as JSON and is enforced by the pure decideAgent engine — the same field set Circle Agent
// Wallet spending policies use, so the mandate maps onto wallet-layer enforcement when it
// lands on Arc mainnet. Shares the stakerbot's market/arena/NPM plumbing.

export interface AgentBotConfig {
  enabled: boolean;
  rpcUrl: string;
  rpcUrls: string[];
  privateKey: Hex;
  market: ArbMarketConfig;
  arena: Address;
  npm: Address;
  pythAddress: Address;
  hermesUrl: string;
  hermesTimeoutMs: number;
  mintBase: bigint;
  maxDeviationBps: bigint;
  pollIntervalMs: number;
  gasFloorWei: bigint;
  receiptTimeoutMs: number;
  lowBalanceWei: bigint;
  /** The mandate JSON (validated): allowedViews/minConfidence/expiresAtSec/minEntryLeftSec/maxStakeUsdc6. */
  policy: {
    allowedViews: Array<'UP' | 'DOWN' | 'RANGE'>;
    minConfidence: number;
    expiresAtSec: number;
    minEntryLeftSec: number;
    maxStakeUsdc6: bigint;
  };
  /** Once-per-epoch ledger file (restart-safe idempotency, same pattern as the flow ledger). */
  ledgerFile: string;
  /** Treasury rail: 'agent-wallet' draws shortfalls from the Circle Agent Wallet via the CLI. */
  funding: 'none' | 'agent-wallet';
  /** The Circle Agent Wallet (MPC SCA) the shortfall transfers are drawn from. */
  agentWalletAddress: Address | null;
  /** Chain name the Circle CLI expects for the transfer (ARC-TESTNET here). */
  circleChain: string;
  /** Native head-room requested on top of the stake's quote leg (gas for approve/mint/stake). */
  fundGasMarginWei: bigint;
  /** How long one `circle wallet transfer` may take before the tick gives up. */
  circleCliTimeoutMs: number;
}

export function loadAgentBotConfig(): AgentBotConfig {
  const enabled = boolEnv('LIMEN_AGENT_ENABLED', false);
  const gasFloorGwei = posInt('GAS_FLOOR_GWEI', DEFAULTS.GAS_FLOOR_GWEI);
  const rpcUrls = parseRpcUrls();
  const rawPolicy = (process.env.LIMEN_AGENT_POLICY ?? '').trim();
  if (enabled && rawPolicy === '') {
    throw new Error('[config] LIMEN_AGENT_ENABLED=true requires LIMEN_AGENT_POLICY (the mandate JSON)');
  }
  let policy: AgentBotConfig['policy'] = {
    allowedViews: ['UP', 'DOWN', 'RANGE'],
    minConfidence: 0.45,
    expiresAtSec: 0,
    minEntryLeftSec: 20,
    maxStakeUsdc6: 10_000_000n, // 10 USDC quote-leg budget by default
  };
  if (rawPolicy !== '') {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawPolicy) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`[config] LIMEN_AGENT_POLICY is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const views = Array.isArray(parsed.allowedViews) ? (parsed.allowedViews as string[]) : policy.allowedViews;
    for (const v of views) {
      if (v !== 'UP' && v !== 'DOWN' && v !== 'RANGE') throw new Error(`[config] LIMEN_AGENT_POLICY.allowedViews has unknown view "${v}"`);
    }
    policy = {
      allowedViews: views as AgentBotConfig['policy']['allowedViews'],
      minConfidence: typeof parsed.minConfidence === 'number' ? parsed.minConfidence : policy.minConfidence,
      expiresAtSec: typeof parsed.expiresAtSec === 'number' ? parsed.expiresAtSec : policy.expiresAtSec,
      minEntryLeftSec: typeof parsed.minEntryLeftSec === 'number' ? parsed.minEntryLeftSec : policy.minEntryLeftSec,
      maxStakeUsdc6: typeof parsed.maxStakeUsdc6 === 'string' || typeof parsed.maxStakeUsdc6 === 'number'
        ? BigInt(parsed.maxStakeUsdc6)
        : policy.maxStakeUsdc6,
    };
    if (enabled && policy.expiresAtSec <= 0) {
      throw new Error('[config] LIMEN_AGENT_POLICY.expiresAtSec (unix seconds) is required — a mandate must have a hard end');
    }
    if (policy.maxStakeUsdc6 <= 0n) throw new Error('[config] LIMEN_AGENT_POLICY.maxStakeUsdc6 must be > 0');
  }
  const ledgerFile = optStr('LIMEN_AGENT_LEDGER_FILE') ?? '';
  if (enabled && ledgerFile === '') {
    throw new Error('[config] LIMEN_AGENT_ENABLED=true requires LIMEN_AGENT_LEDGER_FILE (once-per-epoch idempotency)');
  }
  const fundingRaw = opt('LIMEN_AGENT_FUNDING', 'none');
  if (fundingRaw !== 'none' && fundingRaw !== 'agent-wallet') {
    throw new Error(`[config] LIMEN_AGENT_FUNDING must be "none" or "agent-wallet", got "${fundingRaw}"`);
  }
  const agentWalletAddress = optStr('LIMEN_AGENT_WALLET_ADDRESS');
  if (enabled && fundingRaw === 'agent-wallet' && (agentWalletAddress === undefined || !/^0x[0-9a-fA-F]{40}$/.test(agentWalletAddress))) {
    throw new Error('[config] LIMEN_AGENT_FUNDING=agent-wallet requires a valid LIMEN_AGENT_WALLET_ADDRESS (the Circle Agent Wallet)');
  }
  const cfg: AgentBotConfig = {
    enabled,
    rpcUrl: rpcUrls[0]!,
    rpcUrls,
    // The key is only REQUIRED when the agent is enabled; a disabled load must not demand secrets.
    privateKey: enabled ? reqPrivateKey('LIMEN_AGENT_PRIVATE_KEY') : (`0x${'1'.repeat(64)}` as Hex),
    market: parseArbMarket('KEEPER_ARB_MARKET'),
    arena: reqAddress('STAKERBOT_ARENA'),
    npm: reqAddress('STAKERBOT_NPM'),
    pythAddress: reqAddress('PYTH_ADDRESS'),
    hermesUrl: opt('HERMES_URL', DEFAULTS.HERMES_URL).replace(/\/$/, ''),
    hermesTimeoutMs: posInt('HERMES_TIMEOUT_MS', DEFAULTS.HERMES_TIMEOUT_MS),
    mintBase: optBigInt('LIMEN_AGENT_MINT_BASE', 40_000n),
    maxDeviationBps: optBigInt('LIMEN_AGENT_MAX_DEVIATION_BPS', 300n),
    pollIntervalMs: posInt('LIMEN_AGENT_POLL_INTERVAL_MS', 10_000),
    gasFloorWei: BigInt(gasFloorGwei) * 1_000_000_000n,
    receiptTimeoutMs: posInt('RECEIPT_TIMEOUT_MS', DEFAULTS.RECEIPT_TIMEOUT_MS),
    lowBalanceWei: posBigInt('LOW_BALANCE_WEI', DEFAULTS.LOW_BALANCE_WEI),
    policy,
    ledgerFile,
    funding: fundingRaw,
    agentWalletAddress: agentWalletAddress !== undefined && /^0x[0-9a-fA-F]{40}$/.test(agentWalletAddress)
      ? (agentWalletAddress as Address)
      : null,
    circleChain: opt('LIMEN_AGENT_CIRCLE_CHAIN', 'ARC-TESTNET'),
    fundGasMarginWei: optBigInt('LIMEN_AGENT_FUND_GAS_MARGIN_WEI', 50_000_000_000_000_000n), // 0.05 USDC
    circleCliTimeoutMs: posInt('LIMEN_AGENT_CIRCLE_TIMEOUT_MS', 120_000),
  };
  return Object.freeze(cfg);
}

export function loadStakerbotConfig(): StakerbotConfig {
  const gasFloorGwei = posInt('GAS_FLOOR_GWEI', DEFAULTS.GAS_FLOOR_GWEI);
  const rpcUrls = parseRpcUrls();
  const stakers: StakerConfig[] = [
    { side: 1, sideLabel: 'UP', privateKey: reqPrivateKey('STAKERBOT_UP_PRIVATE_KEY') },
    { side: 2, sideLabel: 'DOWN', privateKey: reqPrivateKey('STAKERBOT_DOWN_PRIVATE_KEY') },
    { side: 3, sideLabel: 'RANGE', privateKey: reqPrivateKey('STAKERBOT_RANGE_PRIVATE_KEY') },
  ];
  const mintBase = optBigInt('STAKERBOT_MINT_BASE', 40_000n); // 0.0004 cirBTC (8dp)
  const mintUsdc = optBigInt('STAKERBOT_MINT_USDC', 26_000_000n); // 26 USDC (6dp)
  if (mintBase <= 0n || mintUsdc <= 0n) throw new Error('[config] STAKERBOT_MINT_BASE/USDC must be > 0');
  const cfg: StakerbotConfig = {
    rpcUrl: rpcUrls[0]!,
    rpcUrls,
    market: parseArbMarket('KEEPER_ARB_MARKET'),
    arena: reqAddress('STAKERBOT_ARENA'),
    npm: reqAddress('STAKERBOT_NPM'),
    pythAddress: reqAddress('PYTH_ADDRESS'),
    hermesUrl: opt('HERMES_URL', DEFAULTS.HERMES_URL).replace(/\/$/, ''),
    hermesTimeoutMs: posInt('HERMES_TIMEOUT_MS', DEFAULTS.HERMES_TIMEOUT_MS),
    stakers,
    mintBase,
    mintUsdc,
    maxDeviationBps: optBigInt('STAKERBOT_MAX_DEVIATION_BPS', 300n),
    pollIntervalMs: posInt('STAKERBOT_POLL_INTERVAL_MS', 10_000),
    gasFloorWei: BigInt(gasFloorGwei) * 1_000_000_000n,
    receiptTimeoutMs: posInt('RECEIPT_TIMEOUT_MS', DEFAULTS.RECEIPT_TIMEOUT_MS),
    lowBalanceWei: posBigInt('LOW_BALANCE_WEI', DEFAULTS.LOW_BALANCE_WEI),
  };
  return Object.freeze(cfg);
}

/**
 * Parse an env value as a decimal USDC amount → wei. Arc's native gas token IS USDC at 18 decimals
 * (1 USDC = 1e18 wei), so parseEther is the exact converter. A blank/unset value falls back.
 */
function usdcToWei(name: string, fallback: string): bigint {
  const v = opt(name, fallback);
  try {
    return parseEther(v);
  } catch {
    throw new Error(`[config] ${name} must be a decimal USDC amount, got "${v}"`);
  }
}

/** A cap that is effectively infinite — used for the window the operator left unset (never trips). */
const UNCAPPED_WEI = 2n ** 255n;

/**
 * Load the persisted spend circuit-breaker config. The cap is OFF unless an hour- or burst-cap is
 * set (so existing deployments are unchanged). When ON, a ledger file path is REQUIRED — the
 * breaker MUST persist across restarts or a crash-loop could reset it (the exact bypass the
 * adversarial review flagged) — so we hard-fail boot if it's missing.
 */
function loadSpendCapConfig(): SpendCapConfig {
  const hourCapWei = usdcToWei('KEEPER_SPEND_CAP_HOUR_USDC', '0');
  const burstCapWei = usdcToWei('KEEPER_SPEND_CAP_BURST_USDC', '0');
  const enabled = hourCapWei > 0n || burstCapWei > 0n;
  const hourWindowMs = 3_600_000;
  const burstWindowMs = posInt('KEEPER_SPEND_CAP_BURST_WINDOW_SEC', 600) * 1000;
  const ledgerFile = optStr('KEEPER_SPEND_LEDGER_FILE');
  if (enabled && ledgerFile === undefined) {
    throw new Error(
      '[config] KEEPER_SPEND_LEDGER_FILE is REQUIRED when a spend cap (KEEPER_SPEND_CAP_HOUR_USDC / ' +
        'KEEPER_SPEND_CAP_BURST_USDC) is set — the breaker must persist so a crash-loop cannot reset it.',
    );
  }
  return {
    enabled,
    ledgerFile,
    caps: {
      hourCapWei: hourCapWei > 0n ? hourCapWei : UNCAPPED_WEI,
      hourWindowMs,
      burstCapWei: burstCapWei > 0n ? burstCapWei : UNCAPPED_WEI,
      burstWindowMs,
    },
    retainMs: Math.max(hourWindowMs, burstWindowMs),
  };
}

/**
 * Load the owner-reserve drawdown governor config. Enabled only when an owner key is configured
 * (the keeper needs the owner address to read the reserve balance). Thresholds default to the same
 * levels the gas-watchdog uses so the two agree on what "low" means.
 */
function loadReserveGovConfig(enabled: boolean): ReserveGovConfig {
  return {
    enabled,
    floorWei: usdcToWei('KEEPER_RESERVE_FLOOR_USDC', '3'),
    throttleWei: usdcToWei('KEEPER_RESERVE_THROTTLE_USDC', '8'),
    warnDrawdownWeiPerHour: usdcToWei('KEEPER_RESERVE_WARN_DRAWDOWN_USDC_PER_HOUR', '12'),
    projectDryWarnMs: posInt('KEEPER_RESERVE_PROJECT_DRY_WARN_HOURS', 6) * 3_600_000,
    retainMs: posInt('KEEPER_RESERVE_RETAIN_HOURS', 6) * 3_600_000,
  };
}

/** Load + validate the full keeper config from the environment (throws on any problem). */
export function loadConfig(): KeeperConfig {
  const gasFloorGwei = posInt('GAS_FLOOR_GWEI', DEFAULTS.GAS_FLOOR_GWEI);
  const rpcUrls = parseRpcUrls();
  const ownerPrivateKey = resolveOwnerPrivateKey();
  // Liveness deadlines. tickDeadline must sit ABOVE the slowest legitimate per-tick op (the v3
  // settlement sample and the receipt wait) so a healthy settle never trips it; stallExit is the
  // hard backstop, set well above a full multi-market pass.
  const receiptTimeoutMsForDeadline = posInt('RECEIPT_TIMEOUT_MS', DEFAULTS.RECEIPT_TIMEOUT_MS);
  const v3SampleSecForDeadline = posInt('KEEPER_V3_SAMPLE_SEC', DEFAULTS.V3_SAMPLE_SEC);
  // v3 pipeline chaining budget: the deadline default grows by it so a chain that stops STARTING
  // new steps at the budget still has the full single-step headroom for its in-flight receipt wait.
  const v3ChainBudgetMs = nonNegInt('KEEPER_V3_CHAIN_BUDGET_MS', 45_000);
  const tickDeadlineMs = posInt(
    'KEEPER_TICK_DEADLINE_MS',
    Math.max(receiptTimeoutMsForDeadline, v3SampleSecForDeadline * 1000) + 30_000 + v3ChainBudgetMs,
  );
  const stallExitMs = posInt('KEEPER_STALL_EXIT_MS', Math.max(tickDeadlineMs * 3, 300_000));
  // v2 global default subsidy (raw USDC, 6-dp). Unset/0 => no global default (per-market
  // subsidyPerEpoch can still enable it). v2-only; the per-market parser rejects it on a v1 market.
  const globalSubsidy = optBigInt('KEEPER_V2_SUBSIDY_PER_EPOCH', 0n);
  const cfg: KeeperConfig = {
    rpcUrl: rpcUrls[0]!, // primary / probe URL (back-compat single)
    rpcUrls,
    privateKey: resolvePrivateKey(),
    ownerPrivateKey,
    pythAddress: reqAddress('PYTH_ADDRESS'),
    hermesUrl: opt('HERMES_URL', DEFAULTS.HERMES_URL).replace(/\/$/, ''),
    markets: parseMarkets('KEEPER_MARKETS', globalSubsidy === 0n ? undefined : globalSubsidy),
    pollIntervalMs: posInt('POLL_INTERVAL_MS', DEFAULTS.POLL_INTERVAL_MS),
    sweepBatch: posInt('SWEEP_BATCH', DEFAULTS.SWEEP_BATCH),
    txGasCap: posBigInt('KEEPER_TX_GAS_CAP', DEFAULTS.TX_GAS_CAP),
    gasFloorWei: BigInt(gasFloorGwei) * 1_000_000_000n,
    hermesTimeoutMs: posInt('HERMES_TIMEOUT_MS', DEFAULTS.HERMES_TIMEOUT_MS),
    receiptTimeoutMs: posInt('RECEIPT_TIMEOUT_MS', DEFAULTS.RECEIPT_TIMEOUT_MS),
    lowBalanceWei: posBigInt('LOW_BALANCE_WEI', DEFAULTS.LOW_BALANCE_WEI),
    gasEscalation: loadGasEscalation(BigInt(gasFloorGwei) * 1_000_000_000n),
    baseBackoffMs: posInt('BASE_BACKOFF_MS', DEFAULTS.BASE_BACKOFF_MS),
    maxBackoffMs: posInt('MAX_BACKOFF_MS', DEFAULTS.MAX_BACKOFF_MS),
    wedgedAlertThreshold: posInt('WEDGED_ALERT_THRESHOLD', DEFAULTS.WEDGED_ALERT_THRESHOLD),
    httpPort: nonNegInt('KEEPER_HTTP_PORT', DEFAULTS.HTTP_PORT, 65535),
    httpHost: opt('KEEPER_HTTP_HOST', DEFAULTS.HTTP_HOST),
    stallFactor: posInt('STALL_FACTOR', DEFAULTS.STALL_FACTOR),
    metricsStateFile: optStr('KEEPER_METRICS_STATE_FILE'),
    metricsPersistIntervalMs: posInt('KEEPER_METRICS_PERSIST_INTERVAL_MS', DEFAULTS.METRICS_PERSIST_INTERVAL_MS),
    alert: loadAlertConfig(),
    // v2 pinned-window safety margin (seconds). Non-negative; default 2s. Only affects v2 markets.
    v2WindowMarginSec: BigInt(nonNegInt('KEEPER_V2_WINDOW_MARGIN_SEC', Number(DEFAULT_V2_WINDOW_MARGIN_SEC))),
    // v2 fast poll (ms) used when ≥1 v2 market is configured. Default 4000 — comfortably below
    // a 12s pin window so the loop attempts the pinned start/end multiple times inside it.
    v2PollIntervalMs: posInt('KEEPER_V2_POLL_INTERVAL_MS', DEFAULTS.V2_POLL_INTERVAL_MS),
    // v3 settlement-average sampling (entry-anchored markets): window seconds + sample interval.
    v3SampleSec: posInt('KEEPER_V3_SAMPLE_SEC', DEFAULTS.V3_SAMPLE_SEC),
    v3SampleIntervalMs: posInt('KEEPER_V3_SAMPLE_INTERVAL_MS', DEFAULTS.V3_SAMPLE_INTERVAL_MS),
    // v3 settlement-latency pipeline: pre-sample the [T-window, T] average + chain the pipeline
    // cranks in one tick + let the loop wake right at the boundary. Both ON by default; either
    // reverts to the exact legacy cadence via its env (presample=false / budget=0).
    v3PreSampleEnabled: boolEnv('KEEPER_V3_PRESAMPLE', true),
    v3ChainBudgetMs,
    v3ChainMaxSteps: posInt('KEEPER_V3_CHAIN_MAX_STEPS', 24),
    v3AnchorMarginSec: nonNegInt('KEEPER_V3_ANCHOR_MARGIN_SEC', 2),
    tickDeadlineMs,
    stallExitMs,
    // --- drain-elimination ---
    simPreflight: boolEnv('KEEPER_SIM_PREFLIGHT', true),
    fallbackGasLimit: posBigInt('KEEPER_FALLBACK_GAS_LIMIT', 1_500_000n),
    v3MineLatencySec: posInt('KEEPER_MINE_LATENCY_SEC', 15),
    spendCap: loadSpendCapConfig(),
    // The reserve governor needs the owner address to read the reserve balance — enable it only
    // when an owner key is configured (it always is on the live keeper).
    reserve: loadReserveGovConfig(ownerPrivateKey !== undefined),
    refillSafeFile: optStr('KEEPER_REFILL_SAFE_FILE'),
  };
  return Object.freeze(cfg);
}
