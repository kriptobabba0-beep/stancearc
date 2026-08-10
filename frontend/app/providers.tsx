'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { WagmiProvider } from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { wagmiConfig } from '@/lib/wagmi';
import { makeQueryClient } from '@/lib/queryClient';
import { assertBootDecimals, setBootDecimals, isBootDecimalsReady } from '@/lib/decimals';
import { ENV } from '@/lib/env';
import { MARKETS } from '@/lib/markets';
import { erc20Abi, feeArenaAbi } from '@/abis';
import { BouncingLoader } from '@/components/ui/BouncingLoader';
import { NetworkBusyChip } from '@/components/NetworkBusyChip';
import { MarketProvider } from '@/components/MarketProvider';
import { ThemeProvider } from '@/components/ThemeProvider';
import { WalletModeProvider } from '@/components/circle/WalletModeProvider';
import { CircleWalletProvider } from '@/components/circle/CircleWalletProvider';
import { EmbeddedWalletConnector } from '@/components/circle/EmbeddedWalletConnector';
import { AuthModalProvider } from '@/components/auth/AuthModalProvider';

type BootState =
  | { status: 'loading' }
  | { status: 'ok' }
  // Transient RPC trouble (rate limit, timeout, network blip) that outlived the quick retries.
  // The loop keeps retrying underneath — this is a "please hold" card, not a dead end.
  | { status: 'degraded'; message: string }
  | { status: 'fatal'; message: string };

/**
 * Tags the boot checks that prove a real configuration problem (zero/wrong address, bad
 * decimals). ONLY these may end in the fatal banner. Anything untagged is treated as transient
 * RPC trouble and retried forever — Arc's public RPC throttles bursts with "request limit
 * reached", and a throttled read must never brick the app behind a permanent error screen.
 */
class BootConfigError extends Error {}

/**
 * Pulls the human-useful line out of a viem error. The interesting part ("request limit
 * reached") lives in `details` somewhere down the cause chain; the top-level message is a
 * multi-line dump with request bodies and docs links that we don't want on a banner.
 */
function describeRpcError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as { shortMessage?: unknown; details?: unknown; cause?: unknown };
    if (typeof e.details === 'string' && e.details) parts.push(e.details);
    if (typeof e.shortMessage === 'string' && e.shortMessage) parts.push(e.shortMessage);
    cur = e.cause;
  }
  if (err instanceof Error && err.message) parts.push(err.message.split('\n')[0]);
  const limitHit = parts.find((p) => /request limit|rate limit|limit exceeded|429/i.test(p));
  return limitHit ?? parts[0] ?? String(err);
}

// Backoff between boot retries: quick at first (a throttle window usually clears in seconds),
// then settle at a steady 15s so a long RPC outage costs ~4 requests/minute, not a hammer.
const RETRY_DELAYS_MS = [1_500, 3_000, 6_000, 12_000];
const RETRY_STEADY_MS = 15_000;
// After this many consecutive transient failures, swap the spinner for the honest "busy" card.
const DEGRADE_AFTER_FAILURES = 3;

function FatalBanner({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <div
        role="alert"
        className="rounded-2xl border border-side-down/30 bg-side-down-soft p-6 shadow-card"
      >
        <h1 className="font-display text-lg font-semibold text-ink">Limen Finance failed to boot</h1>
        <p className="mt-2 text-sm text-ink-soft">{message}</p>
        <p className="mt-3 text-xs text-ink-muted">
          Check NEXT_PUBLIC_* addresses/RPC in your .env.local and that the contracts are deployed on
          Arc Testnet (chainId {ENV.CHAIN_ID}).
        </p>
      </div>
    </div>
  );
}

/** Shown when the RPC keeps rate-limiting past the quick retries. Calm, self-healing, retryable. */
function DegradedBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
      <div
        role="alert"
        className="rounded-2xl border border-side-range/30 bg-side-range-soft p-6 shadow-card"
      >
        <h1 className="font-display text-lg font-semibold text-ink">Arc Testnet is busy right now</h1>
        <p className="mt-2 text-sm text-ink-soft">
          The public Arc RPC is throttling requests, so Limen can&apos;t finish its startup checks
          yet. This clears by itself — the app keeps retrying until it gets through.
        </p>
        <p className="mt-3 break-words font-mono text-xs text-ink-muted">{message}</p>
        <div className="mt-4 flex items-center gap-4">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-subtle-hover"
          >
            Retry now
          </button>
          <span className="flex items-center gap-2 text-xs text-ink-muted">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-side-range" aria-hidden="true" />
            Retrying automatically
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * One-time boot gate: reads USDC decimals + asserts FeeArena bytecode/owner() answer.
 * Genuine misconfiguration (BootConfigError) is fatal; everything else — including Arc's
 * "request limit reached" throttle — is retried on a backoff until the chain answers.
 */
export function BootGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BootState>(() =>
    isBootDecimalsReady() ? { status: 'ok' } : { status: 'loading' },
  );
  const ran = useRef(false);
  // "Retry now" resolves the pending backoff sleep early; harmless no-op between sleeps.
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (ran.current || state.status === 'ok') return;
    ran.current = true;
    let cancelled = false;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const t = window.setTimeout(() => {
          kickRef.current = () => {};
          resolve();
        }, ms);
        kickRef.current = () => {
          window.clearTimeout(t);
          kickRef.current = () => {};
          resolve();
        };
      });

    const runBootChecks = async () => {
      const client = getPublicClient(wagmiConfig);
      if (!client) throw new BootConfigError('No RPC client configured.');

      // 0) Active/default market must have a real (non-zero) FeeArena. A malformed
      // NEXT_PUBLIC_MARKETS blob (typo'd address / dup id) would otherwise boot the all-zero
      // placeholder silently — surface it as a fatal here instead (Fix D).
      // The boot gate runs once at first paint, where the active market is always the default
      // (MARKETS[0]) — MarketProvider initializes to DEFAULT_MARKET_ID for a stable SSR/first
      // paint and only hydrates from localStorage after mount. So MARKETS[0].feeArena IS the
      // contract the app uses here; validate THAT (not the legacy global ENV.FEE_ARENA_ADDRESS,
      // which is the stale single-market/ETH value once NEXT_PUBLIC_MARKETS targets cirBTC).
      const ZERO = '0x0000000000000000000000000000000000000000';
      if (!MARKETS[0] || MARKETS[0].feeArena.toLowerCase() === ZERO) {
        throw new BootConfigError(
          'Active market has no FeeArena address (zero address). Check NEXT_PUBLIC_MARKETS — it is likely malformed (typo, duplicate id, or wrong shape).',
        );
      }
      const feeArenaAddress = MARKETS[0].feeArena;

      // 1) FeeArena bytecode must exist (catches wrong/undeployed address). Validate the ACTIVE
      // market's arena (mirrors step 0), NOT the legacy global ENV.FEE_ARENA_ADDRESS. A throw
      // from getBytecode itself is an RPC failure (transient); only an authoritative "no code
      // here" answer is config-fatal.
      const code = await client.getBytecode({ address: feeArenaAddress });
      if (!code || code === '0x') {
        throw new BootConfigError(`No contract bytecode at FeeArena address ${feeArenaAddress}.`);
      }

      // 2) Boot decimals read + hard-fail assert (mirrors BadDecimals — USDC===6 only). The base
      // leg is decimals-agnostic on-chain, so we no longer require/assert base===18 (cirBTC is 8dp).
      // We read ONLY the USDC decimals on-chain; the base decimals come from the active market config
      // (MARKETS[0].baseDecimals) — passed through for type-stability but NOT gated. This also drops a
      // dependency on a possibly-stale WETH mock address that no live cirBTC market would have.
      const usdcDecimals = await client.readContract({
        address: ENV.USDC_ADDRESS,
        abi: erc20Abi,
        functionName: 'decimals',
      });
      try {
        setBootDecimals(assertBootDecimals(Number(usdcDecimals), MARKETS[0].baseDecimals));
      } catch (err) {
        // The RPC answered and the VALUE is wrong — that's configuration, not weather.
        throw new BootConfigError(err instanceof Error ? err.message : String(err));
      }

      // 3) Sanity-touch FeeArena owner() so a wrong-ABI/wrong-address surfaces at boot. Same
      // active-market arena as steps 0–1 (not the legacy global ENV.FEE_ARENA_ADDRESS).
      await client.readContract({ ...{ address: feeArenaAddress, abi: feeArenaAbi }, functionName: 'owner' });
    };

    (async () => {
      // Config errors must repeat before we declare them fatal: a flaky/lagging RPC node can
      // answer one bytecode probe with nonsense, and one bad answer shouldn't brick the app.
      let failures = 0;
      let configStreak = 0;
      while (!cancelled) {
        try {
          await runBootChecks();
          if (!cancelled) setState({ status: 'ok' });
          return;
        } catch (err) {
          if (cancelled) return;
          if (err instanceof BootConfigError) {
            configStreak += 1;
            if (configStreak >= 2) {
              setState({ status: 'fatal', message: err.message });
              return;
            }
          } else {
            configStreak = 0;
          }
          failures += 1;
          if (!(err instanceof BootConfigError) && failures >= DEGRADE_AFTER_FAILURES) {
            setState({ status: 'degraded', message: describeRpcError(err) });
          }
          await sleep(RETRY_DELAYS_MS[failures - 1] ?? RETRY_STEADY_MS);
        }
      }
    })();

    return () => {
      // Strict-mode mounts the component twice in dev: cancel this run and let the remount
      // start a fresh loop (ran-flag reset), so exactly one loop survives.
      cancelled = true;
      ran.current = false;
      kickRef.current();
    };
    // Run-once boot loop; it manages its own state transitions internally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.status === 'fatal') return <FatalBanner message={state.message} />;
  if (state.status === 'degraded') {
    return <DegradedBanner message={state.message} onRetry={() => kickRef.current()} />;
  }
  if (state.status === 'loading') {
    return (
      <div className="flex min-h-[70vh] w-full items-center justify-center px-4 py-16">
        <BouncingLoader label="Connecting to Arc Testnet…" />
      </div>
    );
  }
  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  // Stable QueryClient across renders.
  const [queryClient] = useState(makeQueryClient);

  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <MarketProvider>
            {/* Wallet-mode + embedded (Circle) wallet context — available app-wide alongside wagmi. */}
            <WalletModeProvider>
              <CircleWalletProvider>
                {/* Bridges the embedded wallet into wagmi so the whole app can use it. */}
                <EmbeddedWalletConnector />
                <AuthModalProvider>
                  <BootGate>{children}</BootGate>
                </AuthModalProvider>
              </CircleWalletProvider>
            </WalletModeProvider>
          </MarketProvider>
          {/* Tx-lifecycle toasts (sonner). Always mounted so write hooks can surface
              submit → confirmed → error in place. Styled to the Clean Institutional system via
              the `toast` className override in globals.css (surface/ink/line tokens, font-sans). */}
          <Toaster
            richColors
            position="bottom-right"
            toastOptions={{ className: 'fa-toast' }}
          />
          {/* Visible only while the shared rate-limit gate is actually cooling down. */}
          <NetworkBusyChip />
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
