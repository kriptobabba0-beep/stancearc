import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// useStakeWithConviction (FeeArena v2) does a conviction stake in up to THREE txs:
//   1. If USDC allowance(user, arena) < conviction -> approve(arena, conviction).
//   2. If !NPM.isApprovedForAll(user, arena) -> NPM.setApprovalForAll(arena, true). REQUIRED because the
//      v2 arena PULLS the LP NFT inside stakeWithConviction (NPM.safeTransferFrom(user -> arena)), which
//      reverts "ERC721: transfer caller is not owner nor approved" unless the arena is an approved operator.
//   3. stakeWithConviction(tokenId, side, conviction) on the v2 arena (simulate-then-write + gas floor).
// We verify: bounds validation (minConv/maxConv), the approve(s)-then-stake calldata + ORDERING, both
// short-circuits (skip USDC approve when allowance covers it; skip NFT approve when already operator),
// that the NFT approve is AWAITED before the stake, and that every write carries the Arc 20-gwei gas
// floor. Mirrors useStakeWithSide.test.tsx + useTokenApproval.

const ARENA = '0x00000000000000000000000000000000feearena2' as const;
const USDC = '0x3600000000000000000000000000000000000000' as const;
const NPM = '0x000000000000000000000000000000000000000c' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

vi.mock('@/lib/contracts', () => ({
  usdc: { address: '0x3600000000000000000000000000000000000000' as const, abi: [{ type: 'function', name: 'approve' }, { type: 'function', name: 'allowance' }] },
  npm: { address: '0x000000000000000000000000000000000000000c' as const, abi: [{ type: 'function', name: 'setApprovalForAll' }, { type: 'function', name: 'isApprovedForAll' }] },
  useMarketContracts: () => ({
    feeArena: { address: '0x00000000000000000000000000000000feearena2' as const, abi: [{ type: 'function', name: 'stakeWithConviction' }] },
  }),
}));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  arcTestnet: { id: 5042002 },
  withGasFloor: <T,>(request: T) => ({
    ...request,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
}));

vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

// Drive the two on-chain reads per-test: USDC allowance + NPM isApprovedForAll.
const allowanceValue = vi.hoisted(() => ({ current: 0n as bigint | undefined }));
const nftApprovedForAllValue = vi.hoisted(() => ({ current: false as boolean | undefined }));
const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => '0xhash' as `0x${string}`);
const waitForTransactionReceipt = vi.fn(async (_cfg: unknown) => ({ status: 'success' }));

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({ simulateContract, waitForTransactionReceipt }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
  // The hook reads BOTH allowance (USDC) and isApprovedForAll (NPM) via useReadContract; key the mock
  // off functionName so each read returns its own per-test value.
  useReadContract: (cfg: { functionName?: string }) =>
    cfg?.functionName === 'isApprovedForAll'
      ? { data: nftApprovedForAllValue.current, isLoading: false }
      : { data: allowanceValue.current, isLoading: false },
}));

const refetchQueries = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries }) }));
const toastMock = vi.hoisted(() => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock, arcScanTxUrl: () => undefined }));

import { useStakeWithConviction } from '@/hooks/useStakeWithConviction';
import { Side } from '@/lib/types';

const BOUNDS = { minConv: 100_000000n, maxConv: 1_000_000000n };

beforeEach(() => {
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  waitForTransactionReceipt.mockClear();
  refetchQueries.mockClear();
  toastMock.loading.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  allowanceValue.current = 0n;
  // Default to "already an operator" so the existing approve/stake-ordering + bounds tests are unaffected
  // by the NFT-approve step; the dedicated NFT-approve tests set this to false explicitly.
  nftApprovedForAllValue.current = true;
});
afterEach(cleanup);

describe('useStakeWithConviction().stake — approve-then-stake', () => {
  it('approves USDC to the arena then stakeWithConviction when allowance is insufficient', async () => {
    allowanceValue.current = 0n; // no allowance -> must approve first
    nftApprovedForAllValue.current = true; // already an operator -> NFT approve skipped here
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 42n, side: Side.UP, conviction: 250_000000n });
    });

    // Two simulate + two writes: USDC approve, then stakeWithConviction (NFT already approved).
    expect(simulateContract).toHaveBeenCalledTimes(2);
    const approveCfg = simulateContract.mock.calls[0][0] as { functionName: string; args: unknown[]; address: string };
    expect(approveCfg.functionName).toBe('approve');
    expect(approveCfg.address).toBe(USDC);
    expect(approveCfg.args).toEqual([ARENA, 250_000000n]); // exact conviction, never MAX

    const stakeCfg = simulateContract.mock.calls[1][0] as { functionName: string; args: unknown[]; address: string; account: string };
    expect(stakeCfg.functionName).toBe('stakeWithConviction');
    expect(stakeCfg.address).toBe(ARENA);
    expect(stakeCfg.account).toBe(USER);
    expect(stakeCfg.args).toEqual([42n, Side.UP, 250_000000n]);

    // Both writes carry the Arc gas floor.
    expect(writeContractAsync).toHaveBeenCalledTimes(2);
    for (const call of writeContractAsync.mock.calls) {
      const wcfg = call[0] as Record<string, unknown>;
      expect(wcfg.maxFeePerGas).toBe(20_000_000_000n);
      expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n);
    }
  });

  it('skips the approve when allowance already covers the conviction (single stake tx)', async () => {
    allowanceValue.current = 1_000_000000n; // covers conviction
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 7n, side: Side.RANGE, conviction: 250_000000n });
    });
    expect(simulateContract).toHaveBeenCalledTimes(1);
    const onlyCfg = simulateContract.mock.calls[0][0] as { functionName: string };
    expect(onlyCfg.functionName).toBe('stakeWithConviction');
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });

  it('refetches active queries after a successful stake', async () => {
    allowanceValue.current = 1_000_000000n;
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 7n, side: Side.UP, conviction: 250_000000n });
    });
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });
});

describe('useStakeWithConviction().stake — NFT operator approval (live-bug fix)', () => {
  it('sends NPM.setApprovalForAll(arena,true) and AWAITS it BEFORE stakeWithConviction when not approved', async () => {
    allowanceValue.current = 1_000_000000n; // USDC already approved -> isolate the NFT-approve step
    nftApprovedForAllValue.current = false; // arena is NOT yet an operator -> must approve the NFT
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 42n, side: Side.UP, conviction: 250_000000n });
    });

    // Two simulate + two writes: setApprovalForAll, then stakeWithConviction (USDC approve skipped).
    expect(simulateContract).toHaveBeenCalledTimes(2);
    const nftCfg = simulateContract.mock.calls[0][0] as { functionName: string; args: unknown[]; address: string; account: string };
    expect(nftCfg.functionName).toBe('setApprovalForAll');
    expect(nftCfg.address).toBe(NPM);
    expect(nftCfg.account).toBe(USER);
    expect(nftCfg.args).toEqual([ARENA, true]); // operator approval to the arena

    // The stake is the SECOND call — i.e. the NFT approve precedes it.
    const stakeCfg = simulateContract.mock.calls[1][0] as { functionName: string; args: unknown[] };
    expect(stakeCfg.functionName).toBe('stakeWithConviction');
    expect(stakeCfg.args).toEqual([42n, Side.UP, 250_000000n]);

    // The NFT approve must be AWAITED (receipt waited) before staking — the arena's NFT pull needs it live.
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(writeContractAsync).toHaveBeenCalledTimes(2);
    // setApprovalForAll was written (and awaited) strictly before stakeWithConviction.
    const firstWrite = writeContractAsync.mock.invocationCallOrder[0];
    const awaitCall = waitForTransactionReceipt.mock.invocationCallOrder[0];
    const secondWrite = writeContractAsync.mock.invocationCallOrder[1];
    expect(firstWrite).toBeLessThan(awaitCall);
    expect(awaitCall).toBeLessThan(secondWrite);

    // The NFT-approve write carries the Arc gas floor too.
    const nftWcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(nftWcfg.maxFeePerGas).toBe(20_000_000_000n);
    expect(nftWcfg.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it('does USDC approve -> NFT approve -> stake (all three, in order) when neither is approved', async () => {
    allowanceValue.current = 0n; // needs USDC approve
    nftApprovedForAllValue.current = false; // needs NFT approve
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 9n, side: Side.DOWN, conviction: 250_000000n });
    });

    expect(simulateContract).toHaveBeenCalledTimes(3);
    expect((simulateContract.mock.calls[0][0] as { functionName: string }).functionName).toBe('approve');
    expect((simulateContract.mock.calls[1][0] as { functionName: string }).functionName).toBe('setApprovalForAll');
    expect((simulateContract.mock.calls[2][0] as { functionName: string }).functionName).toBe('stakeWithConviction');
    // Both approvals are awaited before the stake (USDC receipt + NFT receipt).
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(2);
    expect(writeContractAsync).toHaveBeenCalledTimes(3);
  });

  it('skips the NFT approve when the arena is already an operator (isApprovedForAll=true)', async () => {
    allowanceValue.current = 1_000_000000n; // USDC covered
    nftApprovedForAllValue.current = true; // already an operator -> straight to stake
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 7n, side: Side.UP, conviction: 250_000000n });
    });
    // Single tx: stakeWithConviction. No approve of either kind.
    expect(simulateContract).toHaveBeenCalledTimes(1);
    expect((simulateContract.mock.calls[0][0] as { functionName: string }).functionName).toBe('stakeWithConviction');
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe('useStakeWithConviction().stake — bounds + side validation', () => {
  it('rejects conviction below minConv (no simulate/write)', async () => {
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await expect(result.current.stake({ tokenId: 1n, side: Side.UP, conviction: 50_000000n })).rejects.toThrow();
    });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContractAsync).not.toHaveBeenCalled();
  });

  it('rejects conviction above maxConv (no simulate/write)', async () => {
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await expect(result.current.stake({ tokenId: 1n, side: Side.UP, conviction: 2_000_000000n })).rejects.toThrow();
    });
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it('rejects Side.NONE (no simulate/write)', async () => {
    allowanceValue.current = 1_000_000000n;
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await expect(result.current.stake({ tokenId: 1n, side: Side.NONE, conviction: 250_000000n })).rejects.toThrow();
    });
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it('accepts conviction exactly at the bounds (min and max inclusive)', async () => {
    allowanceValue.current = 5_000_000000n;
    const { result } = renderHook(() => useStakeWithConviction(BOUNDS));
    await act(async () => {
      await result.current.stake({ tokenId: 1n, side: Side.UP, conviction: BOUNDS.minConv });
    });
    await act(async () => {
      await result.current.stake({ tokenId: 2n, side: Side.UP, conviction: BOUNDS.maxConv });
    });
    expect(simulateContract).toHaveBeenCalledTimes(2);
  });
});
