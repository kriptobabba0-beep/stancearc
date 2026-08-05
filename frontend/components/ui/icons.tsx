import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

/** Shared stroke-icon frame. Size via className (w- and h- utilities); color via currentColor. */
function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/**
 * Brand glyph: the Limen doorway mark as a MONOCHROME currentColor icon - the arch with its
 * two tilted marks, for tinted/decorative contexts (menu rows, feed nodes, muted states).
 * The full-color mark lives in components/ui/BrandMark.tsx; use that for identity surfaces.
 */
export function Logo(props: IconProps) {
  return (
    <Svg strokeWidth={2.4} {...props}>
      <path d="M5 21v-9.3a7 7 0 0 1 14 0V21" />
      <path d="M9.4 15.4l.75-4.2" />
      <path d="M13.9 15.4l.75-4.2" />
    </Svg>
  );
}

/** Speech bubble - the navbar's Feedback button. */
export function Feedback(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </Svg>
  );
}

/** Robot head - marks the platform's own bot wallets on the leaderboard. */
export function Bot(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="9" width="14" height="10" rx="2.5" />
      <path d="M12 9V5.5" />
      <circle cx="12" cy="4" r="1.2" />
      <path d="M9.2 13.2v1.8" />
      <path d="M14.8 13.2v1.8" />
      <path d="M2.5 12.5v3" />
      <path d="M21.5 12.5v3" />
    </Svg>
  );
}

export function ArrowUp(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 19V5" />
      <path d="M6 11l6-6 6 6" />
    </Svg>
  );
}

export function ArrowDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M6 13l6 6 6-6" />
    </Svg>
  );
}

export function RangeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 8L4 12l4 4" />
      <path d="M16 8l4 4-4 4" />
      <path d="M4 12h16" />
    </Svg>
  );
}

export function Wallet(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a1 1 0 0 1 1 1v1" />
      <rect x="3" y="7" width="18" height="12" rx="2.5" />
      <path d="M16 12.5h2.5" />
    </Svg>
  );
}

export function External(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 5h5v5" />
      <path d="M19 5l-7 7" />
      <path d="M19 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.5" />
    </Svg>
  );
}

export function Faucet(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9z" />
    </Svg>
  );
}

export function Shield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </Svg>
  );
}

export function Clock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l2.5 1.5" />
    </Svg>
  );
}

export function Trophy(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 5h10v3a5 5 0 0 1-10 0V5z" />
      <path d="M7 6H4.5A2.5 2.5 0 0 0 7 9.5M17 6h2.5A2.5 2.5 0 0 1 17 9.5" />
      <path d="M10 13.5h4M12 13.5V16M9 19h6M10 16h4" />
    </Svg>
  );
}

export function Activity(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12h3l2.5 7 4-15L15 12h6" />
    </Svg>
  );
}

export function Settings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.2 7.4l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </Svg>
  );
}

export function Info(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  );
}

export function Alert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.3 4l-7.5 13A1.5 1.5 0 0 0 4.1 19.3h15.8a1.5 1.5 0 0 0 1.3-2.3l-7.5-13a1.7 1.7 0 0 0-3 0z" />
      <path d="M12 9.5v4M12 16.5h.01" />
    </Svg>
  );
}

export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

/** Copy-to-clipboard glyph (overlapping rounded rectangles). */
export function Copy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a1 1 0 0 1 1-1h9" />
    </Svg>
  );
}

export function Lock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9l6 6 6-6" />
    </Svg>
  );
}

/** Plus glyph - the "New position" / "Create position" affordance (Uniswap Pool page). */
export function Plus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function Minus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  );
}

export function Menu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Svg>
  );
}

/** Magnifying glass - the nav search affordance (Uniswap-style). */
export function Search(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  );
}

/** Horizontal ellipsis - the nav overflow ("···") menu trigger. */
export function Dots(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </Svg>
  );
}

export function Close(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function Sun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </Svg>
  );
}

export function Moon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </Svg>
  );
}

/** Two opposing vertical arrows - the swap "flip direction" control + the Swap section glyph. */
export function SwapArrows(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4v16" />
      <path d="M3 8l4-4 4 4" />
      <path d="M17 20V4" />
      <path d="M21 16l-4 4-4-4" />
    </Svg>
  );
}

/** Calendar - the "epoch length" market-context row glyph. */
export function Calendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </Svg>
  );
}

/** Bell - the "notify me on settlement" affordance glyph. */
export function Bell(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5 2 6H4c.5-1 2-2 2-6z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </Svg>
  );
}

/** Bar-chart - the "view stake details" affordance glyph. */
export function BarChart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </Svg>
  );
}

/** Zigzag trend-up arrow - the Arena side cards' UP glyph (mockup style, not a straight arrow). */
export function TrendUp(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M3 17l5.5-6 3.5 3 6.5-8" />
      <path d="M14 6h4.5v4.5" />
    </Svg>
  );
}

/** Zigzag trend-down arrow - the Arena side cards' DOWN glyph. */
export function TrendDown(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M3 7l5.5 6 3.5-3 6.5 8" />
      <path d="M14 18h4.5v-4.5" />
    </Svg>
  );
}

/** Waveform between bounds - the Arena side cards' RANGE glyph (price oscillating in a band). */
export function WaveRange(props: IconProps) {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M3 14l3.5-6 3 8 3-10 3 8 2.5-4 3 4" />
    </Svg>
  );
}

/** Gift box - the "eligible to share the pot" note glyph (stake review). */
export function Gift(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="8" width="17" height="4" rx="1" />
      <path d="M5.5 12v6.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V12" />
      <path d="M12 8v11.5" />
      <path d="M12 8s-1-4.5-4-4.5a2.25 2.25 0 0 0 0 4.5M12 8s1-4.5 4-4.5a2.25 2.25 0 0 1 0 4.5" />
    </Svg>
  );
}

/** Stacked layers - the "Stake into Arena" step glyph. */
export function Layers(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </Svg>
  );
}

/** Filled brand-glyph frame (logos use fills + their own viewBox, not the stroke Svg). */
function BrandSvg({ children, ...props }: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

/** X (formerly Twitter) brand mark. */
export function XLogo(props: IconProps) {
  return (
    <BrandSvg {...props}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117l11.966 15.644z" />
    </BrandSvg>
  );
}

/** Discord brand mark. */
export function Discord(props: IconProps) {
  return (
    <BrandSvg {...props}>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" />
    </BrandSvg>
  );
}

/** GitHub brand mark. */
export function GitHub(props: IconProps) {
  return (
    <BrandSvg {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222 0 1.606-.014 2.898-.014 3.293 0 .322.216.694.825.576C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </BrandSvg>
  );
}

export function Spinner({ className, ...props }: IconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        className="origin-center animate-spin"
        style={{ animationDuration: '0.7s' }}
      />
    </svg>
  );
}
