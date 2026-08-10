// bootGate.test.tsx — the boot gate must not brick the app on transient RPC trouble.
// Arc's public RPC throttles bursts with "request limit reached"; a throttled boot read used to
// render the permanent "failed to boot" banner. The gate now retries on a backoff: transient
// errors keep the loader (then the calm "busy" card with auto-retry + a Retry-now button), and
// ONLY a repeated, authoritative config problem (no bytecode / bad decimals) ends in the fatal
// banner. wagmi/actions is mocked so the fake client scripts each attempt's outcome.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';

const ARENA = '0x00000000000000000000000000000000000aaaaa';

// ── Scriptable fake RPC client ────────────────────────────────────────────────────────
const rpc = vi.hoisted(() => ({
  failuresLeft: 0, // getBytecode rejects this many times with a rate-limit error first
  bytecode: '0x6001' as string, // what getBytecode answers once it stops failing
  attempts: 0,
}));

function limitError() {
  // Shaped like viem's wrapped transport error: useful line lives in cause.details.
  const err = new Error('RPC Request failed.\nURL: wss://rpc.testnet.arc.network');
  Object.assign(err, {
    shortMessage: 'RPC Request failed.',
    cause: { details: 'request limit reached' },
  });
  return err;
}

vi.mock('wagmi/actions', () => ({
  getPublicClient: () => ({
    getBytecode: async () => {
      rpc.attempts += 1;
      if (rpc.failuresLeft > 0) {
        rpc.failuresLeft -= 1;
        throw limitError();
      }
      return rpc.bytecode;
    },
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'decimals' ? 6 : '0x1111111111111111111111111111111111111111',
  }),
}));

// Config/env modules build transports and parse env at import — stub them out.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/env', () => ({
  ENV: { USDC_ADDRESS: '0x3600000000000000000000000000000000000000', CHAIN_ID: 5042002 },
}));
vi.mock('@/lib/markets', () => ({
  MARKETS: [{ id: 'btc', feeArena: '0x00000000000000000000000000000000000aaaaa', baseDecimals: 8 }],
}));
vi.mock('@/lib/decimals', () => ({
  isBootDecimalsReady: () => false,
  setBootDecimals: vi.fn(),
  assertBootDecimals: (usdc: number, base: number) => {
    if (usdc !== 6) throw new Error(`BadDecimals: USDC decimals ${usdc} (expected 6).`);
    return { usdc, base };
  },
}));

// Providers-only imports BootGate never renders — keep the module importable and light.
vi.mock('@/components/MarketProvider', () => ({
  MarketProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/circle/WalletModeProvider', () => ({
  WalletModeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/circle/CircleWalletProvider', () => ({
  CircleWalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/circle/EmbeddedWalletConnector', () => ({
  EmbeddedWalletConnector: () => null,
}));
vi.mock('@/components/auth/AuthModalProvider', () => ({
  AuthModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { BootGate } from '@/app/providers';

// Flush pending microtasks (the boot attempt runs in an effect's async closure).
const flush = () => act(async () => {});
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('BootGate retry behaviour', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    rpc.failuresLeft = 0;
    rpc.bytecode = '0x6001';
    rpc.attempts = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('retries through transient rate-limit errors without ever showing an error banner', async () => {
    rpc.failuresLeft = 2;
    render(<BootGate><div>app-content</div></BootGate>);
    await flush();

    // First attempt failed → loader, NOT the fatal banner.
    expect(screen.queryByText(/failed to boot/i)).toBeNull();
    // (label renders twice: visible line + sr-only copy)
    expect(screen.getAllByText(/Connecting to Arc Testnet/i).length).toBeGreaterThan(0);

    await advance(1500); // second attempt fails too
    expect(screen.queryByText(/failed to boot/i)).toBeNull();

    await advance(3000); // third attempt succeeds
    expect(screen.getByText('app-content')).toBeTruthy();
    expect(rpc.attempts).toBe(3);
  });

  it('shows the calm busy card after persistent throttling, and Retry now recovers', async () => {
    rpc.failuresLeft = 99;
    render(<BootGate><div>app-content</div></BootGate>);
    await flush(); // failure 1
    await advance(1500); // failure 2
    await advance(3000); // failure 3 → degraded card

    expect(screen.getByText(/Arc Testnet is busy right now/i)).toBeTruthy();
    expect(screen.getByText(/request limit reached/i)).toBeTruthy();
    expect(screen.getByText(/Retrying automatically/i)).toBeTruthy();
    // The scary dev-facing banner must NOT be what a throttled visitor sees.
    expect(screen.queryByText(/failed to boot/i)).toBeNull();

    // The throttle clears; the user clicks Retry now instead of waiting out the backoff.
    rpc.failuresLeft = 0;
    fireEvent.click(screen.getByRole('button', { name: /retry now/i }));
    await flush();
    expect(screen.getByText('app-content')).toBeTruthy();
  });

  it('keeps auto-retrying from the busy card without user action', async () => {
    rpc.failuresLeft = 4;
    render(<BootGate><div>app-content</div></BootGate>);
    await flush(); // failure 1
    await advance(1500); // failure 2
    await advance(3000); // failure 3 → degraded
    expect(screen.getByText(/Arc Testnet is busy right now/i)).toBeTruthy();

    await advance(6000); // failure 4 (still throttled)
    await advance(12000); // attempt 5 succeeds — no click needed
    expect(screen.getByText('app-content')).toBeTruthy();
  });

  it('declares fatal only after a config problem repeats on a second attempt', async () => {
    rpc.bytecode = '0x'; // authoritative "no contract here"
    render(<BootGate><div>app-content</div></BootGate>);
    await flush();

    // One bad answer is not enough — could be a flaky node.
    expect(screen.queryByText(/failed to boot/i)).toBeNull();

    await advance(1500); // second config failure → fatal
    expect(screen.getByText(/failed to boot/i)).toBeTruthy();
    expect(screen.getByText(/No contract bytecode/i)).toBeTruthy();

    // Fatal is terminal: no further attempts get scheduled.
    const attemptsAtFatal = rpc.attempts;
    await advance(60_000);
    expect(rpc.attempts).toBe(attemptsAtFatal);
  });

  it('recovers when a config-looking answer was a one-off node glitch', async () => {
    rpc.bytecode = '0x'; // first probe answers "no code" (lagging node)
    render(<BootGate><div>app-content</div></BootGate>);
    await flush();
    expect(screen.queryByText(/failed to boot/i)).toBeNull();

    rpc.bytecode = '0x6001'; // node caught up
    await advance(1500);
    expect(screen.getByText('app-content')).toBeTruthy();
  });
});
