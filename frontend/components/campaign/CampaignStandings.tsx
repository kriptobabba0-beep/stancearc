'use client';

// components/campaign/CampaignStandings.tsx — one campaign: what it is worth, how far through it
// is, and who is winning it.
//
// The standings use the arena leaderboard's own board component rather than a board of their own.
// A campaign is the same question asked over a fixed range of blocks, so a reader who has learned
// to read one should not have to learn the other; and a shared component cannot drift the way two
// copies of the same markup do.
//
// Everything comes from /api/campaign, which is a KV read of what the keeper's indexer published.
// Nothing is computed in the browser: these numbers decide who gets paid, so every visitor has to
// see the same ones, and they have to match what we read when we pay out.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { compactUsd6 } from '@/lib/identicon';
import { campaignTitle, campaignProgress, ARC_SECONDS_PER_BLOCK } from '@/lib/campaignMeta';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  StandingsBoard,
  MetricValue,
  parseStandings,

  metricTabClass,
  qualifyLabel,
  num,
  VOLUME_TIP,
  PNL_TIP,
  type Metric,
} from '@/components/leaderboard/StandingsBoard';
import type { CampaignPayload } from '@/lib/leaderboardIndex';

/** The API answers `pending` for a campaign that exists but hasn't published standings yet. */
type CampaignData = Partial<CampaignPayload> & { id: string | null; pending?: boolean; live?: boolean };

export function CampaignStandings({ id }: { id?: string }) {
  const { address } = useAccount();
  const me = address?.toLowerCase();
  const [metric, setMetric] = useState<Metric>('volume');

  const { data, isLoading } = useQuery<CampaignData>({
    queryKey: ['campaign', id ?? 'current'],
    queryFn: async () => {
      const res = await fetch(id ? `/api/campaign?id=${encodeURIComponent(id)}` : '/api/campaign');
      if (!res.ok) throw new Error(`campaign API ${res.status}`);
      return (await res.json()) as CampaignData;
    },
    // Paced to the indexer's publish interval; polling faster only re-reads identical bytes.
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  // Each board arrives already ranked by its own metric, with the rank the payout will read. It
  // is shown in exactly that order and never re-sorted here: a second sort can only ever produce
  // a page that disagrees with the standings it came from, and on a prize board that disagreement
  // is the dispute.
  const rows = useMemo(() => {
    const source = metric === 'volume' ? data?.volume : data?.pnl;
    return source?.length ? parseStandings(source) : [];
  }, [data, metric]);

  const myStanding = useMemo(() => {
    if (!me || rows.length === 0) return null;
    const idx = rows.findIndex((r) => r.address.toLowerCase() === me);
    return idx === -1 ? null : { rank: idx + 1, row: rows[idx] };
  }, [rows, me]);

  const title = campaignTitle(data?.id ?? id ?? '', undefined);
  const live = data?.live !== false;
  const progress =
    data?.startBlock && data?.endBlock && data?.cursor
      ? campaignProgress(data.startBlock, data.endBlock, data.cursor)
      : null;
  const status = data?.pending ? 'Starting' : live ? 'Live' : 'Ended';
  const remaining = useMemo(() => {
    if (!live || !data?.endBlock || !data?.cursor) return null;
    try {
      const left = BigInt(data.endBlock) - BigInt(data.cursor);
      if (left <= 0n) return null;
      const mins = Math.round((Number(left) * ARC_SECONDS_PER_BLOCK) / 60);
      if (mins < 1) return 'Ends in under a minute';
      if (mins < 90) return `Ends in about ${mins} min`;
      return `Ends in about ${Math.round(mins / 60)} h`;
    } catch {
      return null;
    }
  }, [live, data?.endBlock, data?.cursor]);

  return (
    <main className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/campaign"
        className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-muted transition-colors hover:text-brand focus-visible:outline-none focus-visible:shadow-focus"
      >
        ← All campaigns
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="kicker">Campaign</span>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">{title}</h1>
          <p className="mt-2 max-w-xl text-sm text-ink-soft">
            Ranked over a fixed range of blocks. Volume rewards trading; realized Stance PnL rewards
            providing liquidity and taking a view with it. Platform wallets are excluded from both
            the rankings and the campaign total.
          </p>
        </div>
      </div>

      {/* ── Totals strip: same shape as the leaderboard's, so the two pages read alike ── */}
      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line/60 lg:grid-cols-4">
        {[
          { k: 'Status', v: status, testId: 'campaign-status' },
          {
            k: 'Prize pool',
            v: data?.prize ? `${data.prize.prizeUsd} USDC` : '—',
            testId: 'campaign-prize',
          },
          {
            k: 'Campaign volume',
            v: data?.totals ? compactUsd6(BigInt(data.totals.volumeUsd6), '$') : '—',
            testId: 'campaign-volume',
          },
          { k: 'Wallets', v: data?.totals ? num(data.totals.participants) : '—', testId: 'campaign-wallets' },
        ].map((cell) => (
          <div key={cell.k} className="bg-surface px-4 py-3.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">{cell.k}</div>
            <div className="mt-1 font-mono text-lg tnum text-ink" data-testid={cell.testId}>
              {cell.v}
            </div>
          </div>
        ))}
      </div>

      {data?.prize?.nextTierAtUsd6 && (
        <p className="mt-2 font-mono text-[11px] text-ink-muted" data-testid="campaign-next-tier">
          Next tier at {compactUsd6(BigInt(data.prize.nextTierAtUsd6), '$')} campaign volume.
        </p>
      )}

      {progress !== null && live && (
        <div className="mt-4">
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">
            {/* Blocks remaining, not a clock: the deadline IS a block, and the standings only move
                when blocks are folded in. Reading it back as minutes is the honest translation. */}
            <span>{remaining ?? 'Progress'}</span>
            <span>{Math.round(progress * 100)}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-inset">
            <div
              className="h-full rounded-full bg-brand transition-[width] duration-700"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Board switch ── */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div
          role="tablist"
          aria-label="Ranking metric"
          className="inline-flex items-center gap-1.5 rounded-2xl border border-line bg-surface-inset p-1.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={metric === 'volume'}
            onClick={() => setMetric('volume')}
            title={VOLUME_TIP}
            className={metricTabClass(metric === 'volume')}
          >
            Volume
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={metric === 'pnl'}
            onClick={() => setMetric('pnl')}
            title={PNL_TIP}
            className={metricTabClass(metric === 'pnl')}
          >
            Realized PnL
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      {isLoading ? (
        <div className="mt-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-2xl" />
            ))}
          </div>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-line bg-surface p-10 text-center" data-testid="campaign-empty">
          <p className="font-display text-lg font-semibold text-ink">No qualifying wallets yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
            {data?.pending
              ? 'This campaign has been announced but hasn’t published standings yet.'
              : 'Trade or provide liquidity while this campaign runs and the top spot is yours by default.'}
          </p>
          <a href="/swap" className="star-btn mt-5 inline-flex h-10 items-center justify-center px-5 text-sm font-semibold">
            Open Swap
          </a>
        </div>
      ) : (
        <div className="mt-6">
          <StandingsBoard
            rows={rows}
            metric={metric}
            sym="$"
            me={me}
            agents={EMPTY_AGENTS}
            resetKey={`${data?.id ?? ''}`}
            testIdPrefix="campaign"
          />

          {myStanding && (
            <div
              data-testid="campaign-my-standing"
              className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-brand/30 bg-brand-soft/50 px-4 py-3"
            >
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Your standing</span>
              <span className="font-mono text-sm tnum text-ink">#{myStanding.rank}</span>
              <span className="font-mono text-sm tnum text-ink-soft">
                <MetricValue row={myStanding.row} metric={metric} sym="$" />
              </span>
              {metric === 'pnl' && (
                <span className="font-mono text-[11px] text-ink-muted">{qualifyLabel(myStanding.row)} qualified</span>
              )}
            </div>
          )}

          {/* The rules a prize is paid on have to be readable without hovering anything. The
              claim rule especially: realized PnL counts fee shares that were CLAIMED, so a
              winner who never pressed Claim ranks below one who did, on identical trading. That
              is a surprise worth spending three lines to prevent. */}
          <div className="mt-6 rounded-xl border border-line bg-surface-muted px-4 py-3.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">How this is scored</p>
            <ul className="mt-2 space-y-1.5 text-[12px] text-ink-soft">
              <li>
                Only activity between the campaign&apos;s first and last block counts. Anything
                before or after belongs to a different period.
              </li>
              <li>
                <strong className="text-ink">Realized PnL counts fee shares you have claimed</strong>, minus
                fees you put at stake. Winnings you never claimed do not count, so claim before the
                campaign ends.
              </li>
              <li>Volume is swaps, liquidity you added and left in, and fees put at stake.</li>
              <li>
                Platform wallets are excluded from the rankings and the total. Activity that
                exploits a bug or is designed to manipulate the standings is excluded.
              </li>
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}

/** Agent badging is a leaderboard concern; a campaign ranks wallets, so there is nothing to badge. */
const EMPTY_AGENTS: Set<string> = new Set();
