import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const ADDR = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca';
const RECIPIENT = '0x3333333333333333333333333333333333333333';

const circle = vi.hoisted(() => ({
  address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca',
  kind: 'google' as string | null,
  status: 'ready' as string,
  executeContract: vi.fn(),
  signOut: vi.fn(),
}));
const portfolio = vi.hoisted(() => ({
  balances: [
    { token: { symbol: 'cirBTC', address: '0xb70000000000000000000000000000000000000', decimals: 8 }, raw: 0n, amount: 0, priceUsd: 64000, usd: 0 },
    { token: { symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 }, raw: 5_000_000n, amount: 5, priceUsd: 1, usd: 5 },
    { token: { symbol: 'EURC', address: '0x89b50855aa3be2f677cd6303cec089b5f319d72a', decimals: 6 }, raw: 0n, amount: 0, priceUsd: 1.08, usd: 0 },
  ],
  totalUsd: 5,
  refetch: vi.fn(),
  isLoading: false,
  pricesReady: true,
}));

vi.mock('@/components/circle/CircleWalletProvider', () => ({ useCircleWallet: () => circle }));
vi.mock('@/hooks/useWalletPortfolio', () => ({ useWalletPortfolio: () => portfolio }));
vi.mock('@/hooks/useWalletTransactions', () => ({ useWalletTransactions: () => ({ data: [], isLoading: false }) }));
vi.mock('@/components/wallet/QrCode', () => ({ QrCode: () => <div data-testid="qr" /> }));
vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app', CHAIN_ID: 5042002 } }));

import { MyWallet } from '@/components/wallet/MyWallet';

beforeEach(() => {
  circle.executeContract.mockReset().mockResolvedValue({ challengeId: 'c' });
  circle.signOut.mockReset();
  portfolio.refetch.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});
afterEach(cleanup);

describe('MyWallet', () => {
  it('shows total USD, the three assets, and the address', () => {
    render(<MyWallet />);
    expect(screen.getAllByText('$5.00').length).toBeGreaterThan(0); // portfolio total + USDC row

    for (const sym of ['cirBTC', 'USDC', 'EURC']) {
      expect(screen.getAllByText(sym).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText(ADDR).length).toBeGreaterThan(0);
  });

  it('copies the address', () => {
    render(<MyWallet />);
    fireEvent.click(screen.getByTestId('copy-address'));
    expect((navigator.clipboard.writeText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(ADDR);
  });

  it('sends USDC via executeContract (transfer signature + atomic amount, gas buffer respected)', async () => {
    render(<MyWallet />);
    fireEvent.click(screen.getByTestId('open-send'));
    fireEvent.change(screen.getByTestId('send-recipient'), { target: { value: RECIPIENT } });
    fireEvent.change(screen.getByTestId('send-amount'), { target: { value: '1' } });
    const submit = screen.getByTestId('send-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(circle.executeContract).toHaveBeenCalled());
    expect(circle.executeContract).toHaveBeenCalledWith({
      contractAddress: '0x3600000000000000000000000000000000000000',
      abiFunctionSignature: 'transfer(address,uint256)',
      abiParameters: [RECIPIENT, '1000000'],
    });
  });

  it('signs out', () => {
    render(<MyWallet />);
    fireEvent.click(screen.getByTestId('wallet-signout'));
    expect(circle.signOut).toHaveBeenCalled();
  });
});
