import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// PoolTable: rows for every registry pool, SORTED BY LIQUIDITY (TVL) desc, each a link to /pool/[id];
// the `query` prop filters the rows. We mock ENV (so the real pools/tokens registries build) and
// usePoolStats (the data). PoolTable has no Create modal / router dependency — that lives in PoolBrowser.

vi.mock('@/lib/env', () => ({
  ENV: {
    FEE_TIER: 3000,
    POOL_ADDRESS: '0x00000000000000000000000000000000000000aa',
    WETH_ADDRESS: '0x00000000000000000000000000000000000000bb',
    USDC_ADDRESS: '0x0000000000000000000000000000000000000002',
    EURC_ADDRESS: '0x0000000000000000000000000000000000000003',
  },
}));

const row = (poolId: string, tvlUsd: number) => ({
  poolId,
  tvlUsd,
  volume24Usd: tvlUsd * 2,
  fees24Usd: tvlUsd * 0.006,
  aprPct: 12.5,
});

vi.mock('@/hooks/usePoolStats', () => ({
  usePoolStats: () => ({
    rows: {
      'cirbtc-usdc': row('cirbtc-usdc', 100),
      'eurc-usdc': row('eurc-usdc', 300),
      'cirbtc-eurc': row('cirbtc-eurc', 50),
    },
    isLoadingFlow: false,
  }),
}));

import { PoolTable } from '@/components/pool/PoolTable';

afterEach(() => cleanup());

describe('PoolTable', () => {
  it('lists pools sorted by liquidity (TVL) descending', () => {
    const { container } = render(<PoolTable query="" />);
    const ids = Array.from(container.querySelectorAll('[data-testid^="pool-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(ids).toEqual(['pool-row-eurc-usdc', 'pool-row-cirbtc-usdc', 'pool-row-cirbtc-eurc']);
  });

  it('rows link to the pool deposit page', () => {
    render(<PoolTable query="" />);
    expect(screen.getByTestId('pool-row-eurc-usdc')).toHaveAttribute('href', '/pool/eurc-usdc');
  });

  it('filters rows by the query', () => {
    render(<PoolTable query="eurc" />);
    expect(screen.getByTestId('pool-row-eurc-usdc')).toBeTruthy();
    expect(screen.getByTestId('pool-row-cirbtc-eurc')).toBeTruthy();
    expect(screen.queryByTestId('pool-row-cirbtc-usdc')).toBeNull();
  });

  it('shows an empty state when nothing matches', () => {
    render(<PoolTable query="zzz" />);
    expect(screen.getByTestId('pool-empty')).toBeTruthy();
  });
});
