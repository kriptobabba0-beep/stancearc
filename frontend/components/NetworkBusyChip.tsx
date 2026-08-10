'use client';

// components/NetworkBusyChip.tsx — a quiet bottom-left pill shown ONLY while the shared
// rate-limit gate is cooling down (i.e. the Arc RPC actually throttled us and requests are
// waiting it out). With the edge proxy + provider mirrors in front, this should be rare —
// but when it happens the user deserves to know why numbers pause for a few seconds,
// instead of guessing the app broke.
import { useEffect, useReducer } from 'react';
import { rpcGate, type RateLimitGate } from '@/lib/rpcResilience';

export function NetworkBusyChip({ gate = rpcGate }: { gate?: RateLimitGate }) {
  const [, bump] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    let timer: number | undefined;
    const schedule = () => {
      const snap = gate.snapshot();
      if (snap.coolingDown) {
        // Re-render right after the cooldown lapses so the chip removes itself.
        window.clearTimeout(timer);
        timer = window.setTimeout(bump, Math.max(50, snap.until - Date.now() + 50));
      }
    };
    const unsub = gate.subscribe(() => {
      bump();
      schedule();
    });
    schedule();
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, [gate]);

  if (!gate.snapshot().coolingDown) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-4 z-50 flex select-none items-center gap-2 rounded-full border border-side-range/40 bg-side-range-soft px-3 py-1.5 shadow-card animate-fade-in"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-side-range animate-pulse-soft" aria-hidden="true" />
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-soft">
        Arc RPC busy — retrying
      </span>
    </div>
  );
}
