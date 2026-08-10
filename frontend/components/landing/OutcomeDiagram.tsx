'use client';

// components/landing/OutcomeDiagram.tsx — the hero's centerpiece (mockup 7.png): the live market as
// a circuit. One input line feeds a circular PRICE NODE (pair · live oracle price · LIVE dot), which
// branches along three animated connectors to the three outcomes:
//   ↗ UP    — settles higher than the band top
//   ∿ RANGE — settles inside the ±band
//   ↘ DOWN  — settles lower than the band bottom
// Every number is real: the node shows the live Pyth price; the outcome thresholds are the actual
// settlement band (epoch start price ± bandBps once the round is running, else around the live price).
// Connectors are an absolutely-positioned SVG underlay (percent coordinates + non-scaling strokes) so
// the layout stays responsive; dashes travel outward via the .dash-anim keyframe.
import { TrendUp, TrendDown, WaveRange } from '@/components/ui/icons';
import { formatUsdPrice18 } from '@/lib/arena';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

const UP_HEX = 'rgb(64 209 120)';
const DOWN_HEX = 'rgb(255 113 102)';
const RANGE_HEX = 'rgb(124 136 153)';

function OutcomeChip({
  icon,
  name,
  detail,
  colorClass,
  hex,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
  colorClass: string;
  hex: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-full border bg-surface', colorClass)}
        style={{ borderColor: hex, boxShadow: `0 0 18px -8px ${hex}` }}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className={cn('block text-sm font-bold tracking-tight', colorClass)}>{name}</span>
        <span className="block whitespace-nowrap font-mono text-[11px] text-ink-muted">{detail}</span>
      </span>
    </div>
  );
}

export function OutcomeDiagram({
  pairLabel,
  price18,
  refPrice18,
  bandBps,
  refIsLive,
}: {
  /** e.g. "cirBTC / USDC" */
  pairLabel: string;
  /** The live oracle price (node display). 0n while loading. */
  price18: bigint;
  /** The band anchor: the running epoch's start price, or the live price pre-start. */
  refPrice18: bigint;
  bandBps: number;
  /** True when the band is anchored to the live price (epoch not started yet). */
  refIsLive: boolean;
}) {
  const band = BigInt(Math.abs(bandBps));
  const upAt = refPrice18 > 0n ? (refPrice18 * (10_000n + band)) / 10_000n : 0n;
  const downAt = refPrice18 > 0n ? (refPrice18 * (10_000n - band)) / 10_000n : 0n;
  const fmt = (v: bigint) => (v > 0n ? formatUsdPrice18(v) : '…');

  return (
    <div className="landing-float relative">
      <div className="relative flex items-center gap-6 sm:gap-10">
        {/* Connector underlay — input line into the node + three branches out to the chips. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="pointer-events-none absolute inset-0 h-full w-full"
        >
          {/* input feed */}
          <path
            d="M -2 50 H 14"
            fill="none"
            stroke="rgb(82 82 92)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d="M -2 50 H 14"
            fill="none"
            stroke="rgb(229 72 77 / 0.9)"
            strokeWidth="1.2"
            vectorEffect="non-scaling-stroke"
            className="dash-anim"
          />
          {/* branches: node edge (~38,50) → chips (~72, 12/50/88) */}
          {(
            [
              { d: 'M 38 50 C 52 50, 56 12, 70 12', hex: UP_HEX },
              { d: 'M 38 50 C 52 50, 56 50, 70 50', hex: RANGE_HEX },
              { d: 'M 38 50 C 52 50, 56 88, 70 88', hex: DOWN_HEX },
            ] as const
          ).map((p, i) => (
            <g key={i}>
              <path
                d={p.d}
                fill="none"
                stroke={p.hex}
                strokeOpacity="0.35"
                strokeWidth="1.2"
                vectorEffect="non-scaling-stroke"
              />
              <path
                d={p.d}
                fill="none"
                stroke={p.hex}
                strokeWidth="1.4"
                vectorEffect="non-scaling-stroke"
                className="dash-anim"
              />
            </g>
          ))}
        </svg>

        {/* The price node */}
        <div className="relative z-[1] ml-[6%] grid h-40 w-40 shrink-0 place-items-center rounded-full border border-line-strong bg-surface shadow-[0_0_60px_-20px_rgb(229_72_77/0.55)] sm:h-44 sm:w-44">
          <div className="absolute inset-2 rounded-full border border-line/60" aria-hidden="true" />
          <div className="text-center">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">{pairLabel}</div>
            <div className="mt-1 font-mono text-2xl font-semibold tnum text-ink sm:text-[26px]">
              {fmt(price18)}
            </div>
            <div className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">Oracle price</div>
            <div className="mt-1.5 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-side-up">
              <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-side-up" aria-hidden="true" />
              Live
            </div>
          </div>
        </div>

        {/* The three outcomes */}
        <div className="relative z-[1] ml-auto flex flex-col gap-7 py-1 sm:gap-9">
          <OutcomeChip
            icon={<TrendUp className="h-5 w-5" />}
            name="UP"
            detail={`Higher than ${fmt(upAt)}`}
            colorClass="text-side-up"
            hex={UP_HEX}
          />
          <OutcomeChip
            icon={<WaveRange className="h-5 w-5" />}
            name="RANGE"
            detail={`Between ${fmt(downAt)} – ${fmt(upAt)}`}
            colorClass="text-ink-soft"
            hex={RANGE_HEX}
          />
          <OutcomeChip
            icon={<TrendDown className="h-5 w-5" />}
            name="DOWN"
            detail={`Lower than ${fmt(downAt)}`}
            colorClass="text-side-down"
            hex={DOWN_HEX}
          />
        </div>
      </div>
      <p className="mt-3 text-right font-mono text-[10px] uppercase tracking-wide text-ink-faint">
        {refIsLive ? 'Thresholds lock when you enter' : 'Band anchored to this round’s start price'}
      </p>
    </div>
  );
}
