'use client';

// components/leaderboard/StandingsBoard.tsx — the standings themselves: a chamfered HUD podium for
// the top three and a ranked table under it.
//
// This lives apart from any page because two of them show the same board. The arena leaderboard
// ranks all of history; a campaign ranks a block range. The framing around them differs — markets
// and time windows on one, a prize tier and a deadline on the other — but the standings are the
// same object and a reader should not have to learn it twice. Copying the markup instead would
// have meant two boards drifting apart by one small fix at a time.
//
// Rows arrive in the indexer's wire shape (LeaderRowOut, strings for the bigint fields) so both
// callers can hand over exactly what their API returned.
import { useEffect, useMemo, useState } from 'react';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';
import { Identicon } from '@/components/leaderboard/Identicon';
import { Pagination } from '@/components/ui/Pagination';
import { compactUsd6, signedCompactUsd6 } from '@/lib/identicon';
import { isPlatformBot } from '@/lib/platformBots';
import { Bot } from '@/components/ui/icons';
import type { LeaderRowOut } from '@/lib/leaderboardIndex';

export type Metric = 'volume' | 'pnl';

/** A row with its figures parsed, which is what everything below sorts and renders. */
export interface StandingsRow {
  address: string;
  volume: bigint;
  swap: bigint;
  liq: bigint;
  fee: bigint;
  pnl: bigint;
  claimed: bigint;
  entered: number;
  won: number;
}

export const PER_PAGE = 15;
/** Rank metals: podium seams + top-3 rank chips. */
export const METALS = ['#E8AE1F', '#C7CCD6', '#C77B4A'] as const;

export const VOLUME_TIP = 'Volume includes eligible swaps, liquidity added, and fees contributed to Stance.';
export const PNL_TIP =
  'Realized PnL equals claimed fee shares minus forfeited fees. Unclaimed winnings are not included.';

export const truncate = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** "13/13 · 100%" — the count keeps 1/1 from looking like 44/44. */
export const qualifyLabel = (r: StandingsRow) =>
  r.entered === 0 ? '—' : `${r.won}/${r.entered} · ${Math.round((r.won / r.entered) * 100)}%`;
export const num = (n: number) => n.toLocaleString('en-US');

/**
 * The board switch. Large and filled when active, because on both pages it is THE control and a
 * quiet chip would disappear into the chrome.
 */
export const metricTabClass = (active: boolean) =>
  cn(
    'cursor-pointer rounded-xl px-6 py-2.5 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:shadow-focus',
    active
      ? 'bg-brand text-white shadow-[0_0_18px_rgb(229_72_77/0.45)]'
      : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
  );

export function parseStandings(rows: readonly LeaderRowOut[]): StandingsRow[] {
  return rows.map((r) => ({
    address: r.address,
    volume: BigInt(r.volumeUsd6),
    swap: BigInt(r.swapUsd6),
    liq: BigInt(r.liqUsd6),
    fee: BigInt(r.feeUsd6),
    pnl: BigInt(r.pnlUsd6),
    claimed: BigInt(r.claimedUsd6),
    entered: r.entered,
    won: r.won,
  }));
}

/**
 * The same order the indexer ranks with (leaderboardIndex `rankBy`), deliberately kept identical.
 *
 * A board that displays one order while the published standings carry another is how a prize gets
 * disputed: the payout reads the API, the claimant screenshots the page. So the tiebreak here
 * matches the engine's exactly — score, then epochs won, then epochs entered, then address.
 */
export function sortStandings(rows: StandingsRow[], metric: Metric): StandingsRow[] {
  const key = metric === 'volume' ? (r: StandingsRow) => r.volume : (r: StandingsRow) => r.pnl;
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return kb > ka ? 1 : -1;
    if (a.won !== b.won) return b.won - a.won;
    if (a.entered !== b.entered) return b.entered - a.entered;
    return a.address < b.address ? -1 : 1;
  });
}

export function MetricValue({ row, metric, sym }: { row: StandingsRow; metric: Metric; sym: string }) {
  if (metric === 'volume') {
    return <span className="font-mono tnum text-ink">{compactUsd6(row.volume, sym)}</span>;
  }
  const tone = row.pnl > 0n ? 'text-side-up' : row.pnl < 0n ? 'text-side-down' : 'text-ink-soft';
  return <span className={cn('font-mono tnum', tone)}>{signedCompactUsd6(row.pnl, sym)}</span>;
}

export function OwnerBadges({ address, me, agents }: { address: string; me?: string; agents: Set<string> }) {
  const a = address.toLowerCase();
  // House wallets first — visitors must never mistake platform activity for organic users.
  if (isPlatformBot(a)) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-side-range/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-side-range">
        <Bot className="h-3 w-3" aria-hidden="true" />
        Platform bot
      </span>
    );
  }
  if (me && a === me) {
    return (
      <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-brand">
        You
      </span>
    );
  }
  if (agents.has(a)) {
    return (
      <span className="rounded-md bg-[#E8AE1F]/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[#E8AE1F]">
        Your agent
      </span>
    );
  }
  return null;
}

export function PodiumCard({
  row,
  rank,
  metric,
  sym,
  me,
  agents,
}: {
  row: StandingsRow;
  rank: 1 | 2 | 3;
  metric: Metric;
  sym: string;
  me?: string;
  agents: Set<string>;
}) {
  const metal = METALS[rank - 1];
  return (
    <div
      className={cn(
        'hud-col relative',
        rank === 1 ? 'md:order-2 md:-translate-y-2' : rank === 2 ? 'md:order-1' : 'md:order-3',
      )}
    >
      <div className="hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)] relative p-5 sm:p-6">
        {/* metal seam along the top edge */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-6 top-0 h-px"
          style={{ background: `linear-gradient(90deg, transparent, ${metal}, transparent)` }}
        />
        <div className="flex items-center justify-between">
          <span
            className="font-mono text-[13px] font-semibold tnum"
            style={{ color: metal, textShadow: `0 0 12px ${metal}55` }}
          >
            #{rank}
          </span>
          {/* Epochs entered and won say nothing about a volume rank, and printing "no Stance
              entries yet" beside a trader's biggest number reads as a missing requirement they
              have failed. It belongs on the board it actually measures. */}
          {metric === 'pnl' && (
            <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">
              {row.entered > 0 ? `${qualifyLabel(row)} qualified` : 'no Stance entries yet'}
            </span>
          )}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Identicon address={row.address} className={rank === 1 ? 'h-14 w-14' : 'h-11 w-11'} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <a
                href={`${ENV.EXPLORER_URL}/address/${row.address}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-sm text-ink hover:text-brand focus-visible:outline-none focus-visible:shadow-focus"
              >
                {truncate(row.address)}
              </a>
              <OwnerBadges address={row.address} me={me} agents={agents} />
            </div>
            <div className={cn('mt-1 font-display font-semibold tracking-tight', rank === 1 ? 'text-[26px]' : 'text-[21px]')}>
              <MetricValue row={row} metric={metric} sym={sym} />
            </div>
          </div>
        </div>
        {/* The sub-line explains WHY the card ranks under the ACTIVE metric: volume shows its
            composition; realized PnL shows the claimed-vs-contributed ledger behind the net. */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
          {metric === 'volume' ? (
            <>
              <span>Swaps {compactUsd6(row.swap, sym)}</span>
              <span>LP {compactUsd6(row.liq, sym)}</span>
              <span>Fees {compactUsd6(row.fee, sym)}</span>
            </>
          ) : (
            <>
              <span>Claimed {compactUsd6(row.claimed, sym)}</span>
              <span>Contributed {compactUsd6(row.fee, sym)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Podium + ranked table for an already-sorted list.
 *
 * Paging is held here rather than by the caller because it is a property of this list and nothing
 * else on either page depends on it. `resetKey` exists because the caller's own controls (metric,
 * window, market, campaign) change which list this is, and staying on page 4 of a different list
 * would strand the reader somewhere they never chose.
 */
export function StandingsBoard({
  rows,
  metric,
  sym,
  me,
  agents,
  resetKey,
  testIdPrefix = 'standings',
}: {
  rows: StandingsRow[];
  metric: Metric;
  sym: string;
  me?: string;
  agents: Set<string>;
  resetKey?: string;
  testIdPrefix?: string;
}) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [resetKey, metric, rows.length]);

  // The columns belong to the metric, not to the table. On a volume board, "Entries" and
  // "Qualified" are Stance-epoch figures that a pure trader will always see as 0 and "—", which
  // reads as something broken or as a hurdle they have missed. Volume's own breakdown goes there
  // instead, and it adds up to the total beside it. PnL keeps the epoch columns, where they are
  // exactly the right question.
  const cols =
    metric === 'volume'
      ? 'grid-cols-[3rem_minmax(0,1fr)_auto] sm:grid-cols-[3rem_minmax(0,1fr)_5.5rem_5.5rem_5.5rem_7rem]'
      : 'grid-cols-[3rem_minmax(0,1fr)_auto] sm:grid-cols-[3rem_minmax(0,1fr)_5rem_8rem_7rem]';

  const podium = useMemo(() => rows.slice(0, 3), [rows]);
  const rest = useMemo(() => rows.slice(3), [rows]);
  const pageCount = Math.max(1, Math.ceil(rest.length / PER_PAGE));
  const current = Math.min(page, pageCount);
  const pageRows = rest.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  return (
    <>
      <div className="grid gap-4 md:grid-cols-3 md:items-end" data-testid={`${testIdPrefix}-podium`}>
        {podium.map((row, i) => (
          <PodiumCard
            key={row.address}
            row={row}
            rank={(i + 1) as 1 | 2 | 3}
            metric={metric}
            sym={sym}
            me={me}
            agents={agents}
          />
        ))}
      </div>

      {rest.length > 0 && (
        <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface" data-testid={`${testIdPrefix}-table`}>
          <div className={cn('grid items-center gap-x-3 border-b border-line px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted', cols)}>
            <span>#</span>
            <span>Address</span>
            {metric === 'volume' ? (
              <>
                <span className="hidden text-right sm:block">Swaps</span>
                <span className="hidden text-right sm:block">LP</span>
                <span className="hidden text-right sm:block">Fees</span>
              </>
            ) : (
              <>
                <span className="hidden text-right sm:block">Entries</span>
                <span className="hidden text-right sm:block">Qualified</span>
              </>
            )}
            <span className="text-right" title={metric === 'volume' ? VOLUME_TIP : PNL_TIP}>
              {metric === 'volume' ? 'Volume' : 'Realized PnL'}
            </span>
          </div>
          <ul>
            {pageRows.map((row, i) => {
              const rank = 3 + (current - 1) * PER_PAGE + i + 1;
              const isMine = (!!me && row.address.toLowerCase() === me) || agents.has(row.address.toLowerCase());
              return (
                <li
                  key={row.address}
                  data-testid={`${testIdPrefix}-row`}
                  className={cn(
                    'grid items-center gap-x-3 border-b border-line/60 px-4 py-2.5 transition-colors last:border-0',
                    cols,
                    isMine ? 'bg-brand-soft/40' : 'hover:bg-surface-muted',
                  )}
                >
                  <span className="font-mono text-sm tnum text-ink-soft">{rank}</span>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Identicon address={row.address} className="h-7 w-7 shrink-0" />
                    <a
                      href={`${ENV.EXPLORER_URL}/address/${row.address}`}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-mono text-sm text-ink hover:text-brand focus-visible:outline-none focus-visible:shadow-focus"
                    >
                      {truncate(row.address)}
                    </a>
                    <OwnerBadges address={row.address} me={me} agents={agents} />
                  </span>
                  {metric === 'volume' ? (
                    <>
                      <span className="hidden text-right font-mono text-[12.5px] tnum text-ink-soft sm:block">{compactUsd6(row.swap, sym)}</span>
                      <span className="hidden text-right font-mono text-[12.5px] tnum text-ink-soft sm:block">{compactUsd6(row.liq, sym)}</span>
                      <span className="hidden text-right font-mono text-[12.5px] tnum text-ink-soft sm:block">{compactUsd6(row.fee, sym)}</span>
                    </>
                  ) : (
                    <>
                      <span className="hidden text-right font-mono text-sm tnum text-ink-soft sm:block">{num(row.entered)}</span>
                      <span className="hidden text-right font-mono text-[12.5px] tnum text-ink-soft sm:block">{qualifyLabel(row)}</span>
                    </>
                  )}
                  <span className="text-right text-sm">
                    <MetricValue row={row} metric={metric} sym={sym} />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {rest.length > PER_PAGE && (
        <div className="mt-3">
          <Pagination page={current} pageCount={pageCount} onPageChange={setPage} label="Standings pages" />
        </div>
      )}
    </>
  );
}
