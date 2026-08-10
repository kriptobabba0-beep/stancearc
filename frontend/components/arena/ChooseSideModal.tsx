'use client';

// components/arena/ChooseSideModal.tsx — mockup #4, exact: the wide "Choose your side" dialog on the
// chamfered Arena frame.
//   Choose your side
//   Select the outcome for this round before staking.
//   [⬤⬤  SELECTED LP POSITION · cirBTC / USDC   #18 · Full range   ▾]   ← a real PICKER: clicking
//        expands the wallet's OTHER stakeable positions; selecting one re-points the whole flow.
//   [ UP ↗ ] [ DOWN ↘ ] [ RANGE ∿ ]  — zigzag trend glyphs, name, two-line meaning, hairline,
//        "Current side depth" + the big live % (sideContribution6 share).
//   [ 🗄 Current fee pot: $X │ 🕐 Entry closes in 00:04:32 ]  — split info bar, red countdown.
//   [ Back ] [ Continue to stake ]
// All values are live (depth/pot/countdown); picking a side stores it on the flow; Continue advances
// to the review modal. Staking is gated on the REAL entry phase.
import { useEffect, useState } from 'react';
import { ArenaModal, arenaButtonClass } from '@/components/arena/ArenaPanel';
import { Countdown } from '@/components/Countdown';
import { TokenPairGlyph } from '@/components/TokenGlyph';
import { usePositionRange } from '@/components/arena/usePositionRange';
import { ARENA_SIDES, SIDE_HEX, SIDE_TEXT, SIDE_DESC } from '@/components/arena/sides';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useActiveMarket } from '@/components/MarketProvider';
import { TrendUp, TrendDown, WaveRange, Check, Lock, Trophy, Clock, ChevronDown } from '@/components/ui/icons';
import { Stars } from '@/components/ui/Stars';
import { PhaseView, Side, type OwnedPosition } from '@/lib/types';
import { SIDE_LABELS, isValidStakeSide } from '@/lib/side';
import { potUsd6, formatUsd6 } from '@/lib/quant';
import { cn } from '@/lib/cn';
import type { ArenaFlow } from '@/components/arena/useArenaFlow';
import type { ReactNode } from 'react';

const SIDE_ICON: Record<number, ReactNode> = {
  [Side.UP]: <TrendUp className="h-7 w-7" />,
  [Side.DOWN]: <TrendDown className="h-7 w-7" />,
  [Side.RANGE]: <WaveRange className="h-7 w-7" />,
};

/** One selectable position row in the expanded picker (band label resolved per position). */
function PositionOption({
  position,
  selected,
  onSelect,
}: {
  position: OwnedPosition;
  selected: boolean;
  onSelect: () => void;
}) {
  const range = usePositionRange(position);
  return (
    <button
      type="button"
      data-testid={`csm-position-${position.tokenId.toString()}`}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:shadow-focus',
        selected
          ? 'border-brand bg-brand-soft/40'
          : 'border-line bg-surface hover:border-line-strong hover:bg-surface-inset',
      )}
    >
      <span className="inline-flex min-w-0 items-center gap-2">
        <span
          className={cn(
            'grid h-4 w-4 shrink-0 place-items-center rounded-full border',
            selected ? 'border-brand bg-brand text-white' : 'border-line text-transparent',
          )}
        >
          <Check className="h-2.5 w-2.5" />
        </span>
        <span className="font-mono text-sm text-ink">#{position.tokenId.toString()}</span>
      </span>
      <span className="truncate font-mono text-[11px] text-ink-muted">
        {range?.label ?? '…'}
        {range?.outOfRange && <span className="text-amber-700 dark:text-amber-300"> · out of range</span>}
      </span>
    </button>
  );
}

export function ChooseSideModal({ flow }: { flow: ArenaFlow }) {
  const { data: epoch } = useCurrentEpoch();
  const { data: oracle } = useOraclePrice();
  const market = useActiveMarket();
  const range = usePositionRange(flow.selectedPosition);
  const [pickerOpen, setPickerOpen] = useState(false);

  const open = flow.modal === 'choose-side';
  // Collapse the picker whenever the modal closes/reopens.
  useEffect(() => {
    if (!open) setPickerOpen(false);
  }, [open]);

  const potUsd6Value = epoch
    ? potUsd6({
        potWETH: epoch.potWETH,
        potUSDC: epoch.potUSDC,
        baseDecimals: market.baseDecimals,
        price18: oracle?.price18 ?? 0n,
      })
    : 0n;

  const entryOpen = epoch?.phase === PhaseView.EntryOpen;
  const canContinue = isValidStakeSide(flow.selectedSide) && entryOpen;
  const hasAlternatives = flow.stakeable.length > 1;

  return (
    <ArenaModal open={open} onClose={flow.closeModal} className="max-w-2xl">
      <div className="text-center">
        <h2 className="font-mono text-2xl font-semibold tracking-tight text-ink">Choose market view</h2>
        <p className="mt-1 text-sm text-ink-soft">Select how the selected market should settle relative to your entry reference price.</p>
      </div>

      {/* Selected LP position — a real picker over every stakeable position in the wallet. */}
      <button
        type="button"
        data-testid="csm-position-toggle"
        aria-expanded={pickerOpen}
        onClick={() => hasAlternatives && setPickerOpen((o) => !o)}
        className={cn(
          'mt-5 flex w-full items-center gap-3 rounded-xl border border-line bg-surface-muted px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:shadow-focus',
          hasAlternatives && 'cursor-pointer hover:border-line-strong hover:bg-surface-inset',
        )}
      >
        <TokenPairGlyph baseSymbol={market.baseSymbol} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-wide text-ink-muted">
              Selected LP position
            </span>
            <span className="text-ink-faint" aria-hidden="true">
              ·
            </span>
            <span className="truncate text-sm font-semibold text-ink">{market.baseSymbol} / USDC</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[12px] text-ink-soft">
            #{flow.selectedPosition?.tokenId.toString() ?? '—'} · {range?.label ?? '…'}
          </span>
        </span>
        {hasAlternatives && (
          <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-ink-muted">
            {flow.stakeable.length} positions
            <ChevronDown className={cn('h-4 w-4 transition-transform', pickerOpen && 'rotate-180')} />
          </span>
        )}
      </button>
      {pickerOpen && (
        <div className="mt-1.5 space-y-1.5" data-testid="csm-position-list">
          {flow.stakeable.map((p) => (
            <PositionOption
              key={p.tokenId.toString()}
              position={p}
              selected={p.tokenId === flow.selectedTokenId}
              onSelect={() => {
                flow.setSelectedTokenId(p.tokenId);
                setPickerOpen(false);
              }}
            />
          ))}
        </div>
      )}

      {/* The LP range + entry-anchored threshold explainer. */}
      <p className="mt-2 text-[11px] leading-snug text-ink-muted">
        This is your LP price range. Market view thresholds are based on your entry reference price.
      </p>

      {/* Side cards — zigzag trend glyphs + the entry-anchored meaning per side. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {ARENA_SIDES.map((s) => {
          const selected = flow.selectedSide === s;
          return (
            <button
              key={s}
              type="button"
              data-testid={`choose-side-${s}`}
              aria-pressed={selected}
              onClick={() => flow.setSelectedSide(s)}
              className={cn(
                'relative flex flex-col items-center gap-1.5 rounded-2xl border px-3 py-6 text-center transition-all focus-visible:outline-none focus-visible:shadow-focus',
                selected ? 'bg-surface-inset' : 'border-line bg-surface-muted hover:border-line-strong hover:bg-surface-inset',
              )}
              style={
                selected
                  ? { borderColor: SIDE_HEX[s], boxShadow: `0 0 0 1px ${SIDE_HEX[s]}, 0 0 28px -14px ${SIDE_HEX[s]}` }
                  : undefined
              }
            >
              {selected && (
                <span
                  className="absolute right-2.5 top-2.5 grid h-5 w-5 place-items-center rounded-full text-white"
                  style={{ backgroundColor: SIDE_HEX[s] }}
                >
                  <Check className="h-3 w-3" />
                </span>
              )}
              <span className={cn(SIDE_TEXT[s])}>{SIDE_ICON[s]}</span>
              <span className={cn('text-lg font-bold tracking-tight', SIDE_TEXT[s])}>{SIDE_LABELS[s]}</span>
              <span className="min-h-9 text-[12px] leading-snug text-ink-muted">{SIDE_DESC[s]}</span>
            </button>
          );
        })}
      </div>

      {/* Split info bar: live pot │ entry countdown (red while open). */}
      <div className="mt-4 flex items-stretch divide-x divide-line rounded-xl border border-line bg-surface-muted text-sm">
        <span className="inline-flex flex-1 items-center justify-center gap-2 px-4 py-3 text-ink-soft">
          <Trophy className="h-4 w-4 shrink-0 text-ink-muted" />
          Fee pool:{' '}
          <span className="font-mono font-semibold tnum text-ink">{formatUsd6(potUsd6Value)}</span>
        </span>
        <span className="inline-flex flex-1 items-center justify-center gap-2 px-4 py-3 text-ink-soft">
          <Clock className="h-4 w-4 shrink-0 text-ink-muted" />
          Entry closes in{' '}
          {epoch && entryOpen ? (
            <Countdown target={epoch.entryCloseTime} className="text-brand" />
          ) : (
            <span className="text-ink-muted">closed</span>
          )}
        </span>
      </div>

      {!entryOpen && (
        <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-amber-700 dark:text-amber-300">
          <Lock className="h-3.5 w-3.5" /> Staking is only open during the entry window.
        </p>
      )}

      {/* Actions */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button type="button" onClick={flow.closeModal} className={arenaButtonClass('secondary')}>
          Back
          <Stars />
        </button>
        <button
          type="button"
          data-testid="choose-side-continue"
          disabled={!canContinue}
          onClick={() => flow.openModal('stake-review')}
          className={arenaButtonClass('primary')}
        >
          Continue to stake
          <Stars />
        </button>
      </div>
    </ArenaModal>
  );
}
