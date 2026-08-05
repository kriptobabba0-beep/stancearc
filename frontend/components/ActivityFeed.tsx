'use client';

// components/ActivityFeed.tsx - human-readable on-chain activity. Each raw event is decoded into a
// sentence ("0xab… staked UP on epoch #42", "Epoch #7 settled - DOWN won", "0xcd… claimed 1.2 USDC
// from epoch #7") via the PURE describeEvent, with a relative-time label ("2m ago") off the resolved
// block timestamp and the chain clock. Falls back to the raw event name for any unknown event.
import { useActivityFeed } from '@/hooks/useActivityFeed';
import { useChainTime } from '@/hooks/useChainTime';
import { useActiveMarket } from '@/components/MarketProvider';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Activity, External } from '@/components/ui/icons';
import { describeEvent, relativeTime, type ActivityTone } from '@/lib/activityText';
import { ENV } from '@/lib/env';

function txUrl(hash: string): string {
  return `${ENV.EXPLORER_URL.replace(/\/$/, '')}/tx/${hash}`;
}

/** Tailwind text-color token for a sentence tone (UP/DOWN/RANGE accents; neutral/brand otherwise). */
const TONE_CLASS: Record<ActivityTone, string> = {
  neutral: 'text-ink',
  brand: 'text-brand',
  up: 'text-side-up',
  down: 'text-side-down',
  range: 'text-side-range',
};

export function ActivityFeed() {
  const { events } = useActivityFeed();
  const { now } = useChainTime();
  const market = useActiveMarket();

  return (
    <SectionCard
      kicker="On-chain"
      title="Activity"
      icon={<Activity className="h-5 w-5" />}
      action={
        <Badge tone="success" dot>
          live
        </Badge>
      }
    >
      {events.length === 0 ? (
        <p className="text-sm text-ink-muted">No recent events.</p>
      ) : (
        <ul className="-mx-1.5 max-h-80 space-y-0.5 overflow-y-auto">
          {events.map((e) => {
            const { text, tone } = describeEvent(e, {
              baseSymbol: market.baseSymbol,
              baseDecimals: market.baseDecimals,
            });
            const rel = relativeTime(e.blockTimestamp, now);
            return (
              <li
                key={e.key}
                className="flex items-center justify-between gap-3 rounded-lg px-1.5 py-2 text-sm transition-colors hover:bg-surface-muted"
              >
                <span className={`min-w-0 truncate font-medium ${TONE_CLASS[tone]}`}>{text}</span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-xs text-ink-faint">
                    {rel || `blk ${e.blockNumber.toString()}`}
                  </span>
                  <a
                    href={txUrl(e.transactionHash)}
                    target="_blank"
                    rel="noreferrer"
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
