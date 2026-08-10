'use client';

// components/SwapForm.tsx — a Uniswap-style SINGLE swap card across the whole token set (cirBTC / USDC /
// EURC). The user picks the "You pay" and "You receive" tokens from a selector; the card resolves the
// direct V3 pool for that pair (lib/pools), quotes client-side from the pool's slot0 + liquidity, and
// swaps via the shared SwapRouter (useSwap is pool-agnostic — it routes by tokenIn/tokenOut/fee). All
// three pairs (cirBTC/USDC, EURC/USDC, cirBTC/EURC) are tradeable, so e.g. cirBTC⇄EURC works directly.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useReadContract } from 'wagmi';
import { parseUnits } from 'viem';
import { useSwap } from '@/hooks/useSwap';
import { erc20Abi, uniswapV3PoolAbi } from '@/abis';
import { arcTestnet } from '@/lib/chain';
import { Card } from '@/components/ui/Card';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { ArrowDown, ChevronDown, Settings, Alert, Check } from '@/components/ui/icons';
import { TokenGlyph } from '@/components/TokenGlyph';
import { SwapCompleted } from '@/components/swap/SwapCompleted';
import { formatBase, formatBps } from '@/lib/format';
import { arcScanTxUrl } from '@/lib/toast';
import { quoteExactInputSingle } from '@/lib/swapQuote';
import { useExactQuote } from '@/hooks/useExactQuote';
import { autoSlippageBps } from '@/lib/autoSlippage';
import { cn } from '@/lib/cn';
import { TOKENS, type TokenInfo } from '@/lib/tokens';
import { findPool, type PoolInfo } from '@/lib/pools';

const HIGH_IMPACT_BPS = 300; // ~3% — amber warning
const MAX_IMPACT_BPS = 2500; // 25% — HARD cap: block a swap that would run the thin pool off its peg
const SLIPPAGE_PRESETS_BPS = [50, 100, 300] as const;
const DEFAULT_SLIPPAGE_BPS = 100;
/** Bounds for a typed slippage. Below 1bp no swap can fill; above 50% the quote stops meaning much. */
const MIN_SLIPPAGE_BPS = 1;
const MAX_SLIPPAGE_BPS = 5_000;
/** Past this, say plainly what the number is buying: a fill at a much worse price. */
const HIGH_SLIPPAGE_BPS = 500;

function parseAmount(s: string, decimals: number): bigint {
  try {
    return parseUnits((s || '0').trim(), decimals);
  } catch {
    return 0n;
  }
}

function applySlippage(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A token-selector pill: shows the token, opens a dropdown of the choices (filtered by `disabledAddr`).
 *
 * `menuPlacement` controls which way the dropdown opens. The Card primitive clips its children to the
 * chamfered HUD octagon (`clip-path` in ui/Card.tsx), so a menu that spills past the card edge gets cut
 * off. The bottom ("You receive") selector therefore opens UPWARD ('top') to stay inside the card; the
 * top selector keeps the default downward ('bottom').
 */
function TokenSelect({
  token,
  onSelect,
  disabledAddr,
  testId,
  menuPlacement = 'bottom',
}: {
  token: TokenInfo;
  onSelect: (t: TokenInfo) => void;
  disabledAddr?: string;
  testId: string;
  menuPlacement?: 'bottom' | 'top';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        data-testid={testId}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface py-1.5 pl-1.5 pr-2.5 font-mono text-[15px] font-semibold text-ink transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:shadow-focus"
      >
        <TokenGlyph symbol={token.symbol} />
        {token.symbol}
        <ChevronDown className="h-4 w-4 text-ink-muted" />
      </button>
      {open && (
        <div
          role="listbox"
          data-testid={`${testId}-menu`}
          className={cn(
            'absolute right-0 z-30 w-44 overflow-hidden rounded-2xl border border-line bg-surface p-1 shadow-pop',
            menuPlacement === 'top' ? 'bottom-full mb-2' : 'top-full mt-2',
          )}
        >
          {TOKENS.map((t) => {
            const isDisabled = disabledAddr !== undefined && sameAddr(t.address, disabledAddr);
            const isActive = sameAddr(t.address, token.address);
            return (
              <button
                key={t.address}
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={isDisabled}
                data-testid={`${testId}-opt-${t.symbol}`}
                onClick={() => {
                  onSelect(t);
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm font-medium transition-colors',
                  isDisabled
                    ? 'cursor-not-allowed text-ink-faint'
                    : 'text-ink hover:bg-surface-muted',
                )}
              >
                <TokenGlyph symbol={t.symbol} />
                <span className="font-mono">{t.symbol}</span>
                {isActive && <Check className="ml-auto h-4 w-4 text-brand" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SwapForm() {
  const { address, isConnected } = useAccount();

  // Default pair: cirBTC -> USDC. Both selectable from the full token set.
  const [tokenIn, setTokenIn] = useState<TokenInfo>(TOKENS[0]);
  const [tokenOut, setTokenOut] = useState<TokenInfo>(TOKENS[1]);
  const [amountInput, setAmountInput] = useState('');
  // Auto is the default: it reads the quote's own quality and widens only when it has to.
  const [slippageMode, setSlippageMode] = useState<'auto' | 'manual'>('auto');
  const [slippageBps, setSlippageBps] = useState<number>(DEFAULT_SLIPPAGE_BPS);
  const [impactAccepted, setImpactAccepted] = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const [customSlippageError, setCustomSlippageError] = useState<string | null>(null);

  // A typed percent only takes effect once it is a number inside the allowed band. Anything else
  // leaves the last good slippage in place, so a half-typed value can never quietly widen or
  // tighten the trade the user is about to sign.
  const applyCustomSlippage = (raw: string) => {
    const cleaned = raw.replace(',', '.');
    setCustomSlippage(cleaned);
    if (cleaned.trim() === '') {
      setCustomSlippageError(null);
      setSlippageBps(DEFAULT_SLIPPAGE_BPS);
      return;
    }
    const pct = Number(cleaned);
    if (!Number.isFinite(pct) || pct <= 0) {
      setCustomSlippageError('Enter a percentage, for example 2.5');
      return;
    }
    const bps = Math.round(pct * 100);
    if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
      setCustomSlippageError(`Use ${formatBps(MIN_SLIPPAGE_BPS)} to ${formatBps(MAX_SLIPPAGE_BPS)}`);
      return;
    }
    setCustomSlippageError(null);
    setSlippageBps(bps);
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  // The direct pool for the selected pair (all 3 pairs have one). Undefined only if a future pair lacks one.
  const pool: PoolInfo | undefined = useMemo(() => findPool(tokenIn, tokenOut), [tokenIn, tokenOut]);

  // Pick a token for one side; if it collides with the other side, flip. If the new pair has no pool,
  // re-point the other side to a token that DOES pair with the new selection.
  function selectIn(t: TokenInfo) {
    if (sameAddr(t.address, tokenOut.address)) {
      setTokenOut(tokenIn);
      setTokenIn(t);
    } else if (!findPool(t, tokenOut)) {
      const alt = TOKENS.find((x) => !sameAddr(x.address, t.address) && findPool(t, x));
      setTokenIn(t);
      if (alt) setTokenOut(alt);
    } else {
      setTokenIn(t);
    }
    setAmountInput('');
  }
  function selectOut(t: TokenInfo) {
    if (sameAddr(t.address, tokenIn.address)) {
      setTokenIn(tokenOut);
      setTokenOut(t);
    } else if (!findPool(tokenIn, t)) {
      const alt = TOKENS.find((x) => !sameAddr(x.address, t.address) && findPool(t, x));
      setTokenOut(t);
      if (alt) setTokenIn(alt);
    } else {
      setTokenOut(t);
    }
    setAmountInput('');
  }
  function onFlip() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountInput('');
  }

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettingsOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  // ── Live pool state for the quote ───────────────────────────────────────────────
  const { data: slot0 } = useReadContract({
    address: pool?.address,
    abi: uniswapV3PoolAbi,
    functionName: 'slot0',
    chainId: arcTestnet.id,
    query: { enabled: !!pool },
  });
  const { data: liquidityRaw } = useReadContract({
    address: pool?.address,
    abi: uniswapV3PoolAbi,
    functionName: 'liquidity',
    chainId: arcTestnet.id,
    query: { enabled: !!pool },
  });
  const sqrtPriceX96 = useMemo(() => {
    const s = slot0 as { sqrtPriceX96?: bigint } | readonly bigint[] | undefined;
    if (!s) return 0n;
    return (s as { sqrtPriceX96?: bigint }).sqrtPriceX96 ?? (s as readonly bigint[])[0] ?? 0n;
  }, [slot0]);
  const liquidity = (liquidityRaw as bigint | undefined) ?? 0n;

  // zeroForOne: input token is the pool's token0.
  const zeroForOne = pool ? sameAddr(tokenIn.address, pool.token0.address) : undefined;

  const amountIn = parseAmount(amountInput, tokenIn.decimals);

  // ── Balances ─────────────────────────────────────────────────────────────────────
  const { data: inBalRaw } = useReadContract({
    address: tokenIn.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: isConnected },
  });
  const fromBalance = (inBalRaw as bigint | undefined) ?? 0n;

  // ── Live quote ─────────────────────────────────────────────────────────────────────
  const quote = useMemo(() => {
    if (zeroForOne === undefined || !pool) return undefined;
    return quoteExactInputSingle({ amountIn, zeroForOne, sqrtPriceX96, liquidity, feePips: pool.feeTier });
  }, [amountIn, zeroForOne, sqrtPriceX96, liquidity, pool]);

  // The pool's own answer when it can give one; the local estimate only as a fallback. The estimate
  // assumes constant liquidity, which a narrow-range pool breaks, and that gap is what produced
  // "Too little received" on swaps the user could afford.
  const exactQuote = useExactQuote({
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    feeTier: pool?.feeTier,
    sqrtPriceX96,
    fallback: { amountOut: quote?.amountOut ?? 0n, priceImpactBps: quote?.priceImpactBps ?? 0 },
  });

  const amountOut = exactQuote.amountOut;
  const priceImpactBps = exactQuote.priceImpactBps;
  const autoBps = autoSlippageBps({ priceImpactBps, exact: exactQuote.exact });
  const effectiveSlippageBps = slippageMode === 'auto' ? autoBps : slippageBps;
  const amountOutMinimum = applySlippage(amountOut, effectiveSlippageBps);
  const highImpact = priceImpactBps > HIGH_IMPACT_BPS;
  // A trade this size moves the pool a long way. It is no longer refused outright: on a thin pool
  // that just meant the swap was impossible. The user is told the number and asked to confirm it.
  const impactNeedsConsent = priceImpactBps > MAX_IMPACT_BPS;

  const { swap, isPending, isApproving, error, result, reset } = useSwap();

  const hasLiquidity = liquidity > 0n;
  // Only "insufficient" once the balance has actually loaded — a mid-refetch undefined read (which
  // defaults fromBalance to 0n) must NOT count, or it flashes a false warning during the swap.
  const insufficientBalance = inBalRaw !== undefined && amountIn > fromBalance;
  const amountEntered = amountIn > 0n;
  const hasQuote = amountOut > 0n;
  const canSwap =
    isConnected && !!pool && hasLiquidity && amountEntered && !insufficientBalance && hasQuote && (!impactNeedsConsent || impactAccepted) && !isPending;

  // A new amount or pair is a different trade; a tick left over from the previous one would be
  // consent the user never gave.
  useEffect(() => setImpactAccepted(false), [amountInput, tokenIn.address, tokenOut.address]);

  const onMax = () => setAmountInput(formatBase(fromBalance, tokenIn.decimals));
  // The confirmation restates the trade FROM THE RESULT, not from the form's current selection:
  // the two are the same right now, but reading the settled trade off the thing that settled is
  // the version that cannot drift.
  const doneTokenIn = result ? TOKENS.find((t) => sameAddr(t.address, result.tokenIn)) : undefined;
  const doneTokenOut = result ? TOKENS.find((t) => sameAddr(t.address, result.tokenOut)) : undefined;
  const showCompleted = !!result && !!doneTokenIn && !!doneTokenOut;
  const onDone = () => {
    reset();
    setAmountInput('');
    setImpactAccepted(false);
  };
  const onSwap = () => {
    if (!canSwap) return;
    void swap({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, amountOutMinimum });
  };

  let submitLabel: string;
  let ctaVariant: 'primary' | 'subtle' = 'primary';
  if (isApproving) submitLabel = 'Approving…';
  else if (isPending) submitLabel = 'Swapping…';
  else if (!isConnected) {
    submitLabel = 'Connect wallet';
    ctaVariant = 'subtle';
  } else if (!pool) {
    submitLabel = 'No pool for this pair';
    ctaVariant = 'subtle';
  } else if (!amountEntered) {
    submitLabel = 'Enter an amount';
    ctaVariant = 'subtle';
  } else if (insufficientBalance) {
    submitLabel = `Insufficient ${tokenIn.symbol}`;
    ctaVariant = 'subtle';
  } else if (!hasLiquidity) {
    submitLabel = 'No liquidity';
    ctaVariant = 'subtle';
  } else if (impactNeedsConsent && !impactAccepted) {
    submitLabel = 'Confirm the price impact';
    ctaVariant = 'subtle';
  } else submitLabel = 'Swap';

  const panelClass = 'rounded-xl border border-line bg-surface-muted px-4 pb-3.5 pt-3';
  const bigAmountClass =
    'w-full bg-transparent text-[36px] font-medium leading-tight tracking-tight text-ink outline-none placeholder:text-ink-faint';

  return (
    <div data-testid="swap-form" className="mx-auto w-full max-w-[480px]">
      <Card className="p-2 shadow-card">
        <div className="mb-1 flex items-center justify-between px-2 pt-1">
          <span
            data-testid="swap-tab"
            aria-current="page"
            className="rounded-lg bg-surface-muted px-3 py-1.5 font-mono text-[13px] font-semibold uppercase tracking-wide text-ink"
          >
            Swap
          </span>
          {/* Nothing to configure on a settled trade, so the control that configures the next one
              is not offered here. */}
          <div ref={settingsRef} className={cn('relative', showCompleted && 'hidden')}>
            <button
              type="button"
              data-testid="swap-settings-toggle"
              aria-label="Swap settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((v) => !v)}
              className={cn(
                'grid h-9 w-9 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:shadow-focus',
                settingsOpen && 'bg-surface-muted text-ink',
              )}
            >
              <Settings className="h-[18px] w-[18px]" />
            </button>
            {settingsOpen && (
              <div
                role="dialog"
                aria-label="Slippage settings"
                data-testid="swap-settings-popover"
                className="absolute right-0 z-20 mt-2 w-64 rounded-2xl border border-line bg-surface p-3 shadow-pop"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">Max slippage</span>
                    <span className="text-sm font-mono text-ink-muted" data-testid="swap-slippage-value">
                    {slippageMode !== 'auto'
                      ? formatBps(slippageBps)
                      : hasQuote
                        ? `Auto · ${formatBps(autoBps)}`
                        : 'Auto'}
                  </span>
                </div>
                <div className="flex gap-1.5" data-testid="swap-slippage">
                  <button
                    type="button"
                    data-testid="swap-slippage-auto"
                    aria-pressed={slippageMode === 'auto'}
                    onClick={() => {
                      setSlippageMode('auto');
                      setCustomSlippage('');
                      setCustomSlippageError(null);
                    }}
                    className={cn(
                      'flex-1 rounded-xl border px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                      slippageMode === 'auto'
                        ? 'border-brand bg-brand-soft text-brand'
                        : 'border-line bg-surface text-ink-soft hover:border-line-strong',
                    )}
                  >
                    Auto
                  </button>
                  {SLIPPAGE_PRESETS_BPS.map((bps) => (
                    <button
                      key={bps}
                      type="button"
                      data-testid={`swap-slippage-${bps}`}
                      aria-pressed={slippageMode === 'manual' && slippageBps === bps && customSlippage === ''}
                      onClick={() => {
                        setSlippageMode('manual');
                        setSlippageBps(bps);
                        setCustomSlippage('');
                      }}
                      className={cn(
                        'flex-1 rounded-xl border px-2.5 py-1.5 text-[13px] font-medium transition-colors',
                        slippageMode === 'manual' && slippageBps === bps && customSlippage === ''
                          ? 'border-brand bg-brand-soft text-brand'
                          : 'border-line bg-surface text-ink-soft hover:border-line-strong',
                      )}
                    >
                      {formatBps(bps)}
                    </button>
                  ))}
                </div>

                {/* Typed slippage. The presets cover normal days; a thin or drifting pool needs a
                    number the presets don't have, and the alternative is a swap that just reverts. */}
                <label className="mt-2 flex items-center gap-2">
                  <span className="sr-only">Custom slippage percent</span>
                  <div
                    className={cn(
                      'flex flex-1 items-center rounded-xl border px-2.5 py-1.5 transition-colors',
                      customSlippage !== ''
                        ? 'border-brand bg-brand-soft'
                        : 'border-line bg-surface hover:border-line-strong',
                    )}
                  >
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Custom"
                      value={customSlippage}
                      data-testid="swap-slippage-custom"
                      onChange={(e) => applyCustomSlippage(e.target.value)}
                      className="w-full bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-faint"
                    />
                    <span className="ml-1 text-[13px] text-ink-muted">%</span>
                  </div>
                </label>

                {customSlippageError && (
                  <p className="mt-1.5 text-[11px] text-side-down" data-testid="swap-slippage-error">
                    {customSlippageError}
                  </p>
                )}
                {!customSlippageError && slippageBps >= HIGH_SLIPPAGE_BPS && (
                  <p className="mt-1.5 text-[11px] text-amber-500" data-testid="swap-slippage-warning">
                    You could receive up to {formatBps(slippageBps)} less than quoted.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {showCompleted ? (
          <SwapCompleted
            tokenIn={doneTokenIn}
            tokenOut={doneTokenOut}
            amountIn={result.amountIn}
            amountOut={result.amountOut}
            explorerUrl={arcScanTxUrl(result.hash)}
            onDone={onDone}
          />
        ) : (
          <>
        <div className="relative">
          {/* You pay */}
          <div className={panelClass} data-testid="swap-pay-panel">
            <label className="kicker mb-1 block">You pay</label>
            <div className="flex items-center gap-3">
              <input
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                aria-label={`Amount of ${tokenIn.symbol} to pay`}
                className={cn(bigAmountClass, 'font-mono')}
                data-testid="swap-amount-input"
              />
              <TokenSelect token={tokenIn} onSelect={selectIn} disabledAddr={tokenOut.address} testId="swap-from" />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[13px]">
              <span aria-hidden="true" />
              <button
                type="button"
                data-testid="swap-max"
                onClick={onMax}
                disabled={!isConnected || fromBalance === 0n}
                className="flex items-center gap-1.5 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="font-mono">{formatBase(fromBalance, tokenIn.decimals)}</span>
                <span className="font-mono">{tokenIn.symbol}</span>
                <span className="font-semibold text-brand hover:text-brand-hover">Max</span>
              </button>
            </div>
          </div>

          <div className="relative z-10 -my-3 flex justify-center">
            <button
              type="button"
              data-testid="swap-flip"
              onClick={onFlip}
              aria-label="Flip swap direction"
              className="grid h-10 w-10 place-items-center rounded-xl border-4 border-surface bg-surface-muted text-ink transition-colors hover:text-brand focus-visible:outline-none focus-visible:shadow-focus"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          </div>

          {/* You receive */}
          <div className={panelClass} data-testid="swap-receive-panel">
            <label className="kicker mb-1 block">You receive</label>
            <div className="flex items-center gap-3">
              <div
                data-testid="swap-amount-out"
                className={cn(bigAmountClass, 'font-mono', !hasQuote && 'text-ink-faint')}
              >
                {hasQuote ? formatBase(amountOut, tokenOut.decimals) : '0'}
              </div>
              <TokenSelect
                token={tokenOut}
                onSelect={selectOut}
                disabledAddr={tokenIn.address}
                testId="swap-to"
                menuPlacement="top"
              />
            </div>
            <div className="mt-1.5 h-[18px]" aria-hidden="true" />
          </div>
        </div>

        {hasQuote && (
          <div className="mt-2 space-y-1.5 px-1 text-[13px]">
            <div className="flex items-center justify-between">
              <span className="kicker">Price impact</span>
              <span
                data-testid="swap-price-impact"
                className={cn('font-mono', highImpact ? 'text-amber-600 dark:text-amber-400' : 'text-ink-soft')}
              >
                {formatBps(priceImpactBps)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="kicker">Min. received</span>
              <span data-testid="swap-min-received" className="font-mono text-ink-soft">
                {formatBase(amountOutMinimum, tokenOut.decimals)} {tokenOut.symbol}
              </span>
            </div>
            {!exactQuote.exact && (
              <p className="text-[11px] text-ink-muted" data-testid="swap-quote-estimated">
                Estimated from the pool price. The floor above is widened to match.
              </p>
            )}
          </div>
        )}

        {/* A trade this size moves the pool a long way. It used to be refused outright, which on a
            thin pool simply meant the swap could not be done at all. Show the number and let the
            user decide, because it is their trade. */}
        {hasQuote && impactNeedsConsent && (
          <label
            data-testid="swap-impact-consent"
            className="mx-1 mt-2 block cursor-pointer rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
          >
            <span className="block">
              This swap moves the price {formatBps(priceImpactBps)}. You would receive about{' '}
              {formatBase(amountOut, tokenOut.decimals)} {tokenOut.symbol}, and no less than{' '}
              {formatBase(amountOutMinimum, tokenOut.decimals)}.
            </span>
            {/* Its own line: the box belongs next to the words it is agreeing to, not floating
                beside a paragraph. */}
            <span className="mt-2 flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={impactAccepted}
                data-testid="swap-impact-consent-input"
                onChange={(e) => setImpactAccepted(e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-line accent-brand"
              />
              I accept.
            </span>
          </label>
        )}
        {!hasQuote && (
          <div className="sr-only">
            <span data-testid="swap-price-impact">—</span>
            <span data-testid="swap-min-received">—</span>
          </div>
        )}

        {/* Suppressed while the consent box is up: that already states the impact, and saying it
            twice makes the screen look like two different problems. */}
        {highImpact && !impactNeedsConsent && (
          <p
            data-testid="swap-impact-warning"
            className="mx-1 mt-2 flex items-start gap-1.5 rounded-xl border border-amber-300/60 bg-amber-50 px-3 py-2 text-[13px] text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300"
          >
            <Alert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            High price impact — you&apos;re moving the pool a lot. Consider a smaller amount.
          </p>
        )}

        {pool && !hasLiquidity && (
          <p data-testid="swap-no-liquidity" className="mx-1 mt-2 text-[13px] text-ink-muted">
            This pool has no liquidity yet — provide liquidity first so swaps can route.
          </p>
        )}
        {insufficientBalance && !isPending && (
          <span data-testid="swap-insufficient" className="mx-1 mt-2 block text-[13px] text-side-down">
            Insufficient {tokenIn.symbol}.
          </span>
        )}

        {/* Inset the CTA inside the card's straight edge — the card is a chamfered HUD octagon that clips
            its children, so a full-bleed button's corners would be cut. Bigger label than the inputs. */}
        <div className="px-4 pt-2">
          <button
            type="button"
            data-testid="swap-submit"
            disabled={!canSwap}
            onClick={onSwap}
            className={buttonClass(ctaVariant, 'md', 'w-full text-base star-btn--contain')}
          >
            {submitLabel}
            {ctaVariant === 'primary' && <Stars />}
          </button>
        </div>

        {error && (
          <p role="alert" className="mx-1 mt-2 text-[13px] text-side-down">
            {error.message}
          </p>
        )}
          </>
        )}
      </Card>
    </div>
  );
}
