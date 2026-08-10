import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Mock the markets module so BOTH MarketProvider and MarketSelector see a 2-market list
// (the live MARKETS is built from ENV, which is a throwing Proxy in tests -> single placeholder).
// The factory is hoisted above imports, so the market list is defined INSIDE it.
vi.mock('@/lib/markets', () => {
  const MARKETS = [
    {
      id: 'eth', label: 'ETH / USDC', baseSymbol: 'WETH', baseDecimals: 18,
      feeArena: '0x1111111111111111111111111111111111111111',
      oracle: '0x2222222222222222222222222222222222222222',
      pool: '0x5555555555555555555555555555555555555555',
      feedId: `0x${'a'.repeat(64)}`,
    },
    {
      id: 'btc', label: 'BTC / USDC', baseSymbol: 'WBTC', baseDecimals: 8,
      feeArena: '0xaaaa111111111111111111111111111111111111',
      oracle: '0xbbbb222222222222222222222222222222222222',
      pool: '0xcccc555555555555555555555555555555555555',
      feedId: `0x${'b'.repeat(64)}`,
    },
  ];
  return {
    MARKETS,
    DEFAULT_MARKET_ID: 'eth',
    marketById: (id: string) => MARKETS.find((m) => m.id === id) ?? MARKETS[0],
  };
});

import { MarketProvider, useActiveMarket } from '@/components/MarketProvider';
import { MarketSelector } from '@/components/MarketSelector';

/** Probe that surfaces the active market id so we can assert the context switched. */
function ActiveProbe() {
  const market = useActiveMarket();
  return <div data-testid="active-market">{market.id}</div>;
}

function renderSelector() {
  return render(
    <MarketProvider>
      <MarketSelector />
      <ActiveProbe />
    </MarketProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(cleanup);

describe('MarketSelector', () => {
  it('renders a tab per market and highlights the default (eth)', () => {
    renderSelector();
    expect(screen.getByTestId('market-selector')).toBeTruthy();
    expect(screen.getByTestId('market-tab-eth')).toBeTruthy();
    expect(screen.getByTestId('market-tab-btc')).toBeTruthy();
    expect(screen.getByText('ETH / USDC')).toBeTruthy();
    expect(screen.getByText('BTC / USDC')).toBeTruthy();
    expect(screen.getByTestId('market-tab-eth').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('market-tab-btc').getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('active-market').textContent).toBe('eth');
  });

  it('switching tabs updates the active market context + persists to localStorage', () => {
    renderSelector();
    fireEvent.click(screen.getByTestId('market-tab-btc'));

    expect(screen.getByTestId('active-market').textContent).toBe('btc');
    expect(screen.getByTestId('market-tab-btc').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('market-tab-eth').getAttribute('aria-selected')).toBe('false');
    expect(window.localStorage.getItem('feearena.marketId')).toBe('btc');
  });
});
