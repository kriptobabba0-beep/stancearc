import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// PoolBrowser: the tabbed (Pools / My Positions) shell. We stub the two panels + the Create modal so the
// test focuses on the tab/toolbar wiring: default tab, switching, the shared search query reaching the
// active panel, and Create opening from both the toolbar and the positions empty state.

vi.mock('@/components/pool/PoolTable', () => ({
  PoolTable: ({ query }: { query: string }) => <div data-testid="pool-table-stub">q:{query}</div>,
}));
vi.mock('@/components/pool/MyPositions', () => ({
  MyPositions: ({ query, onCreate }: { query?: string; onCreate?: () => void }) => (
    <div data-testid="my-positions-stub">
      q:{query}
      <button type="button" data-testid="mp-create" onClick={onCreate}>
        add
      </button>
    </div>
  ),
}));
vi.mock('@/components/pool/CreatePoolModal', () => ({
  CreatePoolModal: ({ open }: { open: boolean }) => (open ? <div data-testid="create-modal-open" /> : null),
}));

import { PoolBrowser } from '@/components/pool/PoolBrowser';

afterEach(() => cleanup());

describe('PoolBrowser', () => {
  it('defaults to the Pools tab (table visible, positions hidden)', () => {
    render(<PoolBrowser />);
    expect(screen.getByTestId('pool-table-stub')).toBeTruthy();
    expect(screen.queryByTestId('my-positions-stub')).toBeNull();
    expect(screen.getByTestId('pool-tab-pools').getAttribute('aria-selected')).toBe('true');
  });

  it('switches to the My Positions tab', () => {
    render(<PoolBrowser />);
    fireEvent.click(screen.getByTestId('pool-tab-positions'));
    expect(screen.getByTestId('my-positions-stub')).toBeTruthy();
    expect(screen.queryByTestId('pool-table-stub')).toBeNull();
    expect(screen.getByTestId('pool-tab-positions').getAttribute('aria-selected')).toBe('true');
  });

  it('shares the search query with the active panel', () => {
    render(<PoolBrowser />);
    fireEvent.change(screen.getByTestId('pool-search'), { target: { value: 'eurc' } });
    expect(screen.getByTestId('pool-table-stub')).toHaveTextContent('q:eurc');
    fireEvent.click(screen.getByTestId('pool-tab-positions'));
    expect(screen.getByTestId('my-positions-stub')).toHaveTextContent('q:eurc');
  });

  it('opens the Create modal from the toolbar', () => {
    render(<PoolBrowser />);
    expect(screen.queryByTestId('create-modal-open')).toBeNull();
    fireEvent.click(screen.getByTestId('pool-create'));
    expect(screen.getByTestId('create-modal-open')).toBeTruthy();
  });

  it('opens the Create modal from the My Positions empty state', () => {
    render(<PoolBrowser />);
    fireEvent.click(screen.getByTestId('pool-tab-positions'));
    fireEvent.click(screen.getByTestId('mp-create'));
    expect(screen.getByTestId('create-modal-open')).toBeTruthy();
  });

  it('arrow keys wrap, and focus + roving tabindex follow the selection', () => {
    render(<PoolBrowser />);
    const tablist = screen.getByRole('tablist');
    const pools = screen.getByTestId('pool-tab-pools');
    const positions = screen.getByTestId('pool-tab-positions');

    // Default: Pools is selected and the only tab-stop (roving tabindex).
    expect(pools.getAttribute('aria-selected')).toBe('true');
    expect(pools.getAttribute('tabindex')).toBe('0');
    expect(positions.getAttribute('tabindex')).toBe('-1');

    // ArrowLeft from the FIRST tab WRAPS to the last — selection, focus and tabindex all move.
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(positions.getAttribute('aria-selected')).toBe('true');
    expect(positions).toHaveFocus();
    expect(positions.getAttribute('tabindex')).toBe('0');
    expect(pools.getAttribute('tabindex')).toBe('-1');

    // ArrowRight from the LAST tab WRAPS back to the first.
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(pools.getAttribute('aria-selected')).toBe('true');
    expect(pools).toHaveFocus();
  });

  it('supports Home / End on the tablist', () => {
    render(<PoolBrowser />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(screen.getByTestId('pool-tab-positions').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(screen.getByTestId('pool-tab-pools').getAttribute('aria-selected')).toBe('true');
  });

  it('makes the search label follow the active tab', () => {
    render(<PoolBrowser />);
    expect(screen.getByTestId('pool-search').getAttribute('placeholder')).toBe('Search pools');
    fireEvent.click(screen.getByTestId('pool-tab-positions'));
    expect(screen.getByTestId('pool-search').getAttribute('placeholder')).toBe('Search positions');
  });
});
