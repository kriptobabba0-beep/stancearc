'use client';

// app/leaderboard/page.tsx — the arena standings. Two boards (VOLUME = fees put at stake,
// contract-valued in the market's quote token; PNL = collected fee shares minus forfeited
// fees), three windows (ALL / 30D / 7D), per active market. Data comes from /api/leaderboard
// — a server-side incremental index over FeeArena events — so the page costs one JSON fetch,
// not a chain scan. Top three stand on a chamfered HUD podium (gold/silver/bronze seams);
// the connected wallet and its agent session signers are badged in place.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';
import { useActiveMarket } from '@/components/MarketProvider';
import { MarketSelector } from '@/components/MarketSelector';
import { Skeleton } from '@/components/ui/Skeleton';
import { compactUsd6 } from '@/lib/identicon';
import { recentSessionAddresses } from '@/hooks/useSessionAgent';
import {
  StandingsBoard,
  MetricValue,
  parseStandings,
  sortStandings,
  qualifyLabel,
  num,
  VOLUME_TIP,
  PNL_TIP,
  type Metric,
} from '@/components/leaderboard/StandingsBoard';
import type { LeaderboardPayload } from '@/lib/leaderboardIndex';

type Window = 'all' | 'd30' | 'd7';

/** The indexer publishes every 30s; several missed rounds mean something is actually wrong. */
const STALE_AFTER_MIN = 10;

function useLeaderboardApi(marketId: string, self?: string) {
  // KV is globally replicated but eventually consistent, so two reads seconds apart can land on
  // edges at different points in that replication and the second one can be the OLDER publish.
  // Nothing is wrong when that happens — but rendering it would walk the standings backwards for
  // one refresh, which is exactly the flicker this page is supposed to have stopped doing. Keep
  // the freshest payload seen per market and never move back from it.
  const freshest = useRef<Record<string, LeaderboardPayload | undefined>>({});

  return useQuery<LeaderboardPayload, Error>({
    queryKey: ['leaderboard-api', marketId, self ?? ''],
    queryFn: async () => {
      // The board carries only its top rows. Naming the viewer lets the API attach their own
      // standing when they fall outside those — one row, looked up server-side.
      const q = self ? `&self=${encodeURIComponent(self)}` : '';
      const res = await fetch(`/api/leaderboard?market=${encodeURIComponent(marketId)}${q}`);
      if (!res.ok) throw new Error(`leaderboard API ${res.status}`);
      const next = (await res.json()) as LeaderboardPayload;
      const prev = freshest.current[marketId];
      if (prev && next.generatedAt < prev.generatedAt) return prev;
      freshest.current[marketId] = next;
      return next;
    },
    // Paced to the keeper indexer's publish interval (30s), because that is the only thing that
    // can change the answer — polling faster just re-reads identical bytes. The old 4s poll dated
    // from when a request could itself advance the index; that is now the indexer's job, and at 4s
    // requests simply queued up behind each other.
    refetchInterval: (q) => (q.state.data?.syncing ? 10_000 : 30_000),
    staleTime: 5_000,
    retry: 2,
  });
}

export default function LeaderboardPage() {
  const market = useActiveMarket();
  const { address } = useAccount();
  const { data, isLoading, isError, refetch } = useLeaderboardApi(market.id, address?.toLowerCase());

  const [metric, setMetric] = useState<Metric>('volume');
  const [windowKey, setWindowKey] = useState<Window>('all');

  // Minutes since the indexer published, or null when it is current (or has never published — a
  // cold start already shows the indexing bar, and "stale" would be the wrong word for it).
  const staleMinutes = useMemo(() => {
    const at = data?.generatedAt ?? 0;
    if (!at) return null;
    const mins = Math.floor((Date.now() - at) / 60_000);
    return mins >= STALE_AFTER_MIN ? mins : null;
  }, [data?.generatedAt]);

  // The connected wallet's agent session signers (local knowledge) — badge them in place.
  const [agents, setAgents] = useState<Set<string>>(new Set());
  useEffect(() => {
    setAgents(new Set(recentSessionAddresses().map((a) => a.toLowerCase())));
  }, [address]);

  const me = address?.toLowerCase();
  const sym = (data?.quoteSymbol ?? market.quoteSymbol ?? 'USDC') === 'EURC' ? '€' : '$';

  const sorted = useMemo(() => {
    if (!data) return [];
    const source = windowKey === 'all' ? data.rows : windowKey === 'd30' ? data.d30 : data.d7;
    const parsed = parseStandings(source);
    // A realized-PnL board lists people who actually took a Stance position. Someone who only
    // swapped has no realized PnL to report, and ranking them at zero pushes real participants
    // down the board on an address tiebreak.
    const scoped = metric === 'pnl' ? parsed.filter((r) => r.entered > 0 || r.pnl !== 0n || r.claimed !== 0n) : parsed;
    return sortStandings(scoped, metric);
  }, [data, metric, windowKey]);

  // "Your standing": best rank across the wallet AND its agent signers.
  const myStanding = useMemo(() => {
    if (sorted.length === 0) return null;
    const mine = new Set<string>([...(me ? [me] : []), ...agents]);
    if (mine.size === 0) return null;
    const idx = sorted.findIndex((r) => mine.has(r.address.toLowerCase()));
    if (idx !== -1) {
      return { rank: idx + 1, row: sorted[idx], viaAgent: !!me && sorted[idx].address.toLowerCase() !== me };
    }
    // Outside the published rows. The API looked this wallet up for us, so the standing is still
    // shown — without a rank, because knowing it would mean ordering every participant, which is
    // the download this board deliberately stopped sending.
    const own = data?.self;
    const raw = own ? (windowKey === 'all' ? own.all : windowKey === 'd30' ? own.d30 : own.d7) : null;
    if (!raw) return null;
    return { rank: null, row: parseStandings([raw])[0]!, viaAgent: false };
  }, [sorted, me, agents, data?.self, windowKey]);

  // Primary board switch: large, filled when active — it must never disappear into the page.
  const metricTab = (active: boolean) =>
    cn(
      'cursor-pointer rounded-xl px-6 py-2.5 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] transition-colors focus-visible:outline-none focus-visible:shadow-focus',
      active
        ? 'bg-brand text-white shadow-[0_0_18px_rgb(229_72_77/0.45)]'
        : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
    );

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <span className="kicker">Standings</span>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Leaderboard
          </h1>
          <p className="mt-2 max-w-xl text-sm text-ink-soft">
            See who drives market activity and who takes home the redistributed fees. Every
            figure is derived from on-chain activity on Arc and independently traceable on{' '}
            <a
              href={`${ENV.EXPLORER_URL}/address/${data?.arena ?? market.feeArena}`}
              target="_blank"
              rel="noreferrer"
              className="text-brand underline-offset-2 hover:underline"
            >
              ArcScan
            </a>
            .
          </p>
        </div>
        <MarketSelector />
      </div>

      {/* ── Totals strip ── */}
      <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-line bg-line/60 lg:grid-cols-4">
        {[
          { k: 'Participants', v: data ? num(data.totals.participants) : '—', tip: undefined as string | undefined },
          { k: 'Total volume', v: data ? compactUsd6(BigInt(data.totals.volumeUsd6), sym) : '—', tip: VOLUME_TIP },
          { k: 'Fees redistributed', v: data ? compactUsd6(BigInt(data.totals.redistributedUsd6), sym) : '—', tip: undefined },
          { k: 'Epochs settled', v: data ? num(data.totals.epochsSettled) : '—', tip: undefined },
        ].map((cell) => (
          <div key={cell.k} className="bg-surface px-4 py-3.5" title={cell.tip}>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink-muted">{cell.k}</div>
            <div className="mt-1 font-mono text-lg tnum text-ink">{cell.v}</div>
          </div>
        ))}
      </div>

      {/* ── Controls ── */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        {/* The board switch is THE control of this page — full-size segmented buttons with a
            filled crimson active state, not a quiet chip that disappears into the chrome. */}
        <div role="tablist" aria-label="Ranking metric" className="inline-flex items-center gap-1.5 rounded-2xl border border-line bg-surface-inset p-1.5">
          <button
            type="button"
            role="tab"
            aria-selected={metric === 'volume'}
            onClick={() => setMetric('volume')}
            title={VOLUME_TIP}
            className={metricTab(metric === 'volume')}
          >
            Volume
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={metric === 'pnl'}
            onClick={() => setMetric('pnl')}
            title={PNL_TIP}
            className={metricTab(metric === 'pnl')}
          >
            Realized PnL
          </button>
        </div>
        {/* Window switch wears the SAME full-size treatment as the board switch. */}
        <div role="tablist" aria-label="Time window" className="inline-flex items-center gap-1.5 rounded-2xl border border-line bg-surface-inset p-1.5">
          {(
            [
              ['all', 'All'],
              ['d30', '30d'],
              ['d7', '7d'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={windowKey === key}
              onClick={() => setWindowKey(key)}
              className={metricTab(windowKey === key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Sync progress (honest while the server index catches up) ── */}
      {data?.syncing && (
        <div className="mt-4 rounded-xl border border-side-range/30 bg-side-range-soft px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink-soft">
              Indexing on-chain history — {data.progress.toFixed(1)}%
            </span>
            <span className="hidden font-mono text-[10px] text-ink-muted sm:block">
              standings fill in live as blocks fold in
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-inset">
            <div className="h-full rounded-full bg-side-range transition-[width] duration-700" style={{ width: `${data.progress}%` }} />
          </div>
        </div>
      )}

      {/* Standings come from a single indexer. If it stops publishing the numbers below simply
          freeze, which looks identical to a quiet market — so say it plainly instead. Recomputed
          on each refetch, which is often enough for a minutes-scale staleness check. */}
      {staleMinutes !== null && (
        <div className="mt-4 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 dark:border-amber-400/25 dark:bg-amber-400/10">
          <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-amber-800 dark:text-amber-300">
            Standings last updated {staleMinutes} min ago — the indexer may be behind
          </span>
        </div>
      )}

      {/* ── Body ── */}
      {isLoading ? (
        <div className="mt-6 space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 w-full rounded-2xl" />
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="mt-6 rounded-2xl border border-side-down/30 bg-side-down-soft p-6">
          <p className="text-sm text-ink-soft">The standings service didn’t answer. It usually recovers on its own.</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-3 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-subtle-hover"
          >
            Retry now
          </button>
        </div>
      ) : sorted.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-line bg-surface p-10 text-center">
          <p className="font-display text-lg font-semibold text-ink">No standings here yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
            {data?.syncing
              ? 'The index is still folding in this market’s history — the first ranks land in a moment.'
              : 'Enter an epoch on this market and the top spot is yours by default.'}
          </p>
          <a href="/stance" className="star-btn mt-5 inline-flex h-10 items-center justify-center px-5 text-sm font-semibold">
            Open Stance
          </a>
        </div>
      ) : (
        <div className="mt-6">
          <StandingsBoard
            rows={sorted}
            metric={metric}
            sym={sym}
            me={me}
            agents={agents}
            resetKey={`${market.id}:${windowKey}`}
            testIdPrefix="leaderboard"
          />

          {/* Your standing */}
          {myStanding && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-brand/30 bg-brand-soft/50 px-4 py-3">
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-brand">Your standing</span>
              <span className="font-mono text-sm tnum text-ink">
                {myStanding.rank !== null ? `#${myStanding.rank}` : `outside top ${data?.maxRows ?? 100}`}
              </span>
              <span className="font-mono text-sm tnum text-ink-soft">
                <MetricValue row={myStanding.row} metric={metric} sym={sym} />
              </span>
              <span className="font-mono text-[11px] text-ink-muted">
                {metric === 'pnl' ? `${qualifyLabel(myStanding.row)} qualified` : ''}
                {myStanding.viaAgent ? ' · via your agent session' : ''}
              </span>
            </div>
          )}

          {/* Say so when the board is capped, rather than letting a short list imply a small arena. */}
          {data?.truncated && (
            <p className="mt-3 font-mono text-[11px] text-ink-muted">
              Showing the top {num(data.maxRows)} of {num(data.totals.participants)} participants.
            </p>
          )}

          <p className="mt-6 text-center font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-faint">
            Volume = swaps + liquidity added + fees contributed · Realized PnL = claimed fee shares - forfeited fees
          </p>
        </div>
      )}
    </div>
  );
}
