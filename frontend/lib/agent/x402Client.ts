// lib/agent/x402Client.ts — the buyer side of the copilot's x402 nanopayments.
//
// When the chat API answers 402, the user pays from their Circle Gateway balance: they sign
// an EIP-3009 TransferWithAuthorization via EIP-712 with the GATEWAY WALLET contract as the
// verifying contract (Circle's "GatewayWalletBatched" scheme — gasless, settled in batches
// by Circle's facilitator), and the request retries with a Payment-Signature header. If the
// Gateway balance is short, a one-time on-chain deposit (approve + deposit) tops it up.
// The shapes here mirror Circle's @circle-fin/x402-batching client exactly — hand-rolled so
// the app bundle stays lean and every byte of the flow is inspectable.

/** Circle Gateway's wallet contract on Arc testnet (deposits + the EIP-712 domain). */
export const GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' as const;

export const gatewayWalletAbi = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'availableBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'depositor', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface Payment402 {
  x402Version?: number;
  error?: string;
  accepts?: PaymentOption[];
  resource?: { url: string; description: string; mimeType: string };
}

/** Pick the Gateway batching option for this chain from a 402's accepts list. */
export function pickPaymentOption(body: Payment402, chainId: number): PaymentOption | null {
  const network = `eip155:${chainId}`;
  return (
    (body.accepts ?? []).find(
      (o) =>
        o.network === network &&
        o.extra?.name === 'GatewayWalletBatched' &&
        typeof o.extra?.verifyingContract === 'string',
    ) ?? null
  );
}

export interface GatewayAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** Gateway batches over days — the authorization must outlive the batch window. */
const GATEWAY_AUTH_VALIDITY_SECONDS = 7 * 24 * 60 * 60 + 100;

export function randomNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as `0x${string}`;
}

/** The EIP-3009 authorization for one payment. Injectable time/nonce keep this testable. */
export function buildAuthorization(
  from: string,
  option: PaymentOption,
  overrides: { nowSec?: number; nonce?: `0x${string}` } = {},
): GatewayAuthorization {
  const now = overrides.nowSec ?? Math.floor(Date.now() / 1000);
  return {
    from,
    to: option.payTo,
    value: option.amount,
    validAfter: (now - 600).toString(),
    validBefore: (now + Math.max(option.maxTimeoutSeconds, GATEWAY_AUTH_VALIDITY_SECONDS)).toString(),
    nonce: overrides.nonce ?? randomNonce(),
  };
}

/** The exact EIP-712 payload wagmi's signTypedData signs (Circle's batching domain). */
export function gatewayTypedData(option: PaymentOption, auth: GatewayAuthorization) {
  const chainId = Number(option.network.split(':')[1]);
  return {
    domain: {
      name: 'GatewayWalletBatched',
      version: '1',
      chainId,
      verifyingContract: option.extra?.verifyingContract as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization' as const,
    message: {
      from: auth.from as `0x${string}`,
      to: auth.to as `0x${string}`,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as `0x${string}`,
    },
  };
}

/** The Payment-Signature header value: base64 of the signed payload + echoed context. */
export function buildPaymentHeader(input: {
  x402Version: number;
  authorization: GatewayAuthorization;
  signature: string;
  resource?: Payment402['resource'];
  accepted: PaymentOption;
}): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      x402Version: input.x402Version,
      payload: { authorization: input.authorization, signature: input.signature },
      resource: input.resource,
      accepted: input.accepted,
    }),
  );
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
