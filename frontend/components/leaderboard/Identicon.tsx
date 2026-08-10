// components/leaderboard/Identicon.tsx — renders lib/identicon's deterministic 5×5 mark as a
// crisp SVG chip: dark inset tile, one accent hue per address. Size via className (h-/w-).
import { identiconFor } from '@/lib/identicon';
import { cn } from '@/lib/cn';

export function Identicon({ address, className }: { address: string; className?: string }) {
  const { cells, color } = identiconFor(address);
  return (
    <svg
      viewBox="0 0 40 40"
      aria-hidden="true"
      className={cn('rounded-lg border border-line bg-surface-inset', className)}
      shapeRendering="crispEdges"
    >
      {cells.map((on, i) =>
        on ? (
          <rect
            key={i}
            x={5 + (i % 5) * 6}
            y={5 + Math.floor(i / 5) * 6}
            width={6}
            height={6}
            fill={color}
          />
        ) : null,
      )}
    </svg>
  );
}
