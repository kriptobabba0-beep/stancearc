import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The Web SDK is browser-only; mock it so loadW3SSdk() resolves without importing the real package.
vi.mock('@circle-fin/w3s-pw-web-sdk', () => ({ W3SSdk: class MockSdk {} }));

import {
  CIRCLE_APP_ID,
  apiCreateUser,
  apiToken,
  apiEmailToken,
  apiSocialToken,
  apiInitialize,
  apiExecute,
  apiTransaction,
  apiWallets,
  loadW3SSdk,
} from '@/lib/circle/client';

let fetchMock: ReturnType<typeof vi.fn>;
function jsonOk(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('circle client wrappers', () => {
  it('has a default App ID', () => {
    expect(CIRCLE_APP_ID).toBe('66dd9e79-4802-52f0-9da0-c7058a853d5d');
  });

  it('apiCreateUser POSTs /api/circle/users', async () => {
    jsonOk({ userId: 'u1' });
    expect(await apiCreateUser()).toEqual({ userId: 'u1' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/circle/users');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('apiToken POSTs to /token (cookie-bound, no userId in body)', async () => {
    jsonOk({ userToken: 'ut', encryptionKey: 'ek' });
    expect(await apiToken()).toEqual({ userToken: 'ut', encryptionKey: 'ek' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/circle/token');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({});
  });

  it('apiEmailToken + apiSocialToken POST their device-token routes', async () => {
    jsonOk({ deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' });
    expect(await apiEmailToken('dev', 'a@b.com')).toEqual({ deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/circle/email-token');
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ deviceId: 'dev', email: 'a@b.com' });
    fetchMock.mockClear();
    jsonOk({ deviceToken: 'dt2', deviceEncryptionKey: 'dek2' });
    expect(await apiSocialToken('dev')).toEqual({ deviceToken: 'dt2', deviceEncryptionKey: 'dek2' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/circle/social-token');
  });

  it('apiInitialize POSTs userToken', async () => {
    jsonOk({ challengeId: 'ci' });
    expect(await apiInitialize('ut')).toEqual({ challengeId: 'ci' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ userToken: 'ut' });
  });

  it('apiExecute POSTs the execution args', async () => {
    jsonOk({ challengeId: 'ce' });
    const args = { userToken: 'ut', walletId: 'w', contractAddress: '0xC', abiFunctionSignature: 'claim(uint256)', abiParameters: ['1'] };
    expect(await apiExecute(args)).toEqual({ challengeId: 'ce' });
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual(args);
  });

  it('apiTransaction + apiWallets POST userToken', async () => {
    jsonOk({ state: 'CONFIRMED', txHash: '0x' });
    expect(await apiTransaction('ut', 'tx')).toEqual({ state: 'CONFIRMED', txHash: '0x' });
    jsonOk({ wallets: [{ id: 'w', address: '0xA', blockchain: 'ARC-TESTNET' }] });
    expect((await apiWallets('ut')).wallets).toHaveLength(1);
  });

  it('throws the route error message on non-ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) });
    await expect(apiToken()).rejects.toThrow(/Forbidden/);
  });

  it('loadW3SSdk dynamically resolves the SDK module', async () => {
    const m = await loadW3SSdk();
    expect(m.W3SSdk).toBeDefined();
  });
});
