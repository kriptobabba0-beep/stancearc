import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const circle = vi.hoisted(() => ({
  isReady: false,
  address: null as string | null,
  kind: null as string | null,
  signOut: vi.fn(),
}));
const account = vi.hoisted(() => ({ address: null as string | null, isConnected: false }));
const openModal = vi.hoisted(() => vi.fn());
const disconnect = vi.hoisted(() => vi.fn());

vi.mock('@/components/auth/AuthModalProvider', () => ({ useAuthModal: () => ({ open: openModal, close: vi.fn(), isOpen: false }) }));
vi.mock('@/components/circle/CircleWalletProvider', () => ({ useCircleWallet: () => circle }));
vi.mock('wagmi', () => ({
  useAccount: () => account,
  useDisconnect: () => ({ disconnect }),
}));
vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app' } }));

import { SignInButton } from '@/components/auth/SignInButton';

beforeEach(() => {
  circle.isReady = false;
  circle.address = null;
  circle.kind = null;
  circle.signOut.mockReset();
  account.address = null;
  account.isConnected = false;
  openModal.mockReset();
  disconnect.mockReset();
});
afterEach(cleanup);

describe('SignInButton', () => {
  it('signed out: shows "Sign In" and opens the modal on click', () => {
    render(<SignInButton />);
    const btn = screen.getByTestId('sign-in');
    expect(btn.textContent).toMatch(/sign in/i);
    fireEvent.click(btn);
    expect(openModal).toHaveBeenCalled();
  });

  it('embedded wallet ready: shows an account chip + a popover with My Wallet and Sign out', () => {
    circle.isReady = true;
    circle.address = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
    circle.kind = 'google';
    render(<SignInButton />);
    const chip = screen.getByTestId('account-chip');
    expect(chip.textContent).toContain('0xabca');
    fireEvent.click(chip);
    expect(screen.getByText(/open my wallet/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('sign-out'));
    expect(circle.signOut).toHaveBeenCalled();
  });

  it('browser wallet connected: chip signs out via wagmi disconnect (no My Wallet link)', () => {
    account.address = '0x2b2b7f60644f4bc01bd15d38c36fcb2530efa27b';
    account.isConnected = true;
    render(<SignInButton />);
    fireEvent.click(screen.getByTestId('account-chip'));
    expect(screen.queryByText(/open my wallet/i)).toBeNull();
    fireEvent.click(screen.getByTestId('sign-out'));
    expect(disconnect).toHaveBeenCalled();
  });
});
