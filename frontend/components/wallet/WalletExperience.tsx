'use client';

// components/wallet/WalletExperience.tsx — what /wallet renders, by state:
//   • embedded (Google/Email/PIN) ready → the full <MyWallet/> experience
//   • browser wallet connected         → a friendly notice (manage in the extension)
//   • signed out                       → a premium prompt that opens the Sign In modal

import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { ENV } from '@/lib/env';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import { useAuthModal } from '@/components/auth/AuthModalProvider';
import { MyWallet } from '@/components/wallet/MyWallet';
import { Card } from '@/components/ui/Card';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Wallet, Shield, External, Spinner } from '@/components/ui/icons';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md py-6">{children}</div>;
}

function SignInPrompt() {
  const { open } = useAuthModal();
  return (
    <Centered>
      <Card className="relative overflow-hidden motion-safe:animate-fade-up">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -left-16 -top-20 h-56 w-56 rounded-full bg-brand/15 blur-3xl" />
          <span className="landing-scanline" />
        </div>
        <div className="relative flex flex-col items-center px-7 py-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl border border-line-strong bg-surface-muted/60">
            <Wallet className="h-7 w-7 text-brand" />
          </span>
          <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">Open your wallet</h1>
          <p className="mt-2 max-w-xs text-sm text-ink-soft">
            Sign in with Google or email — your Limen wallet opens in seconds, with balances, transfers,
            and activity in one place. Or connect any EVM browser wallet.
          </p>
          <button type="button" data-testid="prompt-signin" onClick={open} className={buttonClass('primary', 'lg', 'mt-6 w-full')}>
            <Wallet className="h-4 w-4" /> Sign In
            <Stars />
          </button>
          <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-muted">
            <Shield className="h-3.5 w-3.5 text-ink-faint" /> Non-custodial · secured by Circle MPC
          </p>
        </div>
      </Card>
    </Centered>
  );
}

function BrowserWalletNotice({ address, walletName }: { address: `0x${string}`; walletName?: string }) {
  const name = walletName || 'your wallet';
  return (
    <Centered>
      <Card className="motion-safe:animate-fade-up">
        <div className="flex flex-col items-center px-7 py-10 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl border border-line-strong bg-surface-muted/60">
            <Wallet className="h-7 w-7 text-ink-soft" />
          </span>
          <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
            Connected with {walletName || 'a browser wallet'}
          </h1>
          <p className="mt-2 font-mono text-sm text-ink-muted">{short(address)}</p>
          <p className="mt-3 max-w-xs text-sm text-ink-soft">
            Manage these assets in {name === 'your wallet' ? 'your wallet extension' : `the ${name} extension`}. The
            in-app My Wallet is for Limen Finance’s embedded (Google / email) wallets.
          </p>
          <a href={`${ENV.EXPLORER_URL}/address/${address}`} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'md', 'mt-6')}>
            <External className="h-4 w-4" /> View on ArcScan
            <Stars />
          </a>
        </div>
      </Card>
    </Centered>
  );
}

export function WalletExperience() {
  const { isReady, address } = useCircleWallet();
  const { isConnected, address: wagmiAddr, connector } = useAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <Centered>
        <Card>
          <div className="flex items-center justify-center gap-3 px-7 py-12 text-sm text-ink-muted">
            <Spinner className="h-4 w-4 text-brand" /> Loading your wallet…
          </div>
        </Card>
      </Centered>
    );
  }
  if (isReady && address) return <MyWallet />;
  if (isConnected && wagmiAddr) return <BrowserWalletNotice address={wagmiAddr} walletName={connector?.name} />;
  return <SignInPrompt />;
}
