'use client';

// components/ui/Pagination.tsx — a reusable, accessible pager for long tables (Epoch History,
// Leaderboard). Renders numbered page buttons with a windowed ellipsis when there are many pages,
// plus Prev/Next controls that disable at the ends. The active page carries aria-current="page" and
// the brand (pink) fill; inactive pages are hairline-bordered grey. Purely presentational — the
// parent owns `page` state and slices its own data.
import { cn } from '@/lib/cn';

interface PaginationProps {
  /** 1-based current page. */
  page: number;
  /** Total number of pages (>= 1). */
  pageCount: number;
  /** Called with the next 1-based page when the user navigates. */
  onPageChange: (page: number) => void;
  /** Optional accessible label for the nav landmark. */
  label?: string;
  className?: string;
}

/** Small left/right chevrons matching the stroke-icon style (no left/right chevron in icons.tsx). */
function ChevronLeft({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}
function ChevronRight({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

const ELLIPSIS = 'ellipsis' as const;
type Item = number | typeof ELLIPSIS;

/**
 * Build the windowed list of page items. Shows the first and last page always, the current page with
 * one neighbour either side, and an ellipsis where pages are skipped. For <= 5 pages every page is shown.
 * Examples (current in []):
 *   pageCount 5,  page 3 → 1 2 [3] 4 5
 *   pageCount 10, page 1 → [1] 2 3 … 10
 *   pageCount 10, page 6 → 1 … 5 [6] 7 … 10
 *   pageCount 10, page 10 → 1 … 8 9 [10]
 */
export function pageItems(page: number, pageCount: number): Item[] {
  if (pageCount <= 5) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const items: Item[] = [];
  const push = (n: Item) => items.push(n);

  // Window of pages immediately around the current page.
  const left = Math.max(2, page - 1);
  const right = Math.min(pageCount - 1, page + 1);

  push(1);
  if (left > 2) push(ELLIPSIS);
  for (let p = left; p <= right; p++) push(p);
  if (right < pageCount - 1) push(ELLIPSIS);
  push(pageCount);
  return items;
}

const navBtn =
  'inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface disabled:hover:text-ink-soft';

export function Pagination({
  page,
  pageCount,
  onPageChange,
  label = 'Pagination',
  className,
}: PaginationProps) {
  // Nothing to paginate.
  if (pageCount <= 1) return null;

  const items = pageItems(page, pageCount);
  const atStart = page <= 1;
  const atEnd = page >= pageCount;

  return (
    <nav
      aria-label={label}
      data-testid="pagination"
      className={cn('mt-4 flex items-center justify-center gap-1.5', className)}
    >
      <button
        type="button"
        aria-label="Previous page"
        disabled={atStart}
        onClick={() => onPageChange(page - 1)}
        className={navBtn}
      >
        <ChevronLeft className="h-[18px] w-[18px]" />
        <span className="hidden sm:inline">Prev</span>
      </button>

      <ul className="flex items-center gap-1" role="list">
        {items.map((item, i) =>
          item === ELLIPSIS ? (
            <li
              key={`ellipsis-${i}`}
              aria-hidden="true"
              data-testid="pagination-ellipsis"
              className="grid h-9 w-9 place-items-center text-sm text-ink-faint"
            >
              …
            </li>
          ) : (
            <li key={item}>
              <button
                type="button"
                aria-label={`Page ${item}`}
                aria-current={item === page ? 'page' : undefined}
                data-active={item === page ? 'true' : 'false'}
                onClick={() => onPageChange(item)}
                className={cn(
                  'grid h-9 min-w-9 place-items-center rounded-lg border px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus',
                  item === page
                    ? 'border-brand bg-brand text-white'
                    : 'border-line bg-surface text-ink-soft hover:bg-surface-muted hover:text-ink',
                )}
              >
                {item}
              </button>
            </li>
          ),
        )}
      </ul>

      <button
        type="button"
        aria-label="Next page"
        disabled={atEnd}
        onClick={() => onPageChange(page + 1)}
        className={navBtn}
      >
        <span className="hidden sm:inline">Next</span>
        <ChevronRight className="h-[18px] w-[18px]" />
      </button>
    </nav>
  );
}
