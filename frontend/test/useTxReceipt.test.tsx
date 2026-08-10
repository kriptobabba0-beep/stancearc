import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// useTxReceipt is the SHARED receipt-wait wrapper every v2 write hook (+ the on-ramp mint panel) uses
// instead of calling wagmi's useWaitForTransactionReceipt directly. The LIVE bug was: a confirmed tx
// whose `eth_getTransactionReceipt` is slow on Arc's RPC left the UI spinner stuck "forever" because:
//   • viem's waitForTransactionReceipt rejects on `timeout` (or after retryCount blocks), BUT
//   • the global QueryClient default is `retry: 2`, so react-query RE-RAN the receipt query twice more,
//     each restarting the full 120s viem timeout — so `isError` only flips true after ~3×120s ≈ 6 min.
// The fix: this hook forces `retry: false` on the receipt query so a timeout/error becomes a TERMINAL
// `isError` IMMEDIATELY (one ~120s window, not three), and forwards a finite `timeout`. The write hooks'
// existing isError handling (useTxToast error branch + the panel's awaitingReceipt clear) then fires
// promptly, re-enabling the UI and surfacing "minted — refresh shortly" instead of an infinite spinner.

// Capture exactly what the underlying wagmi hook is called with.
const waitArgs = vi.hoisted(() => ({ current: undefined as Record<string, unknown> | undefined }));
const waitReturn = vi.hoisted(() => ({
  current: { isLoading: true, isSuccess: false, isError: false, data: undefined } as Record<string, unknown>,
}));

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useWaitForTransactionReceipt: (args: Record<string, unknown>) => {
    waitArgs.current = args;
    return waitReturn.current;
  },
}));

import { useTxReceipt, TX_RECEIPT_TIMEOUT_MS } from '@/hooks/useTxToast';

// lib/chain (imported for ARC_CHAIN_ID, which pins reads to Arc) reads NEXT_PUBLIC_* at load and
// hard-fails without them. Stub the env so the real chain module loads with its real chain id.
vi.mock('@/lib/env', () => ({
  ENV: {
    CHAIN_ID: 5042002,
    RPC_HTTP: 'https://rpc.testnet.arc.network',
    RPC_WS: 'wss://rpc.testnet.arc.network',
    EXPLORER_URL: 'https://explorer.testnet.arc.network',
    MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
}));


beforeEach(() => {
  waitArgs.current = undefined;
  waitReturn.current = { isLoading: true, isSuccess: false, isError: false, data: undefined };
});
afterEach(cleanup);

describe('useTxReceipt (shared receipt-wait wrapper)', () => {
  const HASH = '0xabc' as `0x${string}`;

  it('forwards the hash to the underlying receipt query', () => {
    renderHook(() => useTxReceipt(HASH));
    expect(waitArgs.current?.hash).toBe(HASH);
  });

  it('applies the finite 120s receipt timeout so the query cannot hang forever', () => {
    renderHook(() => useTxReceipt(HASH));
    expect(waitArgs.current?.timeout).toBe(TX_RECEIPT_TIMEOUT_MS);
    expect(TX_RECEIPT_TIMEOUT_MS).toBe(120_000);
  });

  it('ROOT-CAUSE FIX: disables react-query retry so a timeout/error is a TERMINAL isError immediately', () => {
    // Without retry:false the global QueryClient default (retry:2) re-runs the 120s timeout twice more,
    // so the spinner sticks for ~6 minutes on a slow-receipt RPC. retry:false makes the first timeout
    // the terminal state.
    renderHook(() => useTxReceipt(HASH));
    const query = waitArgs.current?.query as { retry?: unknown } | undefined;
    expect(query?.retry).toBe(false);
  });

  it('passes through the underlying query state (isSuccess / isError / data / isLoading)', () => {
    waitReturn.current = {
      isLoading: false,
      isSuccess: true,
      isError: false,
      data: { status: 'success' },
    };
    const { result } = renderHook(() => useTxReceipt(HASH));
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect((result.current.data as { status?: string }).status).toBe('success');
  });

  it('merges caller-supplied options (chainId + extra query flags) without dropping retry:false', () => {
    renderHook(() => useTxReceipt(HASH, { chainId: 5042002, query: { enabled: true } }));
    expect(waitArgs.current?.chainId).toBe(5042002);
    const query = waitArgs.current?.query as { retry?: unknown; enabled?: unknown };
    expect(query.retry).toBe(false);
    expect(query.enabled).toBe(true);
  });
});
