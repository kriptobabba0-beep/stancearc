// test/useChainTime.test.tsx
//
// Tests that useChainTime:
//   1. Samples block.timestamp on mount and computes the initial offset.
//   2. Re-samples after RESAMPLE_INTERVAL_MS (45 s) so the offset is updated — not frozen at
//      the first sample. This is the regression guard against the old once-only-sample behaviour.
//   3. Falls back gracefully (offset=0) when the RPC call throws.
//   4. Cleans up the resample interval on unmount (no timer leaks).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Fixed reference for "now" so fake-timer advances are deterministic.
const FAKE_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

// block.timestamp returned by the mock RPC client.
const BLOCK_TS_1 = 1_700_000_010n; // first sample: 10 s ahead of local clock
const BLOCK_TS_2 = 1_700_000_070n; // second sample after 60 s of fake-clock advance

// A STABLE client object — useChainTime's useEffect has [client] as a dependency; if the
// wagmi mock returns a new object each render the effect re-fires on every re-render, causing
// extra getBlock calls. Return the same reference across renders to isolate the re-sample logic.
const getBlock = vi.fn();
const stableClient = { getBlock };

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  usePublicClient: () => stableClient,
}));

// RESAMPLE_INTERVAL_MS — mirrors the value in useChainTime.ts (45_000).
const RESAMPLE_INTERVAL_MS = 45_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FAKE_NOW_MS);
  getBlock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

import { useChainTime } from '@/hooks/useChainTime';

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


describe('useChainTime — periodic re-sampling', () => {
  it('samples block.timestamp immediately on mount and sets the offset', async () => {
    getBlock.mockResolvedValue({ timestamp: BLOCK_TS_1 });

    const { result } = renderHook(() => useChainTime());

    // Flush the leading async sample.
    await act(async () => {
      await Promise.resolve();
    });

    // offsetMs = Number(BLOCK_TS_1) * 1000 - FAKE_NOW_MS = 1_700_000_010_000 - 1_700_000_000_000 = 10_000
    expect(result.current.offsetMs).toBe(10_000);
    // At least one call was made (leading sample); no interval has fired yet.
    expect(getBlock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('re-samples after RESAMPLE_INTERVAL_MS and updates the offset (not frozen at the first value)', async () => {
    // First call returns BLOCK_TS_1; subsequent calls return BLOCK_TS_2.
    getBlock.mockResolvedValueOnce({ timestamp: BLOCK_TS_1 }).mockResolvedValue({ timestamp: BLOCK_TS_2 });

    const { result } = renderHook(() => useChainTime());

    // Flush the leading sample.
    await act(async () => {
      await Promise.resolve();
    });
    const firstOffset = result.current.offsetMs;
    expect(firstOffset).toBe(10_000); // 10 s ahead

    // Advance fake time by RESAMPLE_INTERVAL_MS to fire the interval callback.
    await act(async () => {
      vi.advanceTimersByTime(RESAMPLE_INTERVAL_MS);
      await Promise.resolve(); // flush the async getBlock call
    });

    // After re-sample the offset must have changed — it is NOT frozen at the first sample.
    // The fake clock advanced by 45 s; BLOCK_TS_2 is 60 s beyond BLOCK_TS_1.
    // offsetMs2 = 1_700_000_070_000 - (1_700_000_000_000 + 45_000) = 25_000 ≠ 10_000
    expect(result.current.offsetMs).not.toBe(firstOffset);
    // At least 2 getBlock calls: the leading sample + 1 interval re-sample.
    expect(getBlock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to offset=0 when the RPC call throws (local clock fallback)', async () => {
    getBlock.mockRejectedValue(new Error('RPC error'));

    const { result } = renderHook(() => useChainTime());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.offsetMs).toBe(0);
  });

  it('clears the resample interval on unmount (no leak)', async () => {
    getBlock.mockResolvedValue({ timestamp: BLOCK_TS_1 });
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    const { unmount } = renderHook(() => useChainTime());

    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    // clearInterval should have been called (resample interval + tick interval = 2 intervals).
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('returns now in seconds derived from the current clock plus offsetMs', async () => {
    getBlock.mockResolvedValue({ timestamp: BLOCK_TS_1 });

    const { result } = renderHook(() => useChainTime());

    await act(async () => {
      await Promise.resolve();
    });

    // now = BigInt(Math.floor((FAKE_NOW_MS + 10_000) / 1000)) = BigInt(1_700_000_010)
    expect(result.current.now).toBe(BigInt(Math.floor((FAKE_NOW_MS + 10_000) / 1000)));
  });
});
