// lib/markets.ts — the per-market config list (id, label, base token, and arena/oracle/pool/feed
// addresses). Sourced from the optional NEXT_PUBLIC_MARKETS JSON blob; falls back to a single ETH
// market built from the existing single-market env so the app behaves EXACTLY as today when unset.
// Shared infra (USDC, router, NPM, multicall, Pyth contract, Hermes) stays GLOBAL in lib/contracts.ts.
import { ENV, parseAddress, parseBytes32, type AppEnv } from '@/lib/env';

// How a user acquires this market's base token on the on-ramp (see baseAcquireMode below).
//   - 'faucet': base is a REAL token with NO wrap and NO public mint (e.g. Circle's cirBTC) — the user
//               must fund from an external faucet. This is the ONLY supported mode: the live arena runs
//               on a faucet-only Circle token, so the on-ramp renders a faucet CTA and never a
//               wrap/mint button (which would REVERT against a real token).
//
// The legacy 'wrap' (WETH9.deposit) and 'mint' (open-mint mock) modes were removed with the mock
// tokens — see the deleted useWrapNative / useMintTestToken hooks. acquireMode is now optional config
// that, when present, MUST be 'faucet'; baseAcquireMode() always resolves to 'faucet'.
export type BaseAcquireMode = 'faucet';

/**
 * FeeArena contract generation for a market.
 *  - 'v1' (default): the original stake-with-side arena (winners split forfeited fees by liq*tickSpan).
 *  - 'v2': the conviction-parimutuel arena (FeeArenaV2 + FeeArenaV2Lens). v2 markets MUST carry a Lens
 *          address, conviction bounds (minConv/maxConv, USDC 6dp) and a treasury (burn sink). See
 *          docs/spec-feearena-v2.md.
 *  - 'v3': the ENTRY-ANCHORED arena (FeeArenaV3): every position records its OWN entry price at stake
 *          time and resolves individually against the epoch's single settlement price; winners keep
 *          their own fees + split the losers' forfeited fees. No extra addresses required.
 */
export type MarketVersion = 'v1' | 'v2' | 'v3';

export type Market = {
  id: string;
  label: string;
  baseSymbol: string;
  baseDecimals: number;
  /**
   * The QUOTE token symbol for this arena ('USDC' | 'EURC'). Resolved to a token (address/decimals) via
   * lib/tokens `quoteToken()` in the components. Absent -> 'USDC' (back-compat). The arena contract's
   * "USDC" leg is whatever this resolves to (both are 6dp); used for quote-side labels + balances.
   */
  quoteSymbol?: string;
  feeArena: `0x${string}`;
  oracle: `0x${string}`;
  pool: `0x${string}`;
  feedId: `0x${string}`;
  /**
   * OPTIONAL second Pyth feed for a CROSS-quoted market. When set, the market settles/quotes on the
   * cross rate `feedId / quoteFeedId` via a CompositePythOracle (e.g. cirBTC/EURC: feedId=BTC/USD,
   * quoteFeedId=EUR/USD → BTC/EUR). The stake flow then posts a blob covering BOTH feeds and uses the
   * cross price for the entry anchor. Absent → single-feed market (unchanged).
   */
  quoteFeedId?: `0x${string}`;
  /** Optional FeeArena deploy block — the lower bound for event getLogs (history/leaderboard). 0n if unset. */
  fromBlock: bigint;
  /**
   * Optional on-ramp acquisition mode for the base token. Only 'faucet' is supported — the base is a
   * REAL Circle token (cirBTC) with no wrap and no public mint, so the on-ramp shows a faucet CTA.
   * baseAcquireMode() always resolves to 'faucet' whether this is set or omitted.
   */
  acquireMode?: BaseAcquireMode;
  /**
   * Optional display label for this market's oracle price (e.g. "BTC / USD"). Falls back to a
   * baseSymbol-derived label (e.g. "BTC/USD") in the UI when unset.
   */
  priceLabel?: string;
  /**
   * FeeArena generation. Omitted/absent -> 'v1' (resolve via marketVersion()). When 'v2', the
   * lens/minConv/maxConv/treasury fields below are REQUIRED (validated at parse time).
   */
  version?: MarketVersion;
  /**
   * FeeArenaV2Lens address (read/preview surface: previewClaim, previewRefund, getStake,
   * getStakesByEpoch). REQUIRED + only meaningful for v2 markets.
   */
  lens?: `0x${string}`;
  /** Treasury / burn sink for losing-side conviction (v2). REQUIRED for v2. */
  treasury?: `0x${string}`;
  /** Minimum conviction a staker must post, USDC base units (6dp bigint). REQUIRED for v2. */
  minConv?: bigint;
  /** Maximum conviction a staker may post, USDC base units (6dp bigint). REQUIRED for v2. */
  maxConv?: bigint;
  /**
   * Read-only market: a deprecated arena kept reachable so pending winners can still claim/unstake but
   * NEW staking is blocked in the UI. Used for the cutover v1 'legacy' entry. Omitted -> false.
   */
  readOnly?: boolean;
};

/** Shape of one entry in the NEXT_PUBLIC_MARKETS JSON array (validated in buildMarkets). */
interface RawMarket {
  id?: unknown;
  label?: unknown;
  baseSymbol?: unknown;
  baseDecimals?: unknown;
  quoteSymbol?: unknown;
  feeArena?: unknown;
  oracle?: unknown;
  pool?: unknown;
  feedId?: unknown;
  quoteFeedId?: unknown;
  fromBlock?: unknown;
  acquireMode?: unknown;
  priceLabel?: unknown;
  version?: unknown;
  lens?: unknown;
  treasury?: unknown;
  minConv?: unknown;
  maxConv?: unknown;
  readOnly?: unknown;
}

function reqStr(v: unknown, label: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`[markets] ${label} must be a non-empty string`);
  return v.trim();
}

function reqDecimals(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 36) throw new Error(`[markets] ${label} must be an integer in 0..36, got "${String(v)}"`);
  return n;
}

/** Optional non-empty string; absent/empty -> undefined. */
function optStr(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`[markets] ${label} must be a non-empty string when present`);
  return v.trim();
}

/** Optional on-ramp acquireMode; absent -> undefined. Only 'faucet' is supported (faucet-only tokens). */
function optAcquireMode(v: unknown, label: string): BaseAcquireMode | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === 'faucet') return v;
  throw new Error(`[markets] ${label} must be 'faucet', got "${String(v)}"`);
}

/** Optional non-negative block number (number | numeric string) -> bigint; absent/empty -> 0n. */
function optFromBlock(v: unknown, label: string): bigint {
  if (v === undefined || v === null || v === '') return 0n;
  let n: bigint;
  try {
    n = typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v));
  } catch {
    throw new Error(`[markets] ${label} must be a non-negative integer block number, got "${String(v)}"`);
  }
  if (n < 0n) throw new Error(`[markets] ${label} must be a non-negative integer block number, got "${String(v)}"`);
  return n;
}

/** Optional version marker; absent -> undefined (resolved to 'v1' by marketVersion). 'v1'/'v2'/'v3'. */
function optVersion(v: unknown, label: string): MarketVersion | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === 'v1' || v === 'v2' || v === 'v3') return v;
  throw new Error(`[markets] ${label} must be 'v1', 'v2' or 'v3', got "${String(v)}"`);
}

/** Optional 0x address; absent/empty -> undefined; else validated via parseAddress. */
function optAddress(v: unknown, label: string): `0x${string}` | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new Error(`[markets] ${label} must be a 0x-prefixed 40-hex address when present`);
  return parseAddress(v.trim(), label);
}

/** Optional positive USDC-base-units amount (number | numeric string) -> bigint; absent/empty -> undefined. */
function optUsdcAmount(v: unknown, label: string): bigint | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let n: bigint;
  try {
    n = typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v));
  } catch {
    throw new Error(`[markets] ${label} must be a non-negative integer (USDC 6dp base units), got "${String(v)}"`);
  }
  if (n <= 0n) throw new Error(`[markets] ${label} must be a positive integer (USDC 6dp base units), got "${String(v)}"`);
  return n;
}

/** Optional boolean; absent -> undefined; accepts only real booleans (no string coercion). */
function optBool(v: unknown, label: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`[markets] ${label} must be a boolean when present`);
  return v;
}

/** Parse + validate one raw market entry into a typed Market (addresses/feed validated via env validators). */
function parseMarket(raw: RawMarket, i: number): Market {
  const id = reqStr(raw.id, `markets[${i}].id`);
  const version = optVersion(raw.version, `markets[${i}].version`);
  const lens = optAddress(raw.lens, `markets[${i}].lens`);
  const treasury = optAddress(raw.treasury, `markets[${i}].treasury`);
  const minConv = optUsdcAmount(raw.minConv, `markets[${i}].minConv`);
  const maxConv = optUsdcAmount(raw.maxConv, `markets[${i}].maxConv`);

  // v2 cutover invariants: the conviction-parimutuel arena is unusable without its Lens (preview
  // surface), conviction bounds and a treasury (burn sink). Fail loudly at boot if any is missing.
  if (version === 'v2') {
    if (!lens) throw new Error(`[markets] markets[${i}].lens is REQUIRED when version is 'v2'`);
    if (!treasury) throw new Error(`[markets] markets[${i}].treasury is REQUIRED when version is 'v2'`);
    if (minConv === undefined) throw new Error(`[markets] markets[${i}].minConv is REQUIRED when version is 'v2'`);
    if (maxConv === undefined) throw new Error(`[markets] markets[${i}].maxConv is REQUIRED when version is 'v2'`);
  }
  // Bounds sanity wherever both are present (minConv>0 enforced by optUsdcAmount).
  if (minConv !== undefined && maxConv !== undefined && minConv > maxConv) {
    throw new Error(`[markets] markets[${i}].minConv (${minConv}) must be <= maxConv (${maxConv})`);
  }

  // OPTIONAL second feed for a cross-quoted market (e.g. EUR/USD for cirBTC/EURC = BTC/EUR).
  const quoteFeedId =
    raw.quoteFeedId === undefined || raw.quoteFeedId === null || raw.quoteFeedId === ''
      ? undefined
      : parseBytes32(reqStr(raw.quoteFeedId, `markets[${i}].quoteFeedId`), `markets[${i}].quoteFeedId`);

  return {
    id,
    label: reqStr(raw.label, `markets[${i}].label`),
    baseSymbol: reqStr(raw.baseSymbol, `markets[${i}].baseSymbol`),
    baseDecimals: reqDecimals(raw.baseDecimals, `markets[${i}].baseDecimals`),
    quoteSymbol: optStr(raw.quoteSymbol, `markets[${i}].quoteSymbol`),
    feeArena: parseAddress(reqStr(raw.feeArena, `markets[${i}].feeArena`), `markets[${i}].feeArena`),
    oracle: parseAddress(reqStr(raw.oracle, `markets[${i}].oracle`), `markets[${i}].oracle`),
    pool: parseAddress(reqStr(raw.pool, `markets[${i}].pool`), `markets[${i}].pool`),
    feedId: parseBytes32(reqStr(raw.feedId, `markets[${i}].feedId`), `markets[${i}].feedId`),
    ...(quoteFeedId ? { quoteFeedId } : {}),
    fromBlock: optFromBlock(raw.fromBlock, `markets[${i}].fromBlock`),
    acquireMode: optAcquireMode(raw.acquireMode, `markets[${i}].acquireMode`),
    priceLabel: optStr(raw.priceLabel, `markets[${i}].priceLabel`),
    version,
    lens,
    treasury,
    minConv,
    maxConv,
    readOnly: optBool(raw.readOnly, `markets[${i}].readOnly`),
  };
}

/**
 * Build the market list from a parsed env:
 *  - If env.MARKETS is set, parse it as a JSON array of markets (must be non-empty, ids unique).
 *  - Otherwise fall back to ONE default ETH market built from the existing single-market env keys.
 * Pure (takes env) so it is unit-testable in isolation; the module-level MARKETS uses the live ENV.
 */
export function buildMarkets(env: AppEnv): Market[] {
  if (env.MARKETS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.MARKETS);
    } catch {
      throw new Error('[markets] NEXT_PUBLIC_MARKETS is not valid JSON');
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('[markets] NEXT_PUBLIC_MARKETS must be a non-empty JSON array');
    }
    const markets = parsed.map((m, i) => parseMarket(m as RawMarket, i));
    const ids = new Set<string>();
    for (const m of markets) {
      if (ids.has(m.id)) throw new Error(`[markets] duplicate market id "${m.id}"`);
      ids.add(m.id);
    }
    return markets;
  }

  // Fallback: the existing single-market ETH env (keeps today's app + e2e mocks working unchanged).
  return [
    {
      id: 'eth',
      label: 'ETH / USDC',
      baseSymbol: 'WETH',
      baseDecimals: 18,
      feeArena: env.FEE_ARENA_ADDRESS,
      oracle: env.ORACLE_ADDRESS,
      pool: env.POOL_ADDRESS,
      feedId: env.PYTH_ETHUSD_ID,
      fromBlock: env.FEE_ARENA_FROM_BLOCK,
    },
  ];
}

/** A placeholder all-zero ETH market, returned ONLY when ENV itself is unreadable (test Proxy). */
function placeholderMarkets(): Market[] {
  return [
    {
      id: 'eth',
      label: 'ETH / USDC',
      baseSymbol: 'WETH',
      baseDecimals: 18,
      feeArena: '0x0000000000000000000000000000000000000000',
      oracle: '0x0000000000000000000000000000000000000000',
      pool: '0x0000000000000000000000000000000000000000',
      feedId: `0x${'0'.repeat(64)}`,
      fromBlock: 0n,
    },
  ];
}

// Built at module load from the live ENV. We must distinguish two cases that both surface as throws:
//   1. ENV itself is unreadable — in test environments NEXT_PUBLIC_* are unset and lib/env exports a
//      Proxy that throws on ANY property access. That's the only case where we may safely fall back
//      to the all-zero placeholder, so component tests can import this module (they mock live values).
//   2. ENV is readable but NEXT_PUBLIC_MARKETS is present-but-invalid (typo'd address, dup id, bad
//      shape — valid JSON, wrong contents). This is a REAL misconfig and MUST surface: we let
//      buildMarkets throw so the boot gate shows a FatalBanner instead of a silent zero-address app.
// We probe ENV accessibility by reading one field; if THAT throws we're in case (1). Otherwise we
// call buildMarkets and let any validation error propagate (case 2).
export const MARKETS: Market[] = (() => {
  let envReadable = false;
  try {
    // Touch a single field — the test Proxy throws here; a real env returns the string.
    void ENV.MARKETS;
    envReadable = true;
  } catch {
    envReadable = false;
  }
  if (!envReadable) return placeholderMarkets();
  // ENV is real: a bad MARKETS blob throws out of here (do NOT swallow) — surfaced by BootGate.
  // The v2 conviction arena is SHELVED — never expose it as a selectable market (selectableMarkets).
  return selectableMarkets(buildMarkets(ENV));
})();

export const DEFAULT_MARKET_ID = MARKETS[0].id;

/** Look up a market by id; falls back to the default market if the id is unknown (e.g. stale localStorage). */
export function marketById(id: string | null | undefined): Market {
  return MARKETS.find((m) => m.id === id) ?? MARKETS[0];
}

// ── On-ramp: how a user acquires this market's base token ─────────────────────────
// Faucet-only: the live arena runs on a REAL Circle token (cirBTC) with NO wrap and NO public mint, so
// the on-ramp always shows a faucet CTA. The legacy 'wrap'/'mint' on-ramps (and their mock tokens +
// hooks) were removed. This function exists as the single source of truth the on-ramp reads; it always
// resolves to 'faucet' regardless of whether the market sets acquireMode (which, if present, is
// validated to 'faucet').
export function baseAcquireMode(_market: Market): BaseAcquireMode {
  return 'faucet';
}

// ── FeeArena generation helpers ─────────────────────────────────────────────────

/** The FeeArena generation for a market — absent/legacy entries resolve to 'v1'. */
export function marketVersion(market: Market): MarketVersion {
  return market.version ?? 'v1';
}

/** True when the market is the cutover v2 conviction-parimutuel arena. */
export function isV2Market(market: Market): boolean {
  return marketVersion(market) === 'v2';
}

/**
 * The user-SELECTABLE markets. The v2 conviction arena is shelved (we no longer run it), so it
 * must never appear as a choice in the market switcher — drop it from the live list. Doing this at
 * the MARKETS source (not just in the selector UI) also means a stale persisted v2 selection in
 * localStorage can't strand the dashboard on v2: it's no longer a known market, so MarketProvider
 * falls back to the default. Guarded so an all-v2 env never empties the list (the app stays bootable).
 */
export function selectableMarkets(markets: Market[]): Market[] {
  const live = markets.filter((m) => !isV2Market(m));
  return live.length > 0 ? live : markets;
}

/** True when the market is the ENTRY-ANCHORED arena (FeeArenaV3 — per-position entry prices). */
export function isV3Market(market: Market): boolean {
  return marketVersion(market) === 'v3';
}

/**
 * True when the market is read-only (a deprecated/legacy arena kept reachable for pending claims +
 * unstakes only). New staking must be blocked in the UI for these. Omitted readOnly -> false.
 */
export function isReadOnlyMarket(market: Market): boolean {
  return market.readOnly === true;
}
