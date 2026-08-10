// lib/gateway.ts — Circle Gateway "instant cross-chain USDC" onboarding (testnet) config + off-chain helpers.
//
// Gateway is deposit-once / transfer-many: deposit USDC into the GatewayWallet on a SOURCE chain (the only
// slow leg — finality), then every transfer to Arc is sign(EIP-712 BurnIntent) -> POST /v1/transfer ->
// gatewayMint(attestation, signature) on Arc (<500ms once the deposit is finalized).
//
// SOURCES (all verified 2026-06-19 against Circle's live API + contract source):
//  - Contracts (deterministic across EVM testnets incl. Arc, from gateway-api-testnet.circle.com/v1/info):
//      GatewayWallet = 0x0077777d7EBA4688BDeF3E311b846F25870A19B9  (deposit side, source chain)
//      GatewayMinter = 0x0022222ABE238Cc2C7Bb1f21003F0a260052475B  (gatewayMint, on Arc)
//  - EIP-712 burn intent (confirmed byte-for-byte vs circlefin/evm-gateway-contracts
//      src/lib/EIP712Domain.sol + test/js/eip712TestData.js): the domain is INTENTIONALLY "domain-less" —
//      { name: "GatewayWallet", version: "1" } with NO chainId / verifyingContract (so intents verify
//      cross-chain). All address fields in TransferSpec are bytes32 (left-padded).
//  - REST API (testnet, no auth): https://gateway-api-testnet.circle.com/v1
//      GET  /info      -> per-domain config incl. burnIntentExpirationHeight (maxBlockHeight ceiling)
//      POST /balances  -> { token, sources:[{domain,depositor}] } -> { balances:[{domain,balance}] }
//      POST /transfer  -> [{ burnIntent, signature }] -> { attestation, signature }  (direct mint path)
//  - Fees: actual fee = source gas component + 0.5 bps of value, DEDUCTED from the minted amount
//      (recipient gets value - actualFee). maxFee is only a ceiling.

import { pad, toHex } from 'viem';

// ── Contracts (same on every EVM testnet, incl. Arc domain 26) ─────────────────────
export const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;
export const GATEWAY_MINTER = '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B' as const;
export const GATEWAY_API_URL = 'https://gateway-api-testnet.circle.com/v1';
export const USDC_DECIMALS = 6;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
/** Pre-padded zero bytes32 — `destinationCaller` (anyone may submit the mint). */
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

// ── Arc (the mint destination) ─────────────────────────────────────────────────────
// NOTE: chainId/domain are typed `number` (not literals) so wagmi's writeContract generic narrows
// the same way the proven CCTP path does — a literal chainId pushes it onto a stricter inference
// branch that resolves to `never`.
export const ARC_GATEWAY: {
  domain: number;
  chainId: number;
  label: string;
  usdc: `0x${string}`;
  explorer: string;
} = {
  domain: 26,
  chainId: 5042002,
  label: 'Arc Testnet',
  usdc: '0x3600000000000000000000000000000000000000',
  explorer: 'https://testnet.arcscan.app',
};

// ── Source chains a user can deposit FROM ──────────────────────────────────────────
export interface GatewaySource {
  key: string;
  label: string;
  chainId: number;
  /** Gateway/CCTP domain id. */
  domain: number;
  usdc: `0x${string}`;
  explorer: string;
  /** Human-readable deposit-finality estimate (the only slow leg). */
  approxFinality: string;
  /** Approx. seconds until a deposit finalizes + is credited (drives the live progress bar/ETA). */
  finalitySeconds: number;
  /** Per-source gas-fee component in USDC atomic units (6dp), from Circle's fee schedule. */
  gasFeeFloor: bigint;
}

export const GATEWAY_SOURCES: GatewaySource[] = [
  {
    key: 'avalancheFuji',
    label: 'Avalanche Fuji',
    chainId: 43113,
    domain: 1,
    usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
    explorer: 'https://testnet.snowtrace.io',
    approxFinality: '~8 seconds',
    finalitySeconds: 12,
    gasFeeFloor: 20_000n, // ~$0.02
  },
  {
    key: 'baseSepolia',
    label: 'Base Sepolia',
    chainId: 84532,
    domain: 6,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
    approxFinality: '~13–19 minutes',
    finalitySeconds: 1020,
    gasFeeFloor: 10_000n, // ~$0.01
  },
  {
    key: 'ethereumSepolia',
    label: 'Ethereum Sepolia',
    chainId: 11155111,
    domain: 0,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    explorer: 'https://sepolia.etherscan.io',
    approxFinality: '~13–19 minutes',
    finalitySeconds: 1140,
    gasFeeFloor: 1_000_000n, // ~$1.00
  },
];

export const sourceByKey = (key: string): GatewaySource | undefined =>
  GATEWAY_SOURCES.find((s) => s.key === key);
export const sourceByDomain = (domain: number): GatewaySource | undefined =>
  GATEWAY_SOURCES.find((s) => s.domain === domain);

// ── ABIs ───────────────────────────────────────────────────────────────────────────
/** GatewayWallet (source chain): deposit + balance views + Deposited event. */
export const gatewayWalletAbi = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'availableBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'totalBalance',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** GatewayMinter (Arc): consumes the API's attestation + signature to mint native USDC. */
export const gatewayMinterAbi = [
  {
    type: 'function',
    name: 'gatewayMint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// ── Encoding helpers ────────────────────────────────────────────────────────────────
/** Left-pad a 20-byte EVM address to a 32-byte (bytes32) value, lowercased (TransferSpec fields are bytes32). */
export function addressToBytes32(address: `0x${string}`): `0x${string}` {
  return pad(address.toLowerCase() as `0x${string}`, { size: 32 });
}

/** A random 32-byte salt (replay-protection / transfer uniqueness). */
export function randomSalt(): `0x${string}` {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

// ── EIP-712 burn intent typed data ──────────────────────────────────────────────────
/** Domain-less domain — name + version ONLY (NO chainId / verifyingContract). Intentional. */
export const GATEWAY_DOMAIN = { name: 'GatewayWallet', version: '1' } as const;

export const BURN_INTENT_TYPES = {
  TransferSpec: [
    { name: 'version', type: 'uint32' },
    { name: 'sourceDomain', type: 'uint32' },
    { name: 'destinationDomain', type: 'uint32' },
    { name: 'sourceContract', type: 'bytes32' },
    { name: 'destinationContract', type: 'bytes32' },
    { name: 'sourceToken', type: 'bytes32' },
    { name: 'destinationToken', type: 'bytes32' },
    { name: 'sourceDepositor', type: 'bytes32' },
    { name: 'destinationRecipient', type: 'bytes32' },
    { name: 'sourceSigner', type: 'bytes32' },
    { name: 'destinationCaller', type: 'bytes32' },
    { name: 'value', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
    { name: 'hookData', type: 'bytes' },
  ],
  BurnIntent: [
    { name: 'maxBlockHeight', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'spec', type: 'TransferSpec' },
  ],
} as const;

export interface TransferSpec {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: `0x${string}`;
  destinationContract: `0x${string}`;
  sourceToken: `0x${string}`;
  destinationToken: `0x${string}`;
  sourceDepositor: `0x${string}`;
  destinationRecipient: `0x${string}`;
  sourceSigner: `0x${string}`;
  destinationCaller: `0x${string}`;
  value: bigint;
  salt: `0x${string}`;
  hookData: `0x${string}`;
}

export interface BurnIntentMessage {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: TransferSpec;
}

/**
 * Assemble a BurnIntent for a SOURCE→Arc transfer. Address fields are bytes32-padded; destination is
 * pinned to Arc (domain 26, Arc USDC facade); `destinationCaller` is zero (anyone may submit the mint).
 */
export function buildBurnIntent(args: {
  source: GatewaySource;
  value: bigint;
  depositor: `0x${string}`;
  recipient: `0x${string}`;
  maxBlockHeight: bigint;
  maxFee: bigint;
  salt?: `0x${string}`;
}): BurnIntentMessage {
  return {
    maxBlockHeight: args.maxBlockHeight,
    maxFee: args.maxFee,
    spec: {
      version: 1,
      sourceDomain: args.source.domain,
      destinationDomain: ARC_GATEWAY.domain,
      sourceContract: addressToBytes32(GATEWAY_WALLET),
      destinationContract: addressToBytes32(GATEWAY_MINTER),
      sourceToken: addressToBytes32(args.source.usdc),
      destinationToken: addressToBytes32(ARC_GATEWAY.usdc),
      sourceDepositor: addressToBytes32(args.depositor),
      destinationRecipient: addressToBytes32(args.recipient),
      sourceSigner: addressToBytes32(args.depositor),
      destinationCaller: ZERO_BYTES32,
      value: args.value,
      salt: args.salt ?? randomSalt(),
      hookData: '0x',
    },
  };
}

/** Wrap a BurnIntent message into a viem `signTypedData` argument object. */
export function burnIntentTypedData(message: BurnIntentMessage) {
  return {
    domain: GATEWAY_DOMAIN,
    types: BURN_INTENT_TYPES,
    primaryType: 'BurnIntent' as const,
    message,
  };
}

// ── Fees ────────────────────────────────────────────────────────────────────────────
const ceilDiv = (n: bigint, d: bigint): bigint => (n + d - 1n) / d;

/** The expected fee deducted from a transfer: source gas component + 0.5 bps (= value/20000) of value. */
export function expectedFee(source: GatewaySource, value: bigint): bigint {
  return source.gasFeeFloor + ceilDiv(value * 5n, 100_000n);
}

/** A safe `maxFee` ceiling = expectedFee + 1.5x headroom. The actual (smaller) fee is what's deducted. */
export function computeMaxFee(source: GatewaySource, value: bigint): bigint {
  const fee = expectedFee(source, value);
  return fee + ceilDiv(fee, 2n);
}

/** Minimum sensible transfer for a source = 2x its gas floor (so the fee leaves a meaningful amount). */
export function minTransferValue(source: GatewaySource): bigint {
  return source.gasFeeFloor * 2n;
}

// ── Serialization (bigints -> strings for the JSON body) ────────────────────────────
export function serializeBurnIntent(message: BurnIntentMessage): unknown {
  return {
    maxBlockHeight: message.maxBlockHeight.toString(),
    maxFee: message.maxFee.toString(),
    spec: { ...message.spec, value: message.spec.value.toString() },
  };
}

/** Parse a 6-dp USDC decimal string ("2.000000") into atomic bigint units. */
export function parseUsdc6(s: string): bigint {
  const [whole, frac = ''] = s.trim().split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole || '0') * 1_000_000n + BigInt(fracPadded || '0');
}

// ── REST client (injectable fetch for tests) ────────────────────────────────────────
type FetchImpl = typeof fetch;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * POST JSON to the Gateway API. `retries` re-attempts on TRANSIENT failures only — a network throw or a 5xx
 * (Circle's testnet /transfer intermittently 503s "Service temporarily unavailable") — with linear backoff.
 * 4xx are terminal (bad fee/signature/balance) and never retried. Submits pass retries>0 so a transient blip
 * doesn't waste the user's signature; polled reads leave it at 0 (they self-heal next poll). On a final
 * failure it surfaces Circle's own message ("Invalid signature", "Insufficient balance for depositor 0x…").
 */
async function postJson(
  url: string,
  body: unknown,
  fetchImpl: FetchImpl,
  { retries = 0, retryDelayMs = 1500 }: { retries?: number; retryDelayMs?: number } = {},
): Promise<unknown> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    } catch (e) {
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      throw e;
    }
    if (res.ok) return res.json();
    if (res.status >= 500 && res.status < 600 && attempt < retries) {
      await sleep(retryDelayMs * (attempt + 1)); // transient server error — retry
      continue;
    }
    // Surface Circle's own reason instead of a bare status — the message is the point of debugging. Body is public.
    let detail = '';
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j?.message === 'string' && j.message.trim()) detail = `: ${j.message.trim()}`;
    } catch {
      /* non-JSON / empty body — fall back to the status alone */
    }
    throw new Error(`Gateway API ${url} failed (HTTP ${res.status})${detail}.`);
  }
}

interface GatewayInfo {
  domains: { domain: number; burnIntentExpirationHeight?: string }[];
}

export async function fetchGatewayInfo({ fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {}): Promise<GatewayInfo> {
  const res = await fetchImpl(`${GATEWAY_API_URL}/info`);
  if (!res.ok) throw new Error(`Gateway /info failed (HTTP ${res.status}).`);
  return (await res.json()) as GatewayInfo;
}

/** The max `maxBlockHeight` for a burn intent sourced from `domain` (drifts; read live). */
export async function fetchExpirationHeight(
  domain: number,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<bigint> {
  const info = await fetchGatewayInfo(opts);
  const d = info.domains?.find((x) => x.domain === domain);
  if (!d?.burnIntentExpirationHeight) {
    throw new Error(`No burnIntentExpirationHeight for Gateway domain ${domain}.`);
  }
  return BigInt(d.burnIntentExpirationHeight);
}

/** Query the depositor's spendable unified balance per source domain → Map<domain, atomic bigint>. */
export async function fetchUnifiedBalances(
  sources: { domain: number; depositor: `0x${string}` }[],
  { fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {},
): Promise<Map<number, bigint>> {
  const json = (await postJson(`${GATEWAY_API_URL}/balances`, { token: 'USDC', sources }, fetchImpl)) as {
    balances?: { domain: number; balance: string }[];
  };
  const out = new Map<number, bigint>();
  for (const b of json.balances ?? []) out.set(b.domain, parseUsdc6(b.balance));
  return out;
}

/** Submit a signed burn intent → returns the attestation + Gateway signature to feed to `gatewayMint`. */
export async function submitTransfer(
  message: BurnIntentMessage,
  signature: `0x${string}`,
  { fetchImpl = fetch, retries = 3, retryDelayMs = 1500 }: { fetchImpl?: FetchImpl; retries?: number; retryDelayMs?: number } = {},
): Promise<{ attestation: `0x${string}`; signature: `0x${string}` }> {
  const json = (await postJson(
    `${GATEWAY_API_URL}/transfer`,
    [{ burnIntent: serializeBurnIntent(message), signature }],
    fetchImpl,
    { retries, retryDelayMs }, // the signed intent is reusable — ride out a transient 503, not waste the signature
  )) as { attestation?: string; signature?: string };
  if (!json.attestation || !json.signature) {
    throw new Error('Gateway /transfer returned no attestation. Try the transfer again.');
  }
  return { attestation: json.attestation as `0x${string}`, signature: json.signature as `0x${string}` };
}

// ── Forwarder (one-click) path ──────────────────────────────────────────────────────
// With ?enableForwarder=true, Circle BROADCASTS the destination mint itself (no user gatewayMint tx, no
// chain switch). Two divergences from the manual path, both verified against the live testnet API: (1) the
// burn intent's maxFee must ALSO cover Circle's mint gas — size it via /estimate; (2) the POST returns a
// `transferId` (and OMITS attestation/signature), which we poll on GET /transfer/{id} until the mint settles.
/** Arc supports Gateway forwarding. Flip to false to force the manual gatewayMint path everywhere. */
export const FORWARDER_ENABLED = true;

/**
 * Size a forwarder burn intent: POST /estimate?enableForwarder=true with the UNSIGNED intent → Circle echoes
 * it back with the maxFee bumped to cover its destination-mint gas + a fresh maxBlockHeight. The forwarder
 * estimate WRAPS the result in `{ body: [{ burnIntent }] }` (the non-forwarder one returns the array bare).
 * Returns null if the (undocumented) shape doesn't match — the caller then falls back to the manual mint.
 */
export async function estimateForwarderFee(
  message: BurnIntentMessage,
  { fetchImpl = fetch, retries = 2, retryDelayMs = 1500 }: { fetchImpl?: FetchImpl; retries?: number; retryDelayMs?: number } = {},
): Promise<{ maxFee: bigint; maxBlockHeight: bigint } | null> {
  const url = `${GATEWAY_API_URL}/estimate?enableForwarder=true`;
  const body = JSON.stringify([serializeBurnIntent(message)]);
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } catch {
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
      return null; // network down — caller falls back to the manual mint
    }
    if (res.status >= 500 && res.status < 600 && attempt < retries) {
      await sleep(retryDelayMs * (attempt + 1)); // transient 503 — retry before giving up on the forwarder
      continue;
    }
    if (!res.ok) return null;
    const json = (await res.json().catch(() => null)) as
      | { body?: { burnIntent?: { maxFee?: string; maxBlockHeight?: string } }[] }
      | null;
    const bi = json?.body?.[0]?.burnIntent;
    if (!bi?.maxFee || !bi?.maxBlockHeight) return null;
    try {
      return { maxFee: BigInt(bi.maxFee), maxBlockHeight: BigInt(bi.maxBlockHeight) };
    } catch {
      return null;
    }
  }
}

/**
 * Submit a signed burn intent via the FORWARDER. Returns the `transferId` to poll. Forwarder responses key
 * off transferId only and OMIT attestation/signature (so we can't reuse submitTransfer, which throws on a
 * missing attestation). Circle broadcasts the Arc mint — the caller does NOT call gatewayMint.
 */
export async function submitForwarderTransfer(
  message: BurnIntentMessage,
  signature: `0x${string}`,
  { fetchImpl = fetch, retries = 3, retryDelayMs = 1500 }: { fetchImpl?: FetchImpl; retries?: number; retryDelayMs?: number } = {},
): Promise<{ transferId: string }> {
  const json = (await postJson(
    `${GATEWAY_API_URL}/transfer?enableForwarder=true`,
    [{ burnIntent: serializeBurnIntent(message), signature }],
    fetchImpl,
    { retries, retryDelayMs }, // Circle's testnet forwarder intermittently 503s — retry before failing
  )) as { transferId?: string };
  if (!json?.transferId) {
    throw new Error('Gateway forwarding enabled but no transferId was returned. Try the transfer again.');
  }
  return { transferId: json.transferId };
}

/**
 * Poll GET /transfer/{id} until Circle's forwarded mint settles. Resolves with the Arc mint tx hash on
 * `confirmed`|`finalized`; throws on `failed`|`expired` or timeout. Early polls can 400 ("not available
 * yet") before the record is queryable — treated as transient. Done-set is {confirmed,finalized} (testnet
 * ordering is unverified — never hard-code only one); a terminal status with no hash yet → poll again.
 */
export async function pollForwarderTransfer(
  transferId: string,
  {
    fetchImpl = fetch,
    intervalMs = 5_000,
    timeoutMs = 300_000,
    onStatus,
  }: { fetchImpl?: FetchImpl; intervalMs?: number; timeoutMs?: number; onStatus?: (status: string) => void } = {},
): Promise<{ status: string; transactionHash: `0x${string}` }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let res: Response;
    try {
      res = await fetchImpl(`${GATEWAY_API_URL}/transfer/${transferId}`);
    } catch {
      await sleep(intervalMs); // network blip — keep polling (bounded by timeoutMs)
      continue;
    }
    if (!res.ok) {
      // Early 400 ("not available yet") or a transient 5xx — keep polling rather than failing a transfer
      // that Circle is still processing. A persistent error is bounded by timeoutMs → "still processing".
      await sleep(intervalMs);
      continue;
    }
    const d = (await res.json().catch(() => ({}))) as {
      status?: string;
      transactionHash?: string;
      forwardingDetails?: { failureReason?: string };
    };
    const status = String(d.status ?? '');
    onStatus?.(status);
    if (status === 'confirmed' || status === 'finalized') {
      if (d.transactionHash) return { status, transactionHash: d.transactionHash as `0x${string}` };
      // terminal-success but the hash hasn't propagated — fall through and poll once more
    } else if (status === 'failed') {
      throw new Error(d.forwardingDetails?.failureReason || 'Circle could not complete the forwarded mint.');
    } else if (status === 'expired') {
      throw new Error('The transfer expired before it was minted. Please start a new transfer.');
    }
    await sleep(intervalMs);
  }
  throw new Error(`Still processing (transfer ${transferId}). The mint may still land — check ArcScan shortly.`);
}

// ── Deposit status tracking (live finality loop) ────────────────────────────────────
export interface GatewayDeposit {
  transactionHash: `0x${string}`;
  domain: number;
  /** USDC atomic units (6dp). */
  amount: bigint;
  /** Circle's status — "pending" while it finalizes; anything else means it's been credited. */
  status: string;
  blockHeight: bigint;
  /** Block timestamp in ms epoch (drives the elapsed/ETA math). 0 if absent. */
  blockTimestampMs: number;
}

/** A deposit is still finalizing (not yet spendable) iff its status is "pending". */
export function isPendingDeposit(d: GatewayDeposit): boolean {
  return d.status.toLowerCase() === 'pending';
}

/** List the depositor's Gateway deposits per source domain (incl. ones still finalizing). */
export async function fetchDeposits(
  sources: { domain: number; depositor: `0x${string}` }[],
  { fetchImpl = fetch }: { fetchImpl?: FetchImpl } = {},
): Promise<GatewayDeposit[]> {
  const json = (await postJson(`${GATEWAY_API_URL}/deposits`, { token: 'USDC', sources }, fetchImpl)) as {
    deposits?: {
      transactionHash: string;
      domain: number;
      amount: string;
      status?: string;
      blockHeight?: string;
      blockTimestamp?: string;
    }[];
  };
  return (json.deposits ?? []).map((d) => ({
    transactionHash: d.transactionHash as `0x${string}`,
    domain: d.domain,
    amount: BigInt(d.amount),
    status: String(d.status ?? ''),
    blockHeight: BigInt(d.blockHeight ?? '0'),
    blockTimestampMs: d.blockTimestamp ? Date.parse(d.blockTimestamp) || 0 : 0,
  }));
}

export interface DepositProgressView {
  /** "confirming" while within the finality window; "crediting" once the estimate has elapsed. */
  phase: 'confirming' | 'crediting';
  /** 0..0.99 (never 100% until the deposit actually leaves the pending set). */
  pct: number;
  /** Estimated seconds remaining (0 in the crediting phase). */
  etaSec: number;
}

/** Compute a deposit's live progress from its block timestamp + the source's finality estimate. */
export function depositProgress(args: {
  blockTimestampMs: number;
  now: number;
  finalitySeconds: number;
}): DepositProgressView {
  const total = Math.max(1, args.finalitySeconds);
  const elapsedSec = args.blockTimestampMs > 0 ? Math.max(0, (args.now - args.blockTimestampMs) / 1000) : 0;
  if (elapsedSec >= total) return { phase: 'crediting', pct: 0.99, etaSec: 0 };
  return { phase: 'confirming', pct: Math.min(0.99, elapsedSec / total), etaSec: Math.ceil(total - elapsedSec) };
}

/** Friendly countdown string: "~45s", "~3m 20s", "~17m", "any moment". */
export function formatEta(sec: number): string {
  if (sec <= 0) return 'any moment';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m <= 0) return `~${s}s`;
  if (m >= 60) return `~${Math.floor(m / 60)}h ${m % 60}m`;
  return m < 5 && s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

/** Re-exported for callers that build the zero-address default elsewhere. */
export { ZERO_ADDRESS };
