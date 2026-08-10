import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { UserRejectedRequestError } from 'viem';
import { Connect } from '@/components/Connect';
import { WrongNetworkBanner } from '@/components/WrongNetworkBanner';

// Reconfigurable holders so individual tests can flip connection / connector / error state.
const accountMock = vi.fn();
const connectMock = vi.fn();

vi.mock('wagmi', () => ({
  useAccount: () => accountMock(),
  useConnect: () => connectMock(),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
  useBalance: () => ({ data: { formatted: '12.5', symbol: 'USDC', decimals: 18, value: 12_500000000000000000n } }),
  // useIsOwner() (Admin gating) reads owner() via useReadContract — default to a non-owner.
  useReadContract: () => ({ data: '0x9999999999999999999999999999999999999999', isLoading: false }),
}));

// Mock ENV to avoid NEXT_PUBLIC_* errors in test
vi.mock('@/lib/env', () => ({
  ENV: {
    EXPLORER_URL: 'https://testnet.arcscan.app',
    CHAIN_ID: 5042002,
  },
}));

// Mock chain to avoid env access
vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  GAS_FLOOR_WEI: 20_000_000_000n,
}));

/** Pretend an injected provider exists (so the no-wallet branch is NOT taken). */
function withInjectedProvider() {
  (window as unknown as { ethereum?: unknown }).ethereum = {};
}
function withoutInjectedProvider() {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a present connector + an injected provider available.
  connectMock.mockReturnValue({
    connect: vi.fn(),
    connectors: [{ uid: 'injected' }],
    isPending: false,
    error: undefined,
  });
  accountMock.mockReturnValue({
    address: '0x1111111111111111111111111111111111111111',
    isConnected: true,
  });
  withInjectedProvider();
});
afterEach(() => {
  cleanup();
  withoutInjectedProvider();
});

describe('Connect', () => {
  it('shows the connected wallet chip (short address, click to disconnect); Faucet/ArcScan/gas live elsewhere now', () => {
    render(<Connect />);
    // Connected state is a single chip button — its accessible name carries the short address + disconnect.
    const chip = screen.getByRole('button', { name: /disconnect/i });
    expect(chip.textContent).toMatch(/0x1111/i);
    // Faucet + ArcScan moved to the NavBar; the gas balance was removed entirely.
    expect(screen.queryByRole('link', { name: /faucet/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /arcscan/i })).toBeNull();
    expect(screen.queryByTestId('gas-balance')).toBeNull();
  });

  it('hides WrongNetworkBanner when on Arc Testnet', () => {
    accountMock.mockReturnValue({ isConnected: true });
    const { container } = render(<WrongNetworkBanner />);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a friendly inline error when connect() fails (and is disconnected)', () => {
    accountMock.mockReturnValue({ address: undefined, isConnected: false });
    connectMock.mockReturnValue({
      connect: vi.fn(),
      connectors: [{ uid: 'injected' }],
      isPending: false,
      error: new UserRejectedRequestError(new Error('rejected')),
    });
    render(<Connect />);
    const err = screen.getByTestId('connect-error');
    expect(err).toBeTruthy();
    expect(err.textContent).toMatch(/rejected in wallet/i);
  });

  // Fix 3: mounted-gate — the no-wallet branch must only appear AFTER mount (window read).
  // Before mount (SSR + initial client render) Connect must render the Connect button, not
  // "Install a wallet", so server and client agree → no hydration mismatch.
  it('renders Connect button (not no-wallet) when window.ethereum is present after mount', () => {
    accountMock.mockReturnValue({ address: undefined, isConnected: false });
    withInjectedProvider();
    render(<Connect />);
    // After mount useEffect runs synchronously in jsdom — the Connect button should be visible.
    expect(screen.queryByText(/connect wallet/i)).toBeTruthy();
    expect(screen.queryByText(/install a wallet/i)).toBeNull();
  });

  // Fix 3: after mount, if no injected provider exists, show the no-wallet CTA. The copy is
  // wallet-agnostic (any EVM extension); the link still points at MetaMask as the default pick.
  it('shows the no-wallet message + install link when no injected provider is present after mount', () => {
    accountMock.mockReturnValue({ address: undefined, isConnected: false });
    withoutInjectedProvider();
    render(<Connect />);
    // useEffect fires synchronously in jsdom; re-render via act to flush state.
    act(() => {});
    const el = screen.getByTestId('connect-error');
    expect(el.textContent).toMatch(/install a wallet/i);
    expect(el.getAttribute('href')).toContain('metamask.io');
  });

  // Fix 6: the install label (shortened) must fit without overflow.
  it('no-wallet CTA uses the short "Install a wallet" label (fits at 375px)', () => {
    accountMock.mockReturnValue({ address: undefined, isConnected: false });
    withoutInjectedProvider();
    render(<Connect />);
    act(() => {});
    const el = screen.getByTestId('connect-error');
    // Label must not contain the long form.
    expect(el.textContent).not.toMatch(/no wallet detected/i);
    // Must contain the short, wallet-agnostic form.
    expect(el.textContent).toMatch(/install a wallet/i);
  });
});
