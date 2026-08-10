import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { LeaderboardRow } from '@/hooks/useLeaderboard';

// Leaderboard renders a ranked table and (Task 2) paginates it at 10 rows/page with a <Pagination/>
// control beneath the table. We mock the data hook + wagmi's useAccount wholesale (no importOriginal,
// which would evaluate lib/wagmi -> ENV) via a mutable holder, so the component mounts standalone,
// then assert the slice + paging + the rank carrying across pages.

let leaderboardState: { data?: LeaderboardRow[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
vi.mock('@/hooks/useLeaderboard', () => ({ useLeaderboard: () => leaderboardState }));
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, isConnected: false }) }));

import { Leaderboard } from '@/components/Leaderboard';

/** Build N rows with distinct, sortable addresses (0x...01 .. 0x...NN). */
function rows(n: number): LeaderboardRow[] {
  return Array.from({ length: n }, (_, i) => {
    const hex = (i + 1).toString(16).padStart(40, '0');
    return {
      address: `0x${hex}` as `0x${string}`,
      entered: 5,
      won: 2,
      claimedBase: 1_000000000000000000n,
      claimedUSDC: 1000_000000n,
    } satisfies LeaderboardRow;
  });
}

/** The rank cells are the first <td> of each data row → read all first cells. */
function renderedRanks(): string[] {
  const table = screen.getByTestId('leaderboard');
  const rowEls = within(table).getAllByRole('row');
  // Skip the header row (its cells are <th>, getAllByRole('cell') returns []).
  return rowEls
    .map((r) => within(r).queryAllByRole('cell')[0]?.textContent ?? '')
    .filter((t) => /^\d+$/.test(t));
}

beforeEach(() => {
  leaderboardState = { data: [], isLoading: false, isError: false };
});
afterEach(cleanup);

describe('Leaderboard — pagination', () => {
  it('shows at most 10 rows per page and a pagination control when there are more', () => {
    leaderboardState = { data: rows(23), isLoading: false, isError: false };
    render(<Leaderboard />);

    const ranks = renderedRanks();
    expect(ranks).toHaveLength(10);
    expect(ranks[0]).toBe('1');
    expect(ranks[9]).toBe('10');

    const nav = screen.getByTestId('pagination');
    expect(within(nav).getByRole('button', { name: 'Page 3' })).toBeTruthy();
  });

  it('continues the rank numbering across pages (page 2 starts at 11)', () => {
    leaderboardState = { data: rows(23), isLoading: false, isError: false };
    render(<Leaderboard />);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    const ranks = renderedRanks();
    expect(ranks).toHaveLength(10);
    expect(ranks[0]).toBe('11');
    expect(ranks[9]).toBe('20');

    // Last page → 3 remaining rows, ranks 21..23.
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    const last = renderedRanks();
    expect(last).toHaveLength(3);
    expect(last[0]).toBe('21');
    expect(last[2]).toBe('23');
  });

  it('does not render a pagination control when there are <= 10 rows', () => {
    leaderboardState = { data: rows(6), isLoading: false, isError: false };
    render(<Leaderboard />);
    expect(renderedRanks()).toHaveLength(6);
    expect(screen.queryByTestId('pagination')).toBeNull();
  });

  it('resets to page 1 when the data set changes', () => {
    leaderboardState = { data: rows(23), isLoading: false, isError: false };
    const { rerender } = render(<Leaderboard />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(renderedRanks()[0]).toBe('21');

    leaderboardState = { data: rows(11), isLoading: false, isError: false };
    rerender(<Leaderboard />);
    const ranks = renderedRanks();
    expect(ranks).toHaveLength(10);
    expect(ranks[0]).toBe('1');
  });
});
