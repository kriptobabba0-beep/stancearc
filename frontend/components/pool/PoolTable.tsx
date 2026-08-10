'use client';

// components/pool/PoolTable.tsx — the pool rows for the "Pools" tab: every registry pool SORTED BY
// LIQUIDITY (TVL) desc, filtered by the shared search `query`, each a clickable link to /pool/[id] with
// a clear hover affordance. Stats come from usePoolStats (real on-chain) — TVL drives the sort + lands
// first; the 24h figures fill in after the event scan. (Extracted from the old PoolList so the tabbed
// PoolBrowser can swap it with the positions panel.)
import { useMemo } from 'react';
import Link from 'next/link';
import { POOLS, poolLabel, type PoolInfo } from '@/lib/pools';
import { usePoolStats, type PoolStatRow } from '@/hooks/usePoolStats';
import { formatUsd, formatPct } from '@/lib/poolStats';
import { formatBps } from '@/lib/format';
import { ENV } from '@/lib/env';
import { TokenPairGlyph } from '@/components/TokenGlyph';
import { Skeleton } from '@/components/ui/Skeleton';
import { BarChart, ChevronDown } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

/** One numeric cell: a mobile-only label above the value (so the row reads on a phone), value on lg. */
function NumCell({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="kicker mb-0.5 sm:hidden">{label}</div>
      <div className="font-mono text-[15px] font-semibold tabular-nums text-ink">{children}</div>
    </div>
  );
}

/** A loading dash that becomes the formatted value once the (slower) flow query resolves. */
function flowCell(value: number | undefined, fmt: (n: number) => string, loading: boolean) {
  if (value !== undefined) return fmt(value);
  return loading ? <Skeleton className="h-4 w-16 rounded" /> : <span className="text-ink-faint">—</span>;
}

function PoolRow({ pool, stat, loadingFlow }: { pool: PoolInfo; stat: PoolStatRow | undefined; loadingFlow: boolean }) {
  return (
    <Link
      href={`/pool/${pool.id}`}
      data-testid={`pool-row-${pool.id}`}
      aria-label={`Provide liquidity to ${poolLabel(pool)}`}
      className={cn(
        'group grid grid-cols-2 items-center gap-x-4 gap-y-3 rounded-2xl border border-line bg-surface px-4 py-3.5',
        'cursor-pointer transition-colors hover:border-brand/50 hover:bg-surface-muted',
        'focus-visible:outline-none focus-visible:shadow-focus',
        'sm:grid-cols-[1.7fr_repeat(4,1fr)_4.5rem]',
      )}
    >
      <div className="col-span-2 flex min-w-0 items-center gap-3 sm:col-span-1">
        <TokenPairGlyph baseSymbol={pool.base.symbol} quoteSymbol={pool.quote.symbol} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-display text-[15px] font-semibold text-ink">{poolLabel(pool)}</span>
            <span className="shrink-0 rounded-full border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-soft">
              {formatBps(ENV.FEE_TIER / 100)}
            </span>
          </div>
        </div>
      </div>

      <NumCell label="Liquidity">
        {stat?.tvlUsd !== undefined ? formatUsd(stat.tvlUsd) : <Skeleton className="h-4 w-20 rounded" />}
      </NumCell>
      <NumCell label="24h Volume">{flowCell(stat?.volume24Usd, formatUsd, loadingFlow)}</NumCell>
      <NumCell label="24h Fees">{flowCell(stat?.fees24Usd, formatUsd, loadingFlow)}</NumCell>
      <NumCell label="APR" className="text-side-up">
        <span className="text-side-up">{flowCell(stat?.aprPct, formatPct, loadingFlow)}</span>
      </NumCell>

      <div className="col-span-2 flex items-center justify-end gap-2 text-ink-muted sm:col-span-1">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface-muted/40 transition-colors group-hover:text-ink">
          <BarChart className="h-4 w-4" />
        </span>
        <ChevronDown className="h-4 w-4 -rotate-90 transition-transform group-hover:translate-x-0.5 group-hover:text-ink" />
      </div>
    </Link>
  );
}

export function PoolTable({ query }: { query: string }) {
  const { rows, isLoadingFlow } = usePoolStats();

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? POOLS.filter(
          (p) =>
            p.base.symbol.toLowerCase().includes(q) ||
            p.quote.symbol.toLowerCase().includes(q) ||
            poolLabel(p).toLowerCase().includes(q),
        )
      : POOLS;
    return [...filtered].sort((a, b) => (rows[b.id]?.tvlUsd ?? -1) - (rows[a.id]?.tvlUsd ?? -1));
  }, [query, rows]);

  return (
    <div data-testid="pool-table">
      {/* Column header (lg only) */}
      <div className="hidden px-4 pb-2 sm:grid sm:grid-cols-[1.7fr_repeat(4,1fr)_4.5rem] sm:gap-x-4">
        <span className="kicker">Pool</span>
        <span className="kicker inline-flex items-center gap-1">
          Liquidity <ChevronDown className="h-3 w-3" aria-label="sorted descending" />
        </span>
        <span className="kicker">24h Volume</span>
        <span className="kicker">24h Fees</span>
        <span className="kicker">APR</span>
        <span />
      </div>

      <div className="space-y-2.5">
        {visible.length === 0 ? (
          <div
            data-testid="pool-empty"
            className="rounded-2xl border border-line bg-surface px-4 py-10 text-center text-sm text-ink-muted"
          >
            No pools match “{query}”.
          </div>
        ) : (
          visible.map((p) => <PoolRow key={p.id} pool={p} stat={rows[p.id]} loadingFlow={isLoadingFlow} />)
        )}
      </div>
    </div>
  );
}
