'use client';

// components/pool/PoolStatHeader.tsx — the three headline cards on the Pool list page: TVL, 24h Volume,
// 24h Fees, each with a real sparkline (lib/poolStats over real on-chain data). Rendered in the app's
// HUD card language with the semantic trio for the three hues (crimson / green / blue). TVL lands first
// (fast reserves query); Volume + Fees fill in when the 24h Swap-event scan resolves.
import { usePoolStats } from '@/hooks/usePoolStats';
import { formatUsd } from '@/lib/poolStats';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Sparkline } from '@/components/pool/Sparkline';
import { cn } from '@/lib/cn';

function StatCard({
  label,
  value,
  loading,
  series,
  tone,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  series: number[];
  /** Sparkline hue via a text-* class (currentColor). */
  tone: string;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5">
        <span className="kicker">{label}</span>
        {value === undefined ? (
          loading ? (
            <Skeleton className="mt-2 h-8 w-40 rounded-md" />
          ) : (
            <div className="mt-1.5 font-mono text-2xl font-semibold text-ink-muted">—</div>
          )
        ) : (
          <div className="mt-1.5 font-mono text-[26px] font-semibold tracking-tight text-ink tnum sm:text-3xl">
            {formatUsd(value)}
          </div>
        )}
      </div>
      <div className={cn('mt-4', tone)}>
        <Sparkline data={series} height={64} />
      </div>
    </Card>
  );
}

export function PoolStatHeader() {
  const { totals, spark, isLoadingTvl, isLoadingFlow } = usePoolStats();
  return (
    <div className="grid gap-4 sm:grid-cols-3 motion-safe:animate-fade-up">
      <StatCard
        label="TVL"
        value={totals.tvlUsd}
        loading={isLoadingTvl}
        series={spark.tvl}
        tone="text-brand"
      />
      <StatCard
        label="24h Volume"
        value={totals.volume24Usd}
        loading={isLoadingFlow}
        series={spark.volume}
        tone="text-side-up"
      />
      <StatCard
        label="24h Fees"
        value={totals.fees24Usd}
        loading={isLoadingFlow}
        series={spark.fees}
        tone="text-side-range"
      />
    </div>
  );
}
