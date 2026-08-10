// hooks/useOwnedPositions.ts — enumerate the connected wallet's V3 position NFTs and filter to the
// Arena WETH/USDC pool, excluding already-staked tokenIds. Provides `OwnedPosition[]` to PositionPicker.
//
// Wiring: NPM.balanceOf -> NPM.tokenOfOwnerByIndex(0..n-1) (batched) -> NPM.positions(tokenId)
// (batched), then hand the decoded rows to the pure `filterArenaPositions` (see lib/positions.ts).
// The Arena membership/fee/liquidity/already-staked rules live entirely in that pure function.
import { useMemo } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import { npm } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';
import type { OwnedPosition, StakeView } from '@/lib/types';
import { filterArenaPositions, type RawPosition } from '@/lib/positions';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { useUserStakes } from '@/hooks/useUserStakes';
import { usePollInterval } from '@/hooks/usePollInterval';
import type { PoolInfo } from '@/lib/pools';

/**
 * NPM.positions() is a FLAT multi-output function (nonce, operator, token0, token1, fee, tickLower,
 * tickUpper, liquidity, ...), which viem 2.19.4 decodes POSITIONALLY (an array), NOT as a named
 * object — so p.token0 is undefined. We read by index ([2]=token0, [3]=token1, [4]=fee,
 * [5]=tickLower, [6]=tickUpper, [7]=liquidity) with named fallbacks, so the hook is robust to
 * either decode shape.
 */
type PositionsTuple = {
  [index: number]: unknown;
  token0?: `0x${string}`;
  token1?: `0x${string}`;
  fee?: number | bigint;
  tickLower?: number | bigint;
  tickUpper?: number | bigint;
  liquidity?: bigint;
};

/**
 * Returns the connected account's V3 positions that are eligible to stake:
 *   - Belong to the Arena WETH/USDC pool at the configured fee tier
 *   - Have liquidity > 0
 *   - Are not already staked in FeeArena by this user
 *
 * The full per-position filter runs inside the hook; PositionPicker consumes the filtered
 * `OwnedPosition[]` directly without knowing how many positions the user owns.
 */
export function useOwnedPositions(opts?: { pool?: PoolInfo }): {
  data: OwnedPosition[] | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const { address, isConnected } = useAccount();
  const interval = usePollInterval();
  const enabled = isConnected && !!address;

  // The active market's pool token pair (token0/token1) is the Arena-membership identity. For the
  // default ETH market this resolves to {WETH, USDC}; for BTC it resolves to {WBTC, USDC}. The base
  // leg = whichever of token0/token1 is NOT the global USDC. While the pool tokens are still loading
  // `address` is undefined and `baseLoading` is true — we MUST NOT substitute the default ETH base
  // here (that would transiently filter a non-ETH market against {WETH, USDC}); instead we stay
  // loading until the real base resolves (Fix E).
  const { address: activeBaseToken, isLoading: activeBaseLoading } = useActiveBaseToken();

  // POOL-SELECTABLE path (/pool): an EXPLICIT pool overrides the active-market identity, so the list
  // works for ANY registry pair (incl. cirBTC/EURC, which has no USDC leg). The pool's legs are known
  // statically (no on-chain token0/token1 read), so there's no base-leg loading gate on this path.
  const override = opts?.pool;
  const baseToken = override ? override.base.address : activeBaseToken;
  const quoteToken = override ? override.quote.address : ENV.USDC_ADDRESS;
  const feeTier = override ? override.feeTier : ENV.FEE_TIER;
  const baseLoading = override ? false : activeBaseLoading;

  // 1) balanceOf(owner) -> how many position NFTs to enumerate (re-lists on transfers via polling).
  const {
    data: balance,
    isLoading: balanceLoading,
    isError: balanceError,
  } = useReadContract({
    ...npm,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled, refetchInterval: interval },
  });

  const count = balance !== undefined ? Number(balance) : 0;

  // 2) tokenOfOwnerByIndex(owner, i) for i in 0..count-1 — one Multicall3 batch.
  const indexCalls = useMemo(
    () =>
      address && count > 0
        ? Array.from({ length: count }, (_, i) => ({
            ...npm,
            functionName: 'tokenOfOwnerByIndex' as const,
            args: [address, BigInt(i)] as const,
            chainId: arcTestnet.id,
          }))
        : [],
    [address, count],
  );

  const {
    data: tokenIdResults,
    isLoading: tokenIdsLoading,
    isError: tokenIdsError,
  } = useReadContracts({
    contracts: indexCalls,
    query: { enabled: enabled && count > 0, refetchInterval: interval },
  });

  const tokenIds = useMemo<bigint[]>(() => {
    if (!tokenIdResults) return [];
    return tokenIdResults
      .filter((r) => r.status === 'success' && r.result !== undefined)
      .map((r) => r.result as bigint);
  }, [tokenIdResults]);

  // 3) positions(tokenId) for each enumerated tokenId — one Multicall3 batch.
  const positionCalls = useMemo(
    () =>
      tokenIds.map((tokenId) => ({
        ...npm,
        functionName: 'positions' as const,
        args: [tokenId] as const,
        chainId: arcTestnet.id,
      })),
    [tokenIds],
  );

  const {
    data: positionResults,
    isLoading: positionsLoading,
    isError: positionsError,
  } = useReadContracts({
    contracts: positionCalls,
    query: { enabled: enabled && tokenIds.length > 0, refetchInterval: interval },
  });

  // Already-staked tokenIds for this user — version-aware useUserStakes (v1 arena getUserStakes /
  // v2 Lens getStakesByEpoch window) -> StakeView[].
  const { data: stakes } = useUserStakes(address);

  const data = useMemo<OwnedPosition[] | undefined>(() => {
    if (!enabled) return undefined;
    // Don't classify positions until the active pool's base leg resolves — otherwise a non-ETH
    // market would briefly filter against the wrong (default ETH) pair (Fix E).
    if (!baseToken) return undefined;
    if (count === 0) return [];
    if (!positionResults) return undefined;

    const raw: RawPosition[] = [];
    positionResults.forEach((r, i) => {
      if (r.status !== 'success' || r.result === undefined) return;
      // Read positionally (viem decodes the flat positions() output to an array) with named
      // fallbacks; skip a row only if token0/token1 are genuinely missing.
      const p = r.result as unknown as PositionsTuple;
      const token0 = (p.token0 ?? p[2]) as `0x${string}` | undefined;
      const token1 = (p.token1 ?? p[3]) as `0x${string}` | undefined;
      if (!token0 || !token1) return;
      raw.push({
        tokenId: tokenIds[i],
        token0,
        token1,
        fee: Number(p.fee ?? p[4]),
        // int24 ticks decode as JS numbers; Number() also tolerates a bigint-decoding client.
        tickLower: Number(p.tickLower ?? p[5]),
        tickUpper: Number(p.tickUpper ?? p[6]),
        liquidity: (p.liquidity ?? p[7]) as bigint,
      });
    });

    const stakedTokenIds = ((stakes as readonly StakeView[] | undefined) ?? [])
      // A stake still occupies the position only while not unstaked.
      .filter((s) => !s.unstaked)
      .map((s) => s.tokenId);

    return filterArenaPositions(
      raw,
      { weth: baseToken, usdc: quoteToken, feeTier },
      stakedTokenIds,
    );
  }, [enabled, count, positionResults, tokenIds, stakes, baseToken, quoteToken, feeTier]);

  const isLoading =
    enabled &&
    data === undefined &&
    // While the active pool's base leg is resolving, show the skeleton rather than a wrong-market
    // empty state on a market switch (Fix E).
    (baseLoading || balanceLoading || tokenIdsLoading || positionsLoading || (count > 0 && !positionResults));

  const isError = balanceError || tokenIdsError || positionsError;

  return { data, isLoading, isError };
}
