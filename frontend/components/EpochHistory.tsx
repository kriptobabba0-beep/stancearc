'use client';

// components/EpochHistory.tsx - "Clean Institutional" table of past epochs for the ACTIVE market,
// built from on-chain events via useEpochHistory(). Side badges from lib/side.ts, pots via
// BaseAmount/MoneyAmount (per-market decimals), mono tabular numerics, Skeleton + empty states.
import { useEffect, useState } from 'react';
import { useEpochHistory, type EpochHistoryRow } from '@/hooks/useEpochHistory';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Pagination } from '@/components/ui/Pagination';
import { Clock } from '@/components/ui/icons';
import { BaseAmount, MoneyAmount } from '@/components/MoneyAmount';
import { SIDE_LABELS } from '@/lib/side';
import { formatDeltaBps, formatPrice18 } from '@/lib/format';
import { Side } from '@/lib/types';

const PER_PAGE = 10;

const SIDE_TONE: Record<Side, 'neutral' | 'up' | 'down' | 'range'> = {
  [Side.NONE]: 'neutral',
  [Side.UP]: 'up',
  [Side.DOWN]: 'down',
  [Side.RANGE]: 'range',
};

function SideBadge({ side }: { side: Side }) {
  return <Badge tone={SIDE_TONE[side]}>{SIDE_LABELS[side]}</Badge>;
}

function HistoryRow({ row }: { row: EpochHistoryRow }) {
  return (
    <tr className="border-b border-line/60 transition-colors last:border-0 hover:bg-surface-muted">
      <td className="py-2.5 pr-3 font-mono text-sm tnum text-ink">#{row.epochId.toString()}</td>
      <td className="py-2.5 pr-3 font-mono text-xs tnum text-ink-soft">
        {row.perPosition ? (
          // v3: no global start price - entries are per-position; show the settlement price only.
          <>
            <span className="text-ink-faint">settle </span>
            {row.settlePrice18 !== undefined ? formatPrice18(row.settlePrice18) : '-'}
          </>
        ) : (
          <>
            {formatPrice18(row.startPrice18)}
            <span className="px-1 text-ink-faint">→</span>
            {row.settlePrice18 !== undefined ? formatPrice18(row.settlePrice18) : '-'}
          </>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs tnum text-ink-soft">
        {row.deltaBps !== undefined ? formatDeltaBps(row.deltaBps) : '-'}
      </td>
      <td className="py-2.5 pr-3">
        {row.rolledOver ? (
          <Badge tone="warning">rolled over</Badge>
        ) : row.perPosition ? (
          // ENTRY-ANCHORED: no global winner - each position resolved vs its own entry price.
          <Badge tone="neutral">per-position</Badge>
        ) : (
          <SideBadge side={row.winningSide} />
        )}
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs tnum text-ink">
        <BaseAmount value={row.potBase} />
        <span className="block text-ink-soft">
          <MoneyAmount value={row.potUSDC} token="USDC" /> USDC
        </span>
      </td>
      <td className="py-2.5 text-right font-mono text-sm tnum text-ink-soft">
        {row.rolledOver ? 0 : row.winnerCount ?? '-'}
      </td>
    </tr>
  );
}

export function EpochHistory() {
  const { data, isLoading, isError } = useEpochHistory();

  // Paginate the table at 10 rows/page. Reset to page 1 whenever the data set changes (length).
  const [page, setPage] = useState(1);
  const total = data?.length ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));
  useEffect(() => {
    setPage(1);
  }, [total]);
  // Clamp in case the data shrank below the current page (e.g. a market switch).
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PER_PAGE;
  const pageRows = data ? data.slice(start, start + PER_PAGE) : [];

  return (
    <SectionCard
      kicker="On-chain history"
      title="Epoch History"
      icon={<Clock className="h-5 w-5" />}
    >
      <div data-testid="epoch-history">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-ink-muted">Couldn’t load epoch history. It will retry shortly.</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-ink-muted">No settled epochs yet for this market.</p>
        ) : (
          <>
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse">
                <thead>
                  <tr className="border-b border-line text-left text-ink-muted">
                    <th className="py-2.5 pr-3 kicker font-normal">Epoch</th>
                    <th className="py-2.5 pr-3 kicker font-normal">Price (start → settle)</th>
                    <th className="py-2.5 pr-3 kicker font-normal text-right">Δ</th>
                    <th className="py-2.5 pr-3 kicker font-normal">Winner</th>
                    <th className="py-2.5 pr-3 kicker font-normal text-right">Pot</th>
                    <th className="py-2.5 kicker font-normal text-right">#Win</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => (
                    <HistoryRow key={row.epochId.toString()} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={current}
              pageCount={pageCount}
              onPageChange={setPage}
              label="Epoch history pages"
            />
          </>
        )}
      </div>
    </SectionCard>
  );
}
