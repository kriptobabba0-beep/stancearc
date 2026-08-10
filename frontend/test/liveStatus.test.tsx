import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PhaseView, Side } from '@/lib/types';

const stakes = [{ tokenId: 42n, owner: '0x1', epochId: 9n, side: Side.UP, swept: true, claimed: false, unstaked: false, feeWETH: 0n, feeUSDC: 0n, contribution6: 8000_000000n }];
let phase = PhaseView.Running;

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true }) }));
vi.mock('@/hooks/useCurrentEpoch', () => ({
  useCurrentEpoch: () => ({ data: { epochId: 9n, phase, sideContribution6: [0n, 8000_000000n, 0n, 0n] }, isLoading: false }),
}));
vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: () => ({ data: stakes }) }));
vi.mock('@/hooks/usePreviewClaim', () => ({
  usePreviewClaim: () => ({ data: { claimable: true, isWinner: true, alreadyClaimed: false, payWETH: 1_000000000000000000n, payUSDC: 3000_000000n, contribution6: 8000_000000n, winnerDenominator: 8000_000000n } }),
}));

import { LiveStatus } from '@/components/LiveStatus';

beforeEach(() => { phase = PhaseView.Running; });
afterEach(cleanup);

describe('LiveStatus', () => {
  it('hides outcome before settlement', () => {
    render(<LiveStatus />);
    expect(screen.getByText(/Outcome pending settlement/)).toBeTruthy();
  });

  it('shows previewClaim realized payout after settlement', () => {
    phase = PhaseView.Settled;
    render(<LiveStatus />);
    expect(screen.getByTestId('realized-42')).toBeTruthy();
  });
});
