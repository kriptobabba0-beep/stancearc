import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { parseUnits } from 'viem';

// useMintPosition builds NPM.mint(MintParams) for the ACTIVE market's pool. We verify (a) the pure
// buildMintParams orders (base, USDC) into the sorted (token0, token1) by baseIsToken0, applies the
// full-range ticks, maps amounts, and zeroes the mins; and (b) the hook simulates then writes with
// the 20-gwei gas floor, passing those exact params. Mocking mirrors runSwap.test.tsx.

vi.mock('@/lib/env', () => ({ ENV: { FEE_TIER: 3000 } }));

vi.mock('@/lib/contracts', () => ({
  // NOTE: vi.mock factories are hoisted above imports — addresses MUST be inlined here.
  npm: { address: '0x00000000000000000000000000000000000000aa' as const, abi: [] },
  usdc: { address: '0x0000000000000000000000000000000000000002' as const, abi: [] },
}));

// Re-declared below the mocks for assertions (kept in sync with the inlined literal above).
const USDC = '0x0000000000000000000000000000000000000002' as const;

vi.mock('@/lib/chain', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  withGasFloor: <T,>(request: T) => ({
    ...request,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
}));

// useActiveBaseToken classifies base vs USDC; reconfigured per test via this holder.
const baseTokenMock = vi.fn();
vi.mock('@/hooks/useActiveBaseToken', () => ({
  useActiveBaseToken: () => baseTokenMock(),
}));

vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

// publicClient.simulateContract returns a { request } echoing the call; writeContractAsync spies.
const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => '0xhash');
// Reconfigurable receipt-query state so a test can drive the success / reverted / error branches of the
// centralized tx-lifecycle (useTxToast). Captured args let us assert the query is created with a timeout.
const receiptQuery = vi.hoisted(() => ({
  current: { isLoading: false, isSuccess: false, isError: false, data: undefined } as Record<string, unknown>,
}));
const waitForReceiptArgs = vi.hoisted(() => ({ current: undefined as unknown }));
// The submitted hash exposed by useWriteContract().data — undefined until a test sets it, so the
// tx-lifecycle effect only fires when a hash exists (mirrors the real submit→receipt flow).
const writeHash = vi.hoisted(() => ({ current: undefined as `0x${string}` | undefined }));
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({ simulateContract }),
  useWriteContract: () => ({ writeContractAsync, data: writeHash.current, isPending: false }),
  useWaitForTransactionReceipt: (args: unknown) => {
    waitForReceiptArgs.current = args;
    return receiptQuery.current;
  },
}));

// Shared refetchQueries spy so we can assert the live-refetch (Bug 1a).
const refetchQueries = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries }) }));
// Capture toast lifecycle calls so we can assert success vs. reverted/error (Fix 2/3).
const toastMock = vi.hoisted(() => ({ loading: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock, arcScanTxUrl: () => undefined }));

import { useMintPosition, buildMintParams, fullRangeTicks, tickSpacingForFee } from '@/hooks/useMintPosition';

const WBTC = '0xbbbb000000000000000000000000000000000000' as const;
const WETH = '0xeeee000000000000000000000000000000000000' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  refetchQueries.mockClear();
  toastMock.loading.mockClear();
  toastMock.success.mockClear();
  toastMock.error.mockClear();
  receiptQuery.current = { isLoading: false, isSuccess: false, isError: false, data: undefined };
  waitForReceiptArgs.current = undefined;
  writeHash.current = undefined;
});
afterEach(cleanup);

describe('fullRangeTicks / tickSpacingForFee', () => {
  it('uses spacing 60 and ±887220 ticks for the 0.3% tier (mirrors DeployMarket)', () => {
    expect(tickSpacingForFee(3000)).toBe(60);
    expect(fullRangeTicks(3000)).toEqual({ tickLower: -887220, tickUpper: 887220 });
  });
  it('aligns to spacing for other tiers', () => {
    expect(fullRangeTicks(500)).toEqual({ tickLower: -887270, tickUpper: 887270 }); // spacing 10
    expect(fullRangeTicks(10000)).toEqual({ tickLower: -887200, tickUpper: 887200 }); // spacing 200
  });
});

describe('buildMintParams (pure ordering + amounts)', () => {
  it('base==token0 (ETH market): (base, USDC) -> (amount0, amount1)', () => {
    const p = buildMintParams({
      baseToken: WETH,
      usdcToken: USDC,
      baseIsToken0: true,
      feeTier: 3000,
      baseAmount: parseUnits('1', 18),
      usdcAmount: parseUnits('2000', 6),
      recipient: USER,
      nowSec: 1000n,
    });
    expect(p.token0).toBe(WETH);
    expect(p.token1).toBe(USDC);
    expect(p.amount0Desired).toBe(parseUnits('1', 18)); // base leg
    expect(p.amount1Desired).toBe(parseUnits('2000', 6)); // USDC leg
    expect(p.tickLower).toBe(-887220);
    expect(p.tickUpper).toBe(887220);
    expect(p.amount0Min).toBe(0n);
    expect(p.amount1Min).toBe(0n);
    expect(p.fee).toBe(3000);
    expect(p.recipient).toBe(USER);
    expect(p.deadline).toBe(1000n + 3600n);
  });

  it('USDC==token0 (BTC market, base sorts second): legs swap so amounts map correctly', () => {
    const p = buildMintParams({
      baseToken: WBTC,
      usdcToken: USDC,
      baseIsToken0: false,
      feeTier: 3000,
      baseAmount: parseUnits('0.01', 8), // WBTC at 8dp
      usdcAmount: parseUnits('600', 6),
      recipient: USER,
      nowSec: 0n,
    });
    expect(p.token0).toBe(USDC);
    expect(p.token1).toBe(WBTC);
    expect(p.amount0Desired).toBe(parseUnits('600', 6)); // USDC leg is now token0
    expect(p.amount1Desired).toBe(parseUnits('0.01', 8)); // base leg is token1
  });

  it('caller-selected ticks override the full-range default (range-selectable mints)', () => {
    const p = buildMintParams({
      baseToken: WBTC,
      usdcToken: USDC,
      baseIsToken0: false,
      feeTier: 3000,
      baseAmount: 1n,
      usdcAmount: 1n,
      recipient: USER,
      nowSec: 0n,
      tickLower: -65280,
      tickUpper: -63960,
    });
    expect(p.tickLower).toBe(-65280);
    expect(p.tickUpper).toBe(-63960);
  });
});

describe('useMintPosition().mint', () => {
  it('simulates then writes NPM.mint with the ordered params and the gas floor (ETH market)', async () => {
    baseTokenMock.mockReturnValue({
      address: WETH,
      decimals: 18,
      symbol: 'WETH',
      baseIsToken0: true,
      isLoading: false,
    });

    const { result } = renderHook(() => useMintPosition());
    await act(async () => {
      await result.current.mint({ baseAmount: parseUnits('1', 18), usdcAmount: parseUnits('2000', 6) });
    });

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as { functionName: string; args: unknown[]; account: string };
    expect(simCfg.functionName).toBe('mint');
    expect(simCfg.account).toBe(USER);
    const params = simCfg.args[0] as Record<string, unknown>;
    expect(params.token0).toBe(WETH);
    expect(params.token1).toBe(USDC);
    expect(params.amount0Desired).toBe(parseUnits('1', 18));
    expect(params.amount1Desired).toBe(parseUnits('2000', 6));
    expect(params.tickLower).toBe(-887220);
    expect(params.tickUpper).toBe(887220);
    expect(params.recipient).toBe(USER);

    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n); // 20-gwei Arc floor applied
    expect(wcfg.__sim).toBe(true); // the simulated request was forwarded to the write
  });

  it('maps amounts to the swapped legs when USDC sorts as token0 (BTC market)', async () => {
    baseTokenMock.mockReturnValue({
      address: WBTC,
      decimals: 8,
      symbol: 'WBTC',
      baseIsToken0: false,
      isLoading: false,
    });

    const { result } = renderHook(() => useMintPosition());
    await act(async () => {
      await result.current.mint({ baseAmount: parseUnits('0.01', 8), usdcAmount: parseUnits('600', 6) });
    });

    const params = (simulateContract.mock.calls[0][0] as { args: unknown[] }).args[0] as Record<string, unknown>;
    expect(params.token0).toBe(USDC);
    expect(params.token1).toBe(WBTC);
    expect(params.amount0Desired).toBe(parseUnits('600', 6)); // USDC leg first
    expect(params.amount1Desired).toBe(parseUnits('0.01', 8)); // base leg second
  });

  it('passes caller-selected tickLower/tickUpper through to NPM.mint (range-selectable positions)', async () => {
    baseTokenMock.mockReturnValue({
      address: WBTC,
      decimals: 8,
      symbol: 'WBTC',
      baseIsToken0: false,
      isLoading: false,
    });

    const { result } = renderHook(() => useMintPosition());
    await act(async () => {
      await result.current.mint({
        baseAmount: parseUnits('0.01', 8),
        usdcAmount: 0n, // one-sided out-of-range mint is legal
        tickLower: -65280,
        tickUpper: -63960,
      });
    });

    const params = (simulateContract.mock.calls[0][0] as { args: unknown[] }).args[0] as Record<string, unknown>;
    expect(params.tickLower).toBe(-65280);
    expect(params.tickUpper).toBe(-63960);
  });

  it('Bug 1a: forces an immediate refetch of active queries after the write resolves', async () => {
    baseTokenMock.mockReturnValue({
      address: WETH,
      decimals: 18,
      symbol: 'WETH',
      baseIsToken0: true,
      isLoading: false,
    });
    const { result } = renderHook(() => useMintPosition());
    await act(async () => {
      await result.current.mint({ baseAmount: parseUnits('1', 18), usdcAmount: parseUnits('2000', 6) });
    });
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });

  it('does NOT write while the pool ordering is still loading', async () => {
    baseTokenMock.mockReturnValue({
      address: undefined,
      decimals: 18,
      symbol: 'WETH',
      baseIsToken0: undefined,
      isLoading: true,
    });

    const { result } = renderHook(() => useMintPosition());
    expect(result.current.isPoolLoading).toBe(true);
    await act(async () => {
      await expect(
        result.current.mint({ baseAmount: parseUnits('1', 18), usdcAmount: parseUnits('2000', 6) }),
      ).rejects.toThrow(/loading/i);
    });
    expect(simulateContract).not.toHaveBeenCalled();
    expect(writeContractAsync).not.toHaveBeenCalled();
  });
});

describe('useMintPosition tx-lifecycle (Fix 2/3 via useTxToast)', () => {
  const WETH_BASE = { address: WETH, decimals: 18, symbol: 'WETH', baseIsToken0: true, isLoading: false };

  it('creates the receipt query with a 120s timeout (Fix 3)', () => {
    baseTokenMock.mockReturnValue(WETH_BASE);
    renderHook(() => useMintPosition());
    expect((waitForReceiptArgs.current as { timeout?: number }).timeout).toBe(120_000);
  });

  it('Fix 2: a mined-but-REVERTED receipt fires an error toast, NOT success', () => {
    baseTokenMock.mockReturnValue(WETH_BASE);
    writeHash.current = '0xabc';
    receiptQuery.current = {
      isLoading: false,
      isSuccess: true, // viem resolves isSuccess=true even on a revert
      isError: false,
      data: { status: 'reverted' },
    };
    renderHook(() => useMintPosition());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
    // A revert must NOT claim success — no success-refetch path.
    expect(refetchQueries).not.toHaveBeenCalled();
  });

  it('Fix 2: a mined SUCCESS receipt fires the success toast + refetches', () => {
    baseTokenMock.mockReturnValue(WETH_BASE);
    writeHash.current = '0xabc';
    receiptQuery.current = {
      isLoading: false,
      isSuccess: true,
      isError: false,
      data: { status: 'success' },
    };
    renderHook(() => useMintPosition());
    expect(toastMock.success).toHaveBeenCalledTimes(1);
    expect(toastMock.error).not.toHaveBeenCalled();
    expect(refetchQueries).toHaveBeenCalledWith({ type: 'active' });
  });

  it('Fix 3: a receipt query ERROR/timeout fires a "could not confirm" error toast', () => {
    baseTokenMock.mockReturnValue(WETH_BASE);
    writeHash.current = '0xabc';
    receiptQuery.current = { isLoading: false, isSuccess: false, isError: true, data: undefined };
    renderHook(() => useMintPosition());
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });
});
