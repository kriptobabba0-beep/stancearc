'use client';

// components/CircleActivityFeed.tsx - the LIVE arena activity feed, powered by Circle's Smart Contract
// Platform event monitors (NOT eth_getLogs - that's the separate on-chain ActivityFeed on /explore).
// Circle indexes the arena's on-chain events; we read them from /api/circle/activity (key server-side),
// decode with our ABI, and render a human, multi-market pulse with the connected wallet's rows
// highlighted. This is the user-facing surface of the Circle "Contracts" integration.
import { useAccount } from 'wagmi';
import { useArenaActivity } from '@/hooks/useArenaActivity';
import { useActiveMarket } from '@/components/MarketProvider';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Activity, External } from '@/components/ui/icons';
import { describeActivity, type ActivityTone } from '@/lib/activity/describe';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';

function txUrl(hash: string): string {
  return `${ENV.EXPLORER_URL.replace(/\/$/, '')}/tx/${hash}`;
}

const TONE_CLASS: Record<ActivityTone, string> = {
  neutral: 'text-ink',
  brand: 'text-brand',
  up: 'text-side-up',
  down: 'text-side-down',
  range: 'text-side-range',
};

export function CircleActivityFeed() {
  // Scope the feed to the SELECTED market so the cirBTC/USDC tab shows only USDC activity (not the
  // busier sibling arena's events bleeding through the shared, capped multi-market feed).
  const market = useActiveMarket();
  const { events, degraded, isLoading } = useArenaActivity(market.id);
  const { address } = useAccount();
  const me = address?.toLowerCase();

  return (
    <SectionCard
      kicker="Powered by Circle Contracts"
      title="Live Stance activity"
      icon={<Activity className="h-5 w-5" />}
      action={
        !degraded && events.length > 0 ? (
          <Badge tone="success" dot>
            live
          </Badge>
        ) : undefined
      }
      footer={<span>Indexed via Circle Smart Contract Platform event monitors (polled) · Arc Testnet</span>}
    >
      {events.length === 0 ? (
        <p
          className="text-sm text-ink-muted"
          data-testid="circle-activity-empty"
          data-state={isLoading ? 'loading' : degraded ? 'degraded' : 'empty'}
        >
          {isLoading ? 'Loading activity…' : degraded ? 'Activity is catching up…' : 'No recent Stance events.'}
        </p>
      ) : (
        <ul
          data-testid="circle-activity"
          role="log"
          aria-live="polite"
          aria-label="Live Stance activity"
          className="-mx-1.5 max-h-80 space-y-0.5 overflow-y-auto"
        >
          {events.map((e) => {
            const { text, tone } = describeActivity(e);
            const mine = !!me && e.owner?.toLowerCase() === me;
            return (
              <li
                key={e.id}
                data-testid="circle-activity-row"
                className={cn(
                  'flex items-center justify-between gap-3 rounded-lg px-1.5 py-2 text-sm transition-colors hover:bg-surface-muted',
                  mine && 'bg-brand/5 ring-1 ring-inset ring-brand/20',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {mine && (
                    <span className="shrink-0 rounded bg-brand/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand">
                      you
                    </span>
                  )}
                  <span className={cn('min-w-0 truncate font-medium', TONE_CLASS[tone])}>{text}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="hidden font-mono text-xs text-ink-faint sm:inline">{e.marketLabel}</span>
                  <a
                    href={txUrl(e.txHash)}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View the ${e.marketLabel} epoch ${e.epochId} transaction on ArcScan`}
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
                  >
                    tx
                    <External className="h-3 w-3" />
                  </a>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
