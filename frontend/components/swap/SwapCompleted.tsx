'use client';

// components/swap/SwapCompleted.tsx — what the swap card becomes once the trade has settled.
//
// It replaces the form INSIDE the same card rather than opening a modal over it. A swap is one
// continuous act, and the number the user was watching should simply stop being a prediction and
// become a fact, in the place they were already looking. A modal would break that: it covers the
// thing it is reporting on, and it has to be dismissed before the eye can go back.
//
// The figure shown is what the chain settled at, read off the receipt (see lib/swapReceipt), not
// the quote from before signing. On a thin pool those differ, and the Explorer button is right
// there — a number that doesn't match what it opens is worse than no number.
//
// When the receipt didn't carry a readable payout the amount is simply left out. The swap still
// confirmed and that is still said plainly; what is not known is not guessed at.
import { cn } from '@/lib/cn';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Check, External } from '@/components/ui/icons';
import { TokenGlyph } from '@/components/TokenGlyph';
import { formatBase } from '@/lib/format';
import type { TokenInfo } from '@/lib/tokens';

export function SwapCompleted({
  tokenIn,
  tokenOut,
  amountIn,
  amountOut,
  explorerUrl,
  onDone,
}: {
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: bigint;
  /** Null when the receipt carried no readable payout — the amount is then left unsaid. */
  amountOut: bigint | null;
  explorerUrl?: string;
  onDone: () => void;
}) {
  return (
    <div data-testid="swap-completed">
      <div className="rounded-xl border border-brand/25 bg-surface-muted px-4 pb-5 pt-5">
        {/* The mark: a drawn check inside the crimson ring, with one halo that expands and goes.
            Sized to sit level with the kicker rather than tower over it. */}
        <div className="swap-done-rise flex items-center gap-2.5">
          <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full border border-brand/50 bg-brand-soft/60">
            <span
              aria-hidden="true"
              className="swap-done-halo pointer-events-none absolute inset-0 rounded-full border border-brand/60"
            />
            <Check className="swap-done-check h-4 w-4 text-brand" aria-hidden="true" />
          </span>
          <span className="kicker text-brand">Swap completed</span>
        </div>

        {/* The settled figure, in the same numerals the input used, so it reads as the same object
            rather than a different screen's summary. */}
        <div className="swap-done-rise swap-done-d1 mt-4 flex items-end gap-3">
          <div
            data-testid="swap-completed-amount"
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-[36px] font-medium leading-none tracking-tight',
              amountOut === null ? 'text-ink-faint' : 'text-ink',
            )}
          >
            {amountOut === null ? '—' : formatBase(amountOut, tokenOut.decimals)}
          </div>
          <span className="mb-0.5 inline-flex shrink-0 items-center gap-1.5 font-mono text-[15px] font-semibold text-ink">
            <TokenGlyph symbol={tokenOut.symbol} />
            {tokenOut.symbol}
          </span>
        </div>

        <div
          aria-hidden="true"
          className="swap-done-seam mt-4 h-px w-full"
        />

        <div className="swap-done-rise swap-done-d2 mt-4 flex items-center justify-between text-[13px]">
          <span className="kicker">You paid</span>
          <span data-testid="swap-completed-paid" className="font-mono text-ink-soft">
            {formatBase(amountIn, tokenIn.decimals)} {tokenIn.symbol}
          </span>
        </div>

        {amountOut === null && (
          <p className="swap-done-rise swap-done-d2 mt-3 text-[12px] text-ink-muted">
            Confirmed on chain. The exact amount received wasn&apos;t in the receipt — open the
            explorer to see it.
          </p>
        )}
      </div>

      {/* Inset to match the form's CTA: the card is a chamfered octagon that clips its children,
          so a full-bleed button would lose its corners. */}
      <div className="swap-done-rise swap-done-d3 space-y-2 px-4 pt-3">
        {explorerUrl && (
          <a
            data-testid="swap-completed-explorer"
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            // Bordered rather than bare: it is the second action, so it has to read as a button
            // without ever competing with the crimson one beneath it.
            className={buttonClass(
              'ghost',
              'md',
              'flex w-full items-center justify-center gap-2 border border-line bg-surface text-[15px] text-ink-soft hover:border-line-strong hover:bg-surface-muted hover:text-ink',
            )}
          >
            Explorer
            <External className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
        <button
          type="button"
          data-testid="swap-completed-done"
          onClick={onDone}
          className={buttonClass('primary', 'md', 'w-full text-base star-btn--contain')}
          autoFocus
        >
          Done
          <Stars />
        </button>
      </div>
    </div>
  );
}
