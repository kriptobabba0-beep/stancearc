// hooks/useMintPosition.ts — mint a Uniswap-V3 position in the ACTIVE market's pool, so a user can
// self-serve from tokens -> stakeable position (the on-ramp). Mirrors DeployMarket._seed:
//   - token0/token1 = the pool's ADDRESS-SORTED pair (resolved via useActiveBaseToken().baseIsToken0
//     + the global USDC), so we never assume the base is token0 (USDC can sort first).
//   - fee          = ENV.FEE_TIER (the pool's fee tier).
//   - tickLower/tickUpper = CALLER-SELECTED, spacing-aligned ticks (the range picker builds them via
//     lib/rangeMath presetTicks/customTicks). When omitted we default to the spacing-aligned full
//     range for the fee tier (−887220/887220 for the 0.3% tier, spacing 60) — always in-range,
//     simplest for a first-timer and back-compatible with the original full-range-only flow.
//   - amount0Desired/amount1Desired = the user's chosen (base, USDC) amounts mapped to the sorted pair.
//   - amount0Min/amount1Min = 0 (testnet; slippage-guarded later).
//   - recipient    = the connected user; deadline = far-future.
// MANDATORY simulateContract preflight (like useStakeWithSide) then writeContract with the 20-gwei
// Arc gas floor. Approvals (base + USDC -> NPM) are handled by useTokenApproval; this hook assumes
// allowances are already sufficient (the panel gates the button on that).
import { useCallback, useState } from 'react';
import { useAccount, usePublicClient } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { npm, usdc } from '@/lib/contracts';
import { useActiveBaseToken } from '@/hooks/useActiveBaseToken';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { friendlyError } from '@/lib/errors';
import { bumpPollAfterWrite } from '@/hooks/usePollInterval';
import { toast, arcScanTxUrl } from '@/lib/toast';
import { useTxToast, useTxReceipt } from '@/hooks/useTxToast';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

// Stable per-action toast id so loading→success/error replaces the same toast instead of stacking.
const TOAST_ID = 'mint-position';

// Far-future deadline so the tx never expires while the user signs (testnet UX).
const DEADLINE_SECS = 3600n;
// Canonical Uniswap-V3 max usable tick magnitude (TickMath.MAX_TICK). Aligned DOWN to tick spacing
// for a valid full-range position on any fee tier (mirrors DeployMarket._seed's ±887272 alignment).
const MAX_TICK = 887272;

/**
 * Tick spacing per Uniswap-V3 fee tier. 0.01%->1, 0.05%->10, 0.3%->60, 1%->200. Unknown tiers fall
 * back to the project's default 0.3% spacing.
 */
export function tickSpacingForFee(feeTier: number): number {
  switch (feeTier) {
    case 100:
      return 1;
    case 500:
      return 10;
    case 3000:
      return 60;
    case 10000:
      return 200;
    default:
      return 60;
  }
}

/**
 * Spacing-aligned full-range ticks for a fee tier: align ±MAX_TICK DOWN to the tier's spacing so the
 * range is symmetric and valid. 0.3% -> spacing 60 -> ±887220.
 */
export function fullRangeTicks(feeTier: number): { tickLower: number; tickUpper: number } {
  const spacing = tickSpacingForFee(feeTier);
  const upper = Math.floor(MAX_TICK / spacing) * spacing;
  return { tickLower: -upper, tickUpper: upper };
}

export interface MintPositionArgs {
  /** Desired base-token amount (raw, at the market's baseDecimals). */
  baseAmount: bigint;
  /** Desired USDC amount (raw, 6dp). */
  usdcAmount: bigint;
  /** Optional spacing-aligned lower tick (from lib/rangeMath). Defaults to the full usable range. */
  tickLower?: number;
  /** Optional spacing-aligned upper tick (from lib/rangeMath). Defaults to the full usable range. */
  tickUpper?: number;
}

/**
 * Pure MintParams builder — testable in isolation. Orders (base, USDC) into the pool's sorted
 * (token0, token1) by `baseIsToken0`, applies the selected ticks (default: full range) + zero mins +
 * far-future deadline. Callers supplying ticks MUST pass spacing-aligned values (rangeMath does).
 */
export function buildMintParams(opts: {
  baseToken: `0x${string}`;
  usdcToken: `0x${string}`;
  baseIsToken0: boolean;
  feeTier: number;
  baseAmount: bigint;
  usdcAmount: bigint;
  recipient: `0x${string}`;
  nowSec: bigint;
  /** Optional caller-selected ticks; both default to the spacing-aligned full range. */
  tickLower?: number;
  tickUpper?: number;
}) {
  const full = fullRangeTicks(opts.feeTier);
  const tickLower = opts.tickLower ?? full.tickLower;
  const tickUpper = opts.tickUpper ?? full.tickUpper;
  const [token0, token1] = opts.baseIsToken0
    ? ([opts.baseToken, opts.usdcToken] as const)
    : ([opts.usdcToken, opts.baseToken] as const);
  const [amount0Desired, amount1Desired] = opts.baseIsToken0
    ? ([opts.baseAmount, opts.usdcAmount] as const)
    : ([opts.usdcAmount, opts.baseAmount] as const);
  return {
    token0,
    token1,
    fee: opts.feeTier,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    // Zero slippage mins are acceptable on a private test network with no MEV. A mainnet build
    // (Phase 5) must compute slippage-guarded minimums (e.g. 0.5% tolerance off the pool's sqrt price).
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: opts.recipient,
    deadline: opts.nowSec + DEADLINE_SECS,
  } as const;
}

/**
 * Optional explicit pool target. When supplied (the pool-selectable /pool LP), the mint uses these
 * legs DIRECTLY instead of the active market's pool — so it works for ANY registry pair (incl.
 * cirBTC/EURC, which has no USDC leg). When omitted, the hook falls back to the active market via
 * useActiveBaseToken + the global USDC (the Arena AddLiquidityModal path — unchanged).
 */
export interface MintPoolOverride {
  baseToken: `0x${string}`;
  quoteToken: `0x${string}`;
  baseIsToken0: boolean;
  feeTier: number;
}

export function useMintPosition(override?: MintPoolOverride) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const qc = useQueryClient();
  // useActiveBaseToken is called unconditionally (hooks rule); its result is IGNORED when `override`
  // is supplied so the pool-selectable LP never depends on the active market.
  const active = useActiveBaseToken();
  const baseToken = override?.baseToken ?? active.address;
  const baseIsToken0 = override ? override.baseIsToken0 : active.baseIsToken0;
  const quoteAddress = override?.quoteToken ?? usdc.address;
  const feeTier = override?.feeTier ?? ENV.FEE_TIER;
  // The explicit override is resolved synchronously from the registry — never "loading".
  const baseLoading = override ? false : active.isLoading;
  const { writeContractAsync, data: hash, isPending: isWriting } = useArcWriteContract();
  const [error, setError] = useState<Error | undefined>();
  const [isSimulating, setIsSimulating] = useState(false);

  const {
    isLoading: isConfirming,
    isSuccess,
    isError: isReceiptError,
    data: receipt,
  } = useTxReceipt(hash);

  // Centralized tx-lifecycle: replaces the keyed loading toast with success / reverted / error-or-timeout
  // and refetches active queries on a genuine success (never on a revert/timeout).
  useTxToast({
    id: TOAST_ID,
    hash,
    receipt,
    isSuccess,
    isError: isReceiptError,
    labels: {
      success: 'Liquidity added — position minted',
      reverted: 'Mint reverted — liquidity not added',
      // The receipt wait timed out / RPC stalled — the mint may well have CONFIRMED (Arc can be slow to
      // return receipts). Reassure rather than claim failure: the position appears via the background poll.
      error: 'Mint sent — couldn’t confirm yet. If it went through, your position appears shortly (or refresh).',
    },
  });

  const mint = useCallback(
    async ({ baseAmount, usdcAmount, tickLower, tickUpper }: MintPositionArgs) => {
      setError(undefined);
      try {
        if (!address) throw new Error('Connect your wallet first.');
        if (!publicClient) throw new Error('No RPC client available.');
        if (!baseToken || baseIsToken0 === undefined) {
          throw new Error('Pool is still loading — try again in a moment.');
        }
        if (baseAmount <= 0n && usdcAmount <= 0n) throw new Error('Enter a base or USDC amount.');

        const params = buildMintParams({
          baseToken,
          usdcToken: quoteAddress,
          baseIsToken0,
          feeTier,
          baseAmount,
          usdcAmount,
          recipient: address,
          nowSec: BigInt(Math.floor(Date.now() / 1000)),
          tickLower,
          tickUpper,
        });

        setIsSimulating(true);
        // MANDATORY preflight — catches missing allowance / pool-not-initialized / bad amounts
        // before signing (mirrors useStakeWithSide).
        const { request } = await publicClient.simulateContract({
          account: address,
          address: npm.address,
          abi: npm.abi,
          functionName: 'mint',
          args: [params],
        });
        setIsSimulating(false);

        // Apply the Arc 20-gwei fee floor on top of the simulated request (see lib/chain).
        const tx = await writeContractAsync(
          withGasFloor(request) as Parameters<typeof writeContractAsync>[0],
        );
        toast.loading('Providing liquidity', {
          id: TOAST_ID,
          description: arcScanTxUrl(tx),
        });
        bumpPollAfterWrite();
        // Force a refetch right after submit so balances/allowances refresh promptly (don't wait
        // for the next poll). The isSuccess effect below also refetches once the receipt lands.
        void qc.refetchQueries({ type: 'active' });
        return tx;
      } catch (e) {
        setIsSimulating(false);
        const err = new Error(friendlyError(e));
        setError(err);
        toast.error(err.message, { id: TOAST_ID });
        throw err;
      }
    },
    [address, publicClient, baseToken, baseIsToken0, quoteAddress, feeTier, writeContractAsync, qc],
  );

  return {
    mint,
    isPending: isSimulating || isWriting || isConfirming,
    isSuccess,
    error,
    hash,
    /** True while the pool ordering is still resolving — callers should disable the mint button. */
    isPoolLoading: baseLoading || baseIsToken0 === undefined || !baseToken,
  };
}
