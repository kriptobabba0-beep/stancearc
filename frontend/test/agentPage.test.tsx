import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The Limen Copilot page's three states — honest offline, inviting empty (suggestions),
// and an active thread with a pending action card whose outcomes flow back into the chat.

let chatState: Record<string, unknown>;

const baseChat = {
  messages: [],
  status: 'ready',
  activity: null,
  pendingAction: null,
  paymentRequired: null,
  billing: null,
  models: [],
  setModel: vi.fn(),
  send: vi.fn(),
  reportActionResult: vi.fn(),
  dismissAction: vi.fn(),
  retryWithPayment: vi.fn(),
  dismissPayment: vi.fn(),
  appendLocalNote: vi.fn(),
  clearThread: vi.fn(),
  history: [],
  restoreThread: vi.fn(),
};
chatState = baseChat;

vi.mock('@/hooks/useCopilotChat', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, useCopilotChat: () => chatState };
});
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => undefined,
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}));
vi.mock('@/lib/chain', () => ({ ARC_CHAIN_ID: 5042002, arcTestnet: { id: 5042002 }, withGasFloor: (x: unknown) => x }));
// lib/events pulls in wagmiConfig (a module-scope ENV read) — the page only needs the
// chunked log reader, which the History popover calls on demand.
vi.mock('@/lib/events', () => ({ getEventLogsChunked: vi.fn(async () => []) }));
let pilotState = { state: 'off', detail: '', epochId: null as string | null, phaseName: null as string | null, entryLeftSec: null as number | null, settleInSec: null as number | null, confidence: null as number | null, lastCheckedAt: null as number | null };
vi.mock('@/hooks/useAutopilot', () => ({
  useAutopilot: () => pilotState,
}));
type SessionInfoShape = {
  address: `0x${string}`;
  usdc: bigint;
  base: bigint;
  quoteBal: bigint;
  tokenId: bigint | null;
  lpStaked: boolean;
  range: { tickLower: number; tickUpper: number; poolTick: number; baseIsToken0: boolean } | null;
  lpValue: { base: bigint; quote: bigint; totalQuote: number } | null;
};
const baseSession = {
  active: false,
  address: null as `0x${string}` | null,
  info: null as SessionInfoShape | null,
  busy: false,
  start: vi.fn(),
  stop: vi.fn(),
  enterEpoch: vi.fn(),
  claimMany: vi.fn(),
  exportKey: vi.fn(() => null),
  refresh: vi.fn(),
};
let sessionState: typeof baseSession = baseSession;
vi.mock('@/hooks/useSessionAgent', () => ({
  useSessionAgent: () => sessionState,
  recentSessionAddresses: () => [],
  marketsWithSessions: () => [],
}));
// ActionCard pulls the mint hook, whose module chain reads ENV at import time.
vi.mock('@/hooks/useMintPosition', () => ({
  useMintPosition: () => ({ mint: vi.fn(), isPending: false }),
  tickSpacingForFee: () => 60,
  fullRangeTicks: () => ({ tickLower: -887_220, tickUpper: 887_220 }),
}));
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({ id: 'cirbtc', label: 'cirBTC / USDC', baseDecimals: 8 }),
}));
vi.mock('@/components/MarketSelector', () => ({ MarketSelector: () => null }));
vi.mock('@/lib/markets', () => ({ MARKETS: [{ id: 'cirbtc', label: 'cirBTC / USDC' }] }));
let stakeMock: { stake: ReturnType<typeof vi.fn>; isPending: boolean } = { stake: vi.fn(), isPending: false };
vi.mock('@/hooks/useStakeWithSide', () => ({ useStakeWithSide: () => stakeMock }));
vi.mock('@/hooks/useOwnedPositions', () => ({ useOwnedPositions: () => ({ data: [{ tokenId: 42n }] }) }));
vi.mock('@/hooks/useSwap', () => ({ useSwap: () => ({ swap: vi.fn(), isPending: false }) }));
vi.mock('@/hooks/useOraclePrice', () => ({ useOraclePrice: () => ({ data: { price18: 60000_000000000000000000n, updatedAt: 1n } }) }));
vi.mock('@/lib/tokens', () => ({
  quoteToken: () => ({ symbol: 'USDC', address: `0x${'2'.repeat(40)}`, decimals: 6 }),
  tokenBySymbol: () => ({ symbol: 'cirBTC', address: `0x${'3'.repeat(40)}`, decimals: 8 }),
  USDC: { symbol: 'USDC', address: `0x${'2'.repeat(40)}`, decimals: 6 },
}));

import AgentPage from '@/app/agent/page';

afterEach(() => {
  cleanup();
  chatState = baseChat;
  sessionState = baseSession;
  pilotState = { state: 'off', detail: '', epochId: null, phaseName: null, entryLeftSec: null, settleInSec: null, confidence: null, lastCheckedAt: null };
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('AgentPage', () => {
  it('empty thread invites with suggestions; clicking one sends it', () => {
    render(<AgentPage />);
    expect(screen.getByText(/Ask\. Understand\. Act\./)).toBeTruthy();
    const chip = screen.getByText('What is happening in this epoch right now?');
    fireEvent.click(chip);
    expect(baseChat.send).toHaveBeenCalledWith('What is happening in this epoch right now?');
  });

  it('offline state says so honestly and disables the composer', () => {
    chatState = { ...baseChat, status: 'offline' };
    render(<AgentPage />);
    expect(screen.getByText(/not configured on this deployment/)).toBeTruthy();
    expect((screen.getByPlaceholderText('Copilot offline') as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('renders the thread and a pending stake action card; confirm reports back', async () => {
    const stake = vi.fn(async () => undefined);
    stakeMock = { stake, isPending: false };
    chatState = {
      ...baseChat,
      messages: [
        { role: 'user', content: 'Enter this epoch for me.' },
        { role: 'assistant', content: 'Odds favor UP — proposing the entry for your confirmation.' },
      ],
      pendingAction: { type: 'stake', side: 'UP', marketId: 'cirbtc', note: 'Odds favor UP this epoch.' },
    };
    render(<AgentPage />);
    expect(screen.getByText(/proposing the entry/)).toBeTruthy();
    const card = screen.getByTestId('agent-action-card');
    expect(card.textContent).toContain('Odds favor UP this epoch.');
    fireEvent.click(screen.getByText('Confirm UP'));
    await vi.waitFor(() => expect(stake).toHaveBeenCalledWith({ tokenId: 42n, side: 1 }));
    await vi.waitFor(() => expect(baseChat.reportActionResult).toHaveBeenCalled());
    expect(String((baseChat.reportActionResult as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('submitted');
  });

  it('Stop wins the race: a staked LP arms the sweep, blocks re-entry, and finishes after settlement', async () => {
    // Fake-but-auto-advancing clock: the 12s armed-sweep interval becomes controllable
    // while vi.waitFor keeps working.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ swept: false, retriable: true, reason: 'the LP is staked in a live epoch — press Stop again after it settles (it auto-returns)' })
      .mockResolvedValueOnce({ swept: true, moved: '0.0009 cirBTC + $52.10 USDC' });
    sessionState = { ...baseSession, active: true, address: `0x${'a'.repeat(40)}` as `0x${string}`, stop };
    render(<AgentPage />);

    fireEvent.click(screen.getByText('Stop & Sweep Back'));
    // First attempt: LP mid-epoch — the sweep arms instead of failing, entries halt.
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    const armedBtn = await vi.waitFor(() => screen.getByText('Sweeping at settlement…'));
    expect((armedBtn.closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(
      (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('sweep is armed')),
    ).toBe(true);

    // The armed sweep retries by itself and completes once the epoch has settled.
    await vi.advanceTimersByTimeAsync(12_500);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
          String(c[0]).includes('sweep completed after settlement'),
        ),
      ).toBe(true),
    );
    expect(screen.getByText('Stop & Sweep Back')).toBeTruthy(); // button re-armed for next time
  });

  it('a non-retriable sweep failure tells the real reason and never freezes on "Sweeping at settlement…"', async () => {
    const stop = vi.fn().mockResolvedValue({
      swept: false,
      reason: 'the session has funds but no gas money left — the sweep needs a small $1.5 USDC top-up from your wallet',
    });
    sessionState = { ...baseSession, active: true, address: `0x${'a'.repeat(40)}` as `0x${string}`, stop };
    render(<AgentPage />);

    fireEvent.click(screen.getByText('Stop & Sweep Back'));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    // The feed carries the REAL failure, not the mid-epoch cover story…
    await vi.waitFor(() =>
      expect(
        (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('no gas money left')),
      ).toBe(true),
    );
    expect(
      (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('sweep is armed')),
    ).toBe(false);
    // …and the button stays actionable instead of freezing in the armed state.
    expect(screen.queryByText('Sweeping at settlement…')).toBeNull();
    expect(screen.getByText('Stop & Sweep Back')).toBeTruthy();
  });

  it('no-entry heartbeat: 10 silent minutes with a live session put the autopilot\'s own status in the feed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pilotState = {
      state: 'watching',
      detail: 'Best view RANGE at 61% — below your 65% floor. Re-checking every 15s.',
      epochId: '5100',
      phaseName: 'entry open',
      entryLeftSec: 80,
      settleInSec: 200,
      confidence: 0.61,
      lastCheckedAt: Date.now(),
    };
    sessionState = { ...baseSession, active: true, address: `0x${'a'.repeat(40)}` as `0x${string}` };
    render(<AgentPage />);

    // Nothing for the first minutes…
    await vi.advanceTimersByTimeAsync(120_000);
    expect(
      (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('still watching')),
    ).toBe(false);
    // …but a 10-minute silent stretch gets explained in the feed, in the status line's words.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await vi.waitFor(() =>
      expect(
        (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some(
          (c) => String(c[0]).includes('still watching') && String(c[0]).includes('below your 65% floor'),
        ),
      ).toBe(true),
    );
  });

  it('an armed sweep that later hits a non-retriable error disarms and hands control back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const stop = vi
      .fn()
      .mockResolvedValueOnce({ swept: false, retriable: true, reason: 'the LP is staked in a live epoch — press Stop again after it settles (it auto-returns)' })
      .mockResolvedValueOnce({ swept: false, reason: 'the gas top-up transaction reverted' });
    sessionState = { ...baseSession, active: true, address: `0x${'a'.repeat(40)}` as `0x${string}`, stop };
    render(<AgentPage />);

    fireEvent.click(screen.getByText('Stop & Sweep Back'));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.getByText('Sweeping at settlement…')).toBeTruthy());

    await vi.advanceTimersByTimeAsync(12_500);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('armed sweep stopped')),
      ).toBe(true),
    );
    expect(screen.getByText('Stop & Sweep Back')).toBeTruthy(); // disarmed — ready for a manual press
  });

  it('shows the LP band while the session holds it, and posts a feed note when price drifts out', async () => {
    const addr = `0x${'b'.repeat(40)}` as `0x${string}`;
    const range = { tickLower: -60000, tickUpper: -59400, poolTick: -59700, baseIsToken0: false };
    const info: SessionInfoShape = {
      address: addr,
      usdc: 10n ** 18n,
      base: 0n,
      quoteBal: 2_010_000n, // $2.01 cash
      tokenId: 45n,
      lpStaked: false,
      range,
      lpValue: { base: 158_400n, quote: 49_700_000n, totalQuote: 99.6 },
    };
    sessionState = { ...baseSession, active: true, address: addr, info };
    const { rerender } = render(<AgentPage />);
    // Two "Liquidity range" labels now: the mandate's chips row + the console fact row.
    expect(screen.getAllByText('Liquidity range').length).toBe(2);
    expect(screen.getByText('in range · earning')).toBeTruthy();
    // The budget cell counts the LP's live worth, not just loose cash.
    expect(screen.getByText('≈ $101.61 total')).toBeTruthy();
    expect(screen.getByText('$2.01 cash · ≈$99.60 in the LP')).toBeTruthy();
    expect(baseChat.appendLocalNote).not.toHaveBeenCalled(); // first read primes silently

    // The pool tick leaves the band → badge flips and exactly one warning hits the feed.
    sessionState = { ...sessionState, info: { ...info, range: { ...range, poolTick: -59100 } } };
    rerender(<AgentPage />);
    await vi.waitFor(() => expect(screen.getByText('out of range')).toBeTruthy());
    const notes = (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(notes.filter((n) => n.includes('OUTSIDE your liquidity range')).length).toBe(1);

    // And one recovery note when it returns.
    sessionState = { ...sessionState, info: { ...info, range: { ...range, poolTick: -59500 } } };
    rerender(<AgentPage />);
    await vi.waitFor(() =>
      expect(
        (baseChat.appendLocalNote as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes('back INSIDE your liquidity range')),
      ).toBe(true),
    );
  });
});
