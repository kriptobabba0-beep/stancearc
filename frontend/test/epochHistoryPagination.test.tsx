import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { EpochHistoryRow } from '@/hooks/useEpochHistory';
import { Side } from '@/lib/types';

// EpochHistory renders a table of past epochs and (Task 2) paginates it at 10 rows/page with a
// <Pagination/> control beneath the table. We mock the data hook wholesale (no importOriginal, which
// would evaluate lib/wagmi -> ENV) via a mutable holder, so the component mounts without the
// wagmi/contract graph, and assert the slice + paging behavior.

let historyState: { data?: EpochHistoryRow[]; isLoading: boolean; isError: boolean } = {
  data: [],
  isLoading: false,
  isError: false,
};
vi.mock('@/hooks/useEpochHistory', () => ({ useEpochHistory: () => historyState }));

import { EpochHistory } from '@/components/EpochHistory';

/** Build N settled rows, newest id first (id = N down to 1). */
function rows(n: number): EpochHistoryRow[] {
  return Array.from({ length: n }, (_, i) => {
    const id = BigInt(n - i);
    return {
      epochId: id,
      startPrice18: 2000_000000000000000000n,
      settlePrice18: 2100_000000000000000000n,
      deltaBps: 500n,
      winningSide: Side.UP,
      potBase: 1_000000000000000000n,
      potUSDC: 5000_000000n,
      winnerCount: 3,
      rolledOver: false,
    } satisfies EpochHistoryRow;
  });
}

/** Count the rendered epoch rows by their "#<id>" first cell. */
function renderedEpochIds(): string[] {
  const table = screen.getByTestId('epoch-history');
  return within(table)
    .getAllByText(/^#\d+$/)
    .map((el) => el.textContent ?? '');
}

beforeEach(() => {
  historyState = { data: [], isLoading: false, isError: false };
});
afterEach(cleanup);

describe('EpochHistory — pagination', () => {
  it('shows at most 10 rows per page and a pagination control when there are more', () => {
    historyState = { data: rows(25), isLoading: false, isError: false };
    render(<EpochHistory />);

    // First page shows the 10 newest (ids 25..16).
    expect(renderedEpochIds()).toHaveLength(10);
    expect(renderedEpochIds()[0]).toBe('#25');
    expect(renderedEpochIds()[9]).toBe('#16');

    // 25 rows / 10 = 3 pages → a pagination control renders.
    const nav = screen.getByTestId('pagination');
    expect(nav).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Page 3' })).toBeTruthy();
  });

  it('navigates to the next page and slices the next 10 rows', () => {
    historyState = { data: rows(25), isLoading: false, isError: false };
    render(<EpochHistory />);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    // Page 2 → ids 15..6.
    expect(renderedEpochIds()).toHaveLength(10);
    expect(renderedEpochIds()[0]).toBe('#15');

    // Jump to the last page via its number → only the remaining 5 rows (ids 5..1).
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(renderedEpochIds()).toHaveLength(5);
    expect(renderedEpochIds()[0]).toBe('#5');
    expect(renderedEpochIds()[4]).toBe('#1');
  });

  it('does not render a pagination control when there are <= 10 rows', () => {
    historyState = { data: rows(8), isLoading: false, isError: false };
    render(<EpochHistory />);
    expect(renderedEpochIds()).toHaveLength(8);
    expect(screen.queryByTestId('pagination')).toBeNull();
  });

  it('resets to page 1 when the data set changes (e.g. market switch)', () => {
    historyState = { data: rows(25), isLoading: false, isError: false };
    const { rerender } = render(<EpochHistory />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
    expect(renderedEpochIds()[0]).toBe('#5'); // on page 3

    // A different-length data set (new market) → the effect resets to page 1.
    historyState = { data: rows(12), isLoading: false, isError: false };
    rerender(<EpochHistory />);
    expect(renderedEpochIds()).toHaveLength(10);
    expect(renderedEpochIds()[0]).toBe('#12'); // newest of the new set, page 1
  });
});
