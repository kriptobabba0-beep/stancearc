'use client';

import { type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useUserStakes } from '@/hooks/useUserStakes';
import { usePreviewClaim } from '@/hooks/usePreviewClaim';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { SideBars } from '@/components/SideBars';
import { MoneyAmount, BaseAmount } from '@/components/MoneyAmount';
import { Activity } from '@/components/ui/icons';
import { PhaseView, Side, type StakeView } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';

function SideTag({ side }: { side: Side }) {
  const tone = side === Side.UP ? 'up' : side === Side.DOWN ? 'down' : side === Side.RANGE ? 'range' : 'neutral';
  return <Badge tone={tone}>{SIDE_LABELS[side]}</Badge>;
}

function PositionRow({ children, stake }: { children: ReactNode; stake: StakeView }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface-muted px-4 py-3 text-sm">
      <span className="inline-flex items-center gap-2">
        <span className="font-mono text-ink">#{stake.tokenId.toString()}</span>
        <SideTag side={stake.side} />
      </span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function PositionRealized({ epochId, stake }: { epochId: bigint; stake: StakeView }) {
  // Final numbers come from previewClaim, NOT client math. Reads are pinned by usePreviewClaim.
  const { data: preview } = usePreviewClaim(epochId, stake.tokenId);
  return (
    <div data-testid={`realized-${stake.tokenId.toString()}`}>
      <PositionRow stake={stake}>
        {!preview ? (
          '…'
        ) : preview.isWinner && (preview.payWETH > 0n || preview.payUSDC > 0n) ? (
          <span className="font-mono font-medium text-side-up">
            <BaseAmount value={preview.payWETH} /> +{' '}
            <MoneyAmount value={preview.payUSDC} token="USDC" /> USDC
          </span>
        ) : preview.isWinner ? (
          <span className="text-xs text-amber-600">
            Winning side, but no fees were available to this position this epoch - nothing to claim.
          </span>
        ) : (
          <span className="text-ink-faint">Wrong side - no reward</span>
        )}
      </PositionRow>
    </div>
  );
}

export function LiveStatus() {
  const { address, isConnected } = useAccount();
  const { data: epoch, isLoading } = useCurrentEpoch();
  const { data: stakes } = useUserStakes(address);

  if (isLoading || !epoch) {
    return (
      <SectionCard kicker="This epoch" title="Live status" icon={<Activity className="h-5 w-5" />}>
        <Skeleton className="h-32 w-full" />
      </SectionCard>
    );
  }

  const isSettled = epoch.phase === PhaseView.Settled;
  const myEpochStakes = (stakes ?? []).filter((s) => s.epochId === epoch.epochId);

  return (
    <SectionCard kicker="This epoch" title="Live status" icon={<Activity className="h-5 w-5" />}>
      <SideBars sideContribution6={epoch.sideContribution6} />

      <div className="mt-5 border-t border-line pt-4">
        <p className="mb-2.5 text-sm font-medium text-ink">Your positions this epoch</p>
        {!isConnected ? (
          <p className="text-sm text-ink-muted">Connect a wallet to see your positions.</p>
        ) : myEpochStakes.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No staked positions in epoch #{epoch.epochId.toString()}.
          </p>
        ) : (
          <div className="space-y-2">
            {myEpochStakes.map((s) =>
              isSettled ? (
                <PositionRealized key={s.tokenId.toString()} epochId={epoch.epochId} stake={s} />
              ) : (
                <PositionRow key={s.tokenId.toString()} stake={s}>
                  <span className="text-ink-faint">Outcome pending settlement</span>
                </PositionRow>
              ),
            )}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
