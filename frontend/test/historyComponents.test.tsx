import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Side } from '@/lib/types';
import type { EpochHistoryRow } from '@/hooks/useEpochHistory';
import type { LeaderboardRow } from '@/hooks/useLeaderboard';

// --- mockable hook returns (mutated per test) ---
let epochState: { data?: EpochHistoryRow[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
let leaderboardState: { data?: LeaderboardRow[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
let account: { address?: `0x${string}` } = {};

// The components only call the hook; types are erased — mock the hooks wholesale (no importOriginal,
// which would evaluate lib/wagmi -> ENV). Also stub wagmi's useAccount.
vi.mock('@/hooks/useEpochHistory', () => ({ useEpochHistory: () => epochState }));
vi.mock('@/hooks/useLeaderboard', () => ({ useLeaderboard: () => leaderboardState }));
vi.mock('wagmi', () => ({ useAccount: () => account }));

import { EpochHistory } from '@/components/EpochHistory';
import { Leaderboard } from '@/components/Leaderboard';

const YOU = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;

beforeEach(() => {
  epochState = { data: [], isLoading: false, isError: false };
  leaderboardState = { data: [], isLoading: false, isError: false };
  account = {};
});
afterEach(cleanup);

describe('EpochHistory', () => {
  it('renders the empty state without crashing when there are no rows', () => {
    render(<EpochHistory />);
    expect(screen.getByTestId('epoch-history')).toBeTruthy();
    expect(screen.getByText(/No settled epochs yet/i)).toBeTruthy();
  });

  it('renders a row per epoch, with a rolled-over badge + 0 winners', () => {
    epochState = {
      isLoading: false,
      isError: false,
      data: [
        {
          epochId: 2n, startPrice18: 2000_000000000000000000n, settlePrice18: 2100_000000000000000000n,
          deltaBps: 500n, winningSide: Side.UP, potBase: 1_000000000000000000n, potUSDC: 5000_000000n,
          rolledOver: false,
        },
        {
          epochId: 1n, startPrice18: 1900_000000000000000000n, settlePrice18: 1899_000000000000000000n,
          deltaBps: -5n, winningSide: Side.RANGE, potBase: 0n, potUSDC: 0n, winnerCount: 0, rolledOver: true,
        },
      ],
    };
    render(<EpochHistory />);
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('UP')).toBeTruthy();
    expect(screen.getByText(/rolled over/i)).toBeTruthy();
  });

  it('shows a Skeleton while loading (no rows, no empty text)', () => {
    epochState = { data: undefined, isLoading: true, isError: false };
    render(<EpochHistory />);
    expect(screen.getByTestId('epoch-history')).toBeTruthy();
    expect(screen.queryByText(/No settled epochs yet/i)).toBeNull();
  });
});

describe('Leaderboard', () => {
  it('renders the empty state without crashing when there are no rows', () => {
    render(<Leaderboard />);
    expect(screen.getByTestId('leaderboard')).toBeTruthy();
    expect(screen.getByText(/No participants yet/i)).toBeTruthy();
  });

  it('renders ranked rows and highlights the connected wallet', () => {
    account = { address: YOU };
    leaderboardState = {
      isLoading: false,
      isError: false,
      data: [
        { address: OTHER, entered: 3, won: 2, claimedBase: 1n, claimedUSDC: 9000_000000n },
        { address: YOU, entered: 2, won: 1, claimedBase: 0n, claimedUSDC: 1000_000000n },
      ],
    };
    render(<Leaderboard />);
    expect(screen.getByTestId('leaderboard')).toBeTruthy();
    // the connected wallet's row is marked
    expect(screen.getByTestId('leaderboard-you')).toBeTruthy();
    expect(screen.getByText('you')).toBeTruthy();
    // truncated addresses render
    expect(screen.getByText('0x2222…2222')).toBeTruthy();
    expect(screen.getByText('0x1111…1111')).toBeTruthy();
  });
});
