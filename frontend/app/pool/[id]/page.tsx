'use client';

// app/pool/[id]/page.tsx - the deposit page (reference image #3): a "Set price range" card with the
// DRAGGABLE range chart + the Narrow/Balanced/Wide/Full-Range presets + EDITABLE Min/Max price fields,
// all kept in sync (they all write the SAME tick range), beside the "Add deposit amount" module.
// Reached by clicking a pool row OR via the Create modal's Continue. The range lives here and is fed to
// useLiquidityDeposit (the deposit mechanics); the chart, presets and Min/Max fields only SELECT it.
import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import Link from 'next/link';
import { poolById, poolLabel, POOLS } from '@/lib/pools';
import { presetTicks, customTicks, type RangePreset, type TickRange } from '@/lib/rangeMath';
import { bandPrices, isFullRangeTicks } from '@/lib/rangeDisplay';
import { parsePrice, toPlainPrice, validPriceBand } from '@/lib/priceInput';
import { useLiquidityDeposit } from '@/hooks/useLiquidityDeposit';
import { usePoolStats } from '@/hooks/usePoolStats';
import { formatUsd, formatPct } from '@/lib/poolStats';
import { formatBps } from '@/lib/format';
import { ENV } from '@/lib/env';
import { Card } from '@/components/ui/Card';
import { TokenPairGlyph } from '@/components/TokenGlyph';
import { RangeChart } from '@/components/pool/RangeChart';
import { DepositPanel } from '@/components/pool/DepositPanel';
import { ChevronDown } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

type Choice = RangePreset; // 'narrow' | 'balanced' | 'wide' | 'full'

const PRESETS: ReadonlyArray<{ id: Choice; label: string }> = [
  { id: 'narrow', label: 'Narrow' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'wide', label: 'Wide' },
  { id: 'full', label: 'Full Range' },
];

/** A small Liquidity / Volume / Fees stat for the page header. */
function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-muted/50 px-3.5 py-2">
      <div className="kicker">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold text-ink tnum">{value}</div>
    </div>
  );
}

/** A read-only stat card (the Estimated APR). */
function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-surface-muted/40 px-4 py-3 text-center">
      <div className="kicker">{label}</div>
      <div className={cn('mt-1 font-mono text-lg font-semibold tnum', accent ? 'text-side-up' : 'text-ink')}>
        {value}
      </div>
    </div>
  );
}

/** An EDITABLE price card - click the label/value to type a Min/Max bound; drives the range (→ custom). */
function PriceInputCard({
  label,
  value,
  onChange,
  onBlur,
  unit,
  testid,
  invalid,
  errorId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: (e: FocusEvent<HTMLInputElement>) => void;
  unit: string;
  testid: string;
  invalid: boolean;
  errorId: string;
}) {
  const id = useId();
  return (
    <div
      className={cn(
        'rounded-xl border bg-surface-muted/40 px-4 py-3 text-center transition-colors',
        invalid ? 'border-side-down/60' : 'border-line focus-within:border-brand/50',
      )}
    >
      <label htmlFor={id} className="kicker block cursor-text">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        inputMode="decimal"
        placeholder="0.00"
        aria-label={`${label} price (${unit})`}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        data-testid={testid}
        className="mt-1 w-full bg-transparent text-center font-mono text-lg font-semibold tnum text-ink outline-none placeholder:text-ink-faint"
      />
      <div className="mt-0.5 text-[11px] text-ink-faint">{unit}</div>
    </div>
  );
}

export default function PoolDetailPage({ params }: { params: { id: string } }) {
  const pool = poolById(params.id);

  // ── Range selection state (shared by the chart, the presets AND the Min/Max fields) ───────────
  const [range, setRange] = useState<TickRange | undefined>(undefined);
  const [choice, setChoice] = useState<Choice | 'custom'>('balanced');
  const [minInput, setMinInput] = useState('');
  const [maxInput, setMaxInput] = useState('');
  // True while a range change ORIGINATES from typing in Min/Max, so the sync effect below doesn't clobber
  // what the user is typing. Chart drags / preset clicks leave it false → the fields re-sync to the band.
  const fromInputRef = useRef(false);
  const rangeErrorId = useId();

  // Hooks must run unconditionally; fall back to a real pool so the deposit hook never reads `undefined`
  // (the not-found UI is rendered below, after all hooks have run).
  const deposit = useLiquidityDeposit(pool ?? POOLS[0], range);
  const { currentTick, currentPrice, spacing, dec0, dec1 } = deposit;

  // Initialise to a Balanced band once the live tick lands (presets need it; full needs no tick).
  useEffect(() => {
    if (range === undefined && currentTick !== undefined && pool) {
      setRange(presetTicks('balanced', currentTick, spacing));
    }
  }, [range, currentTick, spacing, pool]);

  // Keep the Min/Max fields in sync with the band whenever the range changes from the chart or a preset
  // (NOT from typing - fromInputRef guards that, so the user's keystrokes aren't overwritten).
  useEffect(() => {
    if (fromInputRef.current) {
      fromInputRef.current = false;
      return;
    }
    if (!pool || !range) {
      setMinInput('');
      setMaxInput('');
      return;
    }
    if (isFullRangeTicks(range.tickLower, range.tickUpper, spacing)) {
      setMinInput('0');
      setMaxInput('∞');
      return;
    }
    const b = bandPrices(range.tickLower, range.tickUpper, dec0, dec1, pool.baseIsToken0);
    setMinInput(toPlainPrice(b.min));
    setMaxInput(toPlainPrice(b.max));
  }, [range, dec0, dec1, spacing, pool]);

  const stats = usePoolStats();

  if (!pool) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="font-display text-2xl font-semibold text-ink">Pool not found</h1>
        <p className="mt-2 text-sm text-ink-soft">That pool id doesn’t exist.</p>
        <Link href="/pool" className="mt-5 inline-block font-medium text-brand hover:text-brand-hover">
          ← Back to pools
        </Link>
      </div>
    );
  }

  // Preset click → recompute ticks around the live price (full needs no tick). Chart drag → 'custom'.
  const selectPreset = (id: Choice) => {
    setChoice(id);
    if (id === 'full') {
      setRange(presetTicks('full', 0, spacing));
    } else if (currentTick !== undefined) {
      setRange(presetTicks(id, currentTick, spacing));
    }
  };
  const onChartChange = (r: TickRange) => {
    setRange(r);
    setChoice('custom');
  };

  // Typing a Min/Max bound commits a CUSTOM range when the pair is a valid 0 < min < max band - and only
  // when the spacing-aligned ticks ACTUALLY change (so typing within one tick-spacing band doesn't churn
  // the deposit hook / chart every keystroke).
  const commitBand = (minS: string, maxS: string) => {
    if (!validPriceBand(minS, maxS)) return;
    const next = customTicks(parsePrice(minS), parsePrice(maxS), dec0, dec1, pool.baseIsToken0, spacing);
    if (range && next.tickLower === range.tickLower && next.tickUpper === range.tickUpper) return;
    fromInputRef.current = true;
    setRange(next);
    setChoice('custom');
  };
  const onMinInput = (v: string) => {
    setMinInput(v);
    commitBand(v, maxInput);
  };
  const onMaxInput = (v: string) => {
    setMaxInput(v);
    commitBand(minInput, v);
  };
  // On blur, if the fields don't form a valid band (cleared / partial / invalid / a half-edited full
  // range), restore them from the COMMITTED range so what the user sees always matches what will be
  // minted. A valid band is left exactly as typed.
  const reconcileFields = () => {
    if (!range || validPriceBand(minInput, maxInput)) return;
    if (isFullRangeTicks(range.tickLower, range.tickUpper, spacing)) {
      setMinInput('0');
      setMaxInput('∞');
      return;
    }
    const b = bandPrices(range.tickLower, range.tickUpper, dec0, dec1, pool.baseIsToken0);
    setMinInput(toPlainPrice(b.min));
    setMaxInput(toPlainPrice(b.max));
  };
  // Reconcile only when focus leaves the range fields ENTIRELY - never when tabbing/clicking from Min to
  // Max (otherwise a half-finished band, e.g. a typed Min while Max is still being entered, gets wiped).
  const onFieldBlur = (e: FocusEvent<HTMLInputElement>) => {
    const tid = (e.relatedTarget as HTMLElement | null)?.getAttribute('data-testid');
    if (tid === 'min-price-input' || tid === 'max-price-input') return;
    reconcileFields();
  };

  const unit = `${pool.quote.symbol} per ${pool.base.symbol}`;
  // Estimated APR = the pool's REAL fee APR (consistent with the list column). We no longer multiply by a
  // concentration boost - on these thin testnet pools the base APR is already high, so the boost produced
  // an absurd ">9,999%". Showing the genuine pool APR is realistic and matches what the list displays.
  const poolApr = stats.rows[pool.id]?.aprPct;
  const row = stats.rows[pool.id];

  // Invalid whenever both fields are filled with something that isn't a valid band - EXCEPT the untouched
  // full-range "0 / ∞" sentinels (a valid display state, not user-entered garbage). So a typed "∞", a
  // grouped paste or min ≥ max surfaces the hint instead of being silently swallowed.
  const isFullSentinel = choice === 'full' && minInput === '0' && maxInput === '∞';
  const customInvalid =
    !isFullSentinel && minInput.trim() !== '' && maxInput.trim() !== '' && !validPriceBand(minInput, maxInput);

  return (
    <div className="pool-upscale mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4 motion-safe:animate-fade-up">
        <div className="flex items-center gap-3">
          <Link
            href="/pool"
            aria-label="Back to pools"
            className="grid h-9 w-9 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <ChevronDown className="h-4 w-4 rotate-90" />
          </Link>
          <TokenPairGlyph baseSymbol={pool.base.symbol} quoteSymbol={pool.quote.symbol} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-display text-xl font-semibold text-ink">{poolLabel(pool)}</h1>
              <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-soft">
                {formatBps(ENV.FEE_TIER / 100)}
              </span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <HeaderStat label="Liquidity" value={row?.tvlUsd !== undefined ? formatUsd(row.tvlUsd) : '…'} />
          <HeaderStat label="Volume 24h" value={row?.volume24Usd !== undefined ? formatUsd(row.volume24Usd) : '…'} />
          <HeaderStat label="Fees 24h" value={row?.fees24Usd !== undefined ? formatUsd(row.fees24Usd) : '…'} />
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.45fr_1fr]">
        {/* Left - set price range */}
        <Card className="motion-safe:animate-fade-up">
          <div className="px-5 py-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-[15px] font-semibold text-ink">Set price range</h2>
              {choice === 'custom' && (
                <span className="rounded-full border border-side-up/40 bg-side-up/10 px-2 py-0.5 text-[11px] font-medium text-side-up">
                  Custom range
                </span>
              )}
            </div>

            <RangeChart
              pool={pool}
              currentPrice={currentPrice}
              range={range}
              spacing={spacing}
              dec0={dec0}
              dec1={dec1}
              onChange={onChartChange}
            />

            {/* Presets - drag, click OR type Min/Max; all stay synced with the handles above. */}
            <div className="mt-4">
              <span className="kicker mb-2 block">Or pick a preset</span>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PRESETS.map((p) => {
                  const active = choice === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`preset-${p.id}`}
                      aria-pressed={active}
                      onClick={() => selectPreset(p.id)}
                      className={cn(
                        'rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors',
                        active
                          ? 'border-brand bg-brand-soft text-brand'
                          : 'border-line bg-surface text-ink-soft hover:border-line-strong',
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Min / Max (editable) / Estimated APR */}
            <div className="mt-4 grid grid-cols-3 gap-2">
              <PriceInputCard
                label="Min"
                value={minInput}
                onChange={onMinInput}
                onBlur={onFieldBlur}
                unit={unit}
                testid="min-price-input"
                invalid={customInvalid}
                errorId={rangeErrorId}
              />
              <PriceInputCard
                label="Max"
                value={maxInput}
                onChange={onMaxInput}
                onBlur={onFieldBlur}
                unit={unit}
                testid="max-price-input"
                invalid={customInvalid}
                errorId={rangeErrorId}
              />
              <StatCard label="Estimated APR" value={poolApr !== undefined ? formatPct(poolApr) : '-'} accent />
            </div>
            {customInvalid && (
              <p id={rangeErrorId} data-testid="range-invalid" role="alert" className="mt-2 text-center text-[11px] text-side-down">
                Enter a valid range - min must be above 0 and below max.
              </p>
            )}
          </div>
        </Card>

        {/* Right - deposit */}
        <Card className="motion-safe:animate-fade-up">
          <div className="px-5 py-5">
            <DepositPanel pool={pool} deposit={deposit} />
          </div>
        </Card>
      </div>
    </div>
  );
}
