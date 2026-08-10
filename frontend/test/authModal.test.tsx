import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const circle = vi.hoisted(() => ({
  isReady: false,
  loginWithGoogle: vi.fn(),
  loginWithEmail: vi.fn(),
  googleEnabled: true,
  status: 'idle' as string,
  error: null as string | null,
}));
const account = vi.hoisted(() => ({ isConnected: false }));
const connect = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn());
// Reconfigurable connector list: generic injected by default; tests can add 6963-discovered wallets.
const connectorsHolder = vi.hoisted(() => ({
  list: [{ uid: 'inj-1', id: 'injected', type: 'injected', name: 'Injected' }] as unknown[],
}));

vi.mock('@/components/circle/CircleWalletProvider', () => ({ useCircleWallet: () => circle }));
vi.mock('@/components/circle/WalletModeProvider', () => ({ useWalletMode: () => ({ mode: null, setMode }) }));
vi.mock('wagmi', () => ({
  useAccount: () => account,
  useConnect: () => ({ connect, connectors: connectorsHolder.list, isPending: false, error: undefined }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import { AuthModal } from '@/components/auth/AuthModal';

beforeEach(() => {
  circle.isReady = false;
  circle.status = 'idle';
  circle.error = null;
  circle.googleEnabled = true;
  circle.loginWithGoogle.mockReset();
  circle.loginWithEmail.mockReset();
  account.isConnected = false;
  connect.mockReset();
  setMode.mockReset();
  push.mockReset();
  connectorsHolder.list = [{ uid: 'inj-1', id: 'injected', type: 'injected', name: 'Injected' }];
  (window as unknown as { ethereum?: unknown }).ethereum = {}; // injected provider present
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe('AuthModal', () => {
  it('renders nothing when closed', () => {
    render(<AuthModal open={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('auth-wallet')).toBeNull();
  });

  it('open: shows the wallet row, Google, and Email options', () => {
    render(<AuthModal open onClose={vi.fn()} />);
    expect(screen.getByTestId('auth-wallet')).toBeTruthy();
    expect(screen.getByTestId('auth-google')).toBeTruthy();
    expect(screen.getByTestId('auth-email-input')).toBeTruthy();
  });

  it('generic injected provider: honest wallet-agnostic copy, no MetaMask-only claim', () => {
    render(<AuthModal open onClose={vi.fn()} />);
    expect(screen.getByText('Connect browser wallet')).toBeTruthy();
    expect(screen.getByText(/any EVM extension/i)).toBeTruthy();
    expect(screen.queryByText(/connect with metamask/i)).toBeNull();
  });

  it('wallet row: selects injected mode and connects', () => {
    render(<AuthModal open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('auth-wallet'));
    expect(setMode).toHaveBeenCalledWith('injected');
    expect(connect).toHaveBeenCalled();
  });

  it('EIP-6963 wallets: one row per discovered wallet with its REAL name, generic row hidden', () => {
    const rabby = { uid: 'r-1', id: 'io.rabby', type: 'injected', name: 'Rabby Wallet' };
    connectorsHolder.list = [
      { uid: 'inj-1', id: 'injected', type: 'injected', name: 'Injected' },
      { uid: 'm-1', id: 'io.metamask', type: 'injected', name: 'MetaMask' },
      rabby,
    ];
    render(<AuthModal open onClose={vi.fn()} />);
    expect(screen.getByText('Connect with MetaMask')).toBeTruthy();
    expect(screen.getByText('Connect with Rabby Wallet')).toBeTruthy();
    expect(screen.queryByText('Connect browser wallet')).toBeNull();
    // Clicking a specific wallet connects THAT connector.
    fireEvent.click(screen.getByText('Connect with Rabby Wallet'));
    expect(setMode).toHaveBeenCalledWith('injected');
    expect(connect).toHaveBeenCalledWith({ connector: rabby });
  });

  it('no wallet at all: wallet-agnostic install CTA', () => {
    delete (window as unknown as { ethereum?: unknown }).ethereum;
    render(<AuthModal open onClose={vi.fn()} />);
    expect(screen.getByText('Install a browser wallet')).toBeTruthy();
    expect(screen.getByText(/any EVM wallet works/i)).toBeTruthy();
    expect(screen.getByTestId('auth-wallet').getAttribute('href')).toContain('metamask.io');
  });

  it('Google: selects embedded mode and logs in', () => {
    render(<AuthModal open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('auth-google'));
    expect(setMode).toHaveBeenCalledWith('embedded');
    expect(circle.loginWithGoogle).toHaveBeenCalled();
  });

  it('Email: requires a valid address then logs in', () => {
    render(<AuthModal open onClose={vi.fn()} />);
    const submit = screen.getByTestId('auth-email-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // empty
    fireEvent.change(screen.getByTestId('auth-email-input'), { target: { value: 'a@b.com' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(setMode).toHaveBeenCalledWith('embedded');
    expect(circle.loginWithEmail).toHaveBeenCalledWith('a@b.com');
  });

  it('hides Google when not configured', () => {
    circle.googleEnabled = false;
    render(<AuthModal open onClose={vi.fn()} />);
    expect(screen.queryByTestId('auth-google')).toBeNull();
    expect(screen.getByTestId('auth-email-submit')).toBeTruthy();
  });
});
