// lib/server/circleServer.ts - SERVER-ONLY Circle W3S (Programmable Wallets) client.
//
// ⚠️ NEVER import this from a client component. It reads the secret CIRCLE_API_KEY from process.env and
// must only run inside Next.js Route Handlers (`export const runtime = 'nodejs'`). The browser talks to
// our /api/circle/* routes (which call this), never to Circle directly with the API key.
//
// User-controlled wallet model (verified live 2026-06-20 via scripts/circle/wallet-smoke.mjs):
//   POST /users {userId}                       -> 201
//   POST /users/token {userId}                 -> {data:{userToken,encryptionKey}}
//   POST /user/initialize (X-User-Token)       -> {data:{challengeId}}   (accountType EOA, ARC-TESTNET)
//   POST /user/transactions/contractExecution  -> {data:{challengeId}}   (no entitySecret - user signs via PIN)
//   GET  /transactions/{id} | GET /wallets     -> read state / list wallets (X-User-Token)
// The user's PIN + MPC keyshare stay on-device (Web SDK); this server never signs.

import { randomUUID } from 'node:crypto';
import type { CircleEventLog } from '@/lib/activity/types';

export const CIRCLE_W3S_BASE = 'https://api.circle.com/v1/w3s';

/** Error carrying the upstream HTTP status (the message is the Circle message, never the API key). */
export class CircleError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CircleError';
    this.status = status;
  }
}

/** Map any thrown error to an HTTP status + a client-safe message (never leaks the API key). */
export function circleHttpError(e: unknown): { status: number; message: string } {
  if (e instanceof CircleError) {
    return { status: e.status >= 400 && e.status <= 599 ? e.status : 502, message: e.message };
  }
  if (e instanceof Error && e.message.includes('CIRCLE_API_KEY')) {
    return { status: 500, message: 'Wallet service not configured.' };
  }
  return { status: 502, message: 'Circle request failed.' };
}

/** Read the server-only Circle API key. Throws if unset (so a missing key fails loudly, server-side). */
export function requireApiKey(): string {
  const k = process.env.CIRCLE_API_KEY;
  if (!k || !k.trim()) {
    throw new Error('CIRCLE_API_KEY is not set in the server environment.');
  }
  return k.trim();
}

type FetchImpl = typeof fetch;
export interface CircleOpts {
  userToken?: string;
  fetchImpl?: FetchImpl;
  /** Override the API key (tests/edge); defaults to requireApiKey(). */
  apiKey?: string;
}

async function circleFetch(
  path: string,
  { method = 'POST', body, userToken, fetchImpl = fetch, apiKey }: { method?: string; body?: unknown } & CircleOpts,
): Promise<Record<string, unknown>> {
  const key = apiKey ?? requireApiKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'X-Request-Id': randomUUID(),
    'Content-Type': 'application/json',
  };
  if (userToken) headers['X-User-Token'] = userToken;

  const res = await fetchImpl(`${CIRCLE_W3S_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      json && typeof json === 'object' && typeof json.message === 'string' ? json.message : `HTTP ${res.status}`;
    // Note: only the Circle-provided message is surfaced - never the API key / headers.
    throw new CircleError(`Circle ${path} failed: ${msg}`, res.status);
  }
  return json;
}

const dataOf = (json: Record<string, unknown>): Record<string, unknown> =>
  (json.data as Record<string, unknown>) ?? json;

// ── User + session ───────────────────────────────────────────────────────────────────
export async function createUser(userId: string, opts: CircleOpts = {}): Promise<void> {
  await circleFetch('/users', { body: { userId }, ...opts });
}

export async function createUserToken(
  userId: string,
  opts: CircleOpts = {},
): Promise<{ userToken: string; encryptionKey: string }> {
  const d = dataOf(await circleFetch('/users/token', { body: { userId }, ...opts }));
  return { userToken: String(d.userToken ?? ''), encryptionKey: String(d.encryptionKey ?? '') };
}

// ── Email / social device tokens (portable login - no userId; identity = email/Google) ──
// The client gets userToken+encryptionKey from the SDK login callback, NOT from /users/token.
export async function createEmailDeviceToken(
  deviceId: string,
  email: string,
  opts: CircleOpts = {},
): Promise<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }> {
  const d = dataOf(
    await circleFetch('/users/email/token', { body: { idempotencyKey: randomUUID(), deviceId, email }, ...opts }),
  );
  return {
    deviceToken: String(d.deviceToken ?? ''),
    deviceEncryptionKey: String(d.deviceEncryptionKey ?? ''),
    otpToken: String(d.otpToken ?? ''),
  };
}

export async function createSocialDeviceToken(
  deviceId: string,
  opts: CircleOpts = {},
): Promise<{ deviceToken: string; deviceEncryptionKey: string }> {
  const d = dataOf(
    await circleFetch('/users/social/token', { body: { idempotencyKey: randomUUID(), deviceId }, ...opts }),
  );
  return { deviceToken: String(d.deviceToken ?? ''), deviceEncryptionKey: String(d.deviceEncryptionKey ?? '') };
}

// ── Wallet provisioning ───────────────────────────────────────────────────────────────
// Circle Programmable Wallets - provision the user's wallet via POST /user/initialize (accountType EOA,
// blockchains ARC-TESTNET). Returns a challengeId the W3S Web SDK resolves with the user's on-device PIN;
// the MPC keyshare never touches our server.
export async function initializeWallet(
  userToken: string,
  opts: Omit<CircleOpts, 'userToken'> = {},
): Promise<{ challengeId: string }> {
  const d = dataOf(
    await circleFetch('/user/initialize', {
      body: { idempotencyKey: randomUUID(), accountType: 'EOA', blockchains: ['ARC-TESTNET'] },
      userToken,
      ...opts,
    }),
  );
  return { challengeId: String(d.challengeId ?? '') };
}

// ── Contract execution (the "/contracts/execute" path for embedded wallets) ────────────
export type FeeLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export interface ContractExecArgs {
  walletId: string;
  contractAddress: string;
  /** EITHER abiFunctionSignature+abiParameters (e.g. "claim(uint256)" + ["42"]) … */
  abiFunctionSignature?: string;
  abiParameters?: unknown[];
  /** … OR raw ABI-encoded calldata (mutually exclusive; tuple-safe - viem-encoded client-side). */
  callData?: string;
  /** Native value to send (USDC on Arc), atomic string. Default "0". */
  amount?: string;
  feeLevel?: FeeLevel;
}

// Circle Contracts (Smart Contract Platform) - execute a state-changing call on a deployed contract
// through the user's MPC wallet. The user signs with their PIN on-device; we only forward the call
// (callData, or abiFunctionSignature + params) plus any native amount, and hand back the challengeId
// the Web SDK resolves. This is the write path behind every embedded-wallet stake/claim/swap.
export async function contractExecution(
  userToken: string,
  args: ContractExecArgs,
  opts: Omit<CircleOpts, 'userToken'> = {},
): Promise<{ challengeId: string }> {
  const body: Record<string, unknown> = {
    idempotencyKey: randomUUID(),
    walletId: args.walletId,
    contractAddress: args.contractAddress,
    amount: args.amount ?? '0',
    feeLevel: args.feeLevel ?? 'MEDIUM',
  };
  // callData and abiFunctionSignature/abiParameters are mutually exclusive in Circle's API.
  if (args.callData) {
    body.callData = args.callData;
  } else {
    body.abiFunctionSignature = args.abiFunctionSignature;
    body.abiParameters = args.abiParameters ?? [];
  }
  const d = dataOf(
    await circleFetch('/user/transactions/contractExecution', { body, userToken, ...opts }),
  );
  return { challengeId: String(d.challengeId ?? '') };
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────
export async function getTransaction(
  id: string,
  userToken: string,
  opts: Omit<CircleOpts, 'userToken'> = {},
): Promise<{ state: string; txHash?: string }> {
  const d = dataOf(await circleFetch(`/transactions/${id}`, { method: 'GET', userToken, ...opts }));
  const t = (d.transaction as Record<string, unknown>) ?? d;
  return { state: String(t.state ?? ''), txHash: t.txHash ? String(t.txHash) : undefined };
}

export interface CircleWallet {
  id: string;
  address: string;
  blockchain: string;
}

export async function listWallets(
  userToken: string,
  opts: Omit<CircleOpts, 'userToken'> = {},
): Promise<CircleWallet[]> {
  const d = dataOf(await circleFetch('/wallets', { method: 'GET', userToken, ...opts }));
  const wallets = (d.wallets as CircleWallet[]) ?? [];
  return wallets.map((w) => ({ id: String(w.id), address: String(w.address), blockchain: String(w.blockchain) }));
}

export interface CircleTransaction {
  id: string;
  state: string;
  txHash?: string;
  /** INBOUND | OUTBOUND | … */
  transactionType?: string;
  /** Human-readable decimal amounts (Circle returns e.g. ["1.5"]). */
  amounts?: string[];
  tokenId?: string;
  sourceAddress?: string;
  destinationAddress?: string;
  createDate?: string;
}

/** List the user's most-recent transactions (across their wallets). Scoped by the user token. */
export async function listTransactions(
  userToken: string,
  opts: Omit<CircleOpts, 'userToken'> = {},
): Promise<CircleTransaction[]> {
  const d = dataOf(await circleFetch('/transactions?pageSize=20', { method: 'GET', userToken, ...opts }));
  const txs = (d.transactions as Record<string, unknown>[]) ?? [];
  return txs.map((t) => ({
    id: String(t.id ?? ''),
    state: String(t.state ?? ''),
    txHash: t.txHash ? String(t.txHash) : undefined,
    transactionType: t.transactionType ? String(t.transactionType) : undefined,
    amounts: Array.isArray(t.amounts) ? (t.amounts as unknown[]).map(String) : undefined,
    tokenId: t.tokenId ? String(t.tokenId) : undefined,
    sourceAddress: t.sourceAddress ? String(t.sourceAddress) : undefined,
    destinationAddress: t.destinationAddress ? String(t.destinationAddress) : undefined,
    createDate: t.createDate ? String(t.createDate) : undefined,
  }));
}

// ── Smart Contract Platform: event logs (account-level; key-only, no user token) ─────────
/** The Arc Testnet blockchain id used across the SCP calls. */
export const ARC_BLOCKCHAIN = 'ARC-TESTNET';

/**
 * List indexed event logs for a contract via Circle's Smart Contract Platform
 * (GET /v1/w3s/contracts/events). This is an ACCOUNT-level read - it needs only the API key (pass
 * `opts.apiKey` to use the SCP key), never a user token. Returns the RAW logs (topics + data); the
 * caller decodes them with the contract ABI (Circle returns decodedData: null for UNVERIFIED contracts).
 */
export async function listContractEvents(
  contractAddress: string,
  opts: CircleOpts & { pageSize?: number } = {},
): Promise<CircleEventLog[]> {
  const { pageSize = 20, ...rest } = opts;
  const qs = new URLSearchParams({
    contractAddress,
    blockchain: ARC_BLOCKCHAIN,
    pageSize: String(pageSize),
  }).toString();
  const d = dataOf(await circleFetch(`/contracts/events?${qs}`, { method: 'GET', ...rest }));
  const logs = (d.eventLogs as Record<string, unknown>[]) ?? [];
  // Validate hex at the trust boundary so a malformed/hostile upstream can't feed garbage to viem's
  // decoder - non-hex topics are dropped and data defaults to '0x' (the decode then degrades, not 500s).
  const isHex = (v: unknown): v is `0x${string}` => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);
  return logs.map((l) => ({
    id: String(l.id ?? ''),
    txHash: isHex(l.txHash) ? l.txHash : ('0x' as `0x${string}`),
    blockHeight: typeof l.blockHeight === 'number' ? l.blockHeight : Number(l.blockHeight ?? 0),
    ...(l.logIndex !== undefined && l.logIndex !== null ? { logIndex: l.logIndex as number | string } : {}),
    topics: Array.isArray(l.topics) ? l.topics.filter(isHex) : [],
    data: isHex(l.data) ? l.data : ('0x' as `0x${string}`),
    ...(l.eventName ? { eventName: String(l.eventName) } : {}),
    ...(l.firstConfirmDate ? { firstConfirmDate: String(l.firstConfirmDate) } : {}),
  }));
}
