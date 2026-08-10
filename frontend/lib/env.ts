// lib/env.ts — validates/parses all NEXT_PUBLIC_* at module load; hard-fails on missing/invalid.
// Pure `parseEnv` is testable in isolation; `ENV` is the frozen snapshot the app imports.

export interface AppEnv {
  CHAIN_ID: number;
  /** All configured Arc HTTP RPC endpoints (in order, de-duped). At least one entry. */
  RPC_HTTP_URLS: string[];
  /** First (primary) Arc HTTP RPC URL — kept for back-compat with single-URL consumers. */
  RPC_HTTP: string;
  RPC_WS: string;
  EXPLORER_URL: string;
  FEE_ARENA_ADDRESS: `0x${string}`;
  /** Optional FeeArena deploy block for the single-market fallback (lower bound for history getLogs). 0n if unset. */
  FEE_ARENA_FROM_BLOCK: bigint;
  ORACLE_ADDRESS: `0x${string}`;
  NPM_ADDRESS: `0x${string}`;
  /** Uniswap QuoterV2 lens. Gives the swap form an exact, tick-aware quote. */
  QUOTER_ADDRESS: `0x${string}`;
  FACTORY_ADDRESS: `0x${string}`;
  POOL_ADDRESS: `0x${string}`;
  SWAP_ROUTER_ADDRESS: `0x${string}`;
  USDC_ADDRESS: `0x${string}`;
  /** Circle EURC (euro stablecoin) ERC-20 on Arc testnet (6dp). Optional; defaults to the canonical Arc address. */
  EURC_ADDRESS: `0x${string}`;
  WETH_ADDRESS: `0x${string}`;
  MULTICALL3_ADDRESS: `0x${string}`;
  FEE_TIER: number; // Arena pool fee tier (uint24), e.g. 3000 == 0.3%
  PYTH_ADDRESS: `0x${string}`; // Pyth pull-oracle contract (getUpdateFee / updatePriceFeeds)
  PYTH_ETHUSD_ID: `0x${string}`; // 32-byte Pyth price-feed id for ETH/USD
  HERMES_URL: string; // Hermes endpoint that serves signed Pyth price updates
  // Optional multi-market config: a JSON array of per-market {id,label,baseSymbol,baseDecimals,
  // feeArena,oracle,pool,feedId}. Empty -> single ETH market built from the keys above (see lib/markets.ts).
  MARKETS: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function reqString(raw: Record<string, string | undefined>, key: string): string {
  const v = raw[key];
  if (v === undefined || v.trim() === '') throw new Error(`[env] missing required ${key}`);
  return v.trim();
}

function reqUrl(raw: Record<string, string | undefined>, key: string, schemes: string[]): string {
  const v = reqString(raw, key);
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    throw new Error(`[env] ${key} is not a valid URL: ${v}`);
  }
  if (!schemes.includes(parsed.protocol.replace(':', ''))) {
    throw new Error(`[env] ${key} must use one of [${schemes.join(', ')}], got "${parsed.protocol}"`);
  }
  return v;
}

function reqAddress(raw: Record<string, string | undefined>, key: string): `0x${string}` {
  const v = reqString(raw, key);
  if (!ADDRESS_RE.test(v)) throw new Error(`[env] ${key} must be a 0x-prefixed 40-hex address, got "${v}"`);
  return v as `0x${string}`;
}

function reqBytes32(raw: Record<string, string | undefined>, key: string): `0x${string}` {
  const v = reqString(raw, key);
  if (!BYTES32_RE.test(v)) throw new Error(`[env] ${key} must be a 0x-prefixed 64-hex bytes32, got "${v}"`);
  return v as `0x${string}`;
}

/** Optional address with a default; validates the 0x-40-hex format when an override is present. */
function optAddress(
  raw: Record<string, string | undefined>,
  key: string,
  fallback: `0x${string}`,
): `0x${string}` {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return fallback;
  return reqAddress(raw, key);
}

/**
 * Parses NEXT_PUBLIC_RPC_HTTP as a comma-separated list of http(s) URLs.
 * Trims entries, drops blanks, validates each URL, and de-duplicates while preserving order.
 * Throws if the result is empty or any entry is not a valid http(s) URL.
 */
function reqHttpUrls(raw: Record<string, string | undefined>, key: string): string[] {
  const raw_val = raw[key];
  if (raw_val === undefined || raw_val.trim() === '') throw new Error(`[env] missing required ${key}`);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const part of raw_val.split(',')) {
    const v = part.trim();
    if (v === '') continue;
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      throw new Error(`[env] ${key} contains an invalid URL: "${v}"`);
    }
    const scheme = parsed.protocol.replace(':', '');
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`[env] ${key} URLs must use http or https, got "${parsed.protocol}" in "${v}"`);
    }
    if (!seen.has(v)) {
      seen.add(v);
      urls.push(v);
    }
  }
  if (urls.length === 0) throw new Error(`[env] ${key} produced no valid URLs after parsing`);
  return urls;
}

/** Optional URL with a default; validates scheme when present. */
function optUrl(
  raw: Record<string, string | undefined>,
  key: string,
  schemes: string[],
  fallback: string,
): string {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return fallback;
  return reqUrl(raw, key, schemes);
}

function reqInt(raw: Record<string, string | undefined>, key: string): number {
  const v = reqString(raw, key);
  if (!/^\d+$/.test(v)) throw new Error(`[env] ${key} must be a positive integer, got "${v}"`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`[env] ${key} must be a positive integer, got "${v}"`);
  return n;
}

/** Optional positive integer with a default; validates when present. */
function optInt(raw: Record<string, string | undefined>, key: string, fallback: number): number {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return fallback;
  return reqInt(raw, key);
}

/** Optional non-negative block number (0 allowed) -> bigint; absent/empty -> 0n. */
function optBlock(raw: Record<string, string | undefined>, key: string): bigint {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return 0n;
  const t = v.trim();
  if (!/^\d+$/.test(t)) throw new Error(`[env] ${key} must be a non-negative integer block number, got "${t}"`);
  return BigInt(t);
}

/** Optional raw JSON string: empty -> "" (caller falls back); else must parse as JSON (shape checked in lib/markets.ts). */
function optJson(raw: Record<string, string | undefined>, key: string): string {
  const v = raw[key];
  if (v === undefined || v.trim() === '') return '';
  const trimmed = v.trim();
  try {
    JSON.parse(trimmed);
  } catch {
    throw new Error(`[env] ${key} must be empty or valid JSON, got "${trimmed.slice(0, 40)}…"`);
  }
  return trimmed;
}

export function parseEnv(raw: Record<string, string | undefined>): AppEnv {
  const rpcHttpUrls = reqHttpUrls(raw, 'NEXT_PUBLIC_RPC_HTTP');
  return {
    CHAIN_ID: reqInt(raw, 'NEXT_PUBLIC_CHAIN_ID'),
    RPC_HTTP_URLS: rpcHttpUrls,
    RPC_HTTP: rpcHttpUrls[0],
    RPC_WS: reqUrl(raw, 'NEXT_PUBLIC_RPC_WS', ['ws', 'wss']),
    EXPLORER_URL: reqUrl(raw, 'NEXT_PUBLIC_EXPLORER_URL', ['http', 'https']),
    FEE_ARENA_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_FEE_ARENA_ADDRESS'),
    FEE_ARENA_FROM_BLOCK: optBlock(raw, 'NEXT_PUBLIC_FEE_ARENA_FROM_BLOCK'),
    ORACLE_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_ORACLE_ADDRESS'),
    NPM_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_NPM_ADDRESS'),
    // Defaulted rather than required: the app must still boot (on the local estimate) if a market
    // is brought up before its quoter is deployed.
    QUOTER_ADDRESS: optAddress(raw, 'NEXT_PUBLIC_QUOTER_ADDRESS', '0xAFCd5e3f8fe76AC40aAD722cD4D909CAb2ef59bF'),
    FACTORY_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_FACTORY_ADDRESS'),
    POOL_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_POOL_ADDRESS'),
    SWAP_ROUTER_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_SWAP_ROUTER_ADDRESS'),
    USDC_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_USDC_ADDRESS'),
    // Circle EURC on Arc testnet (verified on-chain: code present, decimals()=6, symbol()="EURC").
    // Optional override; defaults to the canonical Arc testnet EURC so the asset works out of the box.
    EURC_ADDRESS: optAddress(raw, 'NEXT_PUBLIC_EURC_ADDRESS', '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'),
    WETH_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_WETH_ADDRESS'),
    MULTICALL3_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_MULTICALL3_ADDRESS'),
    FEE_TIER: optInt(raw, 'NEXT_PUBLIC_FEE_TIER', 3000),
    PYTH_ADDRESS: reqAddress(raw, 'NEXT_PUBLIC_PYTH_ADDRESS'),
    PYTH_ETHUSD_ID: reqBytes32(raw, 'NEXT_PUBLIC_PYTH_ETHUSD_ID'),
    HERMES_URL: optUrl(raw, 'NEXT_PUBLIC_HERMES_URL', ['http', 'https'], 'https://hermes.pyth.network'),
    MARKETS: optJson(raw, 'NEXT_PUBLIC_MARKETS'),
  };
}

/** Address validator exposed for lib/markets.ts to reuse on per-market addresses. */
export function parseAddress(value: string, label: string): `0x${string}` {
  if (!ADDRESS_RE.test(value)) throw new Error(`[markets] ${label} must be a 0x-prefixed 40-hex address, got "${value}"`);
  return value as `0x${string}`;
}

/** bytes32 validator exposed for lib/markets.ts to reuse on per-market feed ids. */
export function parseBytes32(value: string, label: string): `0x${string}` {
  if (!BYTES32_RE.test(value)) throw new Error(`[markets] ${label} must be a 0x-prefixed 64-hex bytes32, got "${value}"`);
  return value as `0x${string}`;
}

// NEXT_PUBLIC_* are inlined at build time, so reference them statically (not via a computed key)
// so Next/webpack can substitute the literal values into the client bundle.
const RAW: Record<string, string | undefined> = {
  NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID,
  NEXT_PUBLIC_RPC_HTTP: process.env.NEXT_PUBLIC_RPC_HTTP,
  NEXT_PUBLIC_RPC_WS: process.env.NEXT_PUBLIC_RPC_WS,
  NEXT_PUBLIC_EXPLORER_URL: process.env.NEXT_PUBLIC_EXPLORER_URL,
  NEXT_PUBLIC_FEE_ARENA_ADDRESS: process.env.NEXT_PUBLIC_FEE_ARENA_ADDRESS,
  NEXT_PUBLIC_FEE_ARENA_FROM_BLOCK: process.env.NEXT_PUBLIC_FEE_ARENA_FROM_BLOCK,
  NEXT_PUBLIC_ORACLE_ADDRESS: process.env.NEXT_PUBLIC_ORACLE_ADDRESS,
  NEXT_PUBLIC_NPM_ADDRESS: process.env.NEXT_PUBLIC_NPM_ADDRESS,
  NEXT_PUBLIC_QUOTER_ADDRESS: process.env.NEXT_PUBLIC_QUOTER_ADDRESS,
  NEXT_PUBLIC_FACTORY_ADDRESS: process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
  NEXT_PUBLIC_POOL_ADDRESS: process.env.NEXT_PUBLIC_POOL_ADDRESS,
  NEXT_PUBLIC_SWAP_ROUTER_ADDRESS: process.env.NEXT_PUBLIC_SWAP_ROUTER_ADDRESS,
  NEXT_PUBLIC_USDC_ADDRESS: process.env.NEXT_PUBLIC_USDC_ADDRESS,
  NEXT_PUBLIC_EURC_ADDRESS: process.env.NEXT_PUBLIC_EURC_ADDRESS,
  NEXT_PUBLIC_WETH_ADDRESS: process.env.NEXT_PUBLIC_WETH_ADDRESS,
  NEXT_PUBLIC_MULTICALL3_ADDRESS: process.env.NEXT_PUBLIC_MULTICALL3_ADDRESS,
  NEXT_PUBLIC_FEE_TIER: process.env.NEXT_PUBLIC_FEE_TIER,
  NEXT_PUBLIC_PYTH_ADDRESS: process.env.NEXT_PUBLIC_PYTH_ADDRESS,
  NEXT_PUBLIC_PYTH_ETHUSD_ID: process.env.NEXT_PUBLIC_PYTH_ETHUSD_ID,
  NEXT_PUBLIC_HERMES_URL: process.env.NEXT_PUBLIC_HERMES_URL,
  NEXT_PUBLIC_MARKETS: process.env.NEXT_PUBLIC_MARKETS,
};

// In test environments the NEXT_PUBLIC_* vars are not set; tests import `parseEnv` directly.
// We defer the hard-fail to runtime (when ENV is actually accessed) via a Proxy so the module
// can be imported without crashing in Vitest.
function makeEnv(): AppEnv {
  return parseEnv(RAW);
}

export const ENV: AppEnv = (() => {
  try {
    return makeEnv();
  } catch (e) {
    // In test/build environments without the vars set, return a Proxy that throws on access.
    // Vitest tests import only `parseEnv` directly and never access `ENV`.
    return new Proxy({} as AppEnv, {
      get(_t, prop: string) {
        throw new Error(
          `[env] ENV.${prop} accessed before NEXT_PUBLIC_* were set. ` +
            `Original error: ${e instanceof Error ? e.message : String(e)}`,
        );
      },
    });
  }
})();
