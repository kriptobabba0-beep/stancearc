'use client';

// components/pool/RangeChart.tsx - the liquidity-range chart with DRAGGABLE boundary handles (reference
// image #3). The x-axis is linear in HUMAN price; two handles bracket the selected band and can be
// dragged (pointer) or nudged (keyboard) to set the range. Every change emits CANONICAL spacing-aligned
// ticks via lib/rangeMath.customTicks, so a drag and a preset button feed the exact SAME mint - the
// parent holds the tick range and the handles re-derive their positions from it, keeping the two methods
// perfectly in sync. The depth backdrop is a stylised concentrated-liquidity curve (a visual aid for
// choosing a band, not a per-tick on-chain claim - see lib/rangeChartMath.depthBars).
import { useEffect, useRef, useState } from 'react';
import type { PoolInfo } from '@/lib/pools';
import { customTicks, type TickRange } from '@/lib/rangeMath';
import { bandPrices, formatHumanPrice } from '@/lib/rangeDisplay';
import {
  makeDomain,
  priceToFraction,
  depthBars,
  pctFromCurrent,
  type PriceDomain,
} from '@/lib/rangeChartMath';
import { Plus, Minus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

const NBARS = 41;
const MIN_GAP = 0.012; // min fraction between handles (keeps lower < upper)
const DEFAULT_ZOOM = 0.45;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** A pct chip for a handle ("−10.11%"); blank for the degenerate 0/∞ full-range bounds. */
function pctLabel(price: number, current: number): string {
  if (!(price > 0) || price >= 1e15 || !(current > 0)) return '';
  const p = pctFromCurrent(price, current);
  return `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`;
}

export function RangeChart({
  pool,
  currentPrice,
  range,
  spacing,
  dec0,
  dec1,
  onChange,
}: {
  pool: PoolInfo;
  /** Human price (quote per base) from slot0, or undefined while loading. */
  currentPrice: number | undefined;
  /** The selected canonical range (ticks). */
  range: TickRange | undefined;
  spacing: number;
  dec0: number;
  dec1: number;
  /** Emits a new spacing-aligned range whenever a handle moves. */
  onChange: (range: TickRange) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'lo' | 'hi' | null>(null);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  const baseIsToken0 = pool.baseIsToken0;
  const domain: PriceDomain = makeDomain(currentPrice ?? 0, zoom);
  const priceAt = (frac: number) => domain.min + clamp(frac, 0, 1) * (domain.max - domain.min);

  // Selected band as ordered human prices, then as fractions across the domain.
  const band =
    range !== undefined ? bandPrices(range.tickLower, range.tickUpper, dec0, dec1, baseIsToken0) : undefined;
  const loFrac = band ? priceToFraction(band.min, domain) : 0;
  const hiFrac = band ? priceToFraction(band.max, domain) : 1;

  const curFrac = currentPrice ? priceToFraction(currentPrice, domain) : 0.5;
  const bars = depthBars(domain, currentPrice ?? 0, NBARS);

  /** Set one bound from a target fraction → canonical ticks via customTicks. */
  const applyBound = (which: 'lo' | 'hi', frac: number) => {
    if (!currentPrice) return;
    const f = clamp(frac, 0, 1);
    let nextLoFrac = loFrac;
    let nextHiFrac = hiFrac;
    if (which === 'lo') nextLoFrac = Math.min(f, hiFrac - MIN_GAP);
    else nextHiFrac = Math.max(f, loFrac + MIN_GAP);
    const minPrice = priceAt(clamp(nextLoFrac, 0, 1));
    const maxPrice = priceAt(clamp(nextHiFrac, 0, 1));
    if (!(minPrice > 0) || !(maxPrice > minPrice)) return;
    onChange(customTicks(minPrice, maxPrice, dec0, dec1, baseIsToken0, spacing));
  };

  // Pointer drag - window listeners while a handle is held (so the drag survives leaving the track).
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const el = trackRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      applyBound(dragging, frac);
    };
    const onUp = () => setDragging(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, loFrac, hiFrac, domain.min, domain.max, currentPrice]);

  // Keyboard nudge: ← / → move the bound by 1% of the domain (×5 with Shift).
  const onHandleKey = (which: 'lo' | 'hi', e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = (e.shiftKey ? 0.05 : 0.01) * (e.key === 'ArrowRight' ? 1 : -1);
    applyBound(which, (which === 'lo' ? loFrac : hiFrac) + step);
  };

  const zoomBy = (factor: number) => setZoom((z) => clamp(z * factor, 0.08, 3));

  const loaded = currentPrice !== undefined && currentPrice > 0;

  return (
    <div data-testid="range-chart">
      {/* Header: live price + zoom controls */}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-sm">
          <span className="text-ink-muted">Price </span>
          <span className="font-mono font-semibold text-ink tnum">
            {loaded ? formatHumanPrice(currentPrice!) : '…'}
          </span>{' '}
          <span className="text-ink-muted">
            {pool.quote.symbol} per {pool.base.symbol}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => zoomBy(0.8)}
            aria-label="Zoom in"
            className="grid h-7 w-7 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom out"
            className="grid h-7 w-7 place-items-center rounded-lg border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* The track */}
      <div
        ref={trackRef}
        className="relative h-[240px] touch-none select-none overflow-hidden rounded-xl border border-line bg-surface-muted/50"
      >
        {/* Depth backdrop */}
        <div className="absolute inset-0 flex items-end gap-px px-px">
          {bars.map((h, i) => {
            const center = (i + 0.5) / NBARS;
            const inBand = center >= loFrac && center <= hiFrac;
            return (
              <div
                key={i}
                className={cn('flex-1 rounded-t-[1px]', inBand ? 'bg-side-up/70' : 'bg-ink-faint/20')}
                style={{ height: `${Math.max(2, h * 100)}%` }}
              />
            );
          })}
        </div>

        {loaded && (
          <>
            {/* Selected region */}
            <div
              className="absolute inset-y-0 border-x border-side-up/60 bg-side-up/5"
              style={{ left: `${loFrac * 100}%`, width: `${Math.max(0, (hiFrac - loFrac) * 100)}%` }}
              aria-hidden="true"
            />
            {/* Current price marker */}
            <div
              className="absolute inset-y-0 w-px border-l border-dashed border-ink-soft"
              style={{ left: `${curFrac * 100}%` }}
              aria-hidden="true"
            >
              <span className="absolute -top-px left-1 rounded bg-surface px-1 font-mono text-[10px] text-ink-muted">
                now
              </span>
            </div>

            {/* Handles */}
            {(['lo', 'hi'] as const).map((which) => {
              const frac = which === 'lo' ? loFrac : hiFrac;
              const price = which === 'lo' ? band?.min : band?.max;
              const pct = price !== undefined ? pctLabel(price, currentPrice!) : '';
              return (
                <div
                  key={which}
                  role="slider"
                  tabIndex={0}
                  aria-label={which === 'lo' ? 'Lower price bound' : 'Upper price bound'}
                  aria-valuemin={Math.round(domain.min)}
                  aria-valuemax={Math.round(domain.max)}
                  aria-valuenow={price !== undefined && Number.isFinite(price) ? Math.round(price) : undefined}
                  aria-valuetext={price !== undefined ? `${formatHumanPrice(price)} ${pool.quote.symbol} per ${pool.base.symbol}` : undefined}
                  data-testid={`range-handle-${which}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setDragging(which);
                  }}
                  onKeyDown={(e) => onHandleKey(which, e)}
                  className={cn(
                    'group absolute inset-y-0 z-10 flex w-5 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center',
                    'focus-visible:outline-none',
                  )}
                  style={{ left: `${frac * 100}%` }}
                >
                  {/* vertical line + grip */}
                  <span className="absolute inset-y-0 w-0.5 bg-side-up" />
                  <span
                    className={cn(
                      'relative z-10 grid h-9 w-3.5 place-items-center rounded-[3px] bg-side-up text-surface shadow-pop',
                      'ring-2 ring-transparent transition group-focus-visible:ring-side-up/60',
                    )}
                  >
                    <span className="flex flex-col gap-[3px]">
                      <span className="h-3 w-px bg-surface/80" />
                    </span>
                  </span>
                  {/* % chip */}
                  {pct && (
                    <span
                      className={cn(
                        'absolute top-1.5 whitespace-nowrap rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-ink-soft ring-1 ring-line',
                        which === 'lo' ? 'right-1/2 mr-2' : 'left-1/2 ml-2',
                      )}
                    >
                      {pct}
                    </span>
                  )}
                </div>
              );
            })}
          </>
        )}

        {!loaded && (
          <div className="absolute inset-0 grid place-items-center text-sm text-ink-muted">
            Loading live pool price…
          </div>
        )}
      </div>

      {/* X-axis price ticks */}
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-ink-faint" aria-hidden="true">
        {Array.from({ length: 5 }, (_, i) => {
          const p = domain.min + (i / 4) * (domain.max - domain.min);
          return <span key={i}>{loaded ? formatHumanPrice(p) : '-'}</span>;
        })}
      </div>
    </div>
  );
}
