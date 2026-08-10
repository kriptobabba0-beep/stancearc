import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const circle = vi.hoisted(() => ({ isReady: false, address: null as string | null }));
const account = vi.hoisted(() => ({ isConnected: false, address: null as string | null }));
const openModal = vi.hoisted(() => vi.fn());

vi.mock('@/components/circle/CircleWalletProvider', () => ({ useCircleWallet: () => circle }));
vi.mock('wagmi', () => ({ useAccount: () => account }));
vi.mock('@/components/auth/AuthModalProvider', () => ({ useAuthModal: () => ({ open: openModal, close: vi.fn(), isOpen: false }) }));
vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app' } }));
vi.mock('@/components/wallet/MyWallet', () => ({ MyWallet: () => <div data-testid="my-wallet" /> }));

import { WalletExperience } from '@/components/wallet/WalletExperience';

beforeEach(() => {
  circle.isReady = false;
  circle.address = null;
  account.isConnected = false;
  account.address = null;
  openModal.mockReset();
});
afterEach(cleanup);

describe('WalletExperience', () => {
  it('signed out: shows the sign-in prompt and opens the modal', () => {
    render(<WalletExperience />);
    const btn = screen.getByTestId('prompt-signin');
    fireEvent.click(btn);
    expect(openModal).toHaveBeenCalled();
  });

  it('embedded ready: renders the full MyWallet', () => {
    circle.isReady = true;
    circle.address = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
    render(<WalletExperience />);
    expect(screen.getByTestId('my-wallet')).toBeTruthy();
  });

  it('browser wallet connected (no embedded): shows the wallet notice', () => {
    account.isConnected = true;
    account.address = '0x2b2b7f60644f4bc01bd15d38c36fcb2530efa27b';
    render(<WalletExperience />);
    // No connector name in the mock → the honest generic heading.
    expect(screen.getByText(/connected with a browser wallet/i)).toBeTruthy();
    expect(screen.queryByTestId('my-wallet')).toBeNull();
  });
});
