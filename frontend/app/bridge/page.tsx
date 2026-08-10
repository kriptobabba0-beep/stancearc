'use client';

import { useState } from 'react';
import { BridgeUSDC } from '@/components/BridgeUSDC';
import { GatewayBridge } from '@/components/GatewayBridge';
import { cn } from '@/lib/cn';

type Method = 'cctp' | 'gateway';

const TABS: { id: Method; label: string; blurb: string }[] = [
  { id: 'cctp', label: 'Standard (CCTP)', blurb: 'Burn on the source, wait for Circle’s attestation, mint on Arc.' },
  { id: 'gateway', label: 'Instant (Gateway)', blurb: 'Deposit once into Gateway, then transfer to Arc near-instantly.' },
];

export default function BridgePage() {
  // Allow deep-linking to the Gateway tab via /bridge#gateway.
  const [method, setMethod] = useState<Method>(() =>
    typeof window !== 'undefined' && window.location.hash === '#gateway' ? 'gateway' : 'cctp',
  );

  function select(id: Method) {
    setMethod(id);
    if (typeof window !== 'undefined') {
      // Clear the hash without mangling the path (a literal ' ' would resolve to a bad URL).
      window.history.replaceState(null, '', id === 'gateway' ? '#gateway' : window.location.pathname);
    }
  }

  const active = TABS.find((t) => t.id === method) ?? TABS[0];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6 motion-safe:animate-fade-up">
        <span className="kicker">Onboard</span>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-ink">Bring USDC to Arc</h1>
        <p className="mt-2 text-[15px] text-ink-soft">
          Move USDC onto Arc testnet from another chain — the standard way via Circle CCTP V2, or instantly
          via Circle Gateway’s unified balance. No faucet required once you hold source-chain testnet USDC.
        </p>
      </header>

      {/* Method toggle */}
      <div
        role="tablist"
        aria-label="Onboarding method"
        className="mb-4 inline-flex rounded-xl border border-line bg-surface-muted p-1 motion-safe:animate-fade-up"
      >
        {TABS.map((t) => {
          const isActive = t.id === method;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-testid={`bridge-method-${t.id}`}
              onClick={() => select(t.id)}
              className={cn(
                'rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-focus',
                isActive ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink',
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <p className="mb-4 text-[13px] text-ink-muted">{active.blurb}</p>

      <div className="motion-safe:animate-fade-up" style={{ animationDelay: '60ms' }}>
        {method === 'cctp' ? <BridgeUSDC /> : <GatewayBridge />}
      </div>
    </div>
  );
}
