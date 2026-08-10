'use client';

// components/NavBar.tsx — the Arena "terminal" top navigation.
//
//   LEFT    — the crimson angular logo mark + "FEE ARENA" wordmark over a live "● ARC · LIVE" system line.
//   CENTER  — the primary routes as MONO-UPPERCASE terminal labels. An octagonal crimson "selector"
//             (the same cut-corner geometry as the HUD panels) locks onto the active route — an angular
//             glow + a bright bottom accent — and SLIDES between routes. It's positioned/sized from the
//             active link's measured box, so it tracks the real label widths. Desktop only; mobile uses
//             the sheet below.
//   RIGHT   — the wallet control + one "···" menu (market selector, Faucet, ArcScan, Explore, About,
//             owner-only Admin). A hamburger opens the same set as a mobile dialog. (Dark-only.)
//
// Pure chrome: the wallet control is <SignInButton/> and Admin gating reuses the owner() read. No
// hook/contract logic changed — only the assembled header.
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAccount, useReadContract } from 'wagmi';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';
import { CAMPAIGN_PAGE_ENABLED } from '@/lib/campaignVisibility';
import { useMarketContracts } from '@/lib/contracts';
import { SignInButton } from '@/components/auth/SignInButton';
import { BrandMark } from '@/components/ui/BrandMark';
import { Logo, Faucet, External, Dots, Menu, Close, Shield, Wallet, Feedback } from '@/components/ui/icons';

const FAUCET_URL = 'https://faucet.circle.com';
/** Public beta feedback form (Google Forms) — opens in a new tab. */
const FEEDBACK_URL = 'https://forms.gle/tQh2nCa98GMRFGjXA';

/** Primary destinations — the center nav (Arena first, matching the mockups).
 * Leaderboard sits LAST (right of Bridge) by request; the rail fits at tablet widths via
 * tighter md link padding + the wordmark deferring to lg.
 *
 * Campaign goes next to Leaderboard because it is the same question asked over a fixed period —
 * a visitor looking for one is looking for the other. A page nobody can reach is a page nobody
 * enters, and the standings only drive participation if they are one click from anywhere. */
const PRIMARY_NAV = [
  { href: '/stance', label: 'Stance' },
  { href: '/agent', label: 'Agent' },
  { href: '/swap', label: 'Swap' },
  { href: '/pool', label: 'Pools' },
  { href: '/bridge', label: 'Bridge' },
  { href: '/leaderboard', label: 'Leaderboard' },
  // Last, and after Leaderboard: a campaign is the leaderboard asked over a fixed period, so it
  // reads as the thing that follows it rather than something that interrupts the run of pages.
  ...(CAMPAIGN_PAGE_ENABLED ? ([{ href: '/campaign', label: 'Campaign' }] as const) : []),
] as const;

/** The ArcScan target — the connected wallet's page when known, else the explorer root. */
function arcScanHref(address?: `0x${string}`): string {
  return address ? `${ENV.EXPLORER_URL}/address/${address}` : ENV.EXPLORER_URL;
}

/**
 * Is `href` the active route for `pathname`?
 *  - '/' (Swap) matches only the exact root (so it isn't "active" on every nested page).
 *  - other links match the segment prefix (e.g. /pool… lights Pools).
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Owner gating: read the active arena's owner() and compare to the connected wallet (case-insensitive). */
function useIsOwner(): boolean {
  const { address } = useAccount();
  const { feeArena } = useMarketContracts();
  const { data: ownerAddr } = useReadContract({
    address: feeArena.address,
    abi: feeArena.abi,
    functionName: 'owner',
    query: { enabled: !!address },
  });
  return !!address && !!ownerAddr && address.toLowerCase() === String(ownerAddr).toLowerCase();
}

/**
 * Desktop primary nav: mono terminal labels with the octagonal "selector" that locks onto the active
 * route and slides between them. The selector is `null` until the active link is measured, so it snaps
 * into place on first paint instead of sliding in from the left; after that it animates between routes.
 */
function TerminalNav({ pathname }: { pathname: string }) {
  const railRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const active = rail.querySelector<HTMLElement>('a[data-active="true"]');
      setSel(
        active
          ? { left: active.offsetLeft, top: active.offsetTop, width: active.offsetWidth, height: active.offsetHeight }
          : null,
      );
    };
    measure();
    const settle = window.setTimeout(measure, 60); // re-measure once fonts/layout settle
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(settle);
      window.removeEventListener('resize', measure);
    };
  }, [pathname]);

  return (
    <nav aria-label="Primary" className="hidden md:block">
      <div ref={railRef} className="relative flex items-center gap-1">
        {sel && (
          <span
            aria-hidden="true"
            className="nav-sel"
            style={{ transform: `translateX(${sel.left}px)`, top: sel.top, width: sel.width, height: sel.height }}
          />
        )}
        {PRIMARY_NAV.map((n) => {
          const active = isActive(pathname, n.href);
          const gold = n.href === '/agent'; // the Agent entry wears gold with a shine sweep
          // Campaign gets the same treatment in its own hue: it is a limited-time thing and should
          // catch the eye the way Agent does, without reading as a second Agent.
          const campaign = n.href === '/campaign';
          return (
            <a
              key={n.href}
              href={n.href}
              data-active={active ? 'true' : 'false'}
              aria-current={active ? 'page' : undefined}
              className={cn(
                // Inactive links read as ink-soft (not muted) — the rail must stay legible.
                'relative z-10 px-2.5 py-2 font-mono text-[12.5px] font-semibold uppercase tracking-[0.13em] transition-colors focus-visible:outline-none focus-visible:shadow-focus lg:px-3.5',
                gold ? 'nav-agent-gold' : campaign ? 'nav-campaign-cyan' : active ? 'text-ink' : 'text-ink-soft hover:text-ink',
              )}
            >
              {n.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Secondary destinations for the "···" overflow + the mobile sheet: Explore, About, Faucet, ArcScan and
 * (owner-only) Admin. The sheet additionally repeats Wallet, which is a top-level control on desktop.
 */
function SecondaryLinks({
  isOwner,
  address,
  onNavigate,
  variant,
}: {
  isOwner: boolean;
  address?: `0x${string}`;
  onNavigate?: () => void;
  variant: 'menu' | 'sheet';
}) {
  const itemClass = cn(
    'hud-row focus-visible:outline-none focus-visible:shadow-focus',
    variant === 'sheet' ? 'py-2.5' : 'py-2',
  );
  return (
    <>
      {variant === 'sheet' && (
        <a href="/wallet" onClick={onNavigate} className={itemClass}>
          <Wallet className="h-4 w-4" aria-hidden="true" />
          Wallet
        </a>
      )}
      <a href="/welcome" onClick={onNavigate} className={itemClass}>
        <Logo className="h-4 w-4" aria-hidden="true" />
        About
      </a>
      <a href={FAUCET_URL} target="_blank" rel="noreferrer" onClick={onNavigate} className={itemClass}>
        <Faucet className="h-4 w-4" aria-hidden="true" />
        Faucet
      </a>
      <a href={arcScanHref(address)} target="_blank" rel="noreferrer" onClick={onNavigate} className={itemClass}>
        <External className="h-4 w-4" aria-hidden="true" />
        ArcScan
      </a>
      {isOwner && (
        <a href="/admin" onClick={onNavigate} className={itemClass}>
          <Shield className="h-4 w-4" aria-hidden="true" />
          Admin
        </a>
      )}
    </>
  );
}

export function NavBar() {
  const pathname = usePathname() || '/';
  const { address } = useAccount();
  const isOwner = useIsOwner();

  // "···" overflow dropdown (desktop). Closes on outside-click or Escape.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement | null>(null);

  // Mobile nav sheet — a hamburger toggles a dialog; Escape (or a link click) closes it.
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!overflowOpen && !menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOverflowOpen(false);
        setMenuOpen(false);
      }
    };
    const onClick = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [overflowOpen, menuOpen]);

  const iconBtn =
    'grid h-9 w-9 place-items-center hud-trigger text-ink-soft transition-colors hover:text-ink focus-visible:outline-none';

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-surface/70 backdrop-blur-xl">
      {/* A glowing crimson seam along the bottom edge — the HUD-panel language carried into the chrome. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-brand/45 to-transparent"
      />
      <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {/* LEFT — logo mark + wordmark over a live system line */}
        <a
          href="/"
          aria-label="Limen Finance home"
          className="group flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline-none focus-visible:shadow-focus"
        >
          <BrandMark className="h-8 w-8 transition-transform duration-200 group-hover:scale-110" />
          {/* Wordmark waits for lg so the seven-link rail (incl. CAMPAIGN + LEADERBOARD) fits tablets. */}
          <span className="hidden flex-col leading-none lg:flex">
            <span className="text-sm font-semibold uppercase tracking-[0.22em] text-ink">Limen Finance</span>
            <span className="mt-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.18em] text-ink-muted">
              <span className="nav-live-dot h-1.5 w-1.5 rounded-full bg-brand" />
              Arc · Live
            </span>
          </span>
        </a>

        {/* CENTER — the terminal primary nav (desktop) */}
        <TerminalNav pathname={pathname} />

        {/* RIGHT — feedback + wallet + a single overflow menu + mobile hamburger */}
        <div className="flex items-center gap-2">
          {/* Feedback lives OUTSIDE any wallet state on purpose: same spot on every page,
              connected or not. Quieter than the crimson Sign In — a bordered secondary. */}
          <a
            href={FEEDBACK_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Send feedback (opens in a new tab)"
            className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] font-semibold text-ink-soft transition-colors hover:bg-subtle-hover hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
          >
            <Feedback className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Feedback</span>
          </a>
          <SignInButton />

          {/* "···" overflow menu (desktop) — market selector + Explore/About/Faucet/ArcScan/Admin. */}
          <div ref={overflowRef} className="relative hidden md:block">
            <button
              type="button"
              aria-label="More links"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              aria-controls="nav-overflow-menu"
              onClick={() => setOverflowOpen((o) => !o)}
              className={iconBtn}
            >
              <Dots className="h-[18px] w-[18px]" />
            </button>
            {overflowOpen && (
              <div
                id="nav-overflow-menu"
                role="menu"
                aria-label="More links"
                className="hud-menu absolute right-0 top-12 z-50 w-60 p-2"
              >
                <SecondaryLinks
                  isOwner={isOwner}
                  address={address}
                  variant="menu"
                  onNavigate={() => setOverflowOpen(false)}
                />
              </div>
            )}
          </div>

          {/* Mobile hamburger — toggles the sheet below (md:hidden). */}
          <button
            type="button"
            aria-label="Toggle navigation menu"
            aria-expanded={menuOpen}
            aria-controls="mobile-nav-panel"
            onClick={() => setMenuOpen((o) => !o)}
            className={cn(iconBtn, 'md:hidden')}
          >
            {menuOpen ? <Close className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile nav sheet — primary links + market selector + secondary destinations. */}
      {menuOpen && (
        <div
          id="mobile-nav-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="border-t border-line bg-surface px-4 py-3 md:hidden"
        >
          <nav aria-label="Primary (mobile)" className="flex flex-col gap-0.5">
            {PRIMARY_NAV.map((n) => {
              const active = isActive(pathname, n.href);
              return (
                <a
                  key={n.href}
                  href={n.href}
                  onClick={() => setMenuOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center justify-between rounded-lg px-3 py-2.5 font-mono text-[13px] font-semibold uppercase tracking-[0.13em] transition-colors',
                    active ? 'bg-brand/10 text-ink' : 'text-ink-soft hover:bg-surface-muted hover:text-ink',
                  )}
                >
                  {n.href === '/agent' ? (
                    <span className="nav-agent-gold">{n.label}</span>
                  ) : n.href === '/campaign' ? (
                    <span className="nav-campaign-cyan">{n.label}</span>
                  ) : (
                    n.label
                  )}
                  {active && (
                    <span className="h-1.5 w-1.5 rounded-full bg-brand shadow-[0_0_8px_rgb(var(--c-brand))]" />
                  )}
                </a>
              );
            })}
          </nav>
          <div className="my-2 border-t border-line" />
          <nav aria-label="Secondary (mobile)" className="flex flex-col gap-0.5">
            <SecondaryLinks
              isOwner={isOwner}
              address={address}
              variant="sheet"
              onNavigate={() => setMenuOpen(false)}
            />
          </nav>
        </div>
      )}
    </header>
  );
}
