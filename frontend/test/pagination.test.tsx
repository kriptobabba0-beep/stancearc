import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { Pagination, pageItems } from '@/components/ui/Pagination';

afterEach(() => cleanup());

describe('pageItems — windowed page list', () => {
  it('lists every page when there are <= 5', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it('windows around the current page with an ellipsis on the right near the start', () => {
    // page 1 of 10 → 1 2 … 10
    expect(pageItems(1, 10)).toEqual([1, 2, 'ellipsis', 10]);
  });

  it('windows with an ellipsis on the left near the end', () => {
    // page 10 of 10 → 1 … 9 10
    expect(pageItems(10, 10)).toEqual([1, 'ellipsis', 9, 10]);
  });

  it('windows with ellipses on both sides in the middle', () => {
    // page 6 of 10 → 1 … 5 6 7 … 10
    expect(pageItems(6, 10)).toEqual([1, 'ellipsis', 5, 6, 7, 'ellipsis', 10]);
  });
});

describe('Pagination', () => {
  it('renders nothing when there is a single page', () => {
    const { container } = render(<Pagination page={1} pageCount={1} onPageChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('marks the active page with aria-current=page', () => {
    render(<Pagination page={3} pageCount={5} onPageChange={() => {}} />);
    const active = screen.getByRole('button', { name: 'Page 3' });
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(active.getAttribute('data-active')).toBe('true');
    // A non-active page has no aria-current.
    expect(screen.getByRole('button', { name: 'Page 2' }).getAttribute('aria-current')).toBeNull();
  });

  it('calls onPageChange with the clicked page number', () => {
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageCount={5} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('Prev/Next move one page and are disabled at the ends', () => {
    const onPageChange = vi.fn();
    // First page: Prev disabled, Next enabled → page+1.
    const { rerender } = render(
      <Pagination page={1} pageCount={5} onPageChange={onPageChange} />,
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(next).not.toBeDisabled();
    fireEvent.click(next);
    expect(onPageChange).toHaveBeenCalledWith(2);

    // Last page: Next disabled, Prev enabled → page-1.
    onPageChange.mockClear();
    rerender(<Pagination page={5} pageCount={5} onPageChange={onPageChange} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    const prev = screen.getByRole('button', { name: 'Previous page' });
    expect(prev).not.toBeDisabled();
    fireEvent.click(prev);
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('renders an ellipsis when there are many pages', () => {
    render(<Pagination page={1} pageCount={20} onPageChange={() => {}} />);
    const nav = screen.getByTestId('pagination');
    expect(within(nav).getAllByTestId('pagination-ellipsis').length).toBeGreaterThan(0);
    // The window keeps the page-button count small (not one per page).
    const pageButtons = within(nav)
      .getAllByRole('button')
      .filter((b) => /^Page \d+$/.test(b.getAttribute('aria-label') ?? ''));
    expect(pageButtons.length).toBeLessThan(20);
  });
});
