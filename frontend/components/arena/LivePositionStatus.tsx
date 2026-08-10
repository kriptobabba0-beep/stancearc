'use client';

// components/arena/LivePositionStatus.tsx — the Arena left panel's live "are positions currently
// qualifying?" widget (replaces the old per-side depth bar). In the ENTRY-ANCHORED model every
// position has its OWN entry reference price, so a UP/DOWN/RANGE split reads like misleading global
// sentiment. Instead we read every position in the current epoch (getStakesByEpoch) and, against the
// LIVE oracle price, count how many would qualify right now (their own correct side == their staked
// side). One NFT = one vote (by count). Real data — no fabricated figures.
import { useReadContract } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { usePollInterval } from '@/hooks/usePollInterval';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { adaptStakeV3, tallyQualifyingV3, type RawStakeV3 } from '@/lib/epochV3';

const QUALIFY_HEX = 'rgb(var(--c-side-up))'; // green
const NEUTRAL_HEX = 'rgb(124 136 153)'; // slate — "not qualifying" is neutral, not a loss

export function LivePositionStatus({ epochId, bandBps }: { epochId: bigint; bandBps: number }) {
  const contracts = useMarketContracts();
  const interval = usePollInterval();

  const { data: raw } = useReadContract({
    ...contracts.feeArena,
    functionName: 'getStakesByEpoch',
    args: [epochId],
    chainId: arcTestnet.id,
    query: { refetchInterval: interval },
  });
  const price18 = useOraclePrice().data?.price18 ?? 0n;

  // Active positions only (a settled epoch's rows can be unstaked); judge each against its own anchor.
  const stakes = (raw ? (raw as readonly RawStakeV3[]).map(adaptStakeV3) : []).filter((s) => !s.unstaked);
  const tally = tallyQualifyingV3(stakes, price18, bandBps);

  const hasPositions = tally.total > 0;
  const awaitingPrice = hasPositions && price18 <= 0n;
  const ready = hasPositions && !awaitingPrice;
  const qShare = ready ? (tally.qualifying / tally.total) * 100 : 0;

  return (
    <div className="space-y-2.5">
      {/* Qualifying vs not-qualifying bar (by position count). Empty track until positions + price land. */}
      <div className="flex h-9 w-full overflow-hidden rounded-lg bg-surface-inset">
        {ready && (
          <>
            <div
              className="flex min-w-0 items-center justify-center text-[12px] font-semibold tnum text-white/95"
              style={{ flexGrow: Math.max(qShare, 0.5), flexBasis: 0, backgroundColor: QUALIFY_HEX }}
            >
              {qShare >= 16 ? tally.qualifying : ''}
            </div>
            <div
              className="flex min-w-0 items-center justify-center text-[12px] font-semibold tnum text-white/95"
              style={{ flexGrow: Math.max(100 - qShare, 0.5), flexBasis: 0, backgroundColor: NEUTRAL_HEX }}
            >
              {100 - qShare >= 16 ? tally.notQualifying : ''}
            </div>
          </>
        )}
      </div>

      {/* Fixed category labels (two halves). */}
      <div className="flex w-full">
        <div className="min-w-0 flex-1 text-center text-[12px] font-semibold text-side-up">Qualifying now</div>
        <div className="min-w-0 flex-1 text-center text-[12px] font-semibold text-ink-muted">Not qualifying now</div>
      </div>

      {/* Two lines are RESERVED even when the note is one line: this block sits at the
          bottom of a stretched panel, so a market whose note wraps (the empty-state copy)
          would otherwise lift everything above it by a line — the drift the user saw when
          switching markets. */}
      <p className="min-h-[34px] text-[11px] text-ink-faint">
        {!hasPositions
          ? 'No active Stance positions yet. Status will appear once LP positions enter this epoch.'
          : awaitingPrice
            ? 'Awaiting live price…'
            : `${tally.qualifying} of ${tally.total} position${tally.total === 1 ? '' : 's'} qualifying at the current price.`}
      </p>
    </div>
  );
}
