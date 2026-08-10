import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { encodeFunctionResult, decodeFunctionData } from 'viem';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';

// useRemoveQuote simulates the EXACT remove path for one position —
//   NPM.multicall([ decreaseLiquidity(tokenId, FULL liquidity, 0, 0, deadline),
//                   collect(tokenId, owner, uint128.max, uint128.max) ])
// — and decodes the multicall RESULT: element [1] is the collect return = (amount0, amount1) = the
// TOTAL tokens that would land in the wallet (freed principal + owed fees). It maps amount0/amount1 to
// (base, USDC) using the pool's token0/token1 ordering (useActiveBaseToken.baseIsToken0) and returns
// the raw base/usdc bigints so the row can format them. We verify: (a) it simulates `multicall` on the
// NPM with TWO inner calls (decreaseLiquidity(FULL) + collect(owner)), (b) it decodes element [1] and
// maps to base/usdc by baseIsToken0, and (c) it degrades gracefully (base/usdc undefined) on error.

const USER = '0x1111111111111111111111111111111111111111' as const;
const NPM_ADDR = '0x0000000000000000000000000000000000000abc' as const;
const MAX_UINT128 = (1n << 128n) - 1n;

// collect returns address-sorted (amount0, amount1). Distinguishable values:
//   amount0 = 9_600000 (looks 6dp USDC: 9.6) ; amount1 = 123n (looks like a tiny 8dp cirBTC base).
const AMOUNT0 = 9_600000n;
const AMOUNT1 = 123n;

// The multicall result is bytes[]: [ decreaseLiquidity return, collect return ]. Element [1] is the
// collect (amount0, amount1) tuple — encode it the way viem would so the hook's decode is exercised.
const collectReturn = encodeFunctionResult({
  abi: nonfungiblePositionManagerAbi,
  functionName: 'collect',
  result: [AMOUNT0, AMOUNT1],
});
const decreaseReturn = encodeFunctionResult({
  abi: nonfungiblePositionManagerAbi,
  functionName: 'decreaseLiquidity',
  result: [AMOUNT0, AMOUNT1],
});

vi.mock('@/lib/contracts', () => ({
  // Inlined literal (must match NPM_ADDR below) — vi.mock factories are hoisted above const decls.
  npmContract: {
    address: '0x0000000000000000000000000000000000000abc' as const,
    abi: nonfungiblePositionManagerAbi,
  },
}));
vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 5042002, name: 'Arc Testnet' } }));

// useActiveBaseToken classifies base vs USDC; reconfigured per test.
const baseTokenMock = vi.fn();
vi.mock('@/hooks/useActiveBaseToken', () => ({ useActiveBaseToken: () => baseTokenMock() }));

// wagmi useSimulateContract is reconfigured per test (the multicall result / error state).
const simulateMock = vi.fn();
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: USER }),
  useSimulateContract: (cfg: unknown) => simulateMock(cfg),
}));

import { useRemoveQuote } from '@/hooks/useRemoveQuote';

beforeEach(() => {
  baseTokenMock.mockReset();
  simulateMock.mockReset();
});
afterEach(cleanup);

describe('useRemoveQuote', () => {
  it('simulates multicall([decreaseLiquidity(FULL), collect(owner)]) on the NPM', () => {
    baseTokenMock.mockReturnValue({ baseIsToken0: false, decimals: 8, symbol: 'cirBTC', isLoading: false });
    simulateMock.mockReturnValue({
      data: { result: [decreaseReturn, collectReturn] },
      isLoading: false,
      isError: false,
    });

    renderHook(() => useRemoveQuote({ tokenId: 42n, liquidity: 123_456_789n }));

    // The hook simulated `multicall` on the NPM for the connected owner.
    expect(simulateMock).toHaveBeenCalled();
    const cfg = simulateMock.mock.calls.at(-1)![0] as {
      functionName: string; args: unknown[]; address: string; account: string;
    };
    expect(cfg.functionName).toBe('multicall');
    expect(cfg.address).toBe(NPM_ADDR);
    expect(cfg.account).toBe(USER);

    const inner = cfg.args[0] as readonly `0x${string}`[];
    expect(inner).toHaveLength(2);

    // Inner #1: decreaseLiquidity(tokenId, FULL liquidity, 0, 0, deadline).
    const dec = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: inner[0] });
    expect(dec.functionName).toBe('decreaseLiquidity');
    const decP = (dec.args as readonly unknown[])[0] as {
      tokenId: bigint; liquidity: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint;
    };
    expect(decP.tokenId).toBe(42n);
    expect(decP.liquidity).toBe(123_456_789n);
    expect(decP.amount0Min).toBe(0n);
    expect(decP.amount1Min).toBe(0n);
    expect(decP.deadline).toBeGreaterThan(0n);

    // Inner #2: collect(tokenId, owner, uint128.max, uint128.max).
    const col = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: inner[1] });
    expect(col.functionName).toBe('collect');
    const colP = (col.args as readonly unknown[])[0] as {
      tokenId: bigint; recipient: string; amount0Max: bigint; amount1Max: bigint;
    };
    expect(colP.tokenId).toBe(42n);
    expect(colP.recipient).toBe(USER);
    expect(colP.amount0Max).toBe(MAX_UINT128);
    expect(colP.amount1Max).toBe(MAX_UINT128);
  });

  it('decodes the collect return (element [1]) and maps base/usdc when USDC sorts as token0', () => {
    // BTC-style market: USDC sorts FIRST (baseIsToken0=false) -> base=amount1, usdc=amount0.
    baseTokenMock.mockReturnValue({ baseIsToken0: false, decimals: 8, symbol: 'cirBTC', isLoading: false });
    simulateMock.mockReturnValue({
      data: { result: [decreaseReturn, collectReturn] },
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useRemoveQuote({ tokenId: 42n, liquidity: 1000n }));
    // base = amount1 (the non-USDC leg), usdc = amount0.
    expect(result.current.base).toBe(AMOUNT1);
    expect(result.current.usdc).toBe(AMOUNT0);
    expect(result.current.baseDecimals).toBe(8);
    expect(result.current.baseSymbol).toBe('cirBTC');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('maps base=amount0 / usdc=amount1 when the base sorts as token0 (ETH-style market)', () => {
    baseTokenMock.mockReturnValue({ baseIsToken0: true, decimals: 18, symbol: 'WETH', isLoading: false });
    simulateMock.mockReturnValue({
      data: { result: [decreaseReturn, collectReturn] },
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => useRemoveQuote({ tokenId: 42n, liquidity: 1000n }));
    expect(result.current.base).toBe(AMOUNT0);
    expect(result.current.usdc).toBe(AMOUNT1);
  });

  it('degrades gracefully (base/usdc undefined) when the simulation errors', () => {
    baseTokenMock.mockReturnValue({ baseIsToken0: false, decimals: 8, symbol: 'cirBTC', isLoading: false });
    simulateMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    const { result } = renderHook(() => useRemoveQuote({ tokenId: 42n, liquidity: 1000n }));
    expect(result.current.base).toBeUndefined();
    expect(result.current.usdc).toBeUndefined();
    expect(result.current.isError).toBe(true);
  });

  it('reports loading while the simulation is in flight', () => {
    baseTokenMock.mockReturnValue({ baseIsToken0: false, decimals: 8, symbol: 'cirBTC', isLoading: false });
    simulateMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    const { result } = renderHook(() => useRemoveQuote({ tokenId: 42n, liquidity: 1000n }));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.base).toBeUndefined();
  });
});
