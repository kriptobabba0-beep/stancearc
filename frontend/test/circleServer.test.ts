import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requireApiKey,
  createUser,
  createUserToken,
  createEmailDeviceToken,
  createSocialDeviceToken,
  initializeWallet,
  contractExecution,
  getTransaction,
  listWallets,
  CircleError,
  CIRCLE_W3S_BASE,
} from '@/lib/server/circleServer';

const KEY = 'TEST_API_KEY:abc123:def456';
const UT = 'user-jwt-token';

function okFetch(json: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => json });
}

beforeEach(() => {
  process.env.CIRCLE_API_KEY = KEY;
});
afterEach(() => {
  delete process.env.CIRCLE_API_KEY;
  vi.restoreAllMocks();
});

describe('requireApiKey', () => {
  it('returns the key when set', () => {
    expect(requireApiKey()).toBe(KEY);
  });
  it('throws when unset', () => {
    delete process.env.CIRCLE_API_KEY;
    expect(() => requireApiKey()).toThrow(/CIRCLE_API_KEY/);
  });
});

describe('createUser', () => {
  it('POSTs /users with the Bearer key + userId body', async () => {
    const fetchImpl = okFetch({ data: {} });
    await createUser('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CIRCLE_W3S_BASE}/users`);
    expect((init as RequestInit).method).toBe('POST');
    const h = (init as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h['X-Request-Id']).toBeTruthy();
    expect(h['X-User-Token']).toBeUndefined();
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ userId: 'uid-1' });
  });
});

describe('createUserToken', () => {
  it('parses userToken + encryptionKey from data', async () => {
    const fetchImpl = okFetch({ data: { userToken: UT, encryptionKey: 'enc' } });
    const out = await createUserToken('uid-1', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ userToken: UT, encryptionKey: 'enc' });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${CIRCLE_W3S_BASE}/users/token`);
  });
});

describe('email/social device tokens (portable login)', () => {
  it('createEmailDeviceToken POSTs /users/email/token with deviceId + email', async () => {
    const fetchImpl = okFetch({ data: { deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' } });
    const out = await createEmailDeviceToken('dev-1', 'a@b.com', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CIRCLE_W3S_BASE}/users/email/token`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ deviceId: 'dev-1', email: 'a@b.com' });
    expect(body.idempotencyKey).toBeTruthy();
  });

  it('createSocialDeviceToken POSTs /users/social/token with deviceId only', async () => {
    const fetchImpl = okFetch({ data: { deviceToken: 'dt', deviceEncryptionKey: 'dek' } });
    const out = await createSocialDeviceToken('dev-1', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ deviceToken: 'dt', deviceEncryptionKey: 'dek' });
    expect(fetchImpl.mock.calls[0][0]).toBe(`${CIRCLE_W3S_BASE}/users/social/token`);
    expect(JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string).deviceId).toBe('dev-1');
  });
});

describe('initializeWallet', () => {
  it('POSTs /user/initialize with X-User-Token + EOA + ARC-TESTNET and returns challengeId', async () => {
    const fetchImpl = okFetch({ data: { challengeId: 'ch-init' } });
    const out = await initializeWallet(UT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ challengeId: 'ch-init' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CIRCLE_W3S_BASE}/user/initialize`);
    expect(((init as RequestInit).headers as Record<string, string>)['X-User-Token']).toBe(UT);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.accountType).toBe('EOA');
    expect(body.blockchains).toEqual(['ARC-TESTNET']);
    expect(body.idempotencyKey).toBeTruthy();
  });
});

describe('contractExecution', () => {
  it('POSTs /user/transactions/contractExecution with the mapped body → challengeId', async () => {
    const fetchImpl = okFetch({ data: { challengeId: 'ch-exec' } });
    const out = await contractExecution(
      UT,
      {
        walletId: 'w-1',
        contractAddress: '0xArena',
        abiFunctionSignature: 'claim(uint256)',
        abiParameters: ['42'],
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out).toEqual({ challengeId: 'ch-exec' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CIRCLE_W3S_BASE}/user/transactions/contractExecution`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      walletId: 'w-1',
      contractAddress: '0xArena',
      abiFunctionSignature: 'claim(uint256)',
      abiParameters: ['42'],
      amount: '0',
      feeLevel: 'MEDIUM',
    });
    expect(body.idempotencyKey).toBeTruthy();
    // No entity secret on the user-controlled path.
    expect(body.entitySecretCiphertext).toBeUndefined();
  });

  it('uses callData when provided (mutually exclusive with abiFunctionSignature)', async () => {
    const fetchImpl = okFetch({ data: { challengeId: 'ch' } });
    await contractExecution(
      UT,
      { walletId: 'w', contractAddress: '0xC', callData: '0xdeadbeef' },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body.callData).toBe('0xdeadbeef');
    expect(body.abiFunctionSignature).toBeUndefined();
    expect(body.abiParameters).toBeUndefined();
  });
});

describe('getTransaction + listWallets (GET, X-User-Token)', () => {
  it('getTransaction GETs /transactions/{id} and returns state + txHash', async () => {
    const fetchImpl = okFetch({ data: { transaction: { state: 'CONFIRMED', txHash: '0xabc' } } });
    const out = await getTransaction('tx-1', UT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual({ state: 'CONFIRMED', txHash: '0xabc' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CIRCLE_W3S_BASE}/transactions/tx-1`);
    expect((init as RequestInit).method).toBe('GET');
    expect(((init as RequestInit).headers as Record<string, string>)['X-User-Token']).toBe(UT);
  });

  it('listWallets GETs /wallets and returns the wallet array', async () => {
    const fetchImpl = okFetch({ data: { wallets: [{ id: 'w-1', address: '0xWallet', blockchain: 'ARC-TESTNET' }] } });
    const out = await listWallets(UT, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toEqual([{ id: 'w-1', address: '0xWallet', blockchain: 'ARC-TESTNET' }]);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${CIRCLE_W3S_BASE}/wallets`);
  });
});

describe('error handling', () => {
  it('throws CircleError carrying the upstream message + status on non-2xx (no key leak)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ code: 3, message: 'Forbidden' }),
    });
    await expect(
      createUser('uid', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createUser('uid', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/Forbidden/);
    // The thrown message must never contain the API key.
    try {
      await createUser('uid', { fetchImpl: fetchImpl as unknown as typeof fetch });
    } catch (e) {
      expect((e as Error).message).not.toContain(KEY);
      expect(e).toBeInstanceOf(CircleError);
    }
  });
});
