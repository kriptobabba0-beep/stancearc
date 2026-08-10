'use client';

// components/auth/SignInButton.tsx — the SINGLE wallet control in the top nav (replaces the old
// "Create Wallet" + "Connect Wallet" pair).
//   • signed out → a crimson "Sign In" button that opens the AuthModal.
//   • signed in  → an account chip (status dot + short address) with a popover: Open My Wallet ·
//                  View on ArcScan · Sign out. Works for embedded (Circle) and any browser wallet.

import { useEffect, useRef, useState } from 'react';
import { useAccount, useDisconnect } from 'wagmi';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import { useAuthModal } from '@/components/auth/AuthModalProvider';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Wallet, ChevronDown, External, Lock } from '@/components/ui/icons';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const KIND_LABEL: Record<string, string> = { email: 'Email', google: 'Google', pin: 'PIN' };

export function SignInButton() {
  const { open } = useAuthModal();
  const circle = useCircleWallet();
  const { address: wagmiAddr, isConnected, connector } = useAccount();
  const { disconnect } = useDisconnect();

  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [menuOpen]);

  const embedded = circle.isReady && !!circle.address;
  const signedIn = mounted && (embedded || isConnected);
  const addr = (embedded ? circle.address : wagmiAddr) ?? undefined;

  function signOut() {
    setMenuOpen(false);
    if (embedded) circle.signOut();
    if (isConnected) disconnect();
  }

  if (!signedIn || !addr) {
    return (
      <button
        type="button"
        data-testid="sign-in"
        onClick={open}
        className={buttonClass('primary', 'sm', 'h-9 rounded-[10px] px-4')}
      >
        <Wallet className="h-4 w-4" aria-hidden="true" />
        Sign In
        <Stars />
      </button>
    );
  }

  // Injected side: name the ACTUAL wallet (MetaMask, Rabby, OKX…) — never assume MetaMask.
  const methodLabel = embedded ? (circle.kind ? KIND_LABEL[circle.kind] : 'Wallet') : connector?.name || 'Wallet';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-testid="account-chip"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className="hud-trigger inline-flex h-9 cursor-pointer items-center gap-2 px-3.5 font-mono text-xs text-ink focus-visible:outline-none"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-side-up shadow-[0_0_6px_rgb(var(--c-side-up))]"
          aria-hidden="true"
        />
        {short(addr)}
        <ChevronDown className={cn('h-3.5 w-3.5 text-ink-muted transition-transform', menuOpen && 'rotate-180')} />
      </button>

      {menuOpen && (
        <div role="menu" className="hud-menu absolute right-0 top-12 z-50 w-60 p-2">
          <div className="flex items-center justify-between px-2.5 pb-2 pt-2.5">
            <span className="font-mono text-xs text-ink-soft">{short(addr)}</span>
            <span className="rounded border border-brand/30 bg-brand/[0.08] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-brand/90">
              {methodLabel}
            </span>
          </div>
          <div className="mb-1 h-px bg-line" />
          {embedded && (
            <a href="/wallet" role="menuitem" onClick={() => setMenuOpen(false)} className="hud-row py-2">
              <Wallet className="h-4 w-4 text-ink-muted" /> Open My Wallet
            </a>
          )}
          <a
            href={`${ENV.EXPLORER_URL}/address/${addr}`}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            onClick={() => setMenuOpen(false)}
            className="hud-row py-2"
          >
            <External className="h-4 w-4 text-ink-muted" /> View on ArcScan
          </a>
          <button
            type="button"
            role="menuitem"
            data-testid="sign-out"
            onClick={signOut}
            className="hud-row hud-row--danger w-full py-2"
          >
            <Lock className="h-4 w-4 text-ink-muted" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
