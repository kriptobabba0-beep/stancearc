'use client';

import { useState, type ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useUserStakes } from '@/hooks/useUserStakes';
import { useStakeWithSide } from '@/hooks/useStakeWithSide';
import { useStakeWithConviction } from '@/hooks/useStakeWithConviction';
import { useActiveMarket } from '@/components/MarketProvider';
import { isV2Market, isReadOnlyMarket } from '@/lib/markets';
import { PositionPicker } from '@/components/PositionPicker';
import { RiskAcknowledgement } from '@/components/RiskAcknowledgement';
import { SectionCard } from '@/components/ui/Card';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { ArrowUp, ArrowDown, RangeIcon, Trophy, Lock } from '@/components/ui/icons';
import { Side, PhaseView } from '@/lib/types';
import { SIDE_LABELS, isValidStakeSide } from '@/lib/side';
import { parseConvictionInput } from '@/lib/conviction';
import { formatUSDC } from '@/lib/format';
import { cn } from '@/lib/cn';

// Fallback conviction bounds (USDC 6dp) when a v2 market omits them — should not happen (markets.ts
// REQUIRES minConv/maxConv for v2) but keeps the input usable rather than crashing. 100 / 1000 USDC.
const FALLBACK_MIN_CONV = 100_000000n;
const FALLBACK_MAX_CONV = 1_000_000000n;

const STAKEABLE_SIDES: Side[] = [Side.UP, Side.DOWN, Side.RANGE];

const SIDE_ICON: Record<number, ReactNode> = {
  [Side.UP]: <ArrowUp className="h-5 w-5" />,
  [Side.DOWN]: <ArrowDown className="h-5 w-5" />,
  [Side.RANGE]: <RangeIcon className="h-5 w-5" />,
};

// Selected pill: a filled wash in the side color with a matching ring (UP green / DOWN red / RANGE blue).
const SIDE_ACTIVE: Record<number, string> = {
  [Side.UP]: 'border-side-up bg-side-up-soft text-side-up ring-1 ring-side-up-ring',
  [Side.DOWN]: 'border-side-down bg-side-down-soft text-side-down ring-1 ring-side-down-ring',
  [Side.RANGE]: 'border-side-range bg-side-range-soft text-side-range ring-1 ring-side-range-ring',
};

// One-line caption under each side so a newcomer knows what the call means.
const SIDE_CAPTION: Record<number, string> = {
  [Side.UP]: 'Breaks above the band',
  [Side.DOWN]: 'Breaks below the band',
  [Side.RANGE]: 'Stays inside the band',
};

// A numbered step header: a small pink-tile index + label. Keeps the "1 · 2 · 3" rhythm legible
// in the swap-style card without the old all-caps run-on kicker.
function StepLabel({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center gap-2">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-brand-soft text-[11px] font-semibold text-brand">
        {n}
      </span>
      <span className="text-sm font-medium text-ink">{children}</span>
    </div>
  );
}

interface StakeWithSideFormProps {
  /**
   * External pre-selected tokenId (e.g. set by the parent after ProvideLiquidity mints a new
   * position). Seeds/overrides the internal selection; the user can still change it manually.
   */
  selectedTokenId?: bigint;
  /** Called when the user changes the selected tokenId (allows the parent to stay in sync). */
  onTokenIdChange?: (tokenId: bigint | undefined) => void;
}

export function StakeWithSideForm({ selectedTokenId: externalTokenId, onTokenIdChange }: StakeWithSideFormProps = {}) {
  const { address, isConnected } = useAccount();
  const market = useActiveMarket();
  const isV2 = isV2Market(market);
  const readOnly = isReadOnlyMarket(market);
  const convBounds = {
    minConv: market.minConv ?? FALLBACK_MIN_CONV,
    maxConv: market.maxConv ?? FALLBACK_MAX_CONV,
  };
  const { data: epoch } = useCurrentEpoch();
  const { data: userStakes } = useUserStakes(address);

  // v2 markets stake WITH a USDC conviction (approve-then-stakeWithConviction); v1 markets keep the
  // version-agnostic side-only stake. Both hooks are always called (Rules of Hooks); only one is used.
  const v1Stake = useStakeWithSide();
  const v2Stake = useStakeWithConviction(convBounds);
  const { isPending, error } = isV2 ? v2Stake : v1Stake;

  const [internalTokenId, setInternalTokenId] = useState<bigint | undefined>(undefined);
  const [side, setSide] = useState<Side>(Side.NONE);
  const [acknowledged, setAcknowledged] = useState(false);
  const [convictionInput, setConvictionInput] = useState('');

  // Parse + validate the conviction text against the market bounds (v2 only).
  const convictionResult = isV2 ? parseConvictionInput(convictionInput, convBounds) : undefined;
  const convictionValid = !isV2 || (convictionResult?.ok ?? false);

  // OneSidePerEpoch (mirrors the contract rule EXACTLY): the contract locks on
  // userEpochTokenIds[user][epoch][0].side unconditionally — unstaking never pops the tokenId, so
  // the first stake of the epoch fixes the side regardless of whether it was later unstaked. ANY
  // stake whose epochId matches the current epoch therefore fixes the side for any *additional*
  // position this epoch. We deliberately do NOT filter on !s.unstaked here (that would diverge from
  // the on-chain rule). Once the side is locked the user may stake more on the SAME side but the
  // other two sides must be disabled — otherwise picking another side only fails at tx time with a
  // raw revert. (The unstaked-only divergence is currently unreachable on-chain — unstake requires
  // Settled, staking requires EntryOpen — but the UI rule is kept identical to the contract rule.)
  const lockedSide = (() => {
    if (epoch === undefined) return Side.NONE;
    for (const s of userStakes ?? []) {
      if (s.epochId === epoch.epochId && isValidStakeSide(s.side)) return s.side;
    }
    return Side.NONE;
  })();
  const isSideLocked = lockedSide !== Side.NONE;

  // When the side is locked, force the selection to the locked side (the user can still add another
  // position, but only on that side). Done during render so the lock applies even before any click.
  const effectiveSide = isSideLocked ? lockedSide : side;

  // Fix 2: if the parent supplies a new externalTokenId (e.g. from a fresh mint), adopt it as the
  // internal selection. The user can still manually override by clicking a different position row.
  const prevExternalRef = useState<bigint | undefined>(undefined);
  if (externalTokenId !== prevExternalRef[0]) {
    prevExternalRef[1](externalTokenId);
    if (externalTokenId !== undefined) {
      setInternalTokenId(externalTokenId);
    }
  }

  // The "live" tokenId: external seed (if any) merged with the user's manual choice.
  const tokenId = internalTokenId;

  const handleSelectTokenId = (id: bigint) => {
    setInternalTokenId(id);
    onTokenIdChange?.(id);
  };

  const submitStake = () => {
    if (tokenId === undefined) return;
    if (isV2) {
      if (!convictionResult?.ok) return;
      void v2Stake.stake({ tokenId, side: effectiveSide, conviction: convictionResult.value });
    } else {
      void v1Stake.stake({ tokenId, side: effectiveSide });
    }
  };

  // Read-only (legacy) markets: a deprecated arena kept reachable so pending winners can still
  // claim/unstake. NEW staking is blocked here — show a clear message instead of the stake form.
  if (readOnly) {
    return (
      <SectionCard kicker="Enter the arena" title="Stake a position" icon={<Trophy className="h-5 w-5" />}>
        <p
          data-testid="readonly-market"
          className="flex items-start gap-2 rounded-xl border border-line bg-surface-muted px-3.5 py-2.5 text-sm text-ink-muted"
        >
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            This is a <span className="font-semibold text-ink">legacy</span> arena — new staking is
            closed. Pending winners can still claim or unstake from the{' '}
            <a href="/claim" className="rounded font-medium text-brand hover:text-brand-hover focus-visible:outline-none focus-visible:shadow-focus">
              Claim
            </a>{' '}
            page. Switch to the current market to stake.
          </span>
        </p>
      </SectionCard>
    );
  }

  // Gate on CONTRACT phase, never the local clock.
  const canStakePhase = epoch?.phase === PhaseView.EntryOpen;
  const ready =
    isConnected &&
    canStakePhase &&
    tokenId !== undefined &&
    STAKEABLE_SIDES.includes(effectiveSide) &&
    acknowledged &&
    convictionValid &&
    !isPending;

  return (
    <SectionCard kicker="Enter the arena" title="Stake a position" icon={<Trophy className="h-5 w-5" />}>
      {!canStakePhase && (
        <p className="mb-4 flex items-center gap-2 rounded-2xl border border-line bg-surface-muted px-4 py-3 text-sm text-ink-muted">
          <Lock className="h-4 w-4 shrink-0" />
          Staking is only open during the Entry window. Current phase:{' '}
          {epoch ? PhaseView[epoch.phase] : '…'}.
        </p>
      )}

      <fieldset disabled={!canStakePhase} className="space-y-5 disabled:opacity-50">
        <div>
          <StepLabel n={1}>Choose a position</StepLabel>
          <PositionPicker selectedTokenId={tokenId} onSelect={handleSelectTokenId} />
        </div>

        <div>
          <StepLabel n={2}>Pick a side</StepLabel>
          {/* Segmented side control — UP green / DOWN red / RANGE blue, selected pill filled in its color. */}
          <div role="group" aria-label="Pick a side" className="grid grid-cols-3 gap-2">
            {STAKEABLE_SIDES.map((s) => {
              const active = effectiveSide === s;
              // OneSidePerEpoch: when a side is locked, every OTHER side is disabled so the user
              // can only add to the side they already back this epoch.
              const disabled = isSideLocked && s !== lockedSide;
              return (
                <button
                  key={s}
                  type="button"
                  data-testid={`side-${s}`}
                  aria-pressed={active}
                  disabled={disabled}
                  onClick={() => !isSideLocked && setSide(s)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-2xl border px-2 py-3.5 text-sm font-semibold transition-all duration-150',
                    'focus-visible:outline-none focus-visible:shadow-focus',
                    disabled
                      ? 'cursor-not-allowed border-line bg-surface-muted text-ink-faint opacity-50'
                      : 'cursor-pointer',
                    active
                      ? SIDE_ACTIVE[s]
                      : !disabled &&
                          'border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-surface-muted',
                  )}
                >
                  {SIDE_ICON[s]}
                  <span>{SIDE_LABELS[s]}</span>
                  <span
                    className={cn(
                      'text-[10.5px] font-normal leading-tight',
                      active ? 'opacity-80' : 'text-ink-faint',
                    )}
                  >
                    {SIDE_CAPTION[s]}
                  </span>
                </button>
              );
            })}
          </div>

          {isSideLocked && (
            <p
              data-testid="one-side-lock"
              className="mt-2 flex items-start gap-1.5 rounded-xl border border-line bg-surface-muted px-3.5 py-2.5 text-xs text-ink-muted"
            >
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                You&apos;ve staked the{' '}
                <span className="font-semibold text-ink">{SIDE_LABELS[lockedSide]}</span> side this
                epoch — additional positions must back the same side. You can stake more on{' '}
                {SIDE_LABELS[lockedSide]}, or unstake after settlement.
              </span>
            </p>
          )}
        </div>

        {isV2 && (
          <div>
            <StepLabel n={3}>Post your conviction</StepLabel>
            <div className="relative">
              <input
                type="text"
                inputMode="decimal"
                data-testid="conviction-input"
                aria-label="Conviction (USDC)"
                aria-invalid={convictionInput !== '' && !convictionResult?.ok}
                value={convictionInput}
                onChange={(e) => setConvictionInput(e.target.value)}
                placeholder={`${formatUSDC(convBounds.minConv)} – ${formatUSDC(convBounds.maxConv)}`}
                className="w-full rounded-2xl border border-line bg-surface px-4 py-3 pr-16 font-mono text-base tnum text-ink focus-visible:border-line-strong focus-visible:outline-none focus-visible:shadow-focus"
              />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-ink-faint">
                USDC
              </span>
            </div>

            {/* Inline bounds validation: only after the user has typed something. */}
            {convictionInput !== '' && convictionResult && !convictionResult.ok && (
              <p role="alert" data-testid="conviction-error" className="mt-1.5 text-xs text-side-down">
                {convictionResult.error}
              </p>
            )}

            <p data-testid="conviction-explainer" className="mt-2 flex items-start gap-1.5 rounded-xl border border-line bg-surface-muted px-3.5 py-2.5 text-xs text-ink-muted">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                Your <span className="font-semibold text-ink">at-risk conviction</span> ({formatUSDC(convBounds.minConv)}–
                {formatUSDC(convBounds.maxConv)} USDC) is pulled now and held by the Stance. If your side{' '}
                <span className="font-semibold text-ink">wins</span>, you get it back 1:1 plus a share of
                the pot. If your side <span className="font-semibold text-ink">loses</span>, the conviction
                is forfeited (burned to the treasury) — only stake what you can afford to lose. You&apos;ll
                approve USDC first, then stake.
              </span>
            </p>
          </div>
        )}

        <div>
          <StepLabel n={isV2 ? 4 : 3}>Acknowledge the risk</StepLabel>
          <RiskAcknowledgement acknowledged={acknowledged} onChange={setAcknowledged} />
        </div>

        <button
          type="button"
          data-testid="stake-submit"
          disabled={!ready}
          onClick={submitStake}
          className={buttonClass('primary', 'lg', 'w-full')}
        >
          {isPending ? 'Staking…' : isV2 ? 'Approve & Stake' : 'Stake'}
          <Stars />
        </button>
        <p className="-mt-2 text-center text-xs text-ink-faint">
          {isV2
            ? 'Two steps: approve USDC, then stake. Irreversible for this epoch.'
            : 'One transaction. Irreversible for this epoch.'}
        </p>

        {error && (
          <p role="alert" className="text-sm text-side-down">
            {error.message}
          </p>
        )}

        {/* 3d: make the staked → settle → claim lifecycle obvious at the point of action. */}
        <p className="flex items-start gap-1.5 text-xs text-ink-faint">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Your stake is locked for the epoch. After the epoch settles (epochs run automatically), claim
          your share of the pot or unstake from the{' '}
          <a href="/claim" className="rounded font-medium text-brand hover:text-brand-hover focus-visible:outline-none focus-visible:shadow-focus">
            Claim
          </a>{' '}
          page.
        </p>
      </fieldset>
    </SectionCard>
  );
}
