'use client';

// components/EpochProofDetail.tsx - the provably-fair reconstruction of one settled epoch. Everything
// shown here is derived ONLY from on-chain events (+ the band read from the epoch struct), so a user
// can VERIFY the settlement was honest end-to-end:
//   1. ORACLE MOVE   - start price → settle price (from EpochStarted / EpochResolved), the signed Δbps,
//                      and the band. We RE-APPLY the rule (deriveWinningSide) and badge whether the
//                      reconstructed winner matches the event's reported winner.
//   2. PROVENANCE    - the Pyth feed id (immutable, from market config) + the latest on-chain publish
//                      time + confidence interval, so the price source is auditable.
//   3. POT SPLIT     - per-position owner / side / contribution6 / floor payout, summing to the pot.
import Link from 'next/link';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { useEpochProof } from '@/hooks/useEpochProof';
import { usePythProvenance } from '@/hooks/usePythProvenance';
import { useActiveMarket } from '@/components/MarketProvider';
import { SectionCard } from '@/components/ui/Card';
import { DataRow, Stat } from '@/components/ui/Data';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { BaseAmount, MoneyAmount } from '@/components/MoneyAmount';
import { Shield, Clock, Trophy, Check, Alert, External } from '@/components/ui/icons';
import { SIDE_LABELS } from '@/lib/side';
import { Side } from '@/lib/types';
import { formatDeltaBps, formatBps, formatPrice18 } from '@/lib/format';
import { formatPythPrice, formatUnixTime } from '@/lib/oracleFormat';
import { priceSymbol } from '@/lib/quant';
import type { EpochProof, ProofPosition } from '@/lib/epochProof';
import { ENV } from '@/lib/env';

const SIDE_TONE: Record<Side, 'neutral' | 'up' | 'down' | 'range'> = {
  [Side.NONE]: 'neutral',
  [Side.UP]: 'up',
  [Side.DOWN]: 'down',
  [Side.RANGE]: 'range',
};

function SideBadge({ side }: { side: Side }) {
  return <Badge tone={SIDE_TONE[side]}>{SIDE_LABELS[side]}</Badge>;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** "Reconstructed winner matches the on-chain settlement" verdict badge. */
function VerificationBadge({ proof }: { proof: EpochProof }) {
  if (proof.winningSideVerified === undefined) {
    return <Badge tone="neutral">not yet resolved</Badge>;
  }
  return proof.winningSideVerified ? (
    <Badge tone="success" dot>
      <Check className="h-3.5 w-3.5" /> verified
    </Badge>
  ) : (
    <Badge tone="warning">
      <Alert className="h-3.5 w-3.5" /> mismatch
    </Badge>
  );
}

function PotSplitRow({ pos, baseSymbol }: { pos: ProofPosition; baseSymbol: string }) {
  return (
    <tr className="border-b border-line/60 last:border-0">
      <td className="py-2.5 pr-3 font-mono text-xs tnum text-ink">#{pos.tokenId.toString()}</td>
      <td className="py-2.5 pr-3 font-mono text-xs text-ink-soft">
        {pos.owner === '0x0000000000000000000000000000000000000000' ? (
          <span className="text-ink-faint">unknown</span>
        ) : (
          <a
            href={`${ENV.EXPLORER_URL.replace(/\/$/, '')}/address/${pos.owner}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-brand"
          >
            {short(pos.owner)}
            <External className="h-3 w-3" />
          </a>
        )}
      </td>
      <td className="py-2.5 pr-3">
        <SideBadge side={pos.side} />
      </td>
      <td className="py-2.5 pr-3 text-right font-mono text-xs tnum text-ink-soft">
        <MoneyAmount value={pos.contribution6} token="USDC" />
      </td>
      <td className="py-2.5 pr-3">
        {pos.isWinner ? (
          <Badge tone="success">won</Badge>
        ) : (
          <span className="text-xs text-ink-faint">-</span>
        )}
      </td>
      <td className="py-2.5 text-right font-mono text-xs tnum text-ink">
        {pos.isWinner ? (
          <>
            <BaseAmount value={pos.payBase} />
            <span className="block text-ink-soft">
              <MoneyAmount value={pos.payUSDC} token="USDC" /> USDC
            </span>
          </>
        ) : (
          <span className="text-ink-faint">0 {baseSymbol}</span>
        )}
      </td>
    </tr>
  );
}

export function EpochProofDetail({ epochId }: { epochId: bigint }) {
  const market = useActiveMarket();
  const { data: proof, isLoading, isError } = useEpochProof(epochId);
  const { data: provenance, feedId } = usePythProvenance();
  const sym = priceSymbol(market.baseSymbol);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError) {
    return (
      <SectionCard kicker="Provably fair" title={`Epoch #${epochId.toString()}`} icon={<Shield className="h-5 w-5" />}>
        <p className="text-sm text-ink-muted">
          Couldn’t reconstruct this epoch from on-chain events. It will retry shortly.
        </p>
      </SectionCard>
    );
  }

  if (!proof) {
    return (
      <SectionCard kicker="Provably fair" title={`Epoch #${epochId.toString()}`} icon={<Shield className="h-5 w-5" />}>
        <p className="text-sm text-ink-muted">No on-chain record for this epoch yet.</p>
      </SectionCard>
    );
  }

  const winningLabel =
    proof.winningSide !== Side.NONE ? SIDE_LABELS[proof.winningSide] : SIDE_LABELS[Side.RANGE];
  const headline = proof.rolledOver
    ? 'Pot rolled forward - no winner'
    : proof.settled
      ? `${winningLabel} won`
      : 'Epoch in progress';

  return (
    <div className="space-y-5">
      {/* Verdict + verification */}
      <SectionCard
        kicker="Provably fair · reconstructed from on-chain events"
        title={`Epoch #${epochId.toString()}`}
        icon={<Trophy className="h-5 w-5" />}
        action={<VerificationBadge proof={proof} />}
      >
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-display text-2xl font-semibold tracking-tight text-ink">{headline}</p>
          {proof.settled && !proof.rolledOver && <SideBadge side={proof.winningSide} />}
        </div>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          Every number below is derived only from this market’s on-chain events plus the epoch’s band.
          The settlement rule is re-applied here so you can confirm the winner was decided honestly.
        </p>
      </SectionCard>

      {/* Oracle move → winning side */}
      <SectionCard
        kicker="The oracle move"
        title={`${market.priceLabel ?? `${sym}/USD`} · start → settle`}
        icon={<Clock className="h-5 w-5" />}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Start price" value={formatPrice18(proof.startPrice18)} sub={formatUnixTime(proof.startTimeActual)} />
          <Stat
            label="Settle price"
            value={proof.settlePrice18 !== undefined ? formatPrice18(proof.settlePrice18) : '-'}
            sub={formatUnixTime(proof.settleTimeActual)}
          />
          <Stat
            label="Δ vs band"
            value={proof.deltaBps !== undefined ? formatDeltaBps(proof.deltaBps) : '-'}
            sub={`band ±${formatBps(proof.bandBps)}`}
          />
        </div>

        <div className="mt-4 rounded-xl border border-line bg-surface-muted px-4 py-3">
          <dl>
            <DataRow label="Reported winner (event)">
              {proof.winningSide !== Side.NONE ? <SideBadge side={proof.winningSide} /> : '-'}
            </DataRow>
            <DataRow label="Reconstructed winner (Δ vs band)">
              {proof.derivedWinningSide !== undefined ? <SideBadge side={proof.derivedWinningSide} /> : '-'}
            </DataRow>
            <DataRow label="Match">
              <VerificationBadge proof={proof} />
            </DataRow>
          </dl>
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Rule: a move strictly beyond ±band is directional (UP if the price rose, DOWN if it fell); a
          move within ±band is a RANGE win.
        </p>
      </SectionCard>

      {/* Oracle provenance */}
      <SectionCard kicker="Oracle provenance" title="Pyth price feed" icon={<Shield className="h-5 w-5" />}>
        <dl>
          <DataRow label="Feed id">
            <span className="break-all text-xs">{feedId}</span>
          </DataRow>
          <DataRow label="Latest on-chain price">
            {provenance ? formatPythPrice(provenance.price, provenance.expo) : '-'}
          </DataRow>
          <DataRow label="Confidence (±)">
            {provenance ? formatPythPrice(provenance.conf, provenance.expo) : '-'}
          </DataRow>
          <DataRow label="Last publish time">
            {provenance ? formatUnixTime(provenance.publishTime) : '-'}
          </DataRow>
        </dl>
        <p className="mt-3 text-xs text-ink-muted">
          The feed id is immutable for this market. The settle price above is the value Pyth published
          at settlement (recorded in the EpochResolved event); the live tuple here lets you cross-check
          the same feed on Pyth’s explorer.
        </p>
      </SectionCard>

      {/* Pot split */}
      <SectionCard
        kicker="The split"
        title="Per-position contributions & payouts"
        icon={<Trophy className="h-5 w-5" />}
        action={
          <Badge tone="neutral">
            {proof.winnerCount} {proof.winnerCount === 1 ? 'winner' : 'winners'}
          </Badge>
        }
      >
        {!proof.settled ? (
          <p className="text-sm text-ink-muted">This epoch hasn’t settled yet - no split to show.</p>
        ) : proof.positions.length === 0 ? (
          <p className="text-sm text-ink-muted">No staked positions were recorded for this epoch.</p>
        ) : (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-2">
              <Stat
                label="Pot (base)"
                value={<BaseAmount value={proof.potBase} />}
                sub="forfeited fees - base leg"
              />
              <Stat
                label="Pot (USDC)"
                value={<MoneyAmount value={proof.potUSDC} token="USDC" />}
                sub="forfeited fees - USDC leg"
              />
            </div>
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="pb-2 pr-3 kicker font-normal">Position</th>
                    <th className="pb-2 pr-3 kicker font-normal">Owner</th>
                    <th className="pb-2 pr-3 kicker font-normal">Side</th>
                    <th className="pb-2 pr-3 kicker font-normal text-right">Contribution</th>
                    <th className="pb-2 pr-3 kicker font-normal">Result</th>
                    <th className="pb-2 kicker font-normal text-right">Payout</th>
                  </tr>
                </thead>
                <tbody>
                  {proof.positions.map((pos) => (
                    <PotSplitRow key={pos.tokenId.toString()} pos={pos} baseSymbol={market.baseSymbol} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-muted">
              Each winner’s payout = pot × (their contribution ÷ winner denominator), floored - summing
              to the pot. Winner denominator: <span className="font-mono">{proof.winnerDenominator.toString()}</span>.
            </p>
          </>
        )}
      </SectionCard>

      <div>
        <Link href="/" className={buttonClass('secondary', 'md')}>
          ← Back to the Arena
          <Stars />
        </Link>
      </div>
    </div>
  );
}
