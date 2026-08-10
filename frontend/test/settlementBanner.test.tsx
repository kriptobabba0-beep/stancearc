import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from './utils/renderWithProviders';
import {
  makeEpochView,
  makeSettledEpochView,
  makeStakeView,
  makeClaimPreview,
  TEST_USER,
} from './utils/fixtures';
import { PhaseView, Side } from '@/lib/types';

const claim = vi.fn();

vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: vi.fn() }));
vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: vi.fn() }));
vi.mock('@/hooks/usePreviewClaim', () => ({ usePreviewClaim: vi.fn() }));
vi.mock('@/hooks/useOraclePrice', () => ({ useOraclePrice: vi.fn() }));
vi.mock('@/hooks/useClaim', () => ({ useClaim: () => ({ claim, isPending: false }) }));
// Pin the active market to the cirBTC market (8dp base) so payout USD math is deterministic.
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
// ShareWinButton imports lib/toast (sonner); stub it so the banner mounts without the toast runtime.
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('wagmi', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, useAccount: () => ({ address: TEST_USER, isConnected: true }) };
});

import { SettlementBanner } from '@/components/SettlementBanner';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useUserStakes } from '@/hooks/useUserStakes';
import { usePreviewClaim } from '@/hooks/usePreviewClaim';
import { useOraclePrice } from '@/hooks/useOraclePrice';

const mockedEpoch = vi.mocked(useCurrentEpoch);
const mockedStakes = vi.mocked(useUserStakes);
const mockedPreview = vi.mocked(usePreviewClaim);
const mockedOracle = vi.mocked(useOraclePrice);

// $100k oracle price (18dp) — values the base leg of a payout.
const PRICE_100K = 100_000n * 10n ** 18n;

const stake = makeStakeView({ side: Side.DOWN, epochId: 1n, tokenId: 101n });

beforeEach(() => {
  vi.clearAllMocks();
  claim.mockReset();
  mockedStakes.mockReturnValue({ data: [stake], isLoading: false } as ReturnType<typeof useUserStakes>);
  mockedOracle.mockReturnValue({ data: { price18: PRICE_100K, updatedAt: 0n } } as ReturnType<typeof useOraclePrice>);
});

describe('SettlementBanner — the win moment', () => {
  it('renders nothing while the epoch is still Running', () => {
    mockedEpoch.mockReturnValue({
      data: makeEpochView({ phase: PhaseView.Running, epochId: 1n }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);
    mockedPreview.mockReturnValue({
      data: makeClaimPreview({ claimable: false }),
      isLoading: false,
    } as ReturnType<typeof usePreviewClaim>);

    renderWithProviders(<SettlementBanner />);
    expect(screen.queryByTestId('settlement-banner')).not.toBeInTheDocument();
  });

  it('shows the win banner with the USD payout + Claim CTA when settled & claimable', async () => {
    mockedEpoch.mockReturnValue({
      data: makeSettledEpochView({ epochId: 1n, winningSide: Side.DOWN }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);
    // Winner: 0.01 cirBTC (8dp) + $250 USDC → 0.01 * 100k = $1000 + $250 = $1,250.
    mockedPreview.mockReturnValue({
      data: makeClaimPreview({
        claimable: true,
        isWinner: true,
        payWETH: 1_000_000n, // 0.01 at 8dp
        payUSDC: 250n * 10n ** 6n, // $250
        contribution6: 5_000_000_000n,
        winnerDenominator: 8_000_000_000n,
      }),
      isLoading: false,
    } as ReturnType<typeof usePreviewClaim>);

    renderWithProviders(<SettlementBanner />);

    const banner = await screen.findByTestId('settlement-banner');
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/DOWN won/)).toBeInTheDocument();
    // ~$1,250 (base leg valued at oracle price + USDC leg).
    expect(screen.getByTestId('banner-amount').textContent).toContain('$1,250');
  });

  it('clicking Claim fires claim() for the winning position', async () => {
    mockedEpoch.mockReturnValue({
      data: makeSettledEpochView({ epochId: 1n, winningSide: Side.DOWN }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);
    mockedPreview.mockReturnValue({
      data: makeClaimPreview({ claimable: true, isWinner: true, payWETH: 0n, payUSDC: 500n * 10n ** 6n }),
      isLoading: false,
    } as ReturnType<typeof usePreviewClaim>);

    renderWithProviders(<SettlementBanner />);
    const btn = await screen.findByTestId('banner-claim');
    fireEvent.click(btn);
    await waitFor(() => expect(claim).toHaveBeenCalledWith({ epochId: 1n, tokenId: 101n }));
  });

  it('does NOT show the banner for a settled epoch the user did NOT win', async () => {
    mockedEpoch.mockReturnValue({
      data: makeSettledEpochView({ epochId: 1n, winningSide: Side.UP }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);
    // Not claimable (wrong side / nothing to claim).
    mockedPreview.mockReturnValue({
      data: makeClaimPreview({ claimable: false, isWinner: false }),
      isLoading: false,
    } as ReturnType<typeof usePreviewClaim>);

    renderWithProviders(<SettlementBanner />);
    // Give the probe effect a tick; the banner must stay absent.
    await waitFor(() => {
      expect(screen.queryByTestId('settlement-banner')).not.toBeInTheDocument();
    });
  });
});
