import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { SOURCES } from '@/lib/cctp';

// Use a mutable ref so individual tests can control which chainId the mock returns.
let mockChainId = 5042002;
let mockIsConnected = true;
let mockPathname = '/';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: mockIsConnected }),
  useChainId: () => mockChainId,
  useSwitchChain: () => ({ switchChain: vi.fn(), isPending: false }),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/lib/env', () => ({
  ENV: { EXPLORER_URL: 'https://testnet.arcscan.app', CHAIN_ID: 5042002 },
}));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  GAS_FLOOR_WEI: 20_000_000_000n,
}));

afterEach(() => {
  cleanup();
  // Reset to Arc + connected + dashboard after each test.
  mockChainId = 5042002;
  mockIsConnected = true;
  mockPathname = '/';
});

// Lazy import so the wagmi mock is applied before the module resolves.
async function renderBanner() {
  const { WrongNetworkBanner } = await import('@/components/WrongNetworkBanner');
  return render(<WrongNetworkBanner />);
}

describe('WrongNetworkBanner', () => {
  // --- dashboard (non-bridge) route ---
  it('hides when on Arc Testnet on the dashboard (chainId=5042002)', async () => {
    mockChainId = 5042002;
    mockPathname = '/';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the alert for Base Sepolia on the dashboard (CCTP source chain but NOT /bridge)', async () => {
    const base = SOURCES.find((s) => s.key === 'baseSepolia')!;
    mockChainId = base.chainId; // 84532
    mockPathname = '/';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows the alert for Ethereum Sepolia on the dashboard (CCTP source chain but NOT /bridge)', async () => {
    const eth = SOURCES.find((s) => s.key === 'ethereumSepolia')!;
    mockChainId = eth.chainId; // 11155111
    mockPathname = '/';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows the alert for an unknown chain on the dashboard (chainId=1, Ethereum Mainnet)', async () => {
    mockChainId = 1;
    mockPathname = '/';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('shows the alert for another unknown chain on the dashboard (chainId=137, Polygon)', async () => {
    mockChainId = 137;
    mockPathname = '/';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('hides when the wallet is disconnected (even on an unknown chain)', async () => {
    mockChainId = 1;
    mockIsConnected = false;
    mockPathname = '/';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  // --- /bridge route ---
  it('hides when on Arc Testnet on /bridge', async () => {
    mockChainId = 5042002;
    mockPathname = '/bridge';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('hides when on Base Sepolia on /bridge (intentional CCTP source)', async () => {
    const base = SOURCES.find((s) => s.key === 'baseSepolia')!;
    mockChainId = base.chainId; // 84532
    mockPathname = '/bridge';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('hides when on Ethereum Sepolia on /bridge (intentional CCTP source)', async () => {
    const eth = SOURCES.find((s) => s.key === 'ethereumSepolia')!;
    mockChainId = eth.chainId; // 11155111
    mockPathname = '/bridge';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the alert on /bridge for an unknown chain not in the CCTP source list', async () => {
    mockChainId = 137; // Polygon — not a registered CCTP source
    mockPathname = '/bridge';
    const { container } = await renderBanner();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});
