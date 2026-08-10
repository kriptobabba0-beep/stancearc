import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BridgeUSDC } from '@/components/BridgeUSDC';

// Disconnected wallet: the panel must still render (the dashboard e2e boots without a source wallet).
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));

// wagmiConfig pulls in ENV via lib/chain; stub the actions + config so import is side-effect free.
vi.mock('wagmi/actions', () => ({ waitForTransactionReceipt: vi.fn() }));
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  GAS_FLOOR_WEI: 20_000_000_000n,
}));

afterEach(cleanup);

describe('BridgeUSDC', () => {
  it('renders the bridge panel without a connected wallet', () => {
    render(<BridgeUSDC />);
    expect(screen.getByTestId('bridge-usdc')).toBeInTheDocument();
    expect(screen.getByTestId('bridge-source')).toBeInTheDocument();
    expect(screen.getByTestId('bridge-amount')).toBeInTheDocument();
  });

  it('shows a connect prompt and disables the burn step when disconnected', () => {
    render(<BridgeUSDC />);
    expect(screen.getByText(/connect a wallet to bridge/i)).toBeInTheDocument();
    expect(screen.getByTestId('bridge-burn')).toBeDisabled();
    expect(screen.getByTestId('bridge-mint')).toBeDisabled();
  });

  it('offers both source chains in the selector', () => {
    render(<BridgeUSDC />);
    expect(screen.getByRole('option', { name: 'Base Sepolia' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ethereum Sepolia' })).toBeInTheDocument();
  });
});
