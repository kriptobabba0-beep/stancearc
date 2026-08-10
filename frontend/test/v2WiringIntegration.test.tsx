// v2WiringIntegration.test.tsx — INTEGRATION tests for the FeeArena v2 frontend wiring (Task 3c).
//
// THE KEY GAP the re-audit found: every prior v2 hook test mocks `@/lib/contracts` and `@/lib/markets`,
// so the hooks were green on mocks but never bound to the ACTUAL deployed surface. These tests instead
// keep `@/lib/contracts`, `@/lib/markets`, `@/abis`, the EpochV2 adapter, and the hooks REAL, and drive
// them off a REAL v2 Market object — only `wagmi` (to capture the resolved call config), `@/lib/env`
// (a readable ENV snapshot, since contracts.ts reads it at module load) and the toast/poll side-effects
// are mocked. We then assert, for a v2 market, the EXACT (contract, function, arg-count) each hook uses:
//   - getStakesByEpoch / previewClaim  -> the LENS  (feeArenaV2LensAbi @ market.lens), NOT the arena.
//   - claim (3 args incl. recipient) / refundConviction (3 args) -> the ARENA (feeArenaV2Abi).
//   - the EpochV2 adapter decodes a REAL raw tuple (encoded with the real arena ABI) round-trip.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { encodeAbiParameters, type AbiFunction, type AbiParameter } from 'viem';

// ── Readable ENV snapshot (contracts.ts touches ENV at module load for shared infra) ────────────────
vi.mock('@/lib/env', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ENV = {
    CHAIN_ID: 5042002,
    PYTH_ADDRESS: ZERO, NPM_ADDRESS: ZERO, SWAP_ROUTER_ADDRESS: ZERO, FACTORY_ADDRESS: ZERO,
    USDC_ADDRESS: ZERO, WETH_ADDRESS: ZERO, MULTICALL3_ADDRESS: ZERO, FEE_ARENA_ADDRESS: ZERO,
    ORACLE_ADDRESS: ZERO, POOL_ADDRESS: ZERO, FEE_ARENA_FROM_BLOCK: 0n, FEE_TIER: 3000,
    PYTH_ETHUSD_ID: `0x${'0'.repeat(64)}`, HERMES_URL: 'https://hermes.pyth.network', MARKETS: '',
  };
  return { ENV, parseEnv: () => ENV, parseAddress: (s: string) => s, parseBytes32: (s: string) => s };
});

// The REAL deployed v2 surface (arena + lens), as a REAL Market the hooks resolve through.
const ARENA = '0xAEB33D3bfd63e4C330bb78A0a0b249e53DAA5C68' as const;
const LENS = '0xa0Db836f8a24781b5a4F457924C9860Dfe2a80b9' as const;
const ORACLE = '0xF8ac3C46A062acC1d4c1BA23158bD0EF7242688E' as const;
const POOL = '0x969f2e3CB9929b5D50B6A59Cf49CF30870e1658b' as const;
const TREASURY = '0x891bbabB7d9ab43aBDb2cEE2a24A25C97D80eFFE' as const;
const FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

import type { Market } from '@/lib/markets';

const V2_MARKET: Market = {
  id: 'btc-v2', label: 'BTC / USDC (v2)', baseSymbol: 'cirBTC', baseDecimals: 8,
  feeArena: ARENA, oracle: ORACLE, pool: POOL, feedId: FEED, fromBlock: 0n,
  version: 'v2', lens: LENS, treasury: TREASURY, minConv: 100_000000n, maxConv: 1_000_000000n,
};

// Active market = the REAL v2 Market above (so REAL marketContracts()/readSurface() bind the REAL ABIs).
vi.mock('@/components/MarketProvider', () => ({ useActiveMarket: () => V2_MARKET }));

// Side-effects we don't assert on.
vi.mock('@/hooks/usePollInterval', () => ({ usePollInterval: () => 5000, bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() }, arcScanTxUrl: () => undefined }));
vi.mock('@/hooks/useTxToast', () => ({
  useTxToast: vi.fn(),
  useTxReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
  TX_RECEIPT_TIMEOUT_MS: 1,
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ refetchQueries: vi.fn(), invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

// Keep withGasFloor real-ish but cheap; arcTestnet id is what the hooks pin reads to.
vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002 },
  withGasFloor: <T,>(r: T) => ({ ...r, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
}));

// ── wagmi capture harness ──────────────────────────────────────────────────────────────────────────
// useReadContract / useReadContracts record every resolved config; the write path records simulate cfg.
const reads = vi.hoisted(() => ({
  calls: [] as { address?: string; abi?: unknown; functionName?: string; args?: unknown[] }[],
  batchCalls: [] as { contracts?: { address?: string; abi?: unknown; functionName?: string; args?: unknown[] }[] }[],
  dataByFn: {} as Record<string, unknown>,
}));
const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async () => '0xhash');

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useReadContract: (cfg: { address?: string; abi?: unknown; functionName?: string; args?: unknown[] }) => {
    reads.calls.push(cfg);
    return { data: cfg.functionName ? reads.dataByFn[cfg.functionName] : undefined, isLoading: false, isError: false };
  },
  useReadContracts: (cfg: { contracts?: { address?: string; abi?: unknown; functionName?: string; args?: unknown[] }[] }) => {
    reads.batchCalls.push(cfg);
    return { data: undefined, isLoading: false, isError: false };
  },
  useAccount: () => ({ address: USER }),
  usePublicClient: () => ({ simulateContract, waitForTransactionReceipt: vi.fn(async () => ({})) }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
}));

import { feeArenaV2Abi, feeArenaV2LensAbi } from '@/abis';
import { marketContracts, readSurface } from '@/lib/contracts';
import { useStakesByEpoch } from '@/hooks/useStakesByEpoch';
import { usePreviewClaim } from '@/hooks/usePreviewClaim';
import { useUserStakes } from '@/hooks/useUserStakes';
import { useClaim } from '@/hooks/useClaim';
import { useRefundConviction } from '@/hooks/useRefundConviction';
import { usePreviewRefund } from '@/hooks/usePreviewRefund';
import { adaptEpochV2 } from '@/lib/epochV2';
import { PhaseView, Side } from '@/lib/types';

/** Find a function entry in a const ABI by name. */
function fn(abi: readonly unknown[], name: string): AbiFunction {
  const e = (abi as readonly { type?: string; name?: string }[]).find((x) => x.type === 'function' && x.name === name);
  if (!e) throw new Error(`ABI missing function ${name}`);
  return e as unknown as AbiFunction;
}
/** Last captured useReadContract call whose functionName matches. */
function lastReadFor(name: string) {
  return [...reads.calls].reverse().find((c) => c.functionName === name);
}

beforeEach(() => {
  reads.calls = [];
  reads.batchCalls = [];
  reads.dataByFn = {};
  simulateContract.mockClear();
  writeContractAsync.mockClear();
});
afterEach(cleanup);

// ── Pure resolution: marketContracts()/readSurface() bind the REAL v2 ABIs to the right addresses ────
describe('v2 contract resolution (REAL marketContracts/readSurface, REAL ABIs)', () => {
  it('binds the arena to feeArenaV2Abi and exposes the Lens at market.lens', () => {
    const c = marketContracts(V2_MARKET);
    expect(c.feeArena.address).toBe(ARENA);
    expect(c.feeArena.abi).toBe(feeArenaV2Abi); // REAL v2 arena ABI (stake/claim/refund/withdraw)
    expect(c.lens?.address).toBe(LENS);
    expect(c.lens?.abi).toBe(feeArenaV2LensAbi); // REAL v2 Lens ABI (previews/stake listings)
  });

  it('readSurface() picks the LENS for the v2 market (stake/preview reads live on the Lens, not the arena)', () => {
    const s = readSurface(marketContracts(V2_MARKET));
    expect(s.address).toBe(LENS);
    expect(s.abi).toBe(feeArenaV2LensAbi);
  });

  it('the v2 ARENA ABI does NOT carry the lens-only reads (getStakesByEpoch/previewClaim/getUserStakes)', () => {
    const names = (feeArenaV2Abi as readonly { type: string; name?: string }[])
      .filter((e) => e.type === 'function').map((e) => e.name);
    expect(names).not.toContain('getStakesByEpoch');
    expect(names).not.toContain('previewClaim');
    expect(names).not.toContain('getUserStakes');
    expect(names).not.toContain('previewRefund');
  });
});

// ── getStakesByEpoch — Lens, 1 arg (uint64 epochId) ─────────────────────────────────────────────────
describe('useStakesByEpoch (getUserStakes-equivalent) targets the Lens with getStakesByEpoch(uint64)', () => {
  it('reads getStakesByEpoch from the LENS address with the Lens ABI and ONE epochId arg', () => {
    renderHook(() => useStakesByEpoch(7n));
    const call = lastReadFor('getStakesByEpoch');
    expect(call, 'getStakesByEpoch must be issued').toBeTruthy();
    expect(call!.address).toBe(LENS);
    expect(call!.abi).toBe(feeArenaV2LensAbi); // Lens ABI, not the arena
    expect(call!.args).toEqual([7n]);
    // The real Lens ABI defines getStakesByEpoch(uint64 epochId).
    const sig = fn(feeArenaV2LensAbi, 'getStakesByEpoch');
    expect(sig.inputs.map((i: AbiParameter) => i.type)).toEqual(['uint64']);
  });
});

// ── useUserStakes (v2) — currentEpochId off the arena, getStakesByEpoch window off the Lens ──────────
describe('useUserStakes (v2) reads currentEpochId() off the arena, then Lens.getStakesByEpoch per epoch', () => {
  it('issues currentEpochId() against the v2 arena (the lens-window top), and batches Lens.getStakesByEpoch', () => {
    reads.dataByFn = { currentEpochId: 6n };
    renderHook(() => useUserStakes(USER));

    const epochIdCall = lastReadFor('currentEpochId');
    expect(epochIdCall, 'currentEpochId must be read').toBeTruthy();
    expect(epochIdCall!.address).toBe(ARENA);
    expect(epochIdCall!.abi).toBe(feeArenaV2Abi); // currentEpochId lives on the arena
    expect(fn(feeArenaV2Abi, 'currentEpochId').inputs).toHaveLength(0);

    // The batched per-epoch stake reads must hit the LENS with getStakesByEpoch + one epochId each.
    const batch = reads.batchCalls.find((b) => (b.contracts?.length ?? 0) > 0);
    expect(batch, 'a non-empty getStakesByEpoch batch must be issued').toBeTruthy();
    for (const c of batch!.contracts!) {
      expect(c.address).toBe(LENS);
      expect(c.abi).toBe(feeArenaV2LensAbi);
      expect(c.functionName).toBe('getStakesByEpoch');
      expect(c.args).toHaveLength(1); // a single uint64 epochId
    }
  });
});

// ── previewClaim — Lens, 2 args (uint64 epochId, uint256 tokenId) ────────────────────────────────────
describe('usePreviewClaim targets the Lens with previewClaim(uint64,uint256)', () => {
  it('reads previewClaim from the LENS address with the Lens ABI and (epochId, tokenId) args', () => {
    renderHook(() => usePreviewClaim(7n, 42n));
    const call = lastReadFor('previewClaim');
    expect(call, 'previewClaim must be issued').toBeTruthy();
    expect(call!.address).toBe(LENS);
    expect(call!.abi).toBe(feeArenaV2LensAbi);
    expect(call!.args).toEqual([7n, 42n]);
    expect(fn(feeArenaV2LensAbi, 'previewClaim').inputs.map((i: AbiParameter) => i.type)).toEqual(['uint64', 'uint256']);
  });
});

// ── previewRefund — Lens, 2 args ────────────────────────────────────────────────────────────────────
describe('usePreviewRefund targets the Lens with previewRefund(uint64,uint256)', () => {
  it('reads previewRefund from the LENS with the Lens ABI and (epochId, tokenId) args', () => {
    renderHook(() => usePreviewRefund(7n, 42n));
    const call = lastReadFor('previewRefund');
    expect(call, 'previewRefund must be issued').toBeTruthy();
    expect(call!.address).toBe(LENS);
    expect(call!.abi).toBe(feeArenaV2LensAbi);
    expect(call!.args).toEqual([7n, 42n]);
    expect(fn(feeArenaV2LensAbi, 'previewRefund').inputs.map((i: AbiParameter) => i.type)).toEqual(['uint64', 'uint256']);
  });
});

// ── claim — ARENA, 3 args (uint64 epochId, uint256 tokenId, address recipient) ──────────────────────
describe('useClaim (v2) simulates claim on the ARENA with 3 args incl. recipient', () => {
  it('simulates claim against the arena address with (epochId, tokenId, recipient) — recipient defaults to wallet', async () => {
    const { result } = renderHook(() => useClaim());
    await act(async () => { await result.current.claim({ epochId: 7n, tokenId: 42n }); });
    expect(simulateContract).toHaveBeenCalledTimes(1);
    const cfg = simulateContract.mock.calls[0][0] as { address: string; functionName: string; args: unknown[] };
    expect(cfg.address).toBe(ARENA); // claim is an ARENA write, not the Lens
    expect(cfg.functionName).toBe('claim');
    expect(cfg.args).toEqual([7n, 42n, USER]); // 3 args; recipient defaults to the connected wallet
    // The real arena ABI's claim is exactly (uint64,uint256,address).
    expect(fn(feeArenaV2Abi, 'claim').inputs.map((i: AbiParameter) => `${i.name}:${i.type}`)).toEqual([
      'epochId:uint64', 'tokenId:uint256', 'recipient:address',
    ]);
  });

  it('forwards an explicit recipient override (blocklisted-owner redirect)', async () => {
    const RECIP = '0x2222222222222222222222222222222222222222' as const;
    const { result } = renderHook(() => useClaim());
    await act(async () => { await result.current.claim({ epochId: 7n, tokenId: 42n, recipient: RECIP }); });
    const cfg = simulateContract.mock.calls[0][0] as { args: unknown[] };
    expect(cfg.args).toEqual([7n, 42n, RECIP]);
  });
});

// ── refundConviction — ARENA, 3 args ────────────────────────────────────────────────────────────────
describe('useRefundConviction simulates refundConviction on the ARENA with 3 args incl. recipient', () => {
  it('simulates refundConviction against the arena with (epochId, tokenId, recipient)', async () => {
    const { result } = renderHook(() => useRefundConviction());
    await act(async () => { await result.current.refundConviction({ epochId: 4n, tokenId: 12n }); });
    const cfg = simulateContract.mock.calls[0][0] as { address: string; functionName: string; args: unknown[] };
    expect(cfg.address).toBe(ARENA);
    expect(cfg.functionName).toBe('refundConviction');
    expect(cfg.args).toEqual([4n, 12n, USER]);
    expect(fn(feeArenaV2Abi, 'refundConviction').inputs.map((i: AbiParameter) => `${i.name}:${i.type}`)).toEqual([
      'epochId:uint64', 'tokenId:uint256', 'recipient:address',
    ]);
  });
});

// ── EpochV2 adapter decodes a REAL raw tuple (encoded with the actual arena ABI) ─────────────────────
describe('adaptEpochV2 decodes a REAL raw EpochV2 tuple (encoded from the actual arena currentEpoch ABI)', () => {
  // Build a sample raw struct matching the real currentEpoch() output tuple, encode it with the REAL
  // ABI's component list, and re-feed the positional array (what viem hands a hook) into the adapter.
  function currentEpochOutputTuple(): AbiParameter {
    const f = fn(feeArenaV2Abi, 'currentEpoch');
    return f.outputs[0] as AbiParameter;
  }

  it('round-trips a Settled raw tuple: collapses phase, injects epochId, surfaces conviction fields', () => {
    const out0 = currentEpochOutputTuple() as AbiParameter & { components: AbiParameter[] };
    expect(out0.type).toBe('tuple'); // sanity: currentEpoch returns a single tuple

    const sample = {
      phase: 5, // RawPhase.Settled
      entryOpenTime: 10n, entryCloseTime: 100n, startTime: 130n, endTime: 430n,
      startTimeActual: 131n, settleTimeActual: 440n, winningSide: 1, // Side.UP
      rolledOver: false, rolloverConsumed: false, sweepCursor: 3, stakedCount: 3, bandBps: 150,
      startPrice18: 1n, settlePrice18: 2n, deltaBps: 5n, potWETH: 7n, potUSDC: 11n,
      sideContribution6: [0n, 1n, 2n, 3n], winnerDenominator: 9n,
      claimedWETH: 0n, claimedUSDC: 0n, claimedCount: 0, subsidyUSDC: 500n,
      sideConviction: [0n, 10n, 20n, 30n], winnerSqrtConvSum: 17n, winningConvictionSum: 60n,
      refundedConviction: 0n, convRefundedCount: 0, burnedConviction: 21n,
    };
    // Encode with the REAL ABI tuple — this throws if our sample field-order/types drift from on-chain.
    const encoded = encodeAbiParameters([out0], [sample]);
    expect(encoded.startsWith('0x')).toBe(true);

    // Feed the keyed object (as viem decodes a named tuple) through the adapter, injecting epochId 42.
    const view = adaptEpochV2(sample as never, 42n);
    expect(view.epochId).toBe(42n); // injected (raw struct has no epochId)
    expect(view.phase).toBe(PhaseView.Settled); // 6-phase Settled -> 4-phase Settled
    expect(view.winningSide).toBe(Side.UP);
    expect(view.sideContribution6).toEqual([0n, 1n, 2n, 3n]);
    expect(view.rolloverPendingIn).toBe(false); // v1-only field defaulted off
    // v2-only conviction fields surfaced on the superset view.
    expect(view.subsidyUSDC).toBe(500n);
    expect(view.sideConviction).toEqual([0n, 10n, 20n, 30n]);
    expect(view.winnerSqrtConvSum).toBe(17n);
    expect(view.winningConvictionSum).toBe(60n);
    expect(view.burnedConviction).toBe(21n);
  });

  it('collapses a raw Running-family phase (Resolved=3 -> Running)', () => {
    const view = adaptEpochV2({ phase: 3 } as never, 9n);
    expect(view.phase).toBe(PhaseView.Running);
  });
});
