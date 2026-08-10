'use client';

// components/arena/MiniSparkline.tsx — a tiny price line for the Arena center panel. Pure SVG, no deps.
// Plots `values` (recent oracle prices from usePriceSamples) normalized to the viewBox, with a soft
// area fill and an endpoint dot. Colour follows the trend (green when the last point is >= the first,
// crimson-red when it has fallen). Needs >= 2 points; fewer renders nothing (caller shows a placeholder).
//
// The SVG stretches to its box (preserveAspectRatio=none) so the line fills the width; the endpoint dot
// is a real DOM circle overlaid at the computed %, so it stays round despite the non-uniform scale.
import { useId } from 'react';

export function MiniSparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const gradientId = useId();
  if (values.length < 2) return null;

  const W = 200;
  const H = 56;
  const PAD = 4; // keep the stroke inside the box
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1; // flat series → centered line

  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => PAD + (1 - (v - min) / span) * (H - PAD * 2);

  // Midpoint-quadratic smoothing: each point becomes a control point toward the next midpoint, so the
  // 1s pulse samples render as a fluid curve instead of a jagged polyline.
  const pts = values.map((v, i) => [x(i), y(v)] as const);
  let curve = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    curve += ` Q${pts[i][0].toFixed(2)},${pts[i][1].toFixed(2)} ${mx.toFixed(2)},${my.toFixed(2)}`;
  }
  curve += ` L${pts[pts.length - 1][0].toFixed(2)},${pts[pts.length - 1][1].toFixed(2)}`;
  const linePath = curve;
  const areaPath = `${curve} L${pts[pts.length - 1][0].toFixed(2)},${H} L${pts[0][0].toFixed(2)},${H} Z`;

  const up = values[values.length - 1] >= values[0];
  const stroke = up ? 'rgb(var(--c-side-up))' : 'rgb(var(--c-side-down))';
  const lastXPct = (x(values.length - 1) / W) * 100;
  const lastYPct = (y(values[values.length - 1]) / H) * 100;

  return (
    <div className={`relative ${className ?? ''}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-full w-full"
        role="img"
        aria-label="Recent oracle price"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#${gradientId})`} />
        <path
          d={linePath}
          fill="none"
          stroke={stroke}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ left: `${lastXPct}%`, top: `${lastYPct}%`, backgroundColor: stroke }}
      />
    </div>
  );
}
