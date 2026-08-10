'use client';

// components/auth/AuthModal.tsx — the single, premium "Sign in" modal.
//   • Browser wallets (primary, top) → wagmi injected connectors. EIP-6963-discovered
//     wallets (MetaMask, Rabby, OKX, …) are listed by their REAL name + icon; when only a
//     generic provider exists the row says "Connect browser wallet" — we support any EVM
//     extension, and the copy must never pretend MetaMask is the only door.
//   • or
//   • Continue with Google                  → Circle embedded (portable)
//   • Continue with Email                   → Circle embedded (portable)
// On a successful embedded login the modal closes and routes to /wallet (the My Wallet experience).
// On a wallet connect it just closes. Dark, immersive, frosted-glass — on-brand with the HUD theme.

import { useEffect, useRef, useState } from 'react';
import { useAccount, useConnect } from 'wagmi';
import { useRouter } from 'next/navigation';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import { useWalletMode } from '@/components/circle/WalletModeProvider';
import { Spinner, Close, Shield, Wallet } from '@/components/ui/icons';
import { BrandMark } from '@/components/ui/BrandMark';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// The install link still points at MetaMask (the most common first wallet) but the copy
// stays generic — any EVM extension works once installed.
const METAMASK_URL = 'https://metamask.io/download/';
const CONIC = 'conic-gradient(from 0deg, #e5484d, #f0883e, #38bdf8, #a855f7, #e5484d)';
const MAX_WALLET_ROWS = 4;

function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum;
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.48 14.97.5 12 .5A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 6.68 9.14 4.75 12 4.75z" />
    </svg>
  );
}

// Official MetaMask fox (from MetaMask/metamask-extension, app/images/logo/metamask-fox.svg).
function MetaMaskIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 35 34" fill="none" className={className} aria-hidden="true">
      <path d="M32.7077 32.7522L25.1688 30.5174L19.4833 33.9008L15.5167 33.8991L9.82793 30.5174L2.29225 32.7522L0 25.0489L2.29225 16.4993L0 9.27094L2.29225 0.312256L14.0674 7.31554H20.9326L32.7077 0.312256L35 9.27094L32.7077 16.4993L35 25.0489L32.7077 32.7522Z" fill="#FF5C16" />
      <path d="M2.29395 0.312256L14.0691 7.32047L13.6008 12.1301L2.29395 0.312256Z" fill="#FF5C16" />
      <path d="M9.82959 25.0522L15.0106 28.9811L9.82959 30.5175V25.0522Z" fill="#FF5C16" />
      <path d="M14.5966 18.5565L13.6009 12.1333L7.22692 16.5009L7.22363 16.4993V16.5025L7.24335 20.9983L9.82809 18.5565H9.82974H14.5966Z" fill="#FF5C16" />
      <path d="M32.7077 0.312256L20.9326 7.32047L21.3993 12.1301L32.7077 0.312256Z" fill="#FF5C16" />
      <path d="M25.1722 25.0522L19.9912 28.9811L25.1722 30.5175V25.0522Z" fill="#FF5C16" />
      <path d="M27.7766 16.5025H27.7783H27.7766V16.4993L27.775 16.5009L21.401 12.1333L20.4053 18.5565H25.1722L27.7586 20.9983L27.7766 16.5025Z" fill="#FF5C16" />
      <path d="M9.82793 30.5175L2.29225 32.7522L0 25.0522H9.82793V30.5175Z" fill="#E34807" />
      <path d="M14.5947 18.5549L16.0341 27.8406L14.0393 22.6777L7.23975 20.9984L9.82613 18.5549H14.593H14.5947Z" fill="#E34807" />
      <path d="M25.1721 30.5175L32.7078 32.7522L35.0001 25.0522H25.1721V30.5175Z" fill="#E34807" />
      <path d="M20.4053 18.5549L18.9658 27.8406L20.9607 22.6777L27.7602 20.9984L25.1722 18.5549H20.4053Z" fill="#E34807" />
      <path d="M0 25.0488L2.29225 16.4993H7.22183L7.23991 20.9967L14.0394 22.676L16.0343 27.8389L15.0089 28.976L9.82793 25.0472H0V25.0488Z" fill="#FF8D5D" />
      <path d="M35.0001 25.0488L32.7078 16.4993H27.7783L27.7602 20.9967L20.9607 22.676L18.9658 27.8389L19.9912 28.976L25.1722 25.0472H35.0001V25.0488Z" fill="#FF8D5D" />
      <path d="M20.9325 7.31543H17.4999H14.0673L13.6006 12.1251L16.0342 27.834H18.9656L21.4008 12.1251L20.9325 7.31543Z" fill="#FF8D5D" />
      <path d="M2.29225 0.312256L0 9.27094L2.29225 16.4993H7.22183L13.5991 12.1301L2.29225 0.312256Z" fill="#661800" />
      <path d="M13.17 20.4199H10.9369L9.72095 21.6062L14.0409 22.6727L13.17 20.4182V20.4199Z" fill="#661800" />
      <path d="M32.7077 0.312256L34.9999 9.27094L32.7077 16.4993H27.7781L21.4009 12.1301L32.7077 0.312256Z" fill="#661800" />
      <path d="M21.833 20.4199H24.0694L25.2853 21.6079L20.9604 22.676L21.833 20.4182V20.4199Z" fill="#661800" />
      <path d="M19.4817 30.8362L19.9911 28.9794L18.9658 27.8423H16.0327L15.0073 28.9794L15.5167 30.8362" fill="#661800" />
      <path d="M19.4816 30.8359V33.9021H15.5166V30.8359H19.4816Z" fill="#C0C4CD" />
      <path d="M9.82959 30.5142L15.52 33.9008V30.8346L15.0106 28.9778L9.82959 30.5142Z" fill="#E7EBF6" />
      <path d="M25.1721 30.5142L19.4817 33.9008V30.8346L19.9911 28.9778L25.1721 30.5142Z" fill="#E7EBF6" />
    </svg>
  );
}

function MailIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </svg>
  );
}

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function AuthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { isReady, loginWithGoogle, loginWithEmail, googleEnabled, status, error } = useCircleWallet();
  const { setMode } = useWalletMode();
  const { isConnected } = useAccount();
  const { connect, connectors, isPending: mmPending, error: mmError } = useConnect();

  const [email, setEmail] = useState('');
  const [mounted, setMounted] = useState(false);
  // Which wallet row is mid-connect (uid) — only that row shows the spinner.
  const [pendingUid, setPendingUid] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => setMounted(true), []);

  // Close (and route to the wallet) the instant an embedded login succeeds; just close on a wallet connect.
  useEffect(() => {
    if (!open) return;
    if (isReady) {
      onClose();
      router.push('/wallet');
    } else if (isConnected) {
      onClose();
    }
  }, [open, isReady, isConnected, onClose, router]);

  // Escape to close + lock body scroll + focus the card while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    cardRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const busy = status === 'connecting';
  // Browser wallets. EIP-6963-discovered connectors carry the wallet's real name + icon and
  // an id ≠ 'injected'; the plain `injected` connector is the fallback when a provider exists
  // but announced nothing. The Circle connector is type 'embedded' and never appears here.
  type BrowserConnector = (typeof connectors)[number] & { type?: string; icon?: string; name?: string; id?: string };
  const injectedConnectors = (connectors as readonly BrowserConnector[]).filter((c) => c.type === 'injected');
  const discovered = injectedConnectors.filter((c) => c.id !== 'injected');
  const generic =
    injectedConnectors.find((c) => c.id === 'injected') ?? (connectors[0] as BrowserConnector | undefined);
  const wallets = (discovered.length > 0 ? discovered : generic ? [generic] : []).slice(0, MAX_WALLET_ROWS);
  const noWallet = mounted && discovered.length === 0 && (!generic || !hasInjectedProvider());
  const errorMsg = error || (mmError ? mmError.message : undefined);

  const onWallet = (c: BrowserConnector) => {
    setMode('injected');
    setPendingUid(c.uid);
    connect({ connector: c });
  };
  const onGoogle = () => {
    setMode('embedded');
    void loginWithGoogle();
  };
  const onEmail = () => {
    if (!EMAIL_RE.test(email)) return;
    setMode('embedded');
    void loginWithEmail(email);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 motion-safe:animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in to Limen Finance"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} aria-hidden="true" />

      {/* Card */}
      <div
        ref={cardRef}
        tabIndex={-1}
        className="relative w-full max-w-[440px] overflow-hidden rounded-[28px] border border-line-strong bg-surface/95 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] outline-none motion-safe:animate-fade-up"
      >
        {/* Ambient brand glow + grid */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -left-20 -top-24 h-64 w-64 rounded-full bg-brand/20 blur-3xl" />
          <div className="absolute -right-16 top-10 h-48 w-48 rounded-full bg-[#38bdf8]/10 blur-3xl" />
          <span className="landing-scanline" />
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 grid h-8 w-8 place-items-center rounded-full border border-line bg-surface-muted/60 text-ink-muted transition-colors hover:text-ink"
        >
          <Close className="h-4 w-4" />
        </button>

        <div className="relative px-7 pb-7 pt-9 sm:px-8">
          {/* Header */}
          <div className="mb-7 text-center">
            {/* The mark stands on its own — bigger, no framing box (its own rounded corners carry it). */}
            <BrandMark className="mx-auto mb-4 h-14 w-14" label="Limen Finance" />
            <h2 className="font-display text-[26px] font-semibold tracking-tight text-ink">Sign in to Limen Finance</h2>
            <p className="mt-1.5 text-sm text-ink-muted">Connect a wallet, or create one in seconds.</p>
          </div>

          {/* Browser wallets — primary. One row per discovered wallet (real name + icon),
              or one honest generic row; never a MetaMask-only claim. */}
          {noWallet ? (
            <a
              href={METAMASK_URL}
              target="_blank"
              rel="noreferrer"
              data-testid="auth-wallet"
              className="group flex h-14 w-full items-center gap-3 rounded-2xl border border-line-strong bg-surface-muted/50 px-4 text-left transition-colors hover:border-brand/50 hover:bg-surface-muted"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface-inset text-ink-soft">
                <Wallet className="h-5 w-5" />
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold text-ink">Install a browser wallet</span>
                <span className="block text-xs text-ink-muted">MetaMask, Rabby, OKX — any EVM wallet works</span>
              </span>
              <ArrowRight className="h-4 w-4 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-ink" />
            </a>
          ) : (
            <div className="space-y-2.5">
              {wallets.map((c, i) => {
                const named = c.id !== 'injected' && !!c.name;
                const isMetaMask = named && /metamask/i.test(c.name ?? '');
                const rowPending = mmPending && pendingUid === c.uid;
                return (
                  <button
                    key={c.uid ?? c.id ?? i}
                    type="button"
                    data-testid={i === 0 ? 'auth-wallet' : `auth-wallet-${i}`}
                    disabled={mmPending}
                    onClick={() => onWallet(c)}
                    className="group flex h-14 w-full items-center gap-3 rounded-2xl border border-line-strong bg-surface-muted/50 px-4 text-left transition-colors hover:border-brand/50 hover:bg-surface-muted disabled:opacity-60"
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-surface-inset">
                      {c.icon ? (
                        // eslint-disable-next-line @next/next/no-img-element -- EIP-6963 data-URI icon
                        <img src={c.icon} alt="" className="h-6 w-6 rounded-md" />
                      ) : isMetaMask ? (
                        <MetaMaskIcon className="h-6 w-6" />
                      ) : (
                        <Wallet className="h-5 w-5 text-ink-soft" />
                      )}
                    </span>
                    <span className="flex-1">
                      <span className="block text-sm font-semibold text-ink">
                        {named ? `Connect with ${c.name}` : 'Connect browser wallet'}
                      </span>
                      <span className="block text-xs text-ink-muted">
                        {named ? 'Browser extension wallet' : 'MetaMask, Rabby, OKX — any EVM extension'}
                      </span>
                    </span>
                    {rowPending ? (
                      <Spinner className="h-4 w-4 text-ink-muted" />
                    ) : (
                      <ArrowRight className="h-4 w-4 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-ink" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Divider */}
          <div className="my-5 flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-faint">
            <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
            or
            <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line" />
          </div>

          {/* Google */}
          {googleEnabled && (
            <button
              type="button"
              data-testid="auth-google"
              disabled={busy}
              onClick={onGoogle}
              className="mb-3 flex h-12 w-full items-center justify-center gap-3 rounded-2xl bg-white text-[15px] font-semibold text-[#1f1f1f] shadow-[0_8px_24px_-12px_rgba(0,0,0,0.7)] transition hover:bg-white/95 disabled:opacity-50"
            >
              <GoogleIcon className="h-5 w-5" />
              Continue with Google
            </button>
          )}

          {/* Email */}
          <div className="group/email flex items-center gap-2 rounded-2xl border border-line bg-surface-inset p-2 pl-4 transition-colors focus-within:border-brand/60 focus-within:bg-surface">
            <MailIcon className="h-4 w-4 shrink-0 text-ink-faint" />
            <div className="min-w-0 flex-1">
              <label htmlFor="auth-email" className="block font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                Email
              </label>
              <input
                id="auth-email"
                data-testid="auth-email-input"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value.trim())}
                onKeyDown={(e) => e.key === 'Enter' && onEmail()}
                placeholder="you@example.com"
                className="w-full bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
              />
            </div>
            {/* Animated gradient submit */}
            <button
              type="button"
              data-testid="auth-email-submit"
              disabled={busy || !EMAIL_RE.test(email)}
              onClick={onEmail}
              aria-label="Continue with email"
              className="group/submit relative grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full disabled:opacity-40"
            >
              <span
                className="absolute -inset-1 rounded-full opacity-0 blur-md transition-opacity duration-300 group-hover/submit:opacity-90 group-hover/submit:[animation:spin_2.5s_linear_infinite]"
                style={{ background: CONIC }}
                aria-hidden="true"
              />
              <span
                className="absolute inset-0 rounded-full opacity-80 transition-opacity group-hover/submit:opacity-100 group-hover/submit:[animation:spin_2.5s_linear_infinite]"
                style={{ background: CONIC }}
                aria-hidden="true"
              />
              <span className="absolute inset-[2.5px] rounded-full bg-[#0c0c0e] shadow-[inset_0_1px_3px_rgba(0,0,0,0.6)]" aria-hidden="true" />
              {busy ? (
                <Spinner className="relative h-4 w-4 text-white" />
              ) : (
                <ArrowRight className="relative h-4 w-4 text-white transition-transform group-hover/submit:translate-x-0.5" />
              )}
            </button>
          </div>

          {errorMsg && (
            <p data-testid="auth-error" className="mt-3 text-center text-[13px] text-side-down">
              {errorMsg}
            </p>
          )}

          {/* Footer */}
          <p className="mt-6 flex items-center justify-center gap-1.5 text-center text-xs text-ink-muted">
            <Shield className="h-3.5 w-3.5 text-ink-faint" />
            Non-custodial · secured by Circle MPC · settles on Arc
          </p>
        </div>
      </div>
    </div>
  );
}
