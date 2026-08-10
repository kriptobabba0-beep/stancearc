'use client';

// components/arena/AddLiquidityModal.tsx — mockup #2, exact: the Arena's "Add liquidity" modal.
//
//   Add liquidity
//   Create a cirBTC / USDC position to enter the Stance.
//   ① DEPOSIT ASSETS   — two asset rows (coin · SYMBOL ▾ · amount + ~$usd · Balance + MAX), linked by
//                         a small ⇅ badge; the LAST-EDITED leg drives, the other is computed from the
//                         live pool price + the selected range (lib/rangeMath.counterpartAmount).
//   1 cirBTC ≈ … USDC  — the live pool rate.
//   ② CHOOSE RANGE     — three preset cards (Narrow/Balanced/Wide — REAL ±5/15/50% presets, not the
//                         mock's placeholder ±0.5/1.5/3) with waveform glyphs; Balanced default.
//   ③ PREVIEW POSITION — pair · range · est. share of pool (new-L vs pool.liquidity(), display-only).
//   Cancel | Create LP position — the primary button walks approvals first (approve base → approve
//                         USDC → mint) so the mock's single CTA drives the whole real flow.
//
// All on-chain wiring reuses the SAME hooks as /pool's ProvideLiquidity (useMintPosition,
// useTokenApproval, slot0 reads, receipt→tokenId parse); only the presentation is Arena-specific.
import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract } from 'wagmi';
import { parseEventLogs, parseUnits } from 'viem';
import { useMintPosition, tickSpacingForFee } from '@/hooks/useMintPosition';
import { useTokenApproval } from '@/hooks/useTokenApproval';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useTxReceipt } from '@/hooks/useTxToast';
import { npm, useMarketContracts } from '@/lib/contracts';
import { useActiveMarket } from '@/components/MarketProvider';
import { quoteToken } from '@/lib/tokens';
import { erc20Abi } from '@/abis';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { ArenaModal, arenaButtonClass } from '@/components/arena/ArenaPanel';
import { TokenGlyph } from '@/components/TokenGlyph';
import { ChevronDown, SwapArrows, Info, Check, RangeIcon, Faucet, External } from '@/components/ui/icons';
import { Stars } from '@/components/ui/Stars';
import {
  counterpartAmount,
  customTicks,
  presetTicks,
  sqrtRatioAtTick,
  sqrtPriceX96ToPrice,
  tickRangeStatus,
  PRESET_PCT,
  type RangePreset,
} from '@/lib/rangeMath';
import { bandPrices, decodeSlot0, formatHumanPrice, isFullRangeTicks } from '@/lib/rangeDisplay';
import { baseUsd6, formatUsd6 } from '@/lib/quant';
import { formatBase, formatUSDC } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { ArenaFlow } from '@/components/arena/useArenaFlow';

const USDC_DECIMALS = 6;
const FAUCET_URL = 'https://faucet.circle.com';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const Q96 = 1n << 96n;

/** The three mock preset cards, bound to the REAL rangeMath presets. */
const PRESETS: ReadonlyArray<{ id: Exclude<RangePreset, 'full'>; name: string; a: string; b: string; amp: number }> = [
  { id: 'narrow', name: 'Narrow', a: 'Higher fee concentration', b: 'Higher out-of-range risk', amp: 5 },
  { id: 'balanced', name: 'Balanced', a: 'Middle range', b: 'Balanced exposure', amp: 3.5 },
  { id: 'wide', name: 'Wide', a: 'Stays active longer', b: 'Lower fee concentration', amp: 1.8 },
];

/** Parse a decimal string to raw units; invalid/empty -> 0n (fail-closed, mirrors ProvideLiquidity). */
function parseAmount(s: string, decimals: number): bigint {
  try {
    return parseUnits((s || '0').trim(), decimals);
  } catch {
    return 0n;
  }
}

/**
 * Parse a HUMAN price string, FAIL-CLOSED: NaN unless the WHOLE trimmed string is a plain decimal.
 * (Bare parseFloat would silently truncate a comma-grouped paste like "63,750" to 63 and mint a
 * far-off band — same guard as ProvideLiquidity.)
 */
function parsePrice(s: string): number {
  const t = s.trim();
  return /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number.parseFloat(t) : Number.NaN;
}

/** In-range liquidity for the given amounts (display-only "est. share of pool" — floors, min leg). */
function liquidityFromAmounts(
  sqrtP: bigint,
  sqrtL: bigint,
  sqrtU: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtP <= sqrtL || sqrtP >= sqrtU || amount0 <= 0n || amount1 <= 0n) return 0n;
  const l0 = (amount0 * ((sqrtP * sqrtU) / Q96)) / (sqrtU - sqrtP);
  const l1 = (amount1 * Q96) / (sqrtP - sqrtL);
  return l0 < l1 ? l0 : l1;
}

/** The small waveform glyph on a preset card (amplitude varies by preset tightness). */
function Wave({ amp, className }: { amp: number; className?: string }) {
  const m = 7;
  return (
    <svg width="38" height="14" viewBox="0 0 38 14" fill="none" aria-hidden="true" className={className}>
      <path
        d={`M2 ${m} Q6 ${m - amp} 10 ${m} T18 ${m} T26 ${m} T34 ${m}`}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Numbered mono section header: ① DEPOSIT ASSETS ⓘ */
function SectionTag({ n, label, info = false }: { n: number; label: string; info?: boolean }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line font-mono text-[10px] font-semibold text-ink-muted">
        {n}
      </span>
      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-soft">{label}</span>
      {info && <Info className="h-3.5 w-3.5 text-ink-faint" />}
    </div>
  );
}

/** One deposit-asset row: [coin SYMBOL ▾] [amount / ~$usd] [Balance / MAX]. */
function AssetRow({
  symbol,
  value,
  onChange,
  usdLabel,
  balanceLabel,
  insufficient,
  onMax,
  inputTestId,
  readOnly = false,
}: {
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  usdLabel: string;
  balanceLabel: string;
  insufficient: boolean;
  onMax: () => void;
  inputTestId: string;
  /** Locked at 0 — the selected band excludes the current price, so this leg isn't deposited. */
  readOnly?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-muted px-3.5 py-3">
      <span className="flex shrink-0 items-center gap-1.5">
        <TokenGlyph symbol={symbol} />
        <span className="font-mono text-sm font-semibold text-ink">{symbol}</span>
        <ChevronDown className="h-3.5 w-3.5 text-ink-faint" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          readOnly={readOnly}
          aria-label={`Amount of ${symbol} to deposit`}
          data-testid={inputTestId}
          className={cn(
            'w-full bg-transparent font-mono text-lg font-semibold tnum outline-none placeholder:text-ink-faint',
            readOnly ? 'cursor-default text-ink-muted' : 'text-ink',
          )}
        />
        <div className="font-mono text-[11px] text-ink-faint">{usdLabel}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={cn('font-mono text-[11px]', insufficient ? 'text-side-down' : 'text-ink-muted')}>
          Balance: {balanceLabel}
        </span>
        <button
          type="button"
          onClick={onMax}
          disabled={readOnly}
          className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[10px] font-semibold text-ink-soft transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
        >
          MAX
        </button>
      </div>
    </div>
  );
}

export function AddLiquidityModal({ flow }: { flow: ArenaFlow }) {
  const open = flow.modal === 'add-liquidity';
  const { address, isConnected } = useAccount();
  const {
    address: baseToken,
    decimals: baseDecimals,
    symbol: baseSymbol,
    baseIsToken0,
  } = useActiveBaseToken();
  const { pool } = useMarketContracts();
  // The active arena's QUOTE token (USDC or EURC) — the second pool leg. Both 6dp, so the amount math
  // (USDC_DECIMALS / formatUSDC / counterpartAmount) is unchanged; only the token address + symbol differ.
  const quote = quoteToken(useActiveMarket().quoteSymbol);
  const { data: oracle } = useOraclePrice();

  const [baseInput, setBaseInput] = useState('');
  const [usdcInput, setUsdcInput] = useState('');
  const [driver, setDriver] = useState<'base' | 'usdc' | null>(null);
  const [choice, setChoice] = useState<RangePreset | 'custom'>('balanced');
  // Custom band inputs: human min/max prices in USDC per base (plain decimals, no grouping).
  const [minPriceInput, setMinPriceInput] = useState('');
  const [maxPriceInput, setMaxPriceInput] = useState('');
  const [awaitingReceipt, setAwaitingReceipt] = useState(false);

  // Reset to a clean slate whenever the modal closes (fresh open = fresh form).
  useEffect(() => {
    if (!open) {
      setBaseInput('');
      setUsdcInput('');
      setDriver(null);
      setChoice('balanced');
      setMinPriceInput('');
      setMaxPriceInput('');
      setAwaitingReceipt(false);
    }
  }, [open]);

  // ── Live pool state (slot0 price/tick + active liquidity for the share preview) ────────────────
  const { data: slot0Raw } = useReadContract({
    ...pool,
    functionName: 'slot0',
    chainId: arcTestnet.id,
    query: { enabled: open && !!baseToken },
  });
  const { data: poolLiqRaw } = useReadContract({
    ...pool,
    functionName: 'liquidity',
    chainId: arcTestnet.id,
    query: { enabled: open && !!baseToken },
  });
  const slot0 = decodeSlot0(slot0Raw);
  const sqrtPriceX96 = slot0?.sqrtPriceX96 ?? 0n;
  const currentTick = slot0?.tick;
  const poolLiq = (poolLiqRaw as bigint | undefined) ?? undefined;

  const dec0 = baseIsToken0 === undefined ? undefined : baseIsToken0 ? baseDecimals : USDC_DECIMALS;
  const dec1 = baseIsToken0 === undefined ? undefined : baseIsToken0 ? USDC_DECIMALS : baseDecimals;
  const spacing = tickSpacingForFee(ENV.FEE_TIER);

  // Custom band validation: plain decimals IN FULL and 0 < min < max (fail-closed parsePrice).
  const minPrice = parsePrice(minPriceInput);
  const maxPrice = parsePrice(maxPriceInput);
  const customValid =
    Number.isFinite(minPrice) && Number.isFinite(maxPrice) && minPrice > 0 && minPrice < maxPrice;
  const priceFormatBad =
    (minPriceInput.trim() !== '' && Number.isNaN(minPrice)) ||
    (maxPriceInput.trim() !== '' && Number.isNaN(maxPrice));

  // The selected range as spacing-aligned ticks: presets center on the live tick, full needs no tick,
  // custom converts the human band (customTicks resolves the baseIsToken0 inversion internally).
  const range = useMemo(() => {
    if (choice === 'full') return presetTicks('full', 0, spacing);
    if (choice === 'custom') {
      if (!customValid || baseIsToken0 === undefined || dec0 === undefined || dec1 === undefined) {
        return undefined;
      }
      return customTicks(minPrice, maxPrice, dec0, dec1, baseIsToken0, spacing);
    }
    if (currentTick === undefined) return undefined;
    return presetTicks(choice, currentTick, spacing);
  }, [choice, currentTick, spacing, customValid, baseIsToken0, dec0, dec1, minPrice, maxPrice]);
  const sqrtBounds = useMemo(
    () =>
      range ? { lower: sqrtRatioAtTick(range.tickLower), upper: sqrtRatioAtTick(range.tickUpper) } : undefined,
    [range],
  );

  // A custom band can exclude the current price → the mint is ONE-SIDED ('below' in raw tick space =
  // deposit only token0; with baseIsToken0=false the human reading inverts — lib/rangeMath owns that).
  const rangeStatus =
    range && currentTick !== undefined
      ? tickRangeStatus(currentTick, range.tickLower, range.tickUpper)
      : undefined;
  const outOfRange = rangeStatus === 'below' || rangeStatus === 'above';
  const activeIsToken0 = rangeStatus === 'below';
  const baseActive = baseIsToken0 === activeIsToken0;
  const baseExcluded = outOfRange && !baseActive;
  const usdcExcluded = outOfRange && baseActive;

  // ── Linked amounts: the last-edited leg drives, the other is the bigint-exact counterpart ──────
  const baseTyped = parseAmount(baseInput, baseDecimals);
  const usdcTyped = parseAmount(usdcInput, USDC_DECIMALS);
  // Out of range forces the driver to the active side (the excluded leg is locked at 0).
  const effectiveDriver: 'base' | 'usdc' | null = outOfRange ? (baseActive ? 'base' : 'usdc') : driver;
  const linked = effectiveDriver !== null && !!sqrtBounds && sqrtPriceX96 > 0n && baseIsToken0 !== undefined;

  let baseAmount = baseTyped;
  let usdcAmount = usdcTyped;
  let baseValue = baseInput;
  let usdcValue = usdcInput;
  if (linked) {
    if (effectiveDriver === 'base') {
      usdcAmount = outOfRange
        ? 0n
        : counterpartAmount({
            amountIn: baseTyped,
            inputIsToken0: baseIsToken0 === true,
            sqrtPriceX96,
            sqrtLowerX96: sqrtBounds.lower,
            sqrtUpperX96: sqrtBounds.upper,
          });
      usdcValue = usdcExcluded ? '0' : usdcAmount > 0n ? formatUSDC(usdcAmount) : '';
    } else {
      baseAmount = outOfRange
        ? 0n
        : counterpartAmount({
            amountIn: usdcTyped,
            inputIsToken0: baseIsToken0 === false,
            sqrtPriceX96,
            sqrtLowerX96: sqrtBounds.lower,
            sqrtUpperX96: sqrtBounds.upper,
          });
      baseValue = baseExcluded ? '0' : baseAmount > 0n ? formatBase(baseAmount, baseDecimals) : '';
    }
  }

  // ── Balances ────────────────────────────────────────────────────────────────────────────────────
  const { data: baseBal } = useReadContract({
    address: baseToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: open && isConnected && !!baseToken },
  });
  const { data: usdcBal } = useReadContract({
    address: quote.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: open && isConnected },
  });
  const baseBalance = (baseBal as bigint | undefined) ?? 0n;
  const usdcBalance = (usdcBal as bigint | undefined) ?? 0n;
  const insufficientBase = baseAmount > baseBalance;
  const insufficientUsdc = usdcAmount > usdcBalance;

  // ── USD labels (oracle-priced base leg; USDC is USD) ────────────────────────────────────────────
  const price18 = oracle?.price18 ?? 0n;
  const baseUsdLabel = `~${formatUsd6(baseUsd6(baseAmount, baseDecimals, price18))}`;
  const usdcUsdLabel = `~${formatUsd6(usdcAmount)}`;

  // Live pool rate for the "1 cirBTC ≈ … USDC" line.
  const rate =
    dec0 !== undefined && dec1 !== undefined && baseIsToken0 !== undefined && sqrtPriceX96 > 0n
      ? sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1, baseIsToken0)
      : undefined;

  // ── Est. share of pool (new in-range L vs pool's active L; display-only) ───────────────────────
  const shareText = useMemo(() => {
    if (!sqrtBounds || sqrtPriceX96 <= 0n || poolLiq === undefined || baseIsToken0 === undefined) return '—';
    const amount0 = baseIsToken0 ? baseAmount : usdcAmount;
    const amount1 = baseIsToken0 ? usdcAmount : baseAmount;
    const newL = liquidityFromAmounts(sqrtPriceX96, sqrtBounds.lower, sqrtBounds.upper, amount0, amount1);
    if (newL <= 0n) return '—';
    const pctX4 = Number((newL * 1_000_000n) / (poolLiq + newL)) / 10_000; // % with 4dp headroom
    if (!Number.isFinite(pctX4)) return '—';
    return `~${pctX4 < 0.001 ? '<0.001' : pctX4.toFixed(3)}%`;
  }, [sqrtBounds, sqrtPriceX96, poolLiq, baseIsToken0, baseAmount, usdcAmount]);

  // ── Approvals + mint (the single CTA walks: approve base → approve USDC → create) ──────────────
  const baseApproval = useTokenApproval(baseToken, npm.address, baseAmount, baseSymbol);
  const usdcApproval = useTokenApproval(quote.address, npm.address, usdcAmount, quote.symbol);
  const { mint, isPending: minting, error: mintError, hash: mintHash, isPoolLoading } = useMintPosition();
  const { data: mintReceipt, isError: mintReceiptError } = useTxReceipt(mintHash, {
    chainId: arcTestnet.id,
    query: { enabled: !!mintHash },
  });

  // Receipt → tokenId → hand the fresh position to the flow and close (the rail advances to step 2).
  useEffect(() => {
    if (!mintReceipt) return;
    if (address) {
      try {
        const logs = parseEventLogs({
          abi: nonfungiblePositionManagerAbi,
          eventName: 'Transfer',
          logs: mintReceipt.logs,
        });
        const mintLog = logs.find(
          (l) => l.args.from?.toLowerCase() === ZERO_ADDR && l.args.to?.toLowerCase() === address.toLowerCase(),
        );
        if (mintLog?.args.tokenId !== undefined) flow.setSelectedTokenId(mintLog.args.tokenId);
      } catch {
        // non-fatal: the positions list refetches anyway
      }
    }
    setAwaitingReceipt(false);
    flow.closeModal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintReceipt, address]);
  useEffect(() => {
    if (mintReceiptError) setAwaitingReceipt(false);
  }, [mintReceiptError]);

  // In range BOTH legs must be positive; out of range the mint is one-sided by construction.
  const amountsEntered = outOfRange
    ? (baseActive ? baseAmount : usdcAmount) > 0n
    : baseAmount > 0n && usdcAmount > 0n;
  const approvalsReady = baseApproval.allowanceReady && usdcApproval.allowanceReady;
  const busy = baseApproval.isPending || usdcApproval.isPending || minting || awaitingReceipt;
  const ready =
    isConnected &&
    !isPoolLoading &&
    !!range &&
    sqrtPriceX96 > 0n &&
    amountsEntered &&
    !insufficientBase &&
    !insufficientUsdc &&
    approvalsReady &&
    !busy;

  const label = busy
    ? baseApproval.isPending
      ? `Approving ${baseSymbol}…`
      : usdcApproval.isPending
        ? 'Approving USDC…'
        : 'Creating position…'
    : baseApproval.needsApproval
      ? `Approve ${baseSymbol}`
      : usdcApproval.needsApproval
        ? 'Approve USDC'
        : 'Create LP position';

  const onPrimary = async () => {
    if (!range) return;
    try {
      if (baseApproval.needsApproval) {
        await baseApproval.approve();
        return;
      }
      if (usdcApproval.needsApproval) {
        await usdcApproval.approve();
        return;
      }
      setAwaitingReceipt(true);
      await mint({ baseAmount, usdcAmount, tickLower: range.tickLower, tickUpper: range.tickUpper });
    } catch {
      setAwaitingReceipt(false); // surfaced via the hooks' errors below
    }
  };

  const onBaseChange = (v: string) => {
    setBaseInput(v);
    setDriver('base');
  };
  const onUsdcChange = (v: string) => {
    setUsdcInput(v);
    setDriver('usdc');
  };

  // ── The selected band as human prices ("60,286 — 66,759 USDC per cirBTC" / "0 — ∞ …") ──────────
  const isFull = !!range && isFullRangeTicks(range.tickLower, range.tickUpper, spacing);
  let bandText: string;
  if (!range) {
    bandText = choice === 'custom' ? 'Enter a min and max price' : '…';
  } else if (isFull) {
    bandText = `0 — ∞ USDC per ${baseSymbol}`;
  } else if (dec0 !== undefined && dec1 !== undefined && baseIsToken0 !== undefined) {
    const { min, max } = bandPrices(range.tickLower, range.tickUpper, dec0, dec1, baseIsToken0);
    bandText = `${formatHumanPrice(min)} — ${formatHumanPrice(max)} USDC per ${baseSymbol}`;
  } else {
    bandText = '…';
  }
  const choiceLabel =
    choice === 'full' ? 'Full' : choice === 'custom' ? 'Custom' : PRESETS.find((p) => p.id === choice)?.name;

  const errorMsg = mintError?.message ?? baseApproval.error?.message ?? usdcApproval.error?.message;

  return (
    <ArenaModal open={open} onClose={flow.closeModal} className="max-w-lg">
      {/* Title */}
      <div className="text-center">
        <h2 className="font-mono text-2xl font-semibold tracking-tight text-ink">Add liquidity</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Create a {baseSymbol} / {quote.symbol} position to enter the Stance.
        </p>
      </div>

      {/* ① Deposit assets */}
      <div className="mt-5">
        <SectionTag n={1} label="Deposit assets" />
        <div className="space-y-1.5">
          <AssetRow
            symbol={baseSymbol}
            value={baseValue}
            onChange={onBaseChange}
            usdLabel={baseUsdLabel}
            balanceLabel={`${formatBase(baseBalance, baseDecimals)} ${baseSymbol}`}
            insufficient={insufficientBase}
            onMax={() => {
              setBaseInput(formatBase(baseBalance, baseDecimals));
              setDriver('base');
            }}
            inputTestId="alm-base-input"
            readOnly={baseExcluded}
          />
          {/* linked-legs badge */}
          <div className="relative z-[1] mx-auto -my-3 grid h-7 w-7 place-items-center rounded-full border border-line bg-surface text-ink-muted">
            <SwapArrows className="h-3.5 w-3.5" />
          </div>
          <AssetRow
            symbol={quote.symbol}
            value={usdcValue}
            onChange={onUsdcChange}
            usdLabel={usdcUsdLabel}
            balanceLabel={`${formatUSDC(usdcBalance)} ${quote.symbol}`}
            insufficient={insufficientUsdc}
            onMax={() => {
              setUsdcInput(formatUSDC(usdcBalance));
              setDriver('usdc');
            }}
            inputTestId="alm-usdc-input"
            readOnly={usdcExcluded}
          />
        </div>
        <div className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-ink-muted">
          1 {baseSymbol} ≈ {rate !== undefined ? formatHumanPrice(rate) : '…'} {quote.symbol}
          <Info className="h-3 w-3 text-ink-faint" />
        </div>
        {isConnected && baseBalance === 0n && (
          <a
            href={FAUCET_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:text-brand-hover"
          >
            <Faucet className="h-3 w-3" /> Get {baseSymbol} from the Circle faucet
            <External className="h-3 w-3" />
          </a>
        )}
      </div>

      {/* ② Choose range */}
      <div className="mt-5">
        <SectionTag n={2} label="Choose range" info />
        <p className="-mt-1 mb-2 text-[12px] text-ink-muted">
          Select how tightly you want to position your liquidity.
        </p>
        <div className="grid grid-cols-3 gap-2">
          {PRESETS.map((p) => {
            const selected = choice === p.id;
            return (
              <button
                key={p.id}
                type="button"
                data-testid={`alm-range-${p.id}`}
                aria-pressed={selected}
                onClick={() => setChoice(p.id)}
                className={cn(
                  'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors focus-visible:outline-none focus-visible:shadow-focus',
                  selected
                    ? 'border-brand bg-brand-soft/40'
                    : 'border-line bg-surface-muted hover:border-line-strong hover:bg-surface-inset',
                )}
              >
                {selected && (
                  <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-brand text-white">
                    <Check className="h-2.5 w-2.5" />
                  </span>
                )}
                <span
                  className={cn(
                    'font-mono text-[11px] font-bold uppercase tracking-wide',
                    selected ? 'text-brand' : 'text-ink',
                  )}
                >
                  {p.name}
                </span>
                <Wave amp={p.amp} className={selected ? 'text-brand' : 'text-ink-muted'} />
                <span className={cn('font-mono text-[11px] font-semibold', selected ? 'text-brand' : 'text-ink-soft')}>
                  ±{PRESET_PCT[p.id] * 100}%
                </span>
                <span className="text-[10px] leading-tight text-ink-muted">
                  {p.a}
                  <br />
                  {p.b}
                </span>
              </button>
            );
          })}
        </div>

        {/* Full range + Custom (same card language, second row). */}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            data-testid="alm-range-full"
            aria-pressed={choice === 'full'}
            onClick={() => setChoice('full')}
            className={cn(
              'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors focus-visible:outline-none focus-visible:shadow-focus',
              choice === 'full'
                ? 'border-brand bg-brand-soft/40'
                : 'border-line bg-surface-muted hover:border-line-strong hover:bg-surface-inset',
            )}
          >
            {choice === 'full' && (
              <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-brand text-white">
                <Check className="h-2.5 w-2.5" />
              </span>
            )}
            <span
              className={cn(
                'font-mono text-[11px] font-bold uppercase tracking-wide',
                choice === 'full' ? 'text-brand' : 'text-ink',
              )}
            >
              Full range
            </span>
            <span className={cn('font-mono text-[11px] font-semibold', choice === 'full' ? 'text-brand' : 'text-ink-soft')}>
              0 — ∞
            </span>
            <span className="text-[10px] leading-tight text-ink-muted">
              Always in range
              <br />
              Lowest fee concentration
            </span>
          </button>
          <button
            type="button"
            data-testid="alm-range-custom"
            aria-pressed={choice === 'custom'}
            onClick={() => setChoice('custom')}
            className={cn(
              'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors focus-visible:outline-none focus-visible:shadow-focus',
              choice === 'custom'
                ? 'border-brand bg-brand-soft/40'
                : 'border-line bg-surface-muted hover:border-line-strong hover:bg-surface-inset',
            )}
          >
            {choice === 'custom' && (
              <span className="absolute right-2 top-2 grid h-4 w-4 place-items-center rounded-full bg-brand text-white">
                <Check className="h-2.5 w-2.5" />
              </span>
            )}
            <span
              className={cn(
                'font-mono text-[11px] font-bold uppercase tracking-wide',
                choice === 'custom' ? 'text-brand' : 'text-ink',
              )}
            >
              Custom
            </span>
            <span className={cn('font-mono text-[11px] font-semibold', choice === 'custom' ? 'text-brand' : 'text-ink-soft')}>
              min — max
            </span>
            <span className="text-[10px] leading-tight text-ink-muted">
              Set your own range
              <br />
              Advanced
            </span>
          </button>
        </div>

        {/* General range disclaimer — shown directly below the preset cards, regardless of choice. */}
        <p data-testid="alm-range-note" className="mt-2.5 text-[11px] leading-snug text-ink-muted">
          Note: If price moves outside your selected range, your position stops earning fees until
          price returns. LP position value can change with market price and impermanent loss.
        </p>

        {/* Custom band inputs (USDC per base; customTicks resolves the tick inversion). */}
        {choice === 'custom' && (
          <div className="mt-2 grid grid-cols-2 gap-2" data-testid="alm-custom-band">
            <label className="block font-mono text-[10px] uppercase tracking-wide text-ink-muted">
              Min price
              <input
                value={minPriceInput}
                onChange={(e) => setMinPriceInput(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                data-testid="alm-min-input"
                className="mt-1 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:shadow-focus"
              />
            </label>
            <label className="block font-mono text-[10px] uppercase tracking-wide text-ink-muted">
              Max price
              <input
                value={maxPriceInput}
                onChange={(e) => setMaxPriceInput(e.target.value)}
                inputMode="decimal"
                placeholder="∞"
                data-testid="alm-max-input"
                className="mt-1 w-full rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:shadow-focus"
              />
            </label>
          </div>
        )}
        {choice === 'custom' && !customValid && (minPriceInput !== '' || maxPriceInput !== '') && (
          <p data-testid="alm-custom-invalid" role="alert" className="mt-1.5 text-[11px] text-side-down">
            {priceFormatBad
              ? 'Enter prices as plain numbers (e.g. 63750.50) — no thousands separators, letters or symbols.'
              : 'Enter a valid band: min price must be above 0 and below max price.'}
          </p>
        )}

        {/* The selected band as human prices — what range you are joining. */}
        <div
          data-testid="alm-band"
          className="mt-2.5 rounded-lg border border-line bg-surface-muted px-3 py-2 text-center font-mono text-[12px] tnum text-ink-soft"
        >
          {bandText}
        </div>

        {/* One-sided warning: the custom band excludes the current price. */}
        {outOfRange && (
          <p
            data-testid="alm-oor-warning"
            className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[11px] leading-snug text-amber-700 dark:text-amber-300"
          >
            Price is outside this band — you&apos;ll deposit only {baseActive ? baseSymbol : quote.symbol}, and
            the position earns no fees and no arena contribution until the price enters the range.
          </p>
        )}
      </div>

      {/* ③ Preview position */}
      <div className="mt-5">
        <SectionTag n={3} label="Preview position" />
        <div className="flex items-center gap-3 rounded-xl border border-line bg-surface-muted px-3.5 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface text-ink-muted">
            <RangeIcon className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">New LP position</div>
            <div className="truncate text-[13px] text-ink-soft">
              <span className="font-semibold text-ink">
                {baseSymbol}/USDC
              </span>{' '}
              · {choiceLabel} range · est. share of pool
            </div>
          </div>
          <span data-testid="alm-share" className="shrink-0 font-mono text-sm font-semibold tnum text-side-up">
            {shareText}
          </span>
        </div>
        <p className="mt-2 text-[11px] text-ink-faint">
          You can modify or remove this LP position while it is not entered into an epoch.
        </p>
      </div>

      {errorMsg && (
        <p role="alert" className="mt-3 text-sm text-side-down">
          {errorMsg}
        </p>
      )}

      {/* Actions */}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <button type="button" onClick={flow.closeModal} className={arenaButtonClass('secondary')}>
          Cancel
          <Stars />
        </button>
        <button
          type="button"
          data-testid="alm-submit"
          disabled={!ready}
          onClick={() => void onPrimary()}
          className={arenaButtonClass('primary')}
        >
          {label}
          <Stars />
        </button>
      </div>
    </ArenaModal>
  );
}
