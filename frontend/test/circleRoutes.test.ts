import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the server Circle client; keep CircleError + circleHttpError real so error mapping is exercised.
const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  createUserToken: vi.fn(),
  createEmailDeviceToken: vi.fn(),
  createSocialDeviceToken: vi.fn(),
  initializeWallet: vi.fn(),
  contractExecution: vi.fn(),
  getTransaction: vi.fn(),
  listWallets: vi.fn(),
}));

vi.mock('@/lib/server/circleServer', async (orig) => {
  const actual = await orig<typeof import('@/lib/server/circleServer')>();
  return { ...actual, ...mocks };
});

import { POST as usersPost } from '@/app/api/circle/users/route';
import { POST as tokenPost } from '@/app/api/circle/token/route';
import { POST as initPost } from '@/app/api/circle/initialize/route';
import { POST as execPost } from '@/app/api/circle/execute/route';
import { POST as txPost } from '@/app/api/circle/transaction/route';
import { POST as walletsPost } from '@/app/api/circle/wallets/route';
import { POST as emailTokenPost } from '@/app/api/circle/email-token/route';
import { POST as socialTokenPost } from '@/app/api/circle/social-token/route';
import { CircleError } from '@/lib/server/circleServer';

const post = (body?: unknown) =>
  new Request('http://test/api/circle', {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

const postC = (cookie: string, body?: unknown) =>
  new Request('http://test/api/circle', {
    method: 'POST',
    headers: { cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.createUser.mockResolvedValue(undefined);
  mocks.createUserToken.mockResolvedValue({ userToken: 'ut', encryptionKey: 'ek' });
  mocks.initializeWallet.mockResolvedValue({ challengeId: 'ci' });
  mocks.contractExecution.mockResolvedValue({ challengeId: 'ce' });
  mocks.getTransaction.mockResolvedValue({ state: 'CONFIRMED', txHash: '0xabc' });
  mocks.listWallets.mockResolvedValue([{ id: 'w', address: '0xA', blockchain: 'ARC-TESTNET' }]);
  mocks.createEmailDeviceToken.mockResolvedValue({ deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' });
  mocks.createSocialDeviceToken.mockResolvedValue({ deviceToken: 'dt', deviceEncryptionKey: 'dek' });
});

describe('circle route handlers', () => {
  it('POST /users creates a user, returns its id, and sets the HttpOnly uid cookie', async () => {
    const res = await usersPost();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(typeof j.userId).toBe('string');
    expect(mocks.createUser).toHaveBeenCalledWith(j.userId);
    // userId is bound to an HttpOnly cookie (not trusted from the body later).
    const cookie = res.cookies.get('fa_circle_uid');
    expect(cookie?.value).toBe(j.userId);
    expect(cookie?.httpOnly).toBe(true);
  });

  it('POST /token reads the userId from the cookie (401 without it), not the body', async () => {
    expect((await tokenPost(post({ userId: 'attacker-controlled' }))).status).toBe(401);
    const res = await tokenPost(postC('fa_circle_uid=u'));
    expect(await res.json()).toEqual({ userToken: 'ut', encryptionKey: 'ek' });
    expect(mocks.createUserToken).toHaveBeenCalledWith('u');
  });

  it('POST /initialize requires userToken; returns a challengeId otherwise', async () => {
    expect((await initPost(post({}))).status).toBe(400);
    const res = await initPost(post({ userToken: 'ut' }));
    expect(await res.json()).toEqual({ challengeId: 'ci' });
  });

  it('POST /execute validates required fields + maps args', async () => {
    expect((await execPost(post({ userToken: 'ut' }))).status).toBe(400);
    const res = await execPost(
      post({
        userToken: 'ut',
        walletId: 'w',
        contractAddress: '0xC',
        abiFunctionSignature: 'claim(uint256)',
        abiParameters: ['1'],
        feeLevel: 'LOW',
      }),
    );
    expect(await res.json()).toEqual({ challengeId: 'ce' });
    expect(mocks.contractExecution).toHaveBeenCalledWith(
      'ut',
      expect.objectContaining({
        walletId: 'w',
        contractAddress: '0xC',
        abiFunctionSignature: 'claim(uint256)',
        abiParameters: ['1'],
        feeLevel: 'LOW',
      }),
    );
  });

  it('POST /execute accepts callData as an alternative to abiFunctionSignature', async () => {
    const res = await execPost(post({ userToken: 'ut', walletId: 'w', contractAddress: '0xC', callData: '0xabcd' }));
    expect(await res.json()).toEqual({ challengeId: 'ce' });
    expect(mocks.contractExecution).toHaveBeenCalledWith('ut', expect.objectContaining({ callData: '0xabcd' }));
  });

  it('POST /transaction returns the tx state', async () => {
    expect((await txPost(post({ userToken: 'ut' }))).status).toBe(400);
    const res = await txPost(post({ userToken: 'ut', id: 'tx' }));
    expect(await res.json()).toEqual({ state: 'CONFIRMED', txHash: '0xabc' });
  });

  it('POST /wallets returns the wallet list', async () => {
    const res = await walletsPost(post({ userToken: 'ut' }));
    expect(await res.json()).toEqual({ wallets: [{ id: 'w', address: '0xA', blockchain: 'ARC-TESTNET' }] });
  });

  it('POST /email-token requires deviceId + email', async () => {
    expect((await emailTokenPost(post({ deviceId: 'd' }))).status).toBe(400);
    const res = await emailTokenPost(post({ deviceId: 'd', email: 'a@b.com' }));
    expect(await res.json()).toEqual({ deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' });
    expect(mocks.createEmailDeviceToken).toHaveBeenCalledWith('d', 'a@b.com');
  });

  it('POST /social-token requires deviceId', async () => {
    expect((await socialTokenPost(post({}))).status).toBe(400);
    const res = await socialTokenPost(post({ deviceId: 'd' }));
    expect(await res.json()).toEqual({ deviceToken: 'dt', deviceEncryptionKey: 'dek' });
  });

  it('maps a CircleError to its HTTP status without leaking the key', async () => {
    mocks.createUserToken.mockRejectedValue(new CircleError('Circle /users/token failed: Forbidden', 403));
    const res = await tokenPost(postC('fa_circle_uid=u'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('Forbidden');
  });
});
