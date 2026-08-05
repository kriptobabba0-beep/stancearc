// hooks/useRemoveQuote.ts - estimate what a position would return on withdraw, by SIMULATING the exact
// remove path useRemoveLiquidity will run:
//
//   NPM.multicall([
//     decreaseLiquidity({ tokenId, liquidity: <position's FULL current liquidity>, 0, 0, deadline }),
//     collect({ tokenId, recipient: owner, amount0Max: uint128.max, amount1Max: uint128.max }),
//   ])
//
// eth_call'd as the connected owner. The multicall RESULT is bytes[]; element [1] is the collect
// return = (amount0, amount1) = the TOTAL tokens that would land in the wallet (freed principal + any
// owed fees). decreaseLiquidity must run FIRST in the same multicall so collect sees the freed
// principal - simulating both together is what makes the estimate correct.
//
// amount0/amount1 are ADDRESS-SORTED (the pool's token0/token1). We map them to (base, USDC) the same
// way PositionPicker does - via useActiveBaseToken.baseIsToken0 (the non-USDC leg is the base). Returns
// the raw base/usdc bigints (caller formats with lib/format at baseDecimals / 6dp), plus loading/error
// flags so the row can fall back to the raw-liquidity display if the estimate is unavailable.
import { useMemo } from 'react';
import { useAccount, useSimulateContract } from 'wagmi';
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { npmContract } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';

const MAX_UINT128 = (1n << 128n) - 1n;
// 20-minute deadline - generous for testnet block times; identical to useRemoveLiquidity so the
// simulated path matches the path the write will actually take.
const DEADLINE_BUFFER_SECONDS = 20n * 60n;

export interface RemoveQuote {
  /** Estimated base-token (non-USDC leg) returned on withdraw, raw at `baseDecimals`. undefined until loaded. */
  base: bigint | undefined;
  /** Estimated USDC (6dp) returned on withdraw, raw. undefined until loaded. */
  usdc: bigint | undefined;
  /** The active market's base decimals (cirBTC 8, WETH 18, …) for formatting `base`. */
  baseDecimals: number;
  /** The active market's base symbol (e.g. "cirBTC"). */
  baseSymbol: string;
  /** True while the simulation (or the base-leg classification) is in flight. */
  isLoading: boolean;
  /** True when the estimate is unavailable (simulation reverted/failed) - caller falls back gracefully. */
  isError: boolean;
}

/**
 * Estimate the cirBTC + USDC a position would return on withdraw. Pure read (eth_call) - never writes.
 * Falls back to `{ base: undefined, usdc: undefined, isError: true }` if the simulation is unavailable
 * so the consuming row can render the raw liquidity instead of crashing.
 */
export function useRemoveQuote({
  tokenId,
  liquidity,
  base: baseOverride,
}: {
  tokenId: bigint;
  liquidity: bigint;
  /**
   * Optional explicit base-leg classification (the pool-selectable /pool off-ramp). When supplied the
   * (amount0,amount1)→(base,quote) mapping + the display decimals/symbol come from the SELECTED pool
   * instead of the active market - so it's correct for any pair (incl. cirBTC/EURC). Omitted = active
   * market via useActiveBaseToken (unchanged).
   */
  base?: { baseIsToken0: boolean; decimals: number; symbol: string };
}): RemoveQuote {
  const { address } = useAccount();
  // useActiveBaseToken is called unconditionally (hooks rule); ignored when the override is given.
  const active = useActiveBaseToken();
  const baseIsToken0 = baseOverride ? baseOverride.baseIsToken0 : active.baseIsToken0;
  const baseDecimals = baseOverride ? baseOverride.decimals : active.decimals;
  const baseSymbol = baseOverride ? baseOverride.symbol : active.symbol;
  const baseLoading = baseOverride ? false : active.isLoading;

  // Encode the SAME two inner calls useRemoveLiquidity batches, so the estimate matches the real path.
  // The deadline only needs to be in the future for the eth_call; it's recomputed per render but never
  // an input to the returned amounts, so this does not destabilize the simulation result.
  const innerCalls = useMemo(() => {
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_BUFFER_SECONDS;
    const decreaseData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: 'decreaseLiquidity',
      args: [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }],
    });
    const collectData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: 'collect',
      args: [
        {
          tokenId,
          recipient: address ?? '0x0000000000000000000000000000000000000000',
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    });
    return [decreaseData, collectData] as const;
  }, [tokenId, liquidity, address]);

  const { data, isLoading: simLoading, isError } = useSimulateContract({
    ...npmContract,
    functionName: 'multicall',
    args: [innerCalls],
    account: address,
    chainId: arcTestnet.id,
    // Only simulate once we have an owner AND a non-zero position to remove (decreaseLiquidity(0)
    // reverts - a 0-liquidity row has nothing to estimate).
    query: { enabled: Boolean(address) && liquidity > 0n },
  });

  // Decode the multicall result: bytes[] -> element [1] is the collect (amount0, amount1) tuple.
  const collected = useMemo<readonly [bigint, bigint] | undefined>(() => {
    const results = data?.result as readonly `0x${string}`[] | undefined;
    if (!results || results.length < 2) return undefined;
    try {
      const decoded = decodeFunctionResult({
        abi: nonfungiblePositionManagerAbi,
        functionName: 'collect',
        data: results[1],
      }) as readonly [bigint, bigint];
      return decoded;
    } catch {
      // A malformed/empty result is treated as "estimate unavailable" - caller falls back.
      return undefined;
    }
  }, [data]);

  // Map the address-sorted (amount0, amount1) back to (base, USDC). While baseIsToken0 is still
  // resolving (undefined) default to base==token0 (mirrors PositionPicker's default-ETH behavior).
  const [base, usdc] = useMemo<[bigint | undefined, bigint | undefined]>(() => {
    if (!collected) return [undefined, undefined];
    const [amount0, amount1] = collected;
    return baseIsToken0 === false ? [amount1, amount0] : [amount0, amount1];
  }, [collected, baseIsToken0]);

  return {
    base,
    usdc,
    baseDecimals,
    baseSymbol,
    isLoading: (simLoading || baseLoading) && base === undefined,
    isError,
  };
}
