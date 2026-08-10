// lib/cctp.ts — Circle CCTP V2 cross-chain USDC onboarding config + off-chain helpers.
//
// Flow (source testnet -> Arc testnet): burn on source via TokenMessengerV2.depositForBurn ->
// extract the MessageSent(bytes) message from the burn receipt -> poll Circle's Iris V2 attestation
// API -> mint on Arc via MessageTransmitterV2.receiveMessage(message, attestation).
//
// SOURCES (all verified 2026-06-05 against Circle's official CCTP V2 docs + reference repo):
//  - Testnet contract addresses (Eth Sepolia d0, Base Sepolia d6, Arc d26):
//      https://developers.circle.com/cctp/references/contract-addresses
//    CCTP V2 testnet uses DETERMINISTIC addresses across chains:
//      TokenMessengerV2     = 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
//      MessageTransmitterV2 = 0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275
//  - USDC testnet token addresses: https://developers.circle.com/stablecoins/usdc-contract-addresses
//      Ethereum Sepolia USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
//      Base Sepolia USDC     = 0x036CbD53842c5426634e7929541eC2318f3dCF7e
//  - depositForBurn V2 ABI + mintRecipient bytes32 padding + receiveMessage:
//      https://developers.circle.com/cctp/quickstarts/transfer-usdc-ethereum-to-arc
//      https://github.com/circlefin/circle-cctp-crosschain-transfer (official sample app)
//    V2 added `destinationCaller`, `maxFee`, `minFinalityThreshold` over V1.
//    minFinalityThreshold: <=1000 == Fast Transfer, >=2000 == Standard (hard finality).
//      https://developers.circle.com/cctp/required-block-confirmations
//    Fast Transfers REQUIRE a non-zero maxFee >= the minimum Fast fee quoted by Iris.
//    The fee is expressed in BPS (basis points) of the transfer amount; we ceil-divide to
//    ensure maxFee is never below the minimum:
//      maxFee = ceil(amount * minimumFeeBps / 10000)
//    Sending maxFee=0 with FINALITY_FAST silently degrades to Standard (~15-20 min) and
//    the 5-min attestation poll times out — use quoteMaxFee() before every depositForBurn.
//  - Iris V2 fee quote endpoint (Fast tier):
//      GET {IRIS_BASE}/v2/burn/USDC/fees/{srcDomain}/{dstDomain}
//      -> array of { finalityThreshold: number, minimumFee: number } (minimumFee is BPS)
//      Pick the entry with finalityThreshold <= 1000 (the Fast tier).
//  - Iris V2 testnet attestation API (sandbox):
//      base = https://iris-api-sandbox.circle.com
//      GET /v2/messages/{sourceDomain}?transactionHash={burnTxHash}
//      -> { messages: [{ status: "complete", message: "0x..", attestation: "0x.." }] }
//      404 while not yet indexed; statuses include "pending_confirmations" -> "complete".
//  - MessageSent event (NOT indexed; message bytes live in log data):
//      `event MessageSent(bytes message);`
//      https://github.com/circlefin/evm-cctp-contracts (src/MessageTransmitter.sol)
//
// Arc facts (independently verified, see project memory): domain 26, chainId 5042002,
//   USDC (mint token) = 0x3600000000000000000000000000000000000000.

import { decodeEventLog, type Log } from 'viem';

// ── ABIs ───────────────────────────────────────────────────────────────────────

/** TokenMessengerV2.depositForBurn — exact V2 arg order/types (uint256,uint32,bytes32,address,bytes32,uint256,uint32). */
export const depositForBurnAbi = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
] as const;

/** MessageTransmitterV2.receiveMessage(message, attestation) — mints on the destination chain. */
export const receiveMessageAbi = [
  {
    type: 'function',
    name: 'receiveMessage',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
] as const;

/** MessageTransmitter MessageSent(bytes message) — emitted by the burn; `message` is in log data (not indexed). */
export const messageSentAbi = [
  {
    type: 'event',
    name: 'MessageSent',
    inputs: [{ name: 'message', type: 'bytes', indexed: false }],
  },
] as const;

// ── Chain config ─────────────────────────────────────────────────────────────────

export interface CctpChain {
  key: string;
  label: string;
  chainId: number;
  /** CCTP domain id. */
  domain: number;
  tokenMessengerV2: `0x${string}`;
  messageTransmitterV2: `0x${string}`;
  usdc: `0x${string}`;
  /** Block-explorer base URL (no trailing slash) for per-step tx links. */
  explorer: string;
}

// CCTP V2 testnet contracts are deterministic across chains.
const TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
const MESSAGE_TRANSMITTER_V2 = '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;

/** Arc testnet — the mint destination (domain 26). */
export const ARC: CctpChain = {
  key: 'arc',
  label: 'Arc Testnet',
  chainId: 5042002,
  domain: 26,
  tokenMessengerV2: TOKEN_MESSENGER_V2,
  messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
  usdc: '0x3600000000000000000000000000000000000000',
  explorer: 'https://testnet.arcscan.app',
};

/** Source testnets a user can bridge USDC FROM. */
export const SOURCES: CctpChain[] = [
  {
    key: 'baseSepolia',
    label: 'Base Sepolia',
    chainId: 84532,
    domain: 6,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org',
  },
  {
    key: 'ethereumSepolia',
    label: 'Ethereum Sepolia',
    chainId: 11155111,
    domain: 0,
    tokenMessengerV2: TOKEN_MESSENGER_V2,
    messageTransmitterV2: MESSAGE_TRANSMITTER_V2,
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    explorer: 'https://sepolia.etherscan.io',
  },
];

/** Lookup a source chain by its `key`. */
export function sourceByKey(key: string): CctpChain | undefined {
  return SOURCES.find((s) => s.key === key);
}

/** Iris V2 testnet (sandbox) attestation base URL. */
export const IRIS_API_URL = 'https://iris-api-sandbox.circle.com';

/** USDC has 6 decimals on every CCTP chain. */
export const USDC_DECIMALS = 6;

/**
 * Fast Transfer (soft finality) — attestation issued after the burn is included in a block.
 * Standard Transfer uses >= 2000 (hard finality). We default to fast for onboarding latency.
 */
export const FINALITY_FAST = 1000;
export const FINALITY_STANDARD = 2000;

// ── Helpers ──────────────────────────────────────────────────────────────────────

/** Left-pad a 20-byte EVM address to a 32-byte (bytes32) value for `mintRecipient`/`destinationCaller`. */
export function toBytes32(address: `0x${string}`): `0x${string}` {
  const hex = address.replace(/^0x/, '').toLowerCase();
  if (hex.length !== 40 || !/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`toBytes32: not a 20-byte address: ${address}`);
  }
  return `0x${hex.padStart(64, '0')}`;
}

/** The all-zero bytes32, used for an empty `destinationCaller` (anyone may relay the mint). */
export const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

export interface DepositForBurnArgs {
  amount: bigint;
  mintRecipient: `0x${string}`;
  burnToken: `0x${string}`;
  maxFee: bigint;
  minFinalityThreshold: number;
  destinationCaller?: `0x${string}`;
}

/**
 * Assemble the exact V2 `depositForBurn` args tuple, hard-wiring `destinationDomain = 26` (Arc).
 * Returns the 7-tuple in ABI order for `writeContract({ args })`.
 */
export function buildDepositForBurnArgs({
  amount,
  mintRecipient,
  burnToken,
  maxFee,
  minFinalityThreshold,
  destinationCaller = ZERO_BYTES32,
}: DepositForBurnArgs): readonly [bigint, number, `0x${string}`, `0x${string}`, `0x${string}`, bigint, number] {
  return [
    amount,
    ARC.domain, // destinationDomain = 26
    mintRecipient,
    burnToken,
    destinationCaller,
    maxFee,
    minFinalityThreshold,
  ] as const;
}

/**
 * Decode the `MessageSent(bytes message)` event from a burn tx receipt's logs and return the
 * raw message bytes (the payload Circle attests and that `receiveMessage` consumes).
 * Throws if no MessageSent log is present.
 */
export function messageFromReceipt(logs: readonly Log[] | Log[]): `0x${string}` {
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: messageSentAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'MessageSent') {
        // viem types args as a tuple/record; the single param is `message`.
        const message = (decoded.args as { message?: `0x${string}` }).message;
        if (message) return message;
      }
    } catch {
      // Not a MessageSent log — keep scanning.
    }
  }
  throw new Error('No MessageSent event found in the burn transaction receipt.');
}

export interface AttestationResult {
  message: `0x${string}`;
  attestation: `0x${string}`;
}

export type AttestationStatus = 'pending' | 'complete';

interface IrisMessage {
  status?: string;
  message?: string;
  attestation?: string;
}
interface IrisResponse {
  messages?: IrisMessage[];
  error?: string;
}

export interface PollOptions {
  /** Delay between polls (ms). Default 5000 (matches Circle's sample). */
  intervalMs?: number;
  /** Total budget before rejecting (ms). Default 300000 (5 min). */
  timeoutMs?: number;
  /** Injectable for tests / non-browser. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional progress callback (status string from Iris, or 'pending' on 404). */
  onStatus?: (status: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Fast-transfer fee quoting ────────────────────────────────────────────────────

/** One entry from the Iris fee-quote array. `minimumFee` is in basis points (BPS). */
interface IrisFeeEntry {
  finalityThreshold: number;
  minimumFee: number;
}

export interface QuoteFeeOptions {
  /** Injectable fetch for tests / non-browser environments. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Quote the minimum maxFee required for a CCTP V2 Fast Transfer.
 *
 * Calls `GET {IRIS_API_URL}/v2/burn/USDC/fees/{srcDomain}/{dstDomain}` and picks the Fast tier
 * (finalityThreshold <= 1000). The response is an array of `{ finalityThreshold, minimumFee }`
 * where `minimumFee` is in BPS. Returns ceil(amount * minimumFeeBps / 10000n) so the result is
 * never below the Circle-required minimum. Throws if the endpoint is unreachable, the response
 * is malformed, or no Fast-tier entry is found.
 *
 * @param srcDomain  CCTP domain of the source chain (e.g. 6 for Base Sepolia).
 * @param dstDomain  CCTP domain of the destination chain (e.g. 26 for Arc).
 * @param amount     Transfer amount in USDC atomic units (6 decimals).
 */
export async function quoteMaxFee(
  srcDomain: number,
  dstDomain: number,
  amount: bigint,
  { fetchImpl = fetch }: QuoteFeeOptions = {},
): Promise<bigint> {
  const url = `${IRIS_API_URL}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch CCTP Fast Transfer fee quote (HTTP ${res.status}). Cannot proceed with burn.`,
    );
  }

  // The endpoint returns an array of { finalityThreshold, minimumFee } entries.
  let entries: IrisFeeEntry[];
  try {
    const body = (await res.json()) as IrisFeeEntry[] | { data?: IrisFeeEntry[] };
    // Some Circle API wrappers nest under `.data`; handle both shapes.
    entries = Array.isArray(body) ? body : (body.data ?? []);
  } catch {
    throw new Error('Failed to parse CCTP fee quote response.');
  }

  // Fast tier: finalityThreshold <= FINALITY_FAST (1000).
  const fastEntry = entries.find((e) => e.finalityThreshold <= FINALITY_FAST);
  if (!fastEntry) {
    throw new Error(
      'No Fast-tier fee entry found in CCTP fee quote. Cannot guarantee Fast Transfer.',
    );
  }

  // Iris returns `minimumFee` in BPS and it may be FRACTIONAL (e.g. 1.3 bps on the Base Sepolia → Arc
  // route) — `BigInt(1.3)` throws "cannot be converted to a BigInt because it is not an integer". Scale
  // the bps to an integer micro-bps (bps × 1e4) so the math stays in BigInt:
  //   maxFee = ceil(amount × bps / 10_000) = ceil(amount × microBps / (10_000 × 1e4)).
  const minimumFeeBps = Number(fastEntry.minimumFee);
  if (!Number.isFinite(minimumFeeBps) || minimumFeeBps < 0) {
    throw new Error('CCTP fee quote returned an invalid minimumFee.');
  }
  const microBps = BigInt(Math.round(minimumFeeBps * 10_000)); // bps × 1e4, integer
  const denom = 100_000_000n; // 10_000 (bps→fraction) × 10_000 (micro-bps scale)
  return (amount * microBps + denom - 1n) / denom; // ceil divide ⇒ never below the required minimum
}

/**
 * Bounded polling of the Iris V2 attestation endpoint for a burn tx.
 * Resolves with { message, attestation } once status === 'complete'.
 * Rejects on timeout, a non-404 HTTP error, or an Iris-reported error.
 *
 * GET {IRIS_API_URL}/v2/messages/{srcDomain}?transactionHash={txHash}
 */
export async function pollAttestation(
  srcDomain: number,
  txHash: `0x${string}`,
  opts: PollOptions = {},
): Promise<AttestationResult> {
  const {
    intervalMs = 5000,
    timeoutMs = 300_000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    onStatus,
  } = opts;

  const url = `${IRIS_API_URL}/v2/messages/${srcDomain}?transactionHash=${txHash}`;
  const deadline = Date.now() + timeoutMs;

  // Loop while there is budget left; always make at least one attempt.
  for (;;) {
    const res = await fetchImpl(url);

    // 404 == not yet indexed by Iris. Keep waiting (if budget remains).
    if (res.status === 404) {
      onStatus?.('pending');
    } else if (!res.ok) {
      throw new Error(`Iris attestation request failed (HTTP ${res.status}).`);
    } else {
      const body = (await res.json()) as IrisResponse;
      if (body.error) throw new Error(`Iris error: ${body.error}`);
      const msg = body.messages?.[0];
      if (msg) {
        onStatus?.(msg.status ?? 'pending');
        if (msg.status === 'complete' && msg.message && msg.attestation) {
          return {
            message: msg.message as `0x${string}`,
            attestation: msg.attestation as `0x${string}`,
          };
        }
      } else {
        onStatus?.('pending');
      }
    }

    if (Date.now() + intervalMs >= deadline) {
      throw new Error('Timed out waiting for Circle attestation. Try again shortly.');
    }
    await sleep(intervalMs);
  }
}
