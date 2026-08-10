import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PhaseView, Side } from '@/lib/types';

let epoch: Record<string, unknown>;

const baseEpoch = {
  epochId: 7n,
  phase: PhaseView.Running,
  entryOpenTime: 0n,
  entryCloseTime: 100n,
  startTime: 130n,
  endTime: 430n,
  startTimeActual: 0n,
  settleTimeActual: 0n,
  bandBps: 150,
  startPrice18: 3000_000000000000000000n,
  settlePrice18: 0n,
  deltaBps: 0n,
  winningSide: Side.NONE,
  rolledOver: false,
  stakedCount: 3,
  sweepCursor: 0, // actual field name (plan test used sweepCursorDone incorrectly)
  potWETH: 0n,
  potUSDC: 0n,
  sideContribution6: [0n, 0n, 0n, 0n] as const,
  winnerDenominator: 0n,
  rolloverPendingIn: true,
  rolloverInWETH: 1_000000000000000000n,
  rolloverInUSDC: 5_000000n,
};

epoch = baseEpoch;

vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: () => ({ data: epoch, isLoading: false }) }));
vi.mock('@/hooks/useOraclePrice', () => ({ useOraclePrice: () => ({ data: { price18: 3050_000000000000000000n, updatedAt: 1n } }) }));
// Countdown uses useChainTime which uses usePublicClient — stub the chain time hook to avoid RPC
vi.mock('@/hooks/useChainTime', () => ({ useChainTime: () => ({ now: 0n, offsetMs: 0 }) }));

import { EpochPanel } from '@/components/EpochPanel';

afterEach(() => {
  cleanup();
  epoch = baseEpoch;
});

describe('EpochPanel', () => {
  it('hides the winner before Settled and shows the rollover-in banner', () => {
    render(<EpochPanel />);
    expect(screen.getByText(/Epoch #7/)).toBeTruthy();
    expect(screen.getByText(/Rollover carried in/)).toBeTruthy();
    expect(screen.queryByText(/Winning side/)).toBeNull();
    expect(screen.getByText(/hidden until the epoch settles/)).toBeTruthy();
  });

  it('renders a small live band (20 bps) as "0.20%", never "0%"', () => {
    epoch = { ...baseEpoch, bandBps: 20 };
    render(<EpochPanel />);
    expect(screen.getByText('0.20%')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('renders a negative settled delta with its sign (not a large positive %)', () => {
    // -200 bps == -2.00%. The old formatBps(Number(...)) rendered this as a huge positive number.
    epoch = {
      ...baseEpoch,
      phase: PhaseView.Settled,
      settlePrice18: 2940_000000000000000000n,
      deltaBps: -200n,
      rolloverPendingIn: false,
    };
    render(<EpochPanel />);
    expect(screen.getByText('-2%')).toBeTruthy();
    expect(screen.queryByText(/hidden until the epoch settles/)).toBeNull();
  });
});
