import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import {
  makeEpochView,
  makeSettledEpochView,
  makeStakeView,
  makeClaimPreview,
  TEST_USER,
} from '../utils/fixtures';
import { PhaseView, Side } from '@/lib/types';

vi.mock('@/hooks/useCurrentEpoch', () => ({
  useCurrentEpoch: vi.fn(),
}));
vi.mock('@/hooks/useUserStakes', () => ({
  useUserStakes: vi.fn(),
}));
vi.mock('@/hooks/usePreviewClaim', () => ({
  usePreviewClaim: vi.fn(),
}));
vi.mock('@/hooks/useDecimals', () => ({
  useDecimals: () => ({ usdc: 6, weth: 18, price: 18 }),
}));
vi.mock('wagmi', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, useAccount: () => ({ address: TEST_USER, isConnected: true }) };
});

import { LiveStatus } from '@/components/LiveStatus';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useUserStakes } from '@/hooks/useUserStakes';
import { usePreviewClaim } from '@/hooks/usePreviewClaim';

const mockedUseCurrentEpoch = vi.mocked(useCurrentEpoch);
const mockedUseUserStakes = vi.mocked(useUserStakes);
const mockedUsePreviewClaim = vi.mocked(usePreviewClaim);

const stake = makeStakeView({ side: Side.UP, epochId: 1n });

describe('LiveStatus projection visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedUseUserStakes.mockReturnValue({ data: [stake], isLoading: false } as ReturnType<typeof useUserStakes>);
    // Default previewClaim is inert.
    mockedUsePreviewClaim.mockReturnValue({ data: makeClaimPreview({ claimable: false }), isLoading: false } as ReturnType<typeof usePreviewClaim>);
  });

  it('shows per-side contribution bars but NO winner/payout projection while Running', () => {
    mockedUseCurrentEpoch.mockReturnValue({
      data: makeEpochView({ phase: PhaseView.Running, epochId: 1n }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);

    renderWithProviders(<LiveStatus />);

    // Pre-settlement shows "Outcome pending settlement" (not a realized payout).
    expect(screen.getByText(/Outcome pending settlement/)).toBeInTheDocument();
    // Winner/share/payout projection is HIDDEN pre-settlement (approved decision #5).
    expect(screen.queryByText(/winning side/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/projected payout/i)).not.toBeInTheDocument();
    // The realized testid should NOT exist pre-settlement.
    expect(screen.queryByTestId(`realized-${stake.tokenId.toString()}`)).not.toBeInTheDocument();
  });

  it('shows realized payout from previewClaim once Settled', () => {
    mockedUseCurrentEpoch.mockReturnValue({
      data: makeSettledEpochView({ epochId: 1n }),
      isLoading: false,
    } as ReturnType<typeof useCurrentEpoch>);
    mockedUsePreviewClaim.mockReturnValue({
      data: makeClaimPreview({
        claimable: true,
        isWinner: true,
        payWETH: 2_500000000000000000n, // 2.5 WETH
        payUSDC: 3_750_000_000n,         // $3750
        contribution6: 5_000_000_000n,
        winnerDenominator: 8_000_000_000n,
      }),
      isLoading: false,
    } as ReturnType<typeof usePreviewClaim>);

    renderWithProviders(<LiveStatus />);

    // Post-settlement the realized testid is present.
    expect(screen.getByTestId(`realized-${stake.tokenId.toString()}`)).toBeInTheDocument();
    // "Outcome pending settlement" must NOT appear post-settlement.
    expect(screen.queryByText(/Outcome pending settlement/)).not.toBeInTheDocument();
  });
});
