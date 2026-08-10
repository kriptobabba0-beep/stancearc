'use client';

// components/pool/Sparkline.tsx — a tiny area+line sparkline for the Pool stat cards. Pure SVG, no deps.
// Colour comes from the wrapper's `currentColor` (set a text-* class on it), so the three header cards
// read as crimson (TVL) / green (volume) / blue (fees) using the app's own semantic palette. Decorative
// (aria-hidden) — the headline figure is announced separately. preserveAspectRatio="none" stretches the
// 0..100 viewBox to the card width.
import { useId } from 'react';
import { cn } from '@/lib/cn';

export function Sparkline({
  data,
  className,
  height = 60,
  strokeWidth = 1.75,
}: {
  data: number[];
  className?: string;
  /** Drawing height in px (the SVG fills its container width). */
  height?: number;
  strokeWidth?: number;
}) {
  const gid = useId();
  const W = 100;
  const H = height;
  const padY = H * 0.12;

  // Need ≥2 points to draw a line; fall back to a flat midline so the card never looks broken.
  const pts = data.length >= 2 ? data : [0, 0];
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min;
  const n = pts.length;

  const x = (i: number) => (n === 1 ? W : (i / (n - 1)) * W);
  const y = (v: number) =>
    span > 0 ? H - padY - ((v - min) / span) * (H - 2 * padY) : H / 2;

  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(' ');
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn('block', className)}
    >
      <defs>
        <linearGradient id={`sparkfill-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sparkfill-${gid})`} stroke="none" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
