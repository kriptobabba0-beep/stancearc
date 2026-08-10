import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const m = vi.hoisted(() => ({
  apiCreateUser: vi.fn(),
  apiToken: vi.fn(),
  apiEmailToken: vi.fn(),
  apiSocialToken: vi.fn(),
  apiInitialize: vi.fn(),
  apiExecute: vi.fn(),
  apiWallets: vi.fn(),
  apiSignOut: vi.fn(),
  apiTransactions: vi.fn(),
  getDeviceId: vi.fn(),
  setAuthentication: vi.fn(),
  execute: vi.fn(),
  updateConfigs: vi.fn(),
  verifyOtp: vi.fn(),
  performLogin: vi.fn(),
}));

vi.mock('@/lib/circle/client', () => ({
  CIRCLE_APP_ID: 'app-id',
  CIRCLE_GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_LOGIN_ENABLED: true,
  apiCreateUser: m.apiCreateUser,
  apiToken: m.apiToken,
  apiEmailToken: m.apiEmailToken,
  apiSocialToken: m.apiSocialToken,
  apiInitialize: m.apiInitialize,
  apiExecute: m.apiExecute,
  apiWallets: m.apiWallets,
  apiSignOut: m.apiSignOut,
  apiTransactions: m.apiTransactions,
  // NOTE: the real package's main entry re-exports ONLY W3SSdk at runtime — SocialLoginProvider is
  // type-only there. The mock mirrors that (no SocialLoginProvider) so a regression to
  // `mod.SocialLoginProvider.GOOGLE` fails here too, not just in the browser.
  loadW3SSdk: async () => ({
    W3SSdk: class {
      _cb?: (e: unknown, r?: unknown) => void;
      getDeviceId() {
        return m.getDeviceId();
      }
      setAuthentication(a: unknown) {
        return m.setAuthentication(a);
      }
      execute(id: string, cb: (e: unknown) => void) {
        return m.execute(id, cb);
      }
      updateConfigs(cfg: unknown, cb?: (e: unknown, r?: unknown) => void) {
        this._cb = cb;
        return m.updateConfigs(cfg, cb);
      }
      verifyOtp() {
        m.verifyOtp();
        this._cb?.(undefined, { userToken: 'lut', encryptionKey: 'lek' });
      }
      performLogin(p: string) {
        m.performLogin(p);
        this._cb?.(undefined, { userToken: 'lut', encryptionKey: 'lek' });
        return Promise.resolve();
      }
      setThemeColor() {}
    },
  }),
}));

import { CircleWalletProvider, useCircleWallet } from '@/components/circle/CircleWalletProvider';

function Consumer() {
  const w = useCircleWallet();
  return (
    <div>
      <span data-testid="status">{w.status}</span>
      <span data-testid="address">{w.address ?? ''}</span>
      <span data-testid="kind">{w.kind ?? ''}</span>
      <span data-testid="error">{w.error ?? ''}</span>
      <button data-testid="create" onClick={() => void w.createOrRestoreWallet()} />
      <button data-testid="email" onClick={() => void w.loginWithEmail('a@b.com').catch(() => {})} />
      <button data-testid="google" onClick={() => void w.loginWithGoogle().catch(() => {})} />
      <button
        data-testid="exec"
        onClick={() =>
          void w
            .executeContract({ contractAddress: '0xC', abiFunctionSignature: 'claim(uint256)', abiParameters: ['1'] })
            .catch(() => {})
        }
      />
      <button data-testid="signout" onClick={() => w.signOut()} />
    </div>
  );
}

const renderProvider = () =>
  render(
    <CircleWalletProvider>
      <Consumer />
    </CircleWalletProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  Object.values(m).forEach((fn) => fn.mockReset());
  m.apiCreateUser.mockResolvedValue({ userId: 'uid-1' });
  m.apiToken.mockResolvedValue({ userToken: 'ut', encryptionKey: 'ek' });
  m.apiEmailToken.mockResolvedValue({ deviceToken: 'dt', deviceEncryptionKey: 'dek', otpToken: 'ot' });
  m.apiSocialToken.mockResolvedValue({ deviceToken: 'dt', deviceEncryptionKey: 'dek' });
  m.apiInitialize.mockResolvedValue({ challengeId: 'ci' });
  m.apiExecute.mockResolvedValue({ challengeId: 'ce' });
  m.apiWallets.mockResolvedValue({ wallets: [{ id: 'w-1', address: '0xWALLET', blockchain: 'ARC-TESTNET' }] });
  m.apiSignOut.mockResolvedValue({ ok: true });
  m.apiTransactions.mockResolvedValue({ transactions: [] });
  m.getDeviceId.mockResolvedValue('device');
  m.execute.mockImplementation((_id: string, cb: (e: unknown) => void) => cb(undefined));
});
afterEach(cleanup);

describe('CircleWalletProvider', () => {
  it('PIN: creates a wallet (user → token → initialize challenge → ready)', async () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('create'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('address').textContent).toBe('0xWALLET');
    expect(screen.getByTestId('kind').textContent).toBe('pin');
    expect(m.apiCreateUser).toHaveBeenCalled();
    expect(m.apiInitialize).toHaveBeenCalledWith('ut');
    expect(m.execute).toHaveBeenCalledWith('ci', expect.any(Function));
  });

  it('restores a persisted PIN wallet on mount (cookie re-mints per call)', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-x');
    localStorage.setItem('feearena.circle.address', '0xPERSISTED');
    localStorage.setItem('feearena.circle.kind', 'pin');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('address').textContent).toBe('0xPERSISTED');
    expect(screen.getByTestId('kind').textContent).toBe('pin');
    expect(m.apiCreateUser).not.toHaveBeenCalled();
  });

  it('email/Google restore WITHOUT a stored session lands signed-out — never a zombie wallet', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-x');
    localStorage.setItem('feearena.circle.address', '0xPERSISTED');
    localStorage.setItem('feearena.circle.kind', 'email');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));
    expect(m.apiExecute).not.toHaveBeenCalled();
  });

  it('recovers an interrupted PIN wallet (created flag + cookie)', async () => {
    localStorage.setItem('feearena.circle.created', '1');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('address').textContent).toBe('0xWALLET');
    expect(m.apiCreateUser).not.toHaveBeenCalled();
  });

  it('EMAIL: device token → verifyOtp → provisions a NEW wallet (initialize)', async () => {
    m.apiWallets.mockResolvedValueOnce({ wallets: [] }); // not a returning user
    renderProvider();
    fireEvent.click(screen.getByTestId('email'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('kind').textContent).toBe('email');
    expect(m.apiEmailToken).toHaveBeenCalledWith('device', 'a@b.com');
    expect(m.verifyOtp).toHaveBeenCalled();
    expect(m.apiInitialize).toHaveBeenCalledWith('lut'); // userToken from the login callback
    expect(m.execute).toHaveBeenCalledWith('ci', expect.any(Function));
  });

  it('GOOGLE: device token → performLogin → recovers the EXISTING wallet (returning user)', async () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('google'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    expect(screen.getByTestId('address').textContent).toBe('0xWALLET');
    expect(screen.getByTestId('kind').textContent).toBe('google');
    expect(m.apiSocialToken).toHaveBeenCalledWith('device');
    expect(m.performLogin).toHaveBeenCalledWith('Google');
    expect(m.apiInitialize).not.toHaveBeenCalled(); // returning user — no re-init
  });

  it('executeContract (PIN) sends the mapped args + signs', async () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('create'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    m.execute.mockClear();
    fireEvent.click(screen.getByTestId('exec'));
    await waitFor(() => expect(m.apiExecute).toHaveBeenCalled());
    expect(m.apiExecute).toHaveBeenCalledWith({
      userToken: 'ut',
      walletId: 'w-1',
      contractAddress: '0xC',
      abiFunctionSignature: 'claim(uint256)',
      abiParameters: ['1'],
    });
  });

  it('email/Google: restores the persisted session on mount so it can transact (no "session expired")', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-1');
    localStorage.setItem('feearena.circle.address', '0xPERSISTED');
    localStorage.setItem('feearena.circle.kind', 'google');
    localStorage.setItem('feearena.circle.session', JSON.stringify({ userToken: 'restored-ut', encryptionKey: 'restored-ek' }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    m.execute.mockClear();
    fireEvent.click(screen.getByTestId('exec'));
    await waitFor(() => expect(m.apiExecute).toHaveBeenCalled());
    expect(m.apiExecute).toHaveBeenCalledWith(expect.objectContaining({ userToken: 'restored-ut', walletId: 'w-1' }));
    expect(screen.getByTestId('error').textContent).toBe('');
  });

  it('a restored Google session with a DEAD token (401) downgrades to signed-out', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-1');
    localStorage.setItem('feearena.circle.address', '0xPERSISTED');
    localStorage.setItem('feearena.circle.kind', 'google');
    localStorage.setItem('feearena.circle.session', JSON.stringify({ userToken: 'stale-ut', encryptionKey: 'stale-ek' }));
    const dead = Object.assign(new Error('Circle transactions failed: token expired'), { status: 401 });
    m.apiTransactions.mockRejectedValue(dead);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));
    expect(screen.getByTestId('error').textContent).toMatch(/sign in again/i);
    expect(localStorage.getItem('feearena.circle.session')).toBeNull();
  });

  it('a NETWORK failure while probing the restored session does NOT sign the user out', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-1');
    localStorage.setItem('feearena.circle.address', '0xPERSISTED');
    localStorage.setItem('feearena.circle.kind', 'google');
    localStorage.setItem('feearena.circle.session', JSON.stringify({ userToken: 'ok-ut', encryptionKey: 'ok-ek' }));
    m.apiTransactions.mockRejectedValue(new TypeError('fetch failed')); // no status → transient
    renderProvider();
    await waitFor(() => expect(m.apiTransactions).toHaveBeenCalled());
    expect(screen.getByTestId('status').textContent).toBe('ready');
  });

  it('executeContract on an expired Google token (401) flips to signed-out with a plain reason', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-1');
    localStorage.setItem('feearena.circle.address', '0xPERSISTED');
    localStorage.setItem('feearena.circle.kind', 'google');
    localStorage.setItem('feearena.circle.session', JSON.stringify({ userToken: 'ut-live', encryptionKey: 'ek-live' }));
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    // The token dies BETWEEN the boot probe and the click (Circle tokens live ~an hour).
    m.apiExecute.mockRejectedValue(Object.assign(new Error('Circle execute failed: token expired'), { status: 401 }));
    fireEvent.click(screen.getByTestId('exec'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));
    expect(screen.getByTestId('error').textContent).toMatch(/sign in again/i);
  });

  it('surfaces a cancelled/failed challenge as an error', async () => {
    m.execute.mockImplementation((_id: string, cb: (e: unknown) => void) => cb({ message: 'User denied' }));
    renderProvider();
    fireEvent.click(screen.getByTestId('create'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('error'));
    expect(screen.getByTestId('error').textContent).toMatch(/denied/i);
  });

  it('signOut clears state + the server session', async () => {
    localStorage.setItem('feearena.circle.walletId', 'w-x');
    localStorage.setItem('feearena.circle.address', '0xP');
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'));
    fireEvent.click(screen.getByTestId('signout'));
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('idle'));
    expect(localStorage.getItem('feearena.circle.walletId')).toBeNull();
    expect(m.apiSignOut).toHaveBeenCalled();
  });
});
