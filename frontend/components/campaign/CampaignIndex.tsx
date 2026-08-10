'use client';

// components/campaign/CampaignIndex.tsx — what /campaign opens on: every campaign that has run,
// split into the one you can still place in and the ones that are settled.
//
// Running first and finished after, because the split is the reader's actual question. Someone
// arriving at this page either wants to know where they stand in something live, or wants to look
// up a result — and those are different enough that a single merged list would serve neither.
//
// Each card is a link, not a card with a link in it: the whole box is the target, so it works the
// same whether you click the title, the prize or the empty space beside them.
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/cn';
import { compactUsd6 } from '@/lib/identicon';
import { campaignProgress } from '@/lib/campaignMeta';
import { Skeleton } from '@/components/ui/Skeleton';

export interface CampaignSummary {
  id: string;
  title: string;
  live: boolean;
  startBlock: string;
  endBlock: string;
  cursor: string;
  generatedAt: number;
  volumeUsd6: string;
  participants: number;
  prizeUsd: number;
}

const num = (n: number) => n.toLocaleString('en-US');

function StatusPill({ live }: { live: boolean }) {
  return (
    <span
      data-testid="campaign-card-status"
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em]',
        live ? 'bg-brand/15 text-brand' : 'bg-surface-inset text-ink-muted',
      )}
    >
      {live && (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_6px_rgb(var(--c-brand))]" />
      )}
      {live ? 'Live' : 'Ended'}
    </span>
  );
}

function CampaignCard({ c }: { c: CampaignSummary }) {
  // Progress is measured in blocks because the campaign's own boundaries are blocks; the clock
  // would drift from the standings, which only move when blocks are folded in.
  const progress = c.live ? campaignProgress(c.startBlock, c.endBlock, c.cursor ?? c.startBlock) : null;
  return (
    <Link
      href={`/campaign/${encodeURIComponent(c.id)}`}
      data-testid="campaign-card"
      className="group block rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-brand/40 hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-display text-lg font-semibold tracking-tight text-ink transition-colors group-hover:text-brand">
          {c.title}
        </h3>
        <StatusPill live={c.live} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div>
          <div className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Prize pool</div>
          <div className="mt-0.5 font-mono text-[15px] tnum text-ink">{c.prizeUsd} USDC</div>
        </div>
        <div>
          <div className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Volume</div>
          <div className="mt-0.5 font-mono text-[15px] tnum text-ink">
            {compactUsd6(BigInt(c.volumeUsd6 || '0'), '$')}
          </div>
        </div>
        <div>
          <div className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Wallets</div>
          <div className="mt-0.5 font-mono text-[15px] tnum text-ink">{num(c.participants)}</div>
        </div>
      </div>

      {progress !== null && (
        <div className="mt-4 h-1 overflow-hidden rounded-full bg-surface-inset">
          <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </Link>
  );
}

function Group({ label, note, campaigns }: { label: string; note: string; campaigns: CampaignSummary[] }) {
  if (campaigns.length === 0) return null;
  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-3">
        <h2 className="kicker">{label}</h2>
        <span className="font-mono text-[11px] text-ink-muted">{note}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {campaigns.map((c) => (
          <CampaignCard key={c.id} c={c} />
        ))}
      </div>
    </section>
  );
}

export function CampaignIndex() {
  const { data, isLoading } = useQuery<{ campaigns: CampaignSummary[] }>({
    queryKey: ['campaigns'],
    queryFn: async () => {
      const res = await fetch('/api/campaigns');
      if (!res.ok) throw new Error(`campaigns API ${res.status}`);
      return (await res.json()) as { campaigns: CampaignSummary[] };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const all = data?.campaigns ?? [];
  const active = all.filter((c) => c.live);
  const finished = all.filter((c) => !c.live);

  return (
    <main className="mx-auto w-full max-w-[1100px] px-4 py-10 sm:px-6 lg:px-8">
      <p className="kicker">Campaigns</p>
      <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-ink">Testnet campaigns</h1>
      <p className="mt-3 max-w-2xl text-[15px] text-ink-soft">
        Ranked contests over a fixed range of blocks. Volume rewards trading; realized Stance PnL
        rewards providing liquidity and taking a view with it. Open a campaign to see its standings
        and how its prize pool is set.
      </p>

      {isLoading ? (
        <div className="mt-8 grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-2xl" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-line bg-surface p-10 text-center" data-testid="campaign-index-empty">
          <p className="font-display text-lg font-semibold text-ink">No campaigns yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
            When one starts it appears here, with its standings updating live while it runs.
          </p>
        </div>
      ) : (
        <>
          <Group label="Active" note="still running — standings update live" campaigns={active} />
          <Group label="Finished" note="settled — final standings" campaigns={finished} />
        </>
      )}
    </main>
  );
}
