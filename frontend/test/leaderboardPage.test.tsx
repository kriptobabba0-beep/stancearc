// leaderboardPage.test.tsx — the /leaderboard page: metric tabs re-rank (volume vs pnl),
// window chips switch datasets, the podium takes the top three, and the connected wallet
// gets its YOU badge + pinned standing. The API is mocked at fetch level.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const ME = '0x1111111111111111111111111111111111111111';
const WHALE = '0x2222222222222222222222222222222222222222';
const GRINDER = '0x3333333333333333333333333333333333333333';
// A REAL platform wallet (swapbot-usdc) so the badge path runs against the actual list.
const HOUSE_BOT = '0x32e149E1e7A514992c8DE27E859605eDad5E7f42';

vi.mock('@/lib/env', () => ({
  ENV: { EXPLORER_URL: 'https://testnet.arcscan.app' },
}));
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({ id: 'btc', label: 'cirBTC / USDC', quoteSymbol: 'USDC', feeArena: '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2' }),
}));
vi.mock('@/components/MarketSelector', () => ({
  MarketSelector: () => <div data-testid="market-selector" />,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ME }),
}));
vi.mock('@/hooks/useSessionAgent', () => ({
  recentSessionAddresses: () => [],
}));

const row = (address: string, volume: bigint, pnl: bigint, entered: number, won: number) => ({
  address,
  volumeUsd6: volume.toString(),
  swapUsd6: volume.toString(), // fixture: all volume as swaps
  liqUsd6: '0',
  feeUsd6: '0',
  pnlUsd6: pnl.toString(),
  claimedUsd6: (pnl > 0n ? pnl : 0n).toString(),
  claimedBase: '0',
  claimedQuote: '0',
  entered,
  won,
});

// WHALE: top volume, NEGATIVE pnl. GRINDER: modest volume, top pnl. ME: rank 3 by volume.
const API_BODY = {
  market: 'btc',
  arena: '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2',
  baseSymbol: 'cirBTC',
  quoteSymbol: 'USDC',
  head: '100',
  cursor: '101',
  syncing: false,
  progress: 100,
  updatedAt: 1,
  lastError: null,
  totals: { epochsSettled: 12, volumeUsd6: '99000000', redistributedUsd6: '55000000', participants: 4 },
  rows: [
    row(WHALE, 50_000_000n, -9_000_000n, 20, 4),
    row(GRINDER, 10_000_000n, 25_000_000n, 10, 8),
    row(ME, 5_000_000n, 1_000_000n, 3, 2),
    row(HOUSE_BOT, 1_000_000n, -500_000n, 2, 0),
  ],
  d30: [row(GRINDER, 10_000_000n, 25_000_000n, 10, 8)],
  d7: [],
};

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => API_BODY }) as unknown as Response);

import LeaderboardPage from '@/app/leaderboard/page';

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return render(<LeaderboardPage />, { wrapper });
}

describe('LeaderboardPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('ranks by volume by default: whale #1 on the podium, totals strip filled', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('0x2222…2222')).toBeTruthy());
    // Podium holds top-3 (#1..#3); the 4th address sits in the list below.
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getAllByText('#3').length).toBeGreaterThan(0);
    expect(screen.getByText('0x32e1…7f42')).toBeTruthy();
    // The house wallet is clearly labelled so nobody mistakes it for an organic user.
    expect(screen.getByText('Platform bot')).toBeTruthy();
    // Totals strip
    expect(screen.getByText('Participants')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    // Volume metric shown for the whale
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
  });

  it('badges the connected wallet and pins its standing (rank 3 by volume)', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('Your standing')).toBeTruthy());
    expect(screen.getAllByText('#3').length).toBeGreaterThanOrEqual(2); // podium chip + pinned standing
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
  });

  it('switching to Realized PnL re-ranks: grinder takes #1, whale shows a red negative', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('0x2222…2222')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Realized PnL' }));
    // Grinder (top pnl +$25.00) now leads the podium…
    const first = screen.getByText('#1').closest('div')!.parentElement!;
    expect(first.textContent).toContain('0x3333…3333');
    // …and the whale's negative PnL renders with the explicit minus.
    expect(screen.getAllByText('−$9.00').length).toBeGreaterThan(0);
  });

  it('window chips switch datasets (7d = empty state for this fixture)', async () => {
    mount();
    await waitFor(() => expect(screen.getByText('0x2222…2222')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: '30d' }));
    expect(screen.queryByText('0x2222…2222')).toBeNull(); // whale has no 30d activity
    expect(screen.getByText('0x3333…3333')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '7d' }));
    await waitFor(() => expect(screen.getByText(/No standings here yet/i)).toBeTruthy());
  });
});
