// lib/circle/client.ts - browser-side helpers for the Circle embedded-wallet flow.
//
// These call our OWN /api/circle/* proxy routes (which hold the server-only API key) - the browser never
// talks to Circle's REST API with the key. The Web SDK (PIN/challenge UI) is loaded lazily because it is
// browser-only and must never be evaluated during SSR.

/** Circle App ID (Console → Wallets → User Controlled → Configurator). Public / client-safe. */
export const CIRCLE_APP_ID =
  process.env.NEXT_PUBLIC_CIRCLE_APP_ID || '66dd9e79-4802-52f0-9da0-c7058a853d5d';

/** Google OAuth Client ID for "Continue with Google" (public). Empty → Google login is hidden. */
export const CIRCLE_GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_CIRCLE_GOOGLE_CLIENT_ID || '';
export const GOOGLE_LOGIN_ENABLED = CIRCLE_GOOGLE_CLIENT_ID.length > 0;

async function postApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/circle/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carry the status: callers must tell an EXPIRED session (401/403 → sign in again)
    // apart from a transient failure, and the message alone can't.
    const err = new Error((json as { error?: string })?.error || `Wallet request failed (HTTP ${res.status}).`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export const apiCreateUser = () => postApi<{ userId: string }>('users');
// userId is NOT sent - the server reads it from the HttpOnly cookie set by apiCreateUser().
export const apiToken = () => postApi<{ userToken: string; encryptionKey: string }>('token');

// Email / Google portable login - mint a device token (the userToken comes from the SDK login callback).
export const apiEmailToken = (deviceId: string, email: string) =>
  postApi<{ deviceToken: string; deviceEncryptionKey: string; otpToken: string }>('email-token', { deviceId, email });
export const apiSocialToken = (deviceId: string) =>
  postApi<{ deviceToken: string; deviceEncryptionKey: string }>('social-token', { deviceId });
export const apiInitialize = (userToken: string) => postApi<{ challengeId: string }>('initialize', { userToken });

export interface ExecuteArgs {
  userToken: string;
  walletId: string;
  contractAddress: string;
  abiFunctionSignature?: string;
  abiParameters?: unknown[];
  callData?: string;
  amount?: string;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}
export const apiExecute = (args: ExecuteArgs) => postApi<{ challengeId: string }>('execute', args);

export const apiTransaction = (userToken: string, id: string) =>
  postApi<{ state: string; txHash?: string }>('transaction', { userToken, id });

/** Clear the server-side (PIN) session cookie. */
export const apiSignOut = () => postApi<{ ok: boolean }>('signout');

export interface CircleWalletDto {
  id: string;
  address: string;
  blockchain: string;
}
export const apiWallets = (userToken: string) =>
  postApi<{ wallets: CircleWalletDto[] }>('wallets', { userToken });

export interface CircleTxDto {
  id: string;
  state: string;
  txHash?: string;
  transactionType?: string;
  amounts?: string[];
  tokenId?: string;
  sourceAddress?: string;
  destinationAddress?: string;
  createDate?: string;
}
export const apiTransactions = (userToken: string) =>
  postApi<{ transactions: CircleTxDto[] }>('transactions', { userToken });

/** Lazily import the browser-only Web SDK (never during SSR). Returns the module ({ W3SSdk }). */
export async function loadW3SSdk(): Promise<typeof import('@circle-fin/w3s-pw-web-sdk')> {
  return import('@circle-fin/w3s-pw-web-sdk');
}
