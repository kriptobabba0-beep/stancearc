'use client';

// components/arena/EnterArenaRail.tsx - the Arena RIGHT column. Renders one of three states driven by
// useArenaFlow, matching the mockups:
//   • add-liquidity (1) - "How to enter the Stance": the 3-step tracker, step 1 active, CTA opens the
//                          Add-liquidity modal (or connects the wallet first).
//   • choose-side  (3) - "Enter the Stance": the available position + the side preview, CTA opens the
//                          Choose-side modal.
//   • staked       (6) - "Your Stance position": the locked stake, side, an estimated claim-if-wins, and
//                          a provisional live status.
// All values are real (positions/stakes/epoch/oracle); the estimate + live status are clearly labelled.
import { useConnect } from 'wagmi';
import { ArenaPanel, arenaButtonClass } from '@/components/arena/ArenaPanel';
import { Stars } from '@/components/ui/Stars';
import { TokenPairGlyph } from '@/components/TokenGlyph';
import { usePositionRange } from '@/components/arena/usePositionRange';
import { ARENA_SIDES, SIDE_TEXT, SIDE_DESC } from '@/components/arena/sides';
import { useActiveMarket } from '@/components/MarketProvider';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import {
  Check,
  Lock,
  Layers,
  Plus,
  ArrowUp,
  ArrowDown,
  RangeIcon,
  Bell,
  BarChart,
  Wallet,
  Faucet,
} from '@/components/ui/icons';
import { Side, type EpochView, type StakeView } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { potUsd6, formatUsd6 } from '@/lib/quant';
import { priceChangePct, formatUsdPrice18 } from '@/lib/arena';
import { entryThresholds } from '@/lib/epochV3';
import { cn } from '@/lib/cn';
import type { ArenaFlow } from '@/components/arena/useArenaFlow';
import type { ReactNode } from 'react';

const SIDE_ICON: Record<number, ReactNode> = {
  [Side.UP]: <ArrowUp className="h-4 w-4" />,
  [Side.DOWN]: <ArrowDown className="h-4 w-4" />,
  [Side.RANGE]: <RangeIcon className="h-4 w-4" />,
};

/** A small status dot + text footer ("● Wallet connected · …"). */
function StateNote({ tone, children }: { tone: 'up' | 'muted' | 'brand'; children: ReactNode }) {
  return (
    <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-muted">
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          tone === 'up' && 'bg-side-up',
          tone === 'brand' && 'bg-brand',
          tone === 'muted' && 'bg-ink-faint',
        )}
        aria-hidden="true"
      />
      {children}
    </p>
  );
}

type StepState = 'active' | 'done' | 'todo';

/**
 * One step in the tracker: a numbered/check circle on a connector rail (left), then a rounded card
 * with an ICON TILE (droplet/lock/layers - red filled when active, muted otherwise), the title +
 * badge, a one-line description, and optional right-hand extras (token pair on step 1). Matches the
 * mockup: the inner cards are rounded-rect (only the outer column is the chamfered HUD frame).
 */
function StepRow({
  n,
  last = false,
  state,
  icon,
  title,
  badge,
  right,
  chip,
  children,
}: {
  n: number;
  last?: boolean;
  state: StepState;
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  right?: ReactNode;
  /** Small bottom-right chip inside the card (the reference's "Step 1 of 3"). */
  chip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      {/* number + connector */}
      <div className="flex flex-col items-center pt-1.5">
        <span
          className={cn(
            'grid h-7 w-7 shrink-0 place-items-center rounded-full border font-mono text-[12px] font-semibold',
            state === 'done' && 'border-side-up bg-side-up/15 text-side-up',
            state === 'active' && 'border-brand bg-brand/15 text-brand',
            state === 'todo' && 'border-line text-ink-faint',
          )}
        >
          {state === 'done' ? <Check className="h-3.5 w-3.5" /> : n}
        </span>
        {!last && <span className={cn('mt-1.5 w-px flex-1', state === 'done' ? 'bg-side-up/40' : 'bg-line')} />}
      </div>
      {/* content card (rounded-rect) */}
      <div
        className={cn(
          'mb-3 flex-1 rounded-xl border px-3 py-3 transition-colors',
          state === 'active' ? 'border-brand bg-brand-soft/50' : 'border-line bg-surface-muted',
          state === 'todo' && 'opacity-70',
        )}
      >
        <div className="flex items-start gap-3">
          {/* Outlined icon tile - red-bordered with a red glyph when active (reference style). */}
          <span
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-lg border',
              state === 'active'
                ? 'border-brand bg-brand/15 text-brand'
                : 'border-line bg-surface/40 text-ink-muted',
            )}
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  'whitespace-nowrap font-mono text-[12px] font-semibold uppercase tracking-[0.05em]',
                  state === 'todo' ? 'text-ink-muted' : 'text-ink',
                )}
              >
                {title}
              </span>
              {badge}
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{children}</p>
          </div>
          {right && <div className="shrink-0 self-center">{right}</div>}
        </div>
        {chip && <div className="mt-2 flex items-center justify-between gap-2">{chip}</div>}
      </div>
    </div>
  );
}

// ── State 1: add liquidity ───────────────────────────────────────────────────────────────────────
function AddLiquidityState({ flow, baseSymbol, quoteSymbol }: { flow: ArenaFlow; baseSymbol: string; quoteSymbol: string }) {
  const { connect, connectors, isPending } = useConnect();
  const injected = connectors[0];

  return (
    <ArenaPanel joint="left" className="flex h-full flex-col px-6 py-6">
      <div className="kicker font-mono">How to enter</div>
      <h2 className="mt-1 font-display text-lg font-semibold tracking-tight text-ink">
        {flow.isConnected ? 'Add liquidity to begin' : 'Connect wallet to begin'}
      </h2>
      <p className="mt-1 text-[13px] text-ink-soft">
        If you do not have an LP position yet, you can create one in the same flow.
      </p>

      <div className="mt-5">
        <StepRow
          n={1}
          state="active"
          icon={<Faucet className="h-[18px] w-[18px]" />}
          title="Add liquidity"
          badge={
            <span className="shrink-0 rounded-full bg-brand/20 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-brand">
              Active
            </span>
          }
          chip={
            <>
              <TokenPairGlyph baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} />
              <span className="rounded-full border border-line bg-surface px-2 py-0.5 font-mono text-[10px] text-ink-muted">
                Step 1 of 3
              </span>
            </>
          }
        >
          Create an LP position.
        </StepRow>
        <StepRow n={2} state="todo" icon={<Lock className="h-[18px] w-[18px]" />} title="Choose market view">
          Select UP, DOWN, or RANGE from your entry reference price.
        </StepRow>
        <StepRow n={3} last state="todo" icon={<Layers className="h-[18px] w-[18px]" />} title="Enter epoch">
          Your LP position stays locked until settlement.
        </StepRow>
      </div>

      {/* Bottom-anchored CTA group (the panel stretches to the row height). */}
      <div className="mt-auto pt-3">
        {flow.isConnected ? (
          <button
            type="button"
            data-testid="arena-add-liquidity"
            onClick={() => flow.openModal('add-liquidity')}
            className={arenaButtonClass('primary', 'w-full star-btn--contain')}
          >
            <Plus className="h-4 w-4" /> Add liquidity
            <Stars />
          </button>
        ) : (
          <button
            type="button"
            disabled={isPending || !injected}
            onClick={() => injected && connect({ connector: injected })}
            className={arenaButtonClass('primary', 'w-full star-btn--contain')}
          >
            <Wallet className="h-4 w-4" /> {isPending ? 'Connecting…' : 'Connect Wallet'}
            <Stars />
          </button>
        )}

        <StateNote tone={flow.isConnected ? 'up' : 'muted'}>
          {flow.isConnected ? 'Wallet connected · no LP position found' : 'Connect your wallet to start'}
        </StateNote>
      </div>
    </ArenaPanel>
  );
}

// ── State 2: choose side ─────────────────────────────────────────────────────────────────────────
function ChooseSideState({ flow, baseSymbol, quoteSymbol }: { flow: ArenaFlow; baseSymbol: string; quoteSymbol: string }) {
  const range = usePositionRange(flow.selectedPosition);

  return (
    <ArenaPanel joint="left" className="flex h-full flex-col px-6 py-6">
      <div className="kicker font-mono">Enter the Stance</div>
      <h2 className="mt-1 font-display text-lg font-semibold tracking-tight text-ink">
        Choose a side for this round
      </h2>
      <p className="mt-1 text-[13px] text-ink-soft">
        You already have liquidity. Next, pick UP, DOWN, or RANGE.
      </p>

      {/* Available position */}
      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-muted px-3.5 py-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <TokenPairGlyph baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} />
          <span className="min-w-0">
            <span className="block font-mono text-[11px] uppercase tracking-wide text-ink-muted">Available position</span>
            <span className="block truncate text-sm font-semibold text-ink">
              {baseSymbol} / {quoteSymbol}
            </span>
            <span className="block truncate font-mono text-[11px] text-ink-faint">
              #{flow.selectedPosition?.tokenId.toString() ?? '-'} · {range?.label ?? '…'}
            </span>
          </span>
        </span>
        <span className="shrink-0 rounded-full border border-side-up/40 bg-side-up/10 px-2.5 py-1 text-[11px] font-semibold text-side-up">
          Ready
        </span>
      </div>

      {/* Step list (1 done · 2 active+side cards · 3 upcoming) - mockup #3. */}
      <div className="mt-4 space-y-2">
        {/* Step 1 - completed */}
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-muted px-3.5 py-2.5">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-side-up bg-side-up/15 text-side-up">
            <Check className="h-3.5 w-3.5" />
          </span>
          <span className="flex-1 text-sm font-medium text-ink">Add liquidity</span>
          <span className="text-[11px] font-medium text-side-up">Completed</span>
        </div>

        {/* Step 2 - active, with the three side cards */}
        <div className="rounded-xl border border-brand bg-brand-soft/40 px-3.5 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-brand bg-brand/15 text-[12px] font-semibold text-brand">
              2
            </span>
            <span className="flex-1 text-sm font-semibold text-ink">Choose market view</span>
            <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Active</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {ARENA_SIDES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => flow.openModal('choose-side')}
                className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface px-2 py-2.5 text-center transition-colors hover:border-line-strong hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus"
              >
                <span className={cn(SIDE_TEXT[s])}>{SIDE_ICON[s]}</span>
                <span className={cn('text-[12px] font-bold', SIDE_TEXT[s])}>{SIDE_LABELS[s]}</span>
                <span className="text-[10px] leading-tight text-ink-faint">{SIDE_DESC[s]}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Step 3 - upcoming */}
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-muted px-3.5 py-2.5 opacity-70">
          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-[12px] font-semibold text-ink-faint">
            3
          </span>
          <span className="flex-1 text-sm font-medium text-ink-muted">Enter epoch</span>
          <span className="text-[11px] text-ink-faint">Upcoming</span>
        </div>
      </div>

      {/* Bottom-anchored CTA group (the panel stretches to the row height). */}
      <div className="mt-auto pt-4">
        <button
          type="button"
          data-testid="arena-choose-side"
          onClick={() => flow.openModal('choose-side')}
          className={arenaButtonClass('primary', 'w-full star-btn--contain')}
        >
          Choose market view
          <Stars />
        </button>

        <StateNote tone="up">
          Wallet connected · {flow.stakeable.length} LP position{flow.stakeable.length === 1 ? '' : 's'} available
        </StateNote>

        <div className="mt-3 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 font-mono text-[11px] font-medium text-amber-700 dark:text-amber-300">
          <span className="font-semibold uppercase tracking-wide">State:</span>
          Has liquidity · Not yet staked
        </div>
      </div>
    </ArenaPanel>
  );
}

// ── State 3: staked ──────────────────────────────────────────────────────────────────────────────
function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line py-2.5 text-sm first:border-t-0">
      <span className="font-mono text-[11px] font-medium uppercase tracking-[0.05em] text-ink-muted">{label}</span>
      <span className="text-right font-mono tnum text-ink">{value}</span>
    </div>
  );
}

function StakedState({
  flow,
  stake,
  epoch,
  baseSymbol,
  quoteSymbol,
}: {
  flow: ArenaFlow;
  stake: StakeView;
  epoch: EpochView | undefined;
  baseSymbol: string;
  quoteSymbol: string;
}) {
  const { data: oracle } = useOraclePrice();
  const market = useActiveMarket();
  const sideLabel = SIDE_LABELS[stake.side];

  // Estimated claim-if-this-side-wins-now: your share of your side's depth × the live pot (USD). Honest
  // estimate - labelled as such; "-" when the side has no depth yet or this position is out of range.
  const sideDepth = epoch?.sideContribution6[stake.side] ?? 0n;
  const potUsdValue6 = epoch
    ? potUsd6({
        potWETH: epoch.potWETH,
        potUSDC: epoch.potUSDC,
        baseDecimals: market.baseDecimals,
        price18: oracle?.price18 ?? 0n,
      })
    : 0n;
  const estClaim6 =
    sideDepth > 0n && stake.contribution6 > 0n ? (potUsdValue6 * stake.contribution6) / sideDepth : undefined;

  // Provisional "live status": which side the live price currently favours vs this stake's side.
  // ENTRY-ANCHORED (v3) positions measure against THEIR OWN entry price; v1 measures against the
  // epoch's global start price. Same display, different reference.
  const v3Entry = (stake as StakeView & { v3?: { entryPrice18: bigint } }).v3?.entryPrice18 ?? 0n;
  const reference18 = v3Entry > 0n ? v3Entry : epoch?.startPrice18 ?? 0n;
  const liveChangePct = epoch ? priceChangePct(reference18, oracle?.price18 ?? 0n) : undefined;
  let liveStatus: { text: string; ahead: boolean | null } = {
    text: v3Entry > 0n ? 'Awaiting price' : 'Awaiting start',
    ahead: null,
  };
  if (liveChangePct !== undefined && epoch) {
    const liveBps = liveChangePct * 100;
    const band = Math.abs(epoch.bandBps);
    const leader = liveBps >= band ? Side.UP : liveBps <= -band ? Side.DOWN : Side.RANGE;
    const ahead = leader === stake.side;
    liveStatus = {
      text: ahead ? 'Currently qualifying' : 'Currently not qualifying',
      ahead,
    };
  }
  const v3Thresholds = v3Entry > 0n && epoch ? entryThresholds(v3Entry, epoch.bandBps) : undefined;

  return (
    <ArenaPanel joint="left" className="flex h-full flex-col px-6 py-6">
      <div className="kicker font-mono">Your Stance position</div>

      {/* Staked position header */}
      <div className="mt-3 flex items-center gap-3 rounded-xl border border-line bg-surface-muted px-3.5 py-3">
        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-inset', SIDE_TEXT[stake.side])}>
          {SIDE_ICON[stake.side]}
        </span>
        <span className="min-w-0">
          <span className="block font-mono text-[11px] uppercase tracking-wide text-ink-muted">Staked position</span>
          <span className="block truncate text-sm font-semibold text-ink">{baseSymbol} / {quoteSymbol}</span>
          <span className="block truncate font-mono text-[11px] text-ink-faint">#{stake.tokenId.toString()}</span>
        </span>
      </div>

      <div className="mt-4">
        {/* v3 entry anchor: the position's own reference price + the thresholds it implies. */}
        {v3Entry > 0n && (
          <Row
            label="Your entry anchor"
            value={<span className="font-semibold">{formatUsdPrice18(v3Entry)}</span>}
          />
        )}
        {v3Thresholds && (
          <Row
            label={
              stake.side === Side.UP
                ? 'Qualifies if settlement is at/above'
                : stake.side === Side.DOWN
                  ? 'Qualifies if settlement is at/below'
                  : 'Qualifies if settlement is between'
            }
            value={
              stake.side === Side.UP
                ? formatUsdPrice18(v3Thresholds.upAt)
                : stake.side === Side.DOWN
                  ? formatUsdPrice18(v3Thresholds.downAt)
                  : `${formatUsdPrice18(v3Thresholds.downAt)} - ${formatUsdPrice18(v3Thresholds.upAt)}`
            }
          />
        )}
        <Row
          label="Market view selected"
          value={<span className={cn('font-semibold', SIDE_TEXT[stake.side])}>{sideLabel}</span>}
        />
        <Row
          label="Status"
          value={
            <span className="inline-flex items-center gap-1.5 text-ink-soft">
              <Lock className="h-3.5 w-3.5" /> Locked until settlement
            </span>
          }
        />
        <Row
          label={`Est. claim if ${sideLabel} wins now`}
          value={
            estClaim6 !== undefined ? (
              <span className="text-side-up">{formatUsd6(estClaim6)}</span>
            ) : (
              <span className="text-ink-faint">-</span>
            )
          }
        />
        <Row
          label="Live status"
          value={
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                liveStatus.ahead === true && 'text-side-up',
                liveStatus.ahead === false && 'text-side-down',
                liveStatus.ahead === null && 'text-ink-muted',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  liveStatus.ahead === true && 'bg-side-up',
                  liveStatus.ahead === false && 'bg-side-down',
                  liveStatus.ahead === null && 'bg-ink-faint',
                )}
              />
              {liveStatus.text}
            </span>
          }
        />
      </div>

      <p className="mt-3 text-[11px] leading-snug text-ink-faint">
        Estimates update in real time from the oracle price. Final settlement uses the Pyth price at
        settlement time. When the round settles, your LP is returned to your wallet automatically -
        winners claim their share from below.
      </p>

      {/* Bottom-anchored action group (the panel stretches to the row height). */}
      <div className="mt-auto pt-4">
        <div className="space-y-2">
          <a
            href="#arena-claim"
            className="flex items-center justify-between rounded-xl border border-line bg-surface-muted px-3.5 py-2.5 text-sm font-medium text-ink-soft transition-colors hover:bg-surface-inset hover:text-ink"
          >
            <span className="inline-flex items-center gap-2">
              <BarChart className="h-4 w-4" /> View position
            </span>
            <span aria-hidden="true">→</span>
          </a>
          <div className="flex items-center justify-between rounded-xl border border-line bg-surface-muted px-3.5 py-2.5 text-sm font-medium text-ink-muted">
            <span className="inline-flex items-center gap-2">
              <Bell className="h-4 w-4" /> Notify me on settlement
            </span>
            <span className="text-[11px] text-ink-faint">soon</span>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2 rounded-xl border border-side-up/30 bg-side-up/10 px-3.5 py-2.5 font-mono text-[12px] font-medium text-side-up">
          <Layers className="h-4 w-4 shrink-0" />
          Liquidity added · Market view selected · Position staked
        </div>
      </div>
    </ArenaPanel>
  );
}

export function EnterArenaRail({ flow }: { flow: ArenaFlow }) {
  const market = useActiveMarket();
  const baseSymbol = market.baseSymbol;
  // The market's real quote (EURC on the EURC market) - never assume USDC.
  const quoteSymbol = market.quoteSymbol ?? 'USDC';

  if (flow.step === 'staked' && flow.currentStake) {
    return <StakedState flow={flow} stake={flow.currentStake} epoch={flow.epoch} baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} />;
  }
  if (flow.step === 'choose-side') {
    return <ChooseSideState flow={flow} baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} />;
  }
  return <AddLiquidityState flow={flow} baseSymbol={baseSymbol} quoteSymbol={quoteSymbol} />;
}
