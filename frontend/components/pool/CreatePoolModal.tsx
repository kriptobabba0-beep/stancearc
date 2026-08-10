'use client';

// components/pool/CreatePoolModal.tsx — the "Create" modal (reference image #2), trimmed to what this
// app needs: pick TOKEN A + TOKEN B, then Continue → that pool's deposit page (/pool/[id]). Deliberately
// NO fee-tier selector and NO V2/V3 selector — the app is single-version with a fixed fee tier (the
// reference's selectors are dropped per the brief). Token B is constrained to tokens that actually have
// a pool with Token A, so Continue always resolves to a real registry pool.
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/Modal';
import { TokenGlyph } from '@/components/TokenGlyph';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { ChevronDown } from '@/components/ui/icons';
import { TOKENS, type TokenInfo } from '@/lib/tokens';
import { findPool, pairableTokens, poolLabel } from '@/lib/pools';
import { formatBps } from '@/lib/format';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';

/** A compact token dropdown: glyph + symbol + chevron → a small listbox of `options`. */
function TokenSelect({
  value,
  options,
  onChange,
  label,
}: {
  value: TokenInfo;
  options: TokenInfo[];
  onChange: (t: TokenInfo) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-xl border border-line bg-surface-muted px-3.5 py-3 text-left transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:shadow-focus"
      >
        <TokenGlyph symbol={value.symbol} className="h-7 w-7 text-[13px]" />
        <span className="flex-1 font-display text-[15px] font-semibold text-ink">{value.symbol}</span>
        <ChevronDown className={cn('h-4 w-4 text-ink-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          {/* click-away */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <ul
            role="listbox"
            aria-label={label}
            className="absolute left-0 right-0 z-20 mt-1.5 overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
          >
            {options.map((t) => {
              const selected = t.address.toLowerCase() === value.address.toLowerCase();
              return (
                <li key={t.address} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(t);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-muted',
                      selected && 'bg-brand-soft',
                    )}
                  >
                    <TokenGlyph symbol={t.symbol} className="h-6 w-6 text-[11px]" />
                    <span className="font-display text-sm font-semibold text-ink">{t.symbol}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

export function CreatePoolModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  // Default to the first registry pair (cirBTC / USDC).
  const [tokenA, setTokenA] = useState<TokenInfo>(TOKENS[0]);
  const [tokenB, setTokenB] = useState<TokenInfo>(TOKENS[1]);

  // Token B options = whatever has a real pool with Token A.
  const bOptions = useMemo(() => pairableTokens(tokenA), [tokenA]);

  const onPickA = (t: TokenInfo) => {
    setTokenA(t);
    // Keep B valid for the new A.
    const opts = pairableTokens(t);
    if (!opts.some((o) => o.address.toLowerCase() === tokenB.address.toLowerCase())) {
      if (opts[0]) setTokenB(opts[0]);
    }
  };

  const pool = findPool(tokenA, tokenB);

  const onContinue = () => {
    if (!pool) return;
    onClose();
    router.push(`/pool/${pool.id}`);
  };

  return (
    <Modal open={open} onClose={onClose} className="max-w-md">
      <h2 className="font-display text-xl font-semibold text-ink">Create position</h2>
      <p className="mt-1 text-sm text-ink-soft">Pick a pair — you’ll set your range and deposit next.</p>

      <div className="mt-5 space-y-2.5">
        <div>
          <span className="kicker mb-1.5 block">Token A</span>
          <TokenSelect value={tokenA} options={TOKENS} onChange={onPickA} label="Select token A" />
        </div>
        <div>
          <span className="kicker mb-1.5 block">Token B</span>
          <TokenSelect value={tokenB} options={bOptions} onChange={setTokenB} label="Select token B" />
        </div>
      </div>

      {/* Fixed-tier context (NOT a selector — the fee tier and version are fixed for the app). */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-dashed border-line bg-surface-muted px-3.5 py-2.5 text-xs text-ink-muted">
        <span>Fee tier</span>
        <span className="font-mono font-medium text-ink-soft">{formatBps(ENV.FEE_TIER / 100)} · fixed</span>
      </div>

      {!pool && (
        <p role="alert" className="mt-3 text-xs text-side-down" data-testid="create-no-pool">
          No pool exists for {tokenA.symbol} / {tokenB.symbol}. Pick a different pair.
        </p>
      )}

      <button
        type="button"
        data-testid="create-continue"
        disabled={!pool}
        onClick={onContinue}
        className={cn(buttonClass('primary', 'lg', 'mt-5 w-full'))}
      >
        {pool ? `Continue to ${poolLabel(pool)}` : 'Select a valid pair'}
        <Stars />
      </button>
    </Modal>
  );
}
