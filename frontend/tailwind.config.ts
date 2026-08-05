import type { Config } from 'tailwindcss';

/**
 * Arena design system - theme-aware.
 * Deep-dark canvas, lifted surfaces, a single crimson accent (#E5484D dark / #DC2626
 * light), and a green/red/blue semantic trio for UP / DOWN / RANGE. Numbers are
 * mono + tabular.
 *
 * Colors are CSS variables (RGB channel triplets, e.g. `--c-ink: 11 18 32`) so the
 * SAME utility classes (`text-ink`, `bg-surface`, `border-side-down/30`) resolve to
 * the active theme. Light/dark values live in globals.css (`:root` + `.dark`); the
 * `<alpha-value>` placeholder keeps Tailwind's `/<opacity>` modifiers working.
 */

// Helper: a token backed by a CSS variable, with alpha-modifier support.
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: v('canvas'),
        surface: { DEFAULT: v('surface'), muted: v('surface-muted'), inset: v('surface-inset') },
        line: { DEFAULT: v('line'), strong: v('line-strong') },
        ink: { DEFAULT: v('ink'), soft: v('ink-soft'), muted: v('ink-muted'), faint: v('ink-faint') },
        brand: { DEFAULT: v('brand'), hover: v('brand-hover'), soft: v('brand-soft'), ring: v('brand-ring') },
        side: {
          up: v('side-up'),
          down: v('side-down'),
          range: v('side-range'),
          'up-soft': v('side-up-soft'),
          'down-soft': v('side-down-soft'),
          'range-soft': v('side-range-soft'),
          'up-ring': v('up-ring'),
          'down-ring': v('down-ring'),
          'range-ring': v('range-ring'),
        },
        // Subtle button hover fill (theme-aware tint).
        'subtle-hover': v('subtle-hover'),
      },
      fontFamily: {
        // Uniswap uses a single clean grotesk everywhere - Inter is the closest free match.
        display: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-inter)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-plex-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      // Uniswap radii: generous rounding - inner sections ~16-20px, cards ~24px, pills full.
      borderRadius: { lg: '0.75rem', xl: '1rem', '2xl': '1.25rem', '3xl': '1.5rem' },
      boxShadow: {
        // Uniswap is flat/clean: cards carry (almost) no shadow; only popovers float.
        card: '0 1px 2px rgba(11,11,11,0.03)',
        cardhover: '0 4px 16px rgba(11,11,11,0.06)',
        pop: '0 12px 40px rgba(11,11,11,0.12), 0 2px 8px rgba(11,11,11,0.05)',
        focus: '0 0 0 3px rgba(229,72,77,0.30)',
        inset: 'inset 0 1px 2px rgba(11,11,11,0.04)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'pulse-soft': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
        'live-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(5,150,105,0.45)' },
          '70%': { boxShadow: '0 0 0 5px rgba(5,150,105,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(5,150,105,0)' },
        },
        'bar-grow': { '0%': { transform: 'scaleX(0)' }, '100%': { transform: 'scaleX(1)' } },
        // Win-moment celebration: a single subtle scale/opacity pop (NOT looped). Gated behind
        // motion-safe: at the call site so prefers-reduced-motion users see it appear without motion.
        'win-pop': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '60%': { opacity: '1', transform: 'scale(1.015)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.55s cubic-bezier(0.16,1,0.3,1) both',
        'fade-in': 'fade-in 0.4s ease both',
        shimmer: 'shimmer 1.6s infinite',
        'pulse-soft': 'pulse-soft 1.8s ease-in-out infinite',
        'live-ring': 'live-ring 2s infinite',
        'bar-grow': 'bar-grow 0.7s cubic-bezier(0.16,1,0.3,1) both',
        'win-pop': 'win-pop 0.6s cubic-bezier(0.16,1,0.3,1) both',
      },
    },
  },
  plugins: [],
};
export default config;
