import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// MyPositions (the "My Positions" tab panel): five render branches — disconnected, loading, no-positions
// (with the Add Liquidity → onCreate button), query-no-match, and the connected-with-positions path that
// filters by pair and renders a YourLiquidity per pool. We mock ENV (so the real lib/pools builds), the
// per-pool useOwnedPositions, useAccount, and stub Connect + YourLiquidity to keep the wagmi graph out.

vi.mock('@/lib/env', () => ({
  ENV: {
    FEE_TIER: 3000,
    POOL_ADDRESS: '0x00000000000000000000000000000000000000aa',
    WETH_ADDRESS: '0x00000000000000000000000000000000000000bb',
    USDC_ADDRESS: '0x0000000000000000000000000000000000000002',
    EURC_ADDRESS: '0x0000000000000000000000000000000000000003',
  },
}));

// Reconfigurable connection + per-pool positions (holder pattern; the vi.mock factories close over these).
const accountState = { current: { isConnected: true } as { isConnected: boolean; address?: string } };
type PosResult = { data: Array<{ tokenId: bigint }>; isLoading: boolean };
const POS: Record<string, PosResult> = {
  'cirbtc-usdc': { data: [], isLoading: false },
  'eurc-usdc': { data: [], isLoading: false },
  'cirbtc-eurc': { data: [], isLoading: false },
};

vi.mock('wagmi', () => ({ useAccount: () => accountState.current }));
vi.mock('@/components/Connect', () => ({ Connect: () => <div data-testid="connect-stub" /> }));
vi.mock('@/components/YourLiquidity', () => ({
  YourLiquidity: ({ pool }: { pool: { id: string } }) => <div data-testid={`yl-${pool.id}`} />,
}));
vi.mock('@/hooks/useOwnedPositions', () => ({
  useOwnedPositions: ({ pool }: { pool: { id: string } }) => POS[pool.id] ?? { data: [], isLoading: false },
}));

import { MyPositions } from '@/components/pool/MyPositions';

function reset() {
  accountState.current = { isConnected: true, address: '0x1111111111111111111111111111111111111111' };
  POS['cirbtc-usdc'] = { data: [], isLoading: false };
  POS['eurc-usdc'] = { data: [], isLoading: false };
  POS['cirbtc-eurc'] = { data: [], isLoading: false };
}
beforeEach(reset);
afterEach(() => cleanup());

describe('MyPositions', () => {
  it('shows the connect state when disconnected (no position groups)', () => {
    accountState.current = { isConnected: false };
    render(<MyPositions />);
    expect(screen.getByTestId('connect-stub')).toBeTruthy();
    expect(screen.queryByTestId('yl-cirbtc-usdc')).toBeNull();
    expect(screen.queryByTestId('my-positions-create')).toBeNull();
  });

  it('shows the loading skeleton while a pool is loading and none have data', () => {
    POS['cirbtc-usdc'] = { data: [], isLoading: true };
    render(<MyPositions />);
    expect(screen.getByTestId('my-positions-loading')).toBeTruthy();
  });

  it('shows the empty state with an Add Liquidity button that calls onCreate', () => {
    const onCreate = vi.fn();
    render(<MyPositions onCreate={onCreate} />);
    expect(screen.getByText(/no active positions/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('my-positions-create'));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('renders a YourLiquidity group only for pools that hold positions', () => {
    POS['cirbtc-usdc'] = { data: [{ tokenId: 1n }], isLoading: false };
    POS['cirbtc-eurc'] = { data: [{ tokenId: 2n }], isLoading: false };
    render(<MyPositions />);
    expect(screen.getByTestId('yl-cirbtc-usdc')).toBeTruthy();
    expect(screen.getByTestId('yl-cirbtc-eurc')).toBeTruthy();
    expect(screen.queryByTestId('yl-eurc-usdc')).toBeNull(); // no positions there
  });

  it('filters position groups by the query (and shows a no-match state)', () => {
    POS['cirbtc-usdc'] = { data: [{ tokenId: 1n }], isLoading: false };
    POS['cirbtc-eurc'] = { data: [{ tokenId: 2n }], isLoading: false };

    // "eurc" matches "cirBTC / EURC" only.
    const { rerender } = render(<MyPositions query="eurc" />);
    expect(screen.getByTestId('yl-cirbtc-eurc')).toBeTruthy();
    expect(screen.queryByTestId('yl-cirbtc-usdc')).toBeNull();

    // A query matching no held pair shows the no-match state (NOT the empty/Add-Liquidity state).
    rerender(<MyPositions query="zzz" />);
    expect(screen.getByTestId('my-positions-no-match')).toBeTruthy();
    expect(screen.queryByTestId('my-positions-create')).toBeNull();
  });
});
