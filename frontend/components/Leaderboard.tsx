'use client';

// components/Leaderboard.tsx — "Clean Institutional" ranked table of per-address aggregates for the
// ACTIVE market, built from on-chain events via useLeaderboard(). Rank, truncated address, epochs
// entered/won, win-rate, total claimed (base + USDC). The connected wallet's row is highlighted.
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { useLeaderboard, type LeaderboardRow } from '@/hooks/useLeaderboard';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Pagination } from '@/components/ui/Pagination';
import { Trophy } from '@/components/ui/icons';
import { BaseAmount, MoneyAmount } from '@/components/MoneyAmount';
import { cn } from '@/lib/cn';

const PER_PAGE = 10;

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function winRate(row: LeaderboardRow): string {
  if (row.entered === 0) return '—';
  return `${Math.round((row.won / row.entered) * 100)}%`;
}

function Row({ row, rank, isYou }: { row: LeaderboardRow; rank: number; isYou: boolean }) {
  return (
    <tr
      className={cn(
        'border-b border-line/60 transition-colors last:border-0',
        isYou ? 'bg-brand-soft/60' : 'hover:bg-surface-muted',
      )}
      data-testid={isYou ? 'leaderboard-you' : undefined}
    >
      <td className="py-2.5 pr-3 font-mono text-sm tnum text-ink-soft">{rank}</td>
      <td className="py-2.5 pr-3 font-mono text-sm text-ink">
        {truncate(row.address)}
        {isYou && (
          <Badge tone="brand" className="ml-2 align-middle">
            you
          </Badge>
        )}
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-sm tnum text-ink-soft">{row.entered}</td>
      <td className="py-2.5 pr-3 text-right font-mono text-sm tnum text-ink-soft">{row.won}</td>
      <td className="py-2.5 pr-3 text-right font-mono text-sm tnum text-ink-soft">{winRate(row)}</td>
      <td className="py-2.5 text-right font-mono text-xs tnum text-ink">
        <BaseAmount value={row.claimedBase} />
        <span className="block text-ink-soft">
          <MoneyAmount value={row.claimedUSDC} token="USDC" /> USDC
        </span>
      </td>
    </tr>
  );
}

export function Leaderboard() {
  const { address } = useAccount();
  const { data, isLoading, isError } = useLeaderboard();
  const me = address?.toLowerCase();

  // Paginate at 10 rows/page. Reset to page 1 whenever the data set changes (length).
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
    <SectionCard kicker="On-chain" title="Leaderboard" icon={<Trophy className="h-5 w-5" />}>
      <div data-testid="leaderboard">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-ink-muted">Couldn’t load the leaderboard. It will retry shortly.</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-ink-muted">No participants yet for this market.</p>
        ) : (
          <>
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[32rem] border-collapse">
                <thead>
                  <tr className="border-b border-line text-left text-ink-muted">
                    <th className="py-2.5 pr-3 kicker font-normal">#</th>
                    <th className="py-2.5 pr-3 kicker font-normal">Address</th>
                    <th className="py-2.5 pr-3 kicker font-normal text-right">Entered</th>
                    <th className="py-2.5 pr-3 kicker font-normal text-right">Won</th>
                    <th className="py-2.5 pr-3 kicker font-normal text-right">Win-rate</th>
                    <th className="py-2.5 kicker font-normal text-right">Claimed</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row, i) => (
                    <Row
                      key={row.address}
                      row={row}
                      rank={start + i + 1}
                      isYou={!!me && row.address.toLowerCase() === me}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={current}
              pageCount={pageCount}
              onPageChange={setPage}
              label="Leaderboard pages"
            />
          </>
        )}
      </div>
    </SectionCard>
  );
}
