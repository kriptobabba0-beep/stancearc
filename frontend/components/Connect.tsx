'use client';

import { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { friendlyError } from '@/lib/errors';
import { Wallet, Alert } from '@/components/ui/icons';

const METAMASK_URL = 'https://metamask.io/download/';

/** SSR-guarded check for an injected EIP-1193 provider (e.g. MetaMask). */
function hasInjectedProvider(): boolean {
  return typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum;
}

function short(addr: `0x${string}`): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * Connect — the wallet control only. Three states, all styled as the redesign's squared HUD chips:
 *   • connected   — a bordered chip (green status dot + short address); click to disconnect.
 *   • no wallet   — a red-outline "Install a wallet" link (any EVM extension works).
 *   • disconnected— a red-outline "Connect Wallet" button.
 *
 * The Faucet + ArcScan affordances that used to live here now sit in <NavBar/> as always-visible
 * buttons (matching the mockups), so this component is purely the wallet pill.
 */
export function Connect() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();

  // Gate window.ethereum reads behind a mounted flag to eliminate SSR/hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const injected = connectors[0];
  const noWallet = mounted && (!injected || !hasInjectedProvider());

  const outlineClass =
    'inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-transparent px-3.5 text-sm font-semibold text-brand transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60';

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={() => disconnect()}
        title="Disconnect wallet"
        aria-label={`${short(address)} — click to disconnect`}
        className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-3 font-mono text-xs text-ink transition-colors hover:border-brand focus-visible:outline-none focus-visible:shadow-focus"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-side-up" aria-hidden="true" />
        {short(address)}
      </button>
    );
  }

  if (noWallet) {
    return (
      <a href={METAMASK_URL} target="_blank" rel="noreferrer" data-testid="connect-error" className={outlineClass}>
        <Wallet className="h-4 w-4" aria-hidden="true" />
        Install a wallet
      </a>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" disabled={isPending} onClick={() => connect({ connector: injected })} className={outlineClass}>
        <Wallet className="h-4 w-4" aria-hidden="true" />
        {isPending ? 'Connecting…' : 'Connect Wallet'}
      </button>
      {connectError && (
        <p
          role="alert"
          data-testid="connect-error"
          className="flex max-w-[16rem] items-center gap-1.5 text-right text-xs text-side-down"
        >
          <Alert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {friendlyError(connectError)}
        </p>
      )}
    </div>
  );
}
