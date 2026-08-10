// versionAwareReads.test.tsx — the v2 read-layer wiring: useCurrentEpoch / useEpoch run the
// EpochV2 adapter (raw 6-phase + injected epochId) for v2 markets and pass EpochView through for v1;
// useUserStakes uses the Lens getStakesByEpoch window (owner-filtered) for v2 and arena.getUserStakes
// for v1. wagmi is mocked so useReadContract returns data keyed by functionName.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { PhaseView, Side, type StakeView } from '@/lib/types';
import { RawPhase, type RawEpochV2 } from '@/lib/epochV2';

const ARENA = '0x00000000000000000000000000000000000aReNa' as `0x${string}`;
const LENS = '0x000000000000000000000000000000000000LeNs' as `0x${string}`;
const USER = '0x1111111111111111111111111111111111111111' as `0x${string}`;
const OTHER = '0x2222222222222222222222222222222222222222' as `0x${string}`;

// ── Per-test market version + contract handles ───────────────────────────────────────
const state = vi.hoisted(() => ({
  v2: false as boolean,
}));

vi.mock('@/lib/markets', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, isV2Market: () => state.v2 };
});

vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({ id: state.v2 ? 'v2' : 'v1', version: state.v2 ? 'v2' : 'v1' }),
}));

vi.mock('@/lib/contracts', () => {
  const arena = '0x00000000000000000000000000000000000aReNa';
  const lensAddr = '0x000000000000000000000000000000000000LeNs';
  const feeArenaV1 = { address: arena, abi: [{ type: 'function', name: 'getUserStakes' }] };
  const feeArenaV2 = { address: arena, abi: [{ type: 'function', name: 'currentEpochId' }] };
  const lens = { address: lensAddr, abi: [{ type: 'function', name: 'getStakesByEpoch' }] };
  const marketContracts = () =>
    state.v2 ? { feeArena: feeArenaV2, oracle: {}, pool: {}, lens } : { feeArena: feeArenaV1, oracle: {}, pool: {} };
  return {
    useMarketContracts: marketContracts,
    useReadSurface: () => (state.v2 ? lens : feeArenaV1),
    readSurface: (c: { lens?: unknown; feeArena: unknown }) => c.lens ?? c.feeArena,
  };
});

vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 5042002 } }));
vi.mock('@/hooks/usePollInterval', () => ({ usePollInterval: () => 5000 }));

// ── wagmi: useReadContract keyed by functionName; useReadContracts returns the staged batch ──────
const reads = vi.hoisted(() => ({ map: {} as Record<string, unknown>, batch: undefined as unknown }));

vi.mock('wagmi', () => ({
  useReadContract: (cfg: { functionName: string }) => ({
    data: reads.map[cfg.functionName],
    isLoading: false,
    isError: false,
  }),
  useReadContracts: () => ({ data: reads.batch, isLoading: false, isError: false }),
}));

import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useEpoch } from '@/hooks/useEpoch';
import { useUserStakes } from '@/hooks/useUserStakes';

function rawEpoch(overrides: Partial<RawEpochV2> = {}): RawEpochV2 {
  return {
    phase: RawPhase.Settled,
    entryOpenTime: 10n, entryCloseTime: 100n, startTime: 130n, endTime: 430n,
    startTimeActual: 131n, settleTimeActual: 440n, winningSide: Side.UP, rolledOver: false,
    rolloverConsumed: false, sweepCursor: 3, stakedCount: 3, bandBps: 150,
    startPrice18: 1n, settlePrice18: 2n, deltaBps: 5n, potWETH: 7n, potUSDC: 11n,
    sideContribution6: [0n, 1n, 2n, 3n] as const, winnerDenominator: 9n,
    claimedWETH: 0n, claimedUSDC: 0n, claimedCount: 0, subsidyUSDC: 500n,
    sideConviction: [0n, 10n, 20n, 30n] as const, winnerSqrtConvSum: 0n, winningConvictionSum: 0n,
    refundedConviction: 0n, convRefundedCount: 0, burnedConviction: 0n,
    ...overrides,
  };
}

function stake(o: Partial<StakeView>): StakeView {
  return {
    tokenId: 1n, owner: USER, epochId: 5n, side: Side.UP, swept: false, claimed: false,
    unstaked: false, feeWETH: 0n, feeUSDC: 0n, contribution6: 0n, ...o,
  };
}

beforeEach(() => {
  state.v2 = false;
  reads.map = {};
  reads.batch = undefined;
});
afterEach(cleanup);

describe('useCurrentEpoch — version-aware', () => {
  it('v1: passes the collapsed EpochView through unchanged (no adapter)', () => {
    state.v2 = false;
    const v1View = { epochId: 7n, phase: PhaseView.Running, sideContribution6: [0n, 0n, 0n, 0n] };
    reads.map = { currentEpoch: v1View };
    const { result } = renderHook(() => useCurrentEpoch());
    expect(result.current.data).toBe(v1View); // same reference -> no remap
  });

  it('v2: adapts the RAW EpochV2 (collapse Settled, inject currentEpochId)', () => {
    state.v2 = true;
    reads.map = { currentEpoch: rawEpoch({ phase: RawPhase.Settled }), currentEpochId: 42n };
    const { result } = renderHook(() => useCurrentEpoch());
    expect(result.current.data?.epochId).toBe(42n); // injected from currentEpochId()
    expect(result.current.data?.phase).toBe(PhaseView.Settled); // 6-phase -> 4-phase collapse
    expect(result.current.data?.sideContribution6).toEqual([0n, 1n, 2n, 3n]);
    expect(result.current.data?.rolloverPendingIn).toBe(false); // v1-only field defaulted
  });

  it('v2: collapses a raw Running-family phase (Resolved -> Running)', () => {
    state.v2 = true;
    reads.map = { currentEpoch: rawEpoch({ phase: RawPhase.Resolved }), currentEpochId: 9n };
    const { result } = renderHook(() => useCurrentEpoch());
    expect(result.current.data?.phase).toBe(PhaseView.Running);
  });
});

describe('useEpoch — version-aware', () => {
  it('v1: passes the EpochView through for getEpoch(id)', () => {
    state.v2 = false;
    const v1View = { epochId: 3n, phase: PhaseView.Settled };
    reads.map = { getEpoch: v1View };
    const { result } = renderHook(() => useEpoch(3n));
    expect(result.current.data).toBe(v1View);
  });

  it('v2: adapts getEpoch(id), injecting the QUERIED epochId', () => {
    state.v2 = true;
    reads.map = { getEpoch: rawEpoch({ phase: RawPhase.EntryOpen }) };
    const { result } = renderHook(() => useEpoch(11n));
    expect(result.current.data?.epochId).toBe(11n); // injected from the arg, not currentEpochId
    expect(result.current.data?.phase).toBe(PhaseView.EntryOpen);
  });
});

describe('useUserStakes — version-aware', () => {
  it('v1: reads arena.getUserStakes(addr) and returns the StakeView[] verbatim', () => {
    state.v2 = false;
    const rows = [stake({ tokenId: 1n }), stake({ tokenId: 2n })];
    reads.map = { getUserStakes: rows };
    const { result } = renderHook(() => useUserStakes(USER));
    expect(result.current.data).toBe(rows);
  });

  it('v2: scans Lens.getStakesByEpoch over recent epochs and keeps ONLY the connected owner rows', () => {
    state.v2 = true;
    reads.map = { currentEpochId: 6n };
    // Two epochs' worth of stakes, mixed owners; only USER rows survive the filter.
    reads.batch = [
      { status: 'success', result: [stake({ tokenId: 10n, owner: USER, epochId: 6n }), stake({ tokenId: 11n, owner: OTHER, epochId: 6n })] },
      { status: 'success', result: [stake({ tokenId: 20n, owner: USER, epochId: 5n })] },
    ];
    const { result } = renderHook(() => useUserStakes(USER));
    const data = result.current.data;
    expect(data?.map((s) => s.tokenId)).toEqual([10n, 20n]);
    expect(data?.every((s) => s.owner === USER)).toBe(true);
  });

  it('v2: tolerates a reverted epoch read in the batch (skips it, keeps the rest)', () => {
    state.v2 = true;
    reads.map = { currentEpochId: 6n };
    reads.batch = [
      { status: 'failure', error: new Error('revert') },
      { status: 'success', result: [stake({ tokenId: 20n, owner: USER, epochId: 5n })] },
    ];
    const { result } = renderHook(() => useUserStakes(USER));
    expect(result.current.data?.map((s) => s.tokenId)).toEqual([20n]);
  });

  it('v2: returns undefined (not an empty list) before the batch resolves', () => {
    state.v2 = true;
    reads.map = { currentEpochId: 6n };
    reads.batch = undefined;
    const { result } = renderHook(() => useUserStakes(USER));
    expect(result.current.data).toBeUndefined();
  });
});
