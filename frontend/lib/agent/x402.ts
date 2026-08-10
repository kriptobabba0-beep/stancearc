// lib/agent/x402.ts — per-message USDC billing for the copilot over x402 nanopayments.
//
// The chat endpoint becomes an x402-metered resource: a request without an X-PAYMENT
// header is answered 402 with the payment requirements; a paying client signs a Circle
// Gateway batched authorization (scheme "exact", extra GatewayWalletBatched — gasless,
// settled in batches by Circle's facilitator) and retries with the header. We verify with
// the facilitator before serving and settle after the reply streams. Everything here is
// plain fetch against gateway.circle.com/v1/x402 — the shapes match Circle's
// @circle-fin/x402-batching SDK, which the copilot deliberately does not import (the
// Workers bundle stays lean and the flow stays inspectable).
//
// OFF unless X402_ENABLED=true AND X402_PAY_TO is set. The default deployment keeps the
// daily quota instead; nothing changes for users until the flag flips.

// Circle's reference buyer (GatewayClient) defaults to protocol version 2 and reads the
// requirements from a PAYMENT-REQUIRED response header, pays via a Payment-Signature
// request header, and reads settlement from a PAYMENT-RESPONSE header — we speak exactly
// that dialect so third-party x402 agents can pay for the copilot too.
const X402_VERSION = 2;
const ARC_TESTNET_NETWORK = 'eip155:5042002';
const ARC_USDC = '0x3600000000000000000000000000000000000000';
// Circle Gateway's wallet contract on Arc testnet — the batching scheme's verifying contract.
const ARC_GATEWAY_WALLET = '0x0077777d7EBA4688BDeF3E311b846F25870A19B9';
const BATCHING_NAME = 'GatewayWalletBatched';
const BATCHING_VERSION = 1;

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export interface PaymentPayload {
  x402Version: number;
  payload: Record<string, unknown>;
  [k: string]: unknown;
}

export interface X402Config {
  enabled: boolean;
  payTo: string;
  /** USDC (6dp) per message, as base units — "10000" = $0.01. */
  amount: string;
  gatewayUrl: string;
}

export function loadX402Config(env: Record<string, string | undefined> = process.env): X402Config {
  const payTo = (env.X402_PAY_TO ?? '').trim();
  return {
    enabled: env.X402_ENABLED === 'true' && /^0x[0-9a-fA-F]{40}$/.test(payTo),
    payTo,
    amount: (env.X402_PRICE_USDC6 ?? '10000').trim(),
    gatewayUrl: (env.X402_GATEWAY_URL ?? 'https://gateway.circle.com').replace(/\/$/, ''),
  };
}

/** The requirements a paying client must satisfy — one price, USDC on Arc testnet. */
export function buildPaymentRequirements(cfg: X402Config): PaymentRequirements {
  return {
    scheme: 'exact',
    network: ARC_TESTNET_NETWORK,
    asset: ARC_USDC,
    amount: cfg.amount,
    payTo: cfg.payTo,
    maxTimeoutSeconds: 60,
    extra: { name: BATCHING_NAME, version: BATCHING_VERSION, verifyingContract: ARC_GATEWAY_WALLET },
  };
}

/** The 402 response body per the x402 spec: version, human error, accepted requirements. */
export function payment402Body(cfg: X402Config, error = 'payment required', resourceUrl?: string): Record<string, unknown> {
  return {
    x402Version: X402_VERSION,
    error,
    accepts: [buildPaymentRequirements(cfg)],
    resource: { url: resourceUrl ?? '', description: 'Limen Copilot message', mimeType: 'text/event-stream' },
  };
}

/** base64(JSON), UTF-8 safe — bare btoa rejects any character above Latin-1 (e.g. an em dash). */
export function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** The payment header is base64-encoded JSON; anything malformed is simply "no payment". */
export function parsePaymentHeader(header: string | null): PaymentPayload | null {
  if (header === null || header.trim() === '') return null;
  try {
    const trimmed = header.trim();
    const decoded =
      typeof Buffer !== 'undefined'
        ? Buffer.from(trimmed, 'base64').toString('utf8')
        : new TextDecoder().decode(Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0)));
    const parsed = JSON.parse(decoded) as PaymentPayload;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.x402Version !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

interface SettleResponse {
  success: boolean;
  errorReason?: string;
  transaction?: string;
}

async function facilitatorPost<T>(cfg: X402Config, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${cfg.gatewayUrl}/v1/x402/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`facilitator ${path} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** Ask Circle's facilitator whether the signed payment is good for the requirements. */
export function verifyPayment(cfg: X402Config, paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
  return facilitatorPost<VerifyResponse>(cfg, 'verify', { paymentPayload, paymentRequirements });
}

/** Settle after serving — Circle batches these; failure is logged, never re-billed here. */
export function settlePayment(cfg: X402Config, paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
  return facilitatorPost<SettleResponse>(cfg, 'settle', { paymentPayload, paymentRequirements });
}
