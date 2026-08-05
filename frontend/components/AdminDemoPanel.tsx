'use client';

import { useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useSweepProgress } from '@/hooks/useSweepProgress';
import { useIsOwner } from '@/hooks/useIsOwner';
import { useAdminCranks, useApproveExact, useRouterAllowance, type CrankSlot } from '@/hooks/useAdminCranks';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Modal } from '@/components/ui/Modal';
import { Skeleton } from '@/components/ui/Skeleton';
import { TxButton } from '@/components/TxButton';
import { MoneyAmount } from '@/components/MoneyAmount';
import { useActiveMarket } from '@/components/MarketProvider';
import { Activity, Trophy, Clock, Settings, Alert, RangeIcon } from '@/components/ui/icons';
import { PhaseView, Side } from '@/lib/types';
import { sideLabel } from '@/lib/side';
import { ENV } from '@/lib/env';
import { parseUnits } from 'viem';

// Approved demo timings (spec §Decisions): 2 min entry / 5 min epoch, 30s gap, 10 min delays.
const DEMO_TIMING = {
  entryWindow: 120,
  epochDuration: 300,
  minStartGap: 30,
  maxStartDelay: 600,
  maxPriceAge: 600,
};
const STALE_AGE_SECONDS = 600n; // mirror maxPriceAge demo default for the disable guard
const SWEEP_BATCH = 20n;

/** Adapter: wraps a CrankSlot into TxButton's expected props. */
function CrankButton<A>({
  label,
  slot,
  disabled,
  title,
  onRun,
}: {
  label: string;
  slot: CrankSlot<A>;
  disabled?: boolean;
  title?: string;
  onRun: () => void;
}) {
  return (
    <TxButton
      label={label}
      disabled={disabled || slot.isPending || slot.isConfirming}
      isPending={slot.isPending || slot.isConfirming}
      onClick={onRun}
      txHash={slot.hash}
      className={title ? 'cursor-not-allowed' : undefined}
    />
  );
}

const inputClass =
  'h-9 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink transition-shadow focus-visible:shadow-focus focus-visible:outline-none';

export function AdminDemoPanel() {
  const { isOwner, isLoading: ownerLoading } = useIsOwner();
  const market = useActiveMarket();
  // Prefer the market's explicit priceLabel (e.g. "BTC / USD") when configured; otherwise derive a
  // label from the base symbol (strip a leading "W" so WBTC -> "BTC/USD"). cirBTC keeps its W-strip
  // fallback of "cirBTC/USD" unless the market sets priceLabel.
  const priceLabel = market.priceLabel ?? `${market.baseSymbol.replace(/^W/i, '')}/USD`;
  const { address } = useAccount();
  const { data: epoch, isLoading: epochLoading } = useCurrentEpoch();
  const { data: oracle } = useOraclePrice();
  const cranks = useAdminCranks();
  const approve = useApproveExact();

  const epochId = epoch?.epochId;
  const { data: sweep } = useSweepProgress(epochId ?? 0n);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPayload, setConfirmPayload] = useState<{
    title: string;
    body: string;
    onConfirm: () => void;
  } | null>(null);
  const [swapAmount, setSwapAmount] = useState('0.1'); // base-token units (e.g. WETH / WBTC)
  const [swapDir, setSwapDir] = useState<'BASE_TO_USDC' | 'USDC_TO_BASE'>('BASE_TO_USDC');

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const oracleZero = !oracle || oracle.price18 === 0n;
  const oracleStale = !!oracle && oracle.updatedAt > 0n && nowSec > oracle.updatedAt + STALE_AGE_SECONDS;

  const phase = epoch?.phase;
  const sweepDone = sweep ? sweep.done >= sweep.total && sweep.total > 0 : false;

  // Outcome preview before endEpoch: compare current oracle price to startPrice18 + band.
  const outcomePreview = useMemo(() => {
    if (!epoch || epoch.startPrice18 === 0n || !oracle || oracle.price18 === 0n) return null;
    const BPS = 10_000n;
    const delta = ((oracle.price18 - epoch.startPrice18) * BPS) / epoch.startPrice18;
    const band = BigInt(epoch.bandBps);
    const side = delta > band ? Side.UP : delta < -band ? Side.DOWN : Side.RANGE;
    return { delta, side };
  }, [epoch, oracle]);

  if (ownerLoading || epochLoading) return <Skeleton className="h-64 w-full rounded-2xl" />;

  if (!isOwner) {
    return (
      <SectionCard title="Operator controls" icon={<Settings className="h-5 w-5" />}>
        <p className="text-sm text-ink-muted">
          Read-only: admin/demo controls are shown only to the contract owner. The contract enforces
          ownership regardless.
        </p>
      </SectionCard>
    );
  }

  const onSettled = () => {
    /* useAdminCranks already invalidates queries; nothing extra needed here */
  };

  const openConfirm = (title: string, body: string, onConfirm: () => void) => {
    setConfirmPayload({ title, body, onConfirm });
    setConfirmOpen(true);
  };

  const closeConfirm = () => {
    setConfirmOpen(false);
    setConfirmPayload(null);
  };

  return (
    <div className="space-y-5">
      {/* ---- Lifecycle cranks (ordering guards via PhaseView) ---- */}
      <SectionCard kicker="Step 1" title="Lifecycle" icon={<Activity className="h-5 w-5" />}>
        <div className="flex flex-wrap gap-2">
          <CrankButton
            label="createEpoch"
            slot={cranks.createEpoch}
            disabled={phase !== undefined && phase !== PhaseView.Idle && phase !== PhaseView.Settled}
            onRun={() => cranks.createEpoch.run(undefined, onSettled)}
          />
          <CrankButton
            label="openEntry"
            slot={cranks.openEntry}
            disabled={phase !== PhaseView.Idle}
            onRun={() => cranks.openEntry.run(undefined, onSettled)}
          />
          <CrankButton
            label="Post price & startEpoch"
            slot={cranks.startEpoch}
            disabled={phase !== PhaseView.EntryOpen}
            onRun={() => cranks.startEpoch.run(undefined, onSettled)}
          />
          <CrankButton
            label="Post price & endEpoch"
            slot={cranks.endEpoch}
            disabled={phase !== PhaseView.Running}
            onRun={() =>
              openConfirm(
                'End epoch & resolve outcome?',
                outcomePreview
                  ? `Predicted winner at current oracle price: ${sideLabel(outcomePreview.side)} (delta ${outcomePreview.delta.toString()} bps). This freezes settlePrice18 and is irreversible.`
                  : 'Oracle/start price unavailable for preview. This freezes settlePrice18 and is irreversible.',
                () => {
                  cranks.endEpoch.run(undefined, onSettled);
                  closeConfirm();
                },
              )
            }
          />
        </div>
        {cranks.createEpoch.error && (
          <p className="mt-2 text-xs text-side-down">{cranks.createEpoch.error.message}</p>
        )}
        {cranks.startEpoch.error && (
          <p className="mt-2 text-xs text-side-down">{cranks.startEpoch.error.message}</p>
        )}
        {cranks.endEpoch.error && (
          <p className="mt-2 text-xs text-side-down">{cranks.endEpoch.error.message}</p>
        )}
      </SectionCard>

      {/* ---- Sweep + finalize (paginated) ---- */}
      <SectionCard
        kicker="Step 2"
        title="Settlement"
        icon={<Trophy className="h-5 w-5" />}
        action={
          <Badge tone="neutral">Sweep {sweep ? `${sweep.done} / ${sweep.total}` : '-'}</Badge>
        }
      >
        <div className="flex flex-wrap gap-2">
          <CrankButton
            label={`sweep(${SWEEP_BATCH.toString()})`}
            slot={cranks.sweep}
            disabled={phase !== PhaseView.Running || sweepDone}
            onRun={() => cranks.sweep.run({ maxCount: SWEEP_BATCH }, onSettled)}
          />
          <CrankButton
            label="finalizeSettle"
            slot={cranks.finalizeSettle}
            disabled={phase !== PhaseView.Running || !sweepDone}
            onRun={() => cranks.finalizeSettle.run(undefined, onSettled)}
          />
          <CrankButton
            label="foldDust"
            slot={cranks.foldDust}
            disabled={phase !== PhaseView.Settled || epochId === undefined}
            onRun={() => epochId !== undefined && cranks.foldDust.run({ epochId }, onSettled)}
          />
        </div>
      </SectionCard>

      {/* ---- Oracle: read-only live Pyth price (V1 is trustless) ---- */}
      <SectionCard
        title={`Pyth price (${priceLabel})`}
        icon={<Clock className="h-5 w-5" />}
        action={
          <span className="font-mono text-sm text-ink">
            {oracle && oracle.price18 > 0n ? (
              <MoneyAmount value={oracle.price18} token="price" />
            ) : (
              '-'
            )}
            {oracleStale ? ' (stale)' : ''}
          </span>
        }
      >
        <p className="text-sm text-ink-soft">
          The outcome is the <strong>real market</strong>: there are no admin price controls. Starting
          and ending an epoch posts a signed Pyth update (fetched from Hermes) on-chain and pays the
          Pyth update fee - see the Lifecycle buttons above.
        </p>
        {oracle && oracle.updatedAt > 0n && (
          <p className="mt-2 text-xs text-ink-muted">
            Last published {new Date(Number(oracle.updatedAt) * 1000).toLocaleString()}
            {oracleStale ? ' - older than the demo max price age.' : '.'}
          </p>
        )}
        {oracleZero && (
          <p className="mt-2 text-xs text-ink-muted">
            No on-chain price yet. The first start/end crank will post one from Hermes.
          </p>
        )}
      </SectionCard>

      {/* ---- Config: demo timing / band / caps / pause ---- */}
      <SectionCard title="Config" icon={<Settings className="h-5 w-5" />}>
        <div className="flex flex-wrap gap-2">
          <CrankButton
            label="Apply demo timing (2m/5m)"
            slot={cranks.setTiming}
            onRun={() => cranks.setTiming.run(DEMO_TIMING, onSettled)}
          />
          <CrankButton
            label="pause"
            slot={cranks.pause}
            onRun={() =>
              openConfirm(
                'Pause the Stance?',
                'Blocks new stakes. Claims/unstakes remain available. Owner-only.',
                () => {
                  cranks.pause.run(undefined, onSettled);
                  closeConfirm();
                },
              )
            }
          />
          <CrankButton
            label="unpause"
            slot={cranks.unpause}
            onRun={() => cranks.unpause.run(undefined, onSettled)}
          />
        </div>
      </SectionCard>

      {/* ---- Emergency ---- */}
      <SectionCard title="Emergency" icon={<Alert className="h-5 w-5" />}>
        <CrankButton
          label="emergencySettle (RANGE)"
          slot={cranks.emergencySettle}
          disabled={epochId === undefined}
          onRun={() =>
            epochId !== undefined &&
            openConfirm(
              'Emergency settle?',
              `Owner escape hatch (only valid after endTime + GRACE). Resolves epoch ${epochId.toString()} as RANGE and rolls the pot. Irreversible.`,
              () => {
                cranks.emergencySettle.run({ epochId, resolution: Side.RANGE }, onSettled);
                closeConfirm();
              },
            )
          }
        />
      </SectionCard>

      {/* ---- Demo-only swaps (exact-amount approval, never MAX) ---- */}
      <SectionCard
        title="Run swaps"
        icon={<RangeIcon className="h-5 w-5" />}
        action={<Badge tone="warning">demo only</Badge>}
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={swapDir}
            onChange={(e) => setSwapDir(e.target.value as typeof swapDir)}
            className={`${inputClass} cursor-pointer`}
          >
            <option value="BASE_TO_USDC">{market.baseSymbol} → USDC</option>
            <option value="USDC_TO_BASE">USDC → {market.baseSymbol}</option>
          </select>
          <input
            value={swapAmount}
            onChange={(e) => setSwapAmount(e.target.value)}
            className={`${inputClass} w-24 font-mono`}
            inputMode="decimal"
          />
          <SwapRunner
            address={address}
            direction={swapDir}
            amountStr={swapAmount}
            approve={approve}
            runSwap={cranks.runSwap}
            onSettled={onSettled}
          />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Exact-amount approval (never MAX), then SwapRouter.exactInputSingle to accrue pool fees.
        </p>
      </SectionCard>

      <Modal open={confirmOpen} onClose={closeConfirm}>
        {confirmPayload && (
          <>
            <h2 className="font-display text-base font-semibold text-ink">{confirmPayload.title}</h2>
            <p className="mb-5 mt-2 text-sm text-ink-soft">{confirmPayload.body}</p>
            <div className="flex justify-end gap-2">
              <button className={buttonClass('secondary', 'sm')} onClick={closeConfirm}>
                Cancel
                <Stars />
              </button>
              <button className={buttonClass('danger', 'sm')} onClick={confirmPayload.onConfirm}>
                Confirm
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

/**
 * Two-step demo swap for the ACTIVE market: exact approve then exactInputSingle.
 * The "base" leg is the active pool's non-USDC token (WETH 18dp, WBTC 8dp, …) resolved on-chain via
 * useActiveBaseToken - so on the BTC market this swaps the WBTC/USDC pool and parses at 8dp, NOT the
 * hardwired WETH/18dp it used to (Fix B). USDC stays the global 6dp token.
 */
function SwapRunner({
  address,
  direction,
  amountStr,
  approve,
  runSwap,
  onSettled,
}: {
  address?: `0x${string}`;
  direction: 'BASE_TO_USDC' | 'USDC_TO_BASE';
  amountStr: string;
  approve: ReturnType<typeof useApproveExact>;
  runSwap: ReturnType<typeof useAdminCranks>['runSwap'];
  onSettled: () => void;
}) {
  const base = useActiveBaseToken();
  // tokenIn = base leg for BASE_TO_USDC, else USDC; decimalsIn matches (base decimals vs USDC 6dp).
  const tokenIn = direction === 'BASE_TO_USDC' ? base.address : ENV.USDC_ADDRESS;
  const decimalsIn = direction === 'BASE_TO_USDC' ? base.decimals : 6;
  let amountIn = 0n;
  try {
    amountIn = parseUnits(amountStr || '0', decimalsIn);
  } catch {
    amountIn = 0n;
  }
  const { data: allowance } = useRouterAllowance(tokenIn as `0x${string}` | undefined, address);
  const needsApproval = allowance === undefined || (allowance as bigint) < amountIn;
  // Until the active pool's base leg resolves we can't build a correct swap - disable both buttons.
  const baseReady = base.address !== undefined;

  if (needsApproval) {
    return (
      <TxButton
        label="Approve (exact)"
        disabled={amountIn === 0n || !address || !baseReady || approve.isPending || approve.isConfirming}
        isPending={approve.isPending || approve.isConfirming}
        onClick={() => tokenIn && approve.run({ token: tokenIn, amount: amountIn })}
        txHash={approve.hash}
      />
    );
  }
  return (
    <TxButton
      label="Swap"
      disabled={amountIn === 0n || !address || !baseReady || runSwap.isPending || runSwap.isConfirming}
      isPending={runSwap.isPending || runSwap.isConfirming}
      onClick={() =>
        address &&
        base.address &&
        runSwap.run(
          { direction, baseToken: base.address, feeTier: ENV.FEE_TIER ?? 3000, recipient: address, amountIn },
          onSettled,
        )
      }
      txHash={runSwap.hash}
    />
  );
}
