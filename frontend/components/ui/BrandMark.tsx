// components/ui/BrandMark.tsx - the full-color Limen Finance mark (the doorway on crimson),
// inlined from limen-mark-master.svg so identity surfaces render it crisp at any size with no
// extra request. Corners are rounded via CSS border-radius - SVG clips its own overflow, so
// the full-bleed artwork rounds cleanly without clipPath ids (which would collide when the
// mark appears more than once on a page). Fixed brand colors on purpose: the mark is the
// logo, not a tintable icon - for currentColor contexts use the `Logo` glyph in icons.tsx.
import { cn } from '@/lib/cn';

export function BrandMark({
  className,
  label,
  circle = false,
}: {
  className?: string;
  label?: string;
  /** Crop to a full circle - for round avatar slots (e.g. the copilot's ringed avatar). */
  circle?: boolean;
}) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={cn(circle ? 'rounded-full' : 'rounded-[24%]', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      shapeRendering="geometricPrecision"
    >
      <rect width="1024" height="1024" fill="#D9363E" />
      <path
        fill="#F2F0EE"
        d="M0 1024V263C44.435 175.434 133.771 148.251 223 147c162.254-2.519 319.73 133.984 322 314v563H0Z"
      />
      <rect
        width="44"
        height="158"
        x="-22"
        y="-79"
        rx="22"
        fill="#D9363E"
        transform="translate(151.755 519.221) rotate(10.008)"
      />
      <rect
        width="44"
        height="158"
        x="-22"
        y="-79"
        rx="22"
        fill="#D9363E"
        transform="translate(372.255 519.221) rotate(10.008)"
      />
    </svg>
  );
}
