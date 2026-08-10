'use client';

// components/ThemeProvider.tsx — token-based theming for the Clean Institutional system.
//
// The app is DARK ONLY. The palette lives in globals.css as CSS variables; the `.dark` class on
// <html> is always on, so the SAME utility classes (text-ink, bg-surface…) resolve to the dark theme.
// There is no light mode and no toggle: ThemeScript applies `.dark` + color-scheme:dark before paint
// (no localStorage / prefers-color-scheme branching), and ThemeProvider always resolves 'dark'.
import { type ReactNode } from 'react';

export type Theme = 'dark';

interface ThemeContextValue {
  /** Always 'dark' — light mode has been removed. */
  theme: Theme;
  /** The currently-applied theme (always 'dark'). */
  resolved: Theme;
  /** No-op: there is nothing to switch to. */
  setTheme: (t: Theme) => void;
  /** No-op: there is nothing to toggle. */
  toggle: () => void;
}

/**
 * Inline, render-blocking script that forces the `.dark` class + color-scheme:dark on <html> before
 * paint. Dark-only, so there is no branching — this just guarantees no flash before hydration.
 * Kept as a string so it runs synchronously in <head> (a React component would run too late).
 */
const THEME_BOOT = `(function(){try{var e=document.documentElement;e.classList.add('dark');e.style.colorScheme='dark';}catch(_){}})();`;

export function ThemeScript() {
  // eslint-disable-next-line react/no-danger
  return <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />;
}

/** Dark-only provider: applies `.dark` and renders children. No state/toggle machinery. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/** Active theme + setters. Dark-only: always resolves 'dark'; setters are no-ops. */
export function useTheme(): ThemeContextValue {
  return { theme: 'dark', resolved: 'dark', setTheme: () => {}, toggle: () => {} };
}
