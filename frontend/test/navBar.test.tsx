import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import { NavBar } from '@/components/NavBar';

// Reconfigurable holders so individual tests can flip connection / owner state / route.
const accountMock = vi.fn();
const readContractMock = vi.fn();
const pathnameMock = vi.fn<() => string>();

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock('wagmi', () => ({
  useAccount: () => accountMock(),
  // <Connect/> (rendered inside NavBar) calls these — give it benign connected-wallet defaults.
  useConnect: () => ({ connect: vi.fn(), connectors: [{ uid: 'injected' }], isPending: false, error: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useBalance: () => ({ data: { formatted: '12.5', symbol: 'USDC', decimals: 18, value: 0n } }),
  useReadContract: () => readContractMock(),
}));

vi.mock('@/lib/env', () => ({
  ENV: { EXPLORER_URL: 'https://testnet.arcscan.app', CHAIN_ID: 5042002 },
}));
vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  GAS_FLOOR_WEI: 20_000_000_000n,
}));

// The wallet control is the single <SignInButton/> (needs the AuthModal + wallet contexts) — stub it;
// its behavior is covered by signInButton.test.tsx.
vi.mock('@/components/auth/SignInButton', () => ({
  SignInButton: () => <div data-testid="sign-in-stub" />,
}));

// Single-market config so MarketSelector renders nothing (no selector noise) and useIsOwner has a target.
vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => ({
    feeArena: { address: '0xfee0000000000000000000000000000000000000', abi: [] },
    oracle: { address: '0x0', abi: [] },
    pool: { address: '0x0', abi: [] },
  }),
}));

const OWNER = '0x1111111111111111111111111111111111111111';
const NOT_OWNER = '0x2222222222222222222222222222222222222222';

function withInjectedProvider() {
  (window as unknown as { ethereum?: unknown }).ethereum = {};
}
function withoutInjectedProvider() {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
}

beforeEach(() => {
  vi.clearAllMocks();
  pathnameMock.mockReturnValue('/');
  accountMock.mockReturnValue({ address: OWNER, isConnected: true });
  // Default: owner() resolves to a DIFFERENT address (connected user is NOT the owner).
  readContractMock.mockReturnValue({ data: NOT_OWNER, isLoading: false });
  withInjectedProvider();
});
afterEach(() => {
  cleanup();
  withoutInjectedProvider();
});

describe('NavBar — primary links + active state', () => {
  it('renders the four primary links (Stance · Swap · Pools · Bridge)', () => {
    render(<NavBar />);
    act(() => {});
    for (const label of ['Stance', 'Swap', 'Pools', 'Bridge']) {
      expect(screen.getAllByRole('link', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('does not render a Portfolio link (page removed)', () => {
    render(<NavBar />);
    act(() => {});
    expect(screen.queryByRole('link', { name: 'Portfolio' })).toBeNull();
  });

  it('always shows the Feedback button (new tab to the form), connected or not', () => {
    const assertFeedback = () => {
      const fb = screen.getByRole('link', { name: /send feedback/i });
      expect(fb.getAttribute('href')).toBe('https://forms.gle/tQh2nCa98GMRFGjXA');
      expect(fb.getAttribute('target')).toBe('_blank');
      expect(fb.getAttribute('rel')).toContain('noreferrer');
    };
    render(<NavBar />);
    act(() => {});
    assertFeedback(); // connected wallet
    cleanup();
    accountMock.mockReturnValue({ address: undefined, isConnected: false });
    render(<NavBar />);
    act(() => {});
    assertFeedback(); // no wallet — same spot, still there
  });

  it('marks Swap active on "/swap" (aria-current=page + data-active=true)', () => {
    pathnameMock.mockReturnValue('/swap');
    render(<NavBar />);
    act(() => {});
    const swap = screen.getByRole('link', { name: 'Swap', current: 'page' });
    expect(swap.getAttribute('data-active')).toBe('true');
    // Other links are NOT active on "/swap".
    const pools = screen.getByRole('link', { name: 'Pools' });
    expect(pools.getAttribute('data-active')).toBe('false');
    expect(pools.getAttribute('aria-current')).toBeNull();
  });

  it('marks Stance active on "/stance" and Swap inactive', () => {
    pathnameMock.mockReturnValue('/stance');
    render(<NavBar />);
    act(() => {});
    const arena = screen.getByRole('link', { name: 'Stance', current: 'page' });
    expect(arena.getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('link', { name: 'Swap' }).getAttribute('data-active')).toBe('false');
  });

  it('keeps Pools active on a nested route like "/pool/x"', () => {
    pathnameMock.mockReturnValue('/pool/x');
    render(<NavBar />);
    act(() => {});
    expect(screen.getByRole('link', { name: 'Pools' }).getAttribute('data-active')).toBe('true');
  });
});

describe('NavBar — overflow menu (secondary links) + Admin gating', () => {
  it('hides the overflow menu contents until opened', () => {
    render(<NavBar />);
    act(() => {});
    expect(screen.queryByRole('menu', { name: /more links/i })).toBeNull();
  });

  it('opens the "···" overflow and exposes About + Faucet + ArcScan (folded into the menu)', () => {
    render(<NavBar />);
    act(() => {});
    // Faucet + ArcScan are no longer always-visible top-level buttons — they live in the overflow now
    // (the top bar is decluttered to the terminal nav + wallet + the "···" menu).
    expect(screen.queryByRole('link', { name: /faucet/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /arcscan/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more links/i }));
    act(() => {});
    const menu = screen.getByRole('menu', { name: /more links/i });
    expect(within(menu).getByRole('link', { name: /about/i })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: /faucet/i })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: /arcscan/i })).toBeTruthy();
    expect(within(menu).queryByRole('link', { name: /bridge/i })).toBeNull();
  });

  it('does NOT show the Admin link to a non-owner', () => {
    accountMock.mockReturnValue({ address: NOT_OWNER, isConnected: true });
    readContractMock.mockReturnValue({ data: OWNER, isLoading: false });
    render(<NavBar />);
    act(() => {});
    fireEvent.click(screen.getByRole('button', { name: /more links/i }));
    act(() => {});
    expect(screen.queryByRole('link', { name: /admin/i })).toBeNull();
  });

  it('shows the Admin link to the on-chain owner', () => {
    accountMock.mockReturnValue({ address: OWNER, isConnected: true });
    readContractMock.mockReturnValue({ data: OWNER, isLoading: false });
    render(<NavBar />);
    act(() => {});
    fireEvent.click(screen.getByRole('button', { name: /more links/i }));
    act(() => {});
    expect(screen.getAllByRole('link', { name: /admin/i }).length).toBeGreaterThan(0);
  });
});

describe('NavBar — mobile nav disclosure', () => {
  it('renders a hamburger toggle with aria-expanded/aria-controls, collapsed by default', () => {
    render(<NavBar />);
    act(() => {});
    const toggle = screen.getByRole('button', { name: /toggle navigation menu/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the panel on click and exposes the primary links + Bridge + Faucet inside it', () => {
    render(<NavBar />);
    act(() => {});
    const toggle = screen.getByRole('button', { name: /toggle navigation menu/i });
    fireEvent.click(toggle);
    act(() => {});
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByRole('link', { name: 'Swap' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Stance' })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: /bridge/i })).toBeTruthy();
    expect(within(panel).getByRole('link', { name: /faucet/i })).toBeTruthy();
  });

  it('closes the panel on Escape', () => {
    render(<NavBar />);
    act(() => {});
    const toggle = screen.getByRole('button', { name: /toggle navigation menu/i });
    fireEvent.click(toggle);
    act(() => {});
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => {});
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the owner-only Admin link inside the mobile panel for the owner', () => {
    accountMock.mockReturnValue({ address: OWNER, isConnected: true });
    readContractMock.mockReturnValue({ data: OWNER, isLoading: false });
    render(<NavBar />);
    act(() => {});
    fireEvent.click(screen.getByRole('button', { name: /toggle navigation menu/i }));
    act(() => {});
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByRole('link', { name: /admin/i })).toBeTruthy();
  });
});

describe('NavBar — wallet', () => {
  it('renders no theme toggle (the app is dark-only)', () => {
    render(<NavBar />);
    act(() => {});
    expect(screen.queryByRole('button', { name: /theme|switch to (light|dark)/i })).toBeNull();
  });

  it('renders the single sign-in wallet control', () => {
    render(<NavBar />);
    act(() => {});
    expect(screen.getByTestId('sign-in-stub')).toBeTruthy();
  });
});
