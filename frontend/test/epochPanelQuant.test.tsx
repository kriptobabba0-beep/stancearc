import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './utils/renderWithProviders';
import { makeEpochView } from './utils/fixtures';
import { PhaseView } from '@/lib/types';

vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: vi.fn() }));
vi.mock('@/hooks/useOraclePrice', () => ({ useOraclePrice: vi.fn() }));
// Countdown uses usePublicClient (needs a WagmiProvider) — stub it; we're testing the quant additions.
vi.mock('@/components/Countdown', () => ({ Countdown: () => <span>00:00:00</span> }));
// Pin the active market to the cirBTC market (8dp base) so pot USD math is deterministic.
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({
    id: 'cirbtc',
    label: 'cirBTC / USDC',
    baseSymbol: 'cirBTC',
    baseDecimals: 8,
    feeArena: '0x0000000000000000000000000000000000000000',
    oracle: '0x0000000000000000000000000000000000000000',
    pool: '0x0000000000000000000000000000000000000000',
    feedId: `0x${'0'.repeat(64)}`,
    fromBlock: 0n,
  }),
}));

import { EpochPanel } from '@/components/EpochPanel';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';

const mockedEpoch = vi.mocked(useCurrentEpoch);
const mockedOracle = vi.mocked(useOraclePrice);

const PRICE_100K = 100_000n * 10n ** 18n;

beforeEach(() => {
  vi.clearAllMocks();
  mockedOracle.mockReturnValue({ data: { price18: PRICE_100K, updatedAt: 0n } } as ReturnType<typeof useOraclePrice>);
});

describe('EpochPanel — quantified game', () => {
  it('shows the pot USD value (pot tokens × oracle price) and the implied move from the band', () => {
    mockedEpoch.mockReturnValue({
      data: makeEpochView({
        phase: PhaseView.EntryOpen,
        epochId: 5n,
        bandBps: 20, // 0.20% implied move
        potWETH: 1_000_000n, // 0.01 cirBTC at 8dp → $1,000 at $100k
        potUSDC: 250n * 10n ** 6n, // $250 USDC
      }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);

    renderWithProviders(<EpochPanel />);

    // Pot at stake: $1,000 (base) + $250 (USDC) = $1,250.
    expect(screen.getByTestId('pot-usd').textContent).toContain('$1,250');
    // Implied move: a 20-bps band reads as >0.20% for UP/DOWN.
    expect(screen.getByTestId('implied-move').textContent).toMatch(/0\.20%/);
    expect(screen.getByTestId('implied-move').textContent).toMatch(/UP\/DOWN; else RANGE/);
  });

  it('with the oracle unread (price 0) the pot USD falls back to the USDC leg only', () => {
    mockedOracle.mockReturnValue({ data: undefined } as ReturnType<typeof useOraclePrice>);
    mockedEpoch.mockReturnValue({
      data: makeEpochView({
        phase: PhaseView.EntryOpen,
        epochId: 6n,
        potWETH: 5_00000000n, // 5 cirBTC — but no price, so excluded
        potUSDC: 42n * 10n ** 6n, // $42 USDC
      }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);

    renderWithProviders(<EpochPanel />);
    expect(screen.getByTestId('pot-usd').textContent).toContain('$42');
  });
});
