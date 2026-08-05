'use client';

import { useCallback, useState } from 'react';
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from 'wagmi';
import { getPublicClient } from 'wagmi/actions';
import { useQueryClient } from '@tanstack/react-query';
import { useMarketContracts, pythContract, swapRouter, usdc } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';
import { useActiveMarket } from '@/components/MarketProvider';
import { wagmiConfig } from '@/lib/wagmi';
import { erc20Abi } from '@/abis/erc20';
import { Side } from '@/lib/types';
import { fetchPythUpdate } from '@/lib/pyth';
import { ENV } from '@/lib/env';
import { friendlyError } from '@/lib/errors';

/** Min base fee floor on Arc testnet (≈20 Gwei) applied to every write. */
const MAX_FEE_PER_GAS_FLOOR = 20_000_000_000n; // 20 Gwei
const MAX_PRIORITY_FEE = 1_000_000_000n; // 1 Gwei

export interface CrankSlot<Args = void> {
  run: (args: Args, onSettled?: () => void) => void;
  isPending: boolean;
  isConfirming: boolean;
  isSuccess: boolean;
  error?: Error;
  hash?: `0x${string}`;
}

/** Internal: one write + receipt watcher + query invalidation, returning a uniform slot. */
function useCrank<Args>(
  build: (args: Args) => {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
  },
): CrankSlot<Args> {
  const qc = useQueryClient();
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const run = useCallback(
    (args: Args, onSettled?: () => void) => {
      reset();
      const cfg = build(args);
      writeContract(
        {
          address: cfg.address,
          abi: cfg.abi as never,
          functionName: cfg.functionName as never,
          args: (cfg.args ?? []) as never,
          ...(cfg.value !== undefined ? { value: cfg.value } : {}),
          // Named explicitly: these params are hand-built, so they never pass through withGasFloor
          // and would otherwise be signed on whatever network the wallet is pointed at.
          chainId: arcTestnet.id,
          maxFeePerGas: MAX_FEE_PER_GAS_FLOOR,
          maxPriorityFeePerGas: MAX_PRIORITY_FEE,
        },
        {
          onSettled: () => {
            // Polling is truth: nudge all FeeArena/oracle reads to refetch promptly.
            qc.invalidateQueries();
            onSettled?.();
          },
        },
      );
    },
    [build, writeContract, reset, qc],
  );

  return {
    run,
    isPending,
    isConfirming,
    isSuccess,
    error: error
      ? new Error(friendlyError(error))
      : undefined,
    hash,
  };
}

/**
 * Post-price crank: fetch a signed Pyth update from Hermes, price it via
 * Pyth.getUpdateFee, then writeContract the FeeArena crank with `args: [updateData]`
 * and `value: fee`. Used for startEpoch/endEpoch on the V1 trustless oracle.
 * Mirrors the CrankSlot status/hash/error contract; `isPending` also covers the
 * async fetch+fee phase so the button stays busy from click to receipt.
 */
function usePostPriceCrank(functionName: 'startEpoch' | 'endEpoch'): CrankSlot<void> {
  const { feeArena } = useMarketContracts();
  const market = useActiveMarket();
  const qc = useQueryClient();
  const { writeContract, data: hash, isPending: isWriting, error: writeError, reset } =
    useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepError, setPrepError] = useState<Error | undefined>(undefined);

  const run = useCallback(
    (_args: void, onSettled?: () => void) => {
      reset();
      setPrepError(undefined);
      setIsPreparing(true);
      void (async () => {
        try {
          // (a) signed price update from Hermes - for THIS market's Pyth feed (ETH or BTC, etc.)
          const { updateData } = await fetchPythUpdate(ENV.HERMES_URL, market.feedId);
          // (b) Pyth update fee for that update (paid as msg.value, refunded if excess)
          const client = getPublicClient(wagmiConfig, { chainId: arcTestnet.id });
          if (!client) throw new Error('No RPC client configured.');
          const fee = (await client.readContract({
            ...pythContract,
            functionName: 'getUpdateFee',
            args: [updateData],
          })) as bigint;
          // (c) crank: post the update + pay the fee
          writeContract(
            {
              address: feeArena.address,
              abi: feeArena.abi as never,
              functionName: functionName as never,
              args: [updateData] as never,
              value: fee,
              chainId: arcTestnet.id,
              maxFeePerGas: MAX_FEE_PER_GAS_FLOOR,
              maxPriorityFeePerGas: MAX_PRIORITY_FEE,
            },
            {
              onSettled: () => {
                qc.invalidateQueries();
                onSettled?.();
              },
            },
          );
        } catch (e) {
          setPrepError(new Error(friendlyError(e)));
        } finally {
          setIsPreparing(false);
        }
      })();
    },
    [functionName, writeContract, reset, qc, feeArena.address, feeArena.abi, market.feedId],
  );

  return {
    run,
    isPending: isPreparing || isWriting,
    isConfirming,
    isSuccess,
    error: prepError ?? (writeError ? new Error(friendlyError(writeError)) : undefined),
    hash,
  };
}

export interface AdminCranks {
  createEpoch: CrankSlot<void>;
  openEntry: CrankSlot<void>;
  startEpoch: CrankSlot<void>;
  endEpoch: CrankSlot<void>;
  sweep: CrankSlot<{ maxCount: bigint }>;
  finalizeSettle: CrankSlot<void>;
  foldDust: CrankSlot<{ epochId: bigint }>;
  emergencySettle: CrankSlot<{ epochId: bigint; resolution: Side }>;
  pause: CrankSlot<void>;
  unpause: CrankSlot<void>;
  setTiming: CrankSlot<{
    entryWindow: number;
    epochDuration: number;
    minStartGap: number;
    maxStartDelay: number;
    maxPriceAge: number;
  }>;
  setBand: CrankSlot<{ bandBps: number }>;
  setStakeCaps: CrankSlot<{ maxStakesPerEpoch: number; maxStakesPerUser: number }>;
  runSwap: CrankSlot<{
    /** Swap direction relative to the ACTIVE market's base leg (base→USDC or USDC→base). */
    direction: 'BASE_TO_USDC' | 'USDC_TO_BASE';
    /** The active market's base token address (non-USDC leg of the active pool). */
    baseToken: `0x${string}`;
    feeTier: number;
    recipient: `0x${string}`;
    amountIn: bigint;
  }>;
}

export function useAdminCranks(): AdminCranks {
  const { feeArena } = useMarketContracts();
  const arenaAddr = feeArena.address;
  const arenaAbi = feeArena.abi;
  // --- lifecycle cranks (no args) ---
  const createEpoch = useCrank<void>(
    useCallback(() => ({ address: arenaAddr, abi: arenaAbi, functionName: 'createEpoch' }), [arenaAddr, arenaAbi]),
  );
  const openEntry = useCrank<void>(
    useCallback(() => ({ address: arenaAddr, abi: arenaAbi, functionName: 'openEntry' }), [arenaAddr, arenaAbi]),
  );
  // startEpoch(bytes[]) / endEpoch(bytes[]) are payable: post a signed Hermes update
  // and pay the Pyth update fee (V1 trustless oracle - no admin setPrice).
  const startEpoch = usePostPriceCrank('startEpoch');
  const endEpoch = usePostPriceCrank('endEpoch');
  const sweep = useCrank<{ maxCount: bigint }>(
    useCallback(
      ({ maxCount }) => ({ address: arenaAddr, abi: arenaAbi, functionName: 'sweep', args: [maxCount] }),
      [arenaAddr, arenaAbi],
    ),
  );
  const finalizeSettle = useCrank<void>(
    useCallback(() => ({ address: arenaAddr, abi: arenaAbi, functionName: 'finalizeSettle' }), [arenaAddr, arenaAbi]),
  );
  const foldDust = useCrank<{ epochId: bigint }>(
    useCallback(
      ({ epochId }) => ({ address: arenaAddr, abi: arenaAbi, functionName: 'foldDust', args: [epochId] }),
      [arenaAddr, arenaAbi],
    ),
  );
  const emergencySettle = useCrank<{ epochId: bigint; resolution: Side }>(
    useCallback(
      ({ epochId, resolution }) => ({
        address: arenaAddr,
        abi: arenaAbi,
        functionName: 'emergencySettle',
        args: [epochId, resolution],
      }),
      [arenaAddr, arenaAbi],
    ),
  );
  const pause = useCrank<void>(
    useCallback(() => ({ address: arenaAddr, abi: arenaAbi, functionName: 'pause' }), [arenaAddr, arenaAbi]),
  );
  const unpause = useCrank<void>(
    useCallback(() => ({ address: arenaAddr, abi: arenaAbi, functionName: 'unpause' }), [arenaAddr, arenaAbi]),
  );

  // --- config setters ---
  const setTiming = useCrank<{
    entryWindow: number;
    epochDuration: number;
    minStartGap: number;
    maxStartDelay: number;
    maxPriceAge: number;
  }>(
    useCallback(
      (a) => ({
        address: arenaAddr,
        abi: arenaAbi,
        functionName: 'setTiming',
        args: [a.entryWindow, a.epochDuration, a.minStartGap, a.maxStartDelay, a.maxPriceAge],
      }),
      [arenaAddr, arenaAbi],
    ),
  );
  const setBand = useCrank<{ bandBps: number }>(
    useCallback(
      ({ bandBps }) => ({ address: arenaAddr, abi: arenaAbi, functionName: 'setBand', args: [bandBps] }),
      [arenaAddr, arenaAbi],
    ),
  );
  const setStakeCaps = useCrank<{ maxStakesPerEpoch: number; maxStakesPerUser: number }>(
    useCallback(
      (a) => ({
        address: arenaAddr,
        abi: arenaAbi,
        functionName: 'setStakeCaps',
        args: [a.maxStakesPerEpoch, a.maxStakesPerUser],
      }),
      [arenaAddr, arenaAbi],
    ),
  );

  // --- demo-only swap (EXACT-amount approval, never MAX) ---
  // NOTE: this single hook call submits exactInputSingle; the AdminDemoPanel handles the
  // prior exact-amount approve() as a separate explicit step via runApprove.
  const runSwap = useCrank<{
    direction: 'BASE_TO_USDC' | 'USDC_TO_BASE';
    baseToken: `0x${string}`;
    feeTier: number;
    recipient: `0x${string}`;
    amountIn: bigint;
  }>(
    useCallback(
      ({ direction, baseToken, feeTier, recipient, amountIn }) => {
        // Swap the ACTIVE market's base leg (passed in) against the global USDC - NOT the global
        // WETH (which is wrong on a BTC market). Fee tier comes from the caller (the pool fee).
        const [tokenIn, tokenOut] =
          direction === 'BASE_TO_USDC'
            ? [baseToken, usdc.address]
            : [usdc.address, baseToken];
        return {
          address: swapRouter.address,
          abi: swapRouter.abi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn,
              tokenOut,
              fee: feeTier,
              recipient,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
              amountIn,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
          value: 0n,
        };
      },
      [],
    ),
  );

  return {
    createEpoch,
    openEntry,
    startEpoch,
    endEpoch,
    sweep,
    finalizeSettle,
    foldDust,
    emergencySettle,
    pause,
    unpause,
    setTiming,
    setBand,
    setStakeCaps,
    runSwap,
  };
}

/** Exact-amount ERC-20 approval for the swap router (NEVER MAX) - used by the swap runner. */
export function useApproveExact(): CrankSlot<{
  token: `0x${string}`;
  amount: bigint;
}> {
  return useCrankApprove();
}

function useCrankApprove(): CrankSlot<{ token: `0x${string}`; amount: bigint }> {
  return useCrank<{ token: `0x${string}`; amount: bigint }>(
    useCallback(
      ({ token, amount }) => ({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [swapRouter.address, amount], // EXACT amount, never type(uint256).max
      }),
      [],
    ),
  );
}

/** Read the router allowance for a token, to decide whether an exact approve is needed first.
 * `token` may be undefined while the active pool's base leg is still resolving - the read is gated
 * off until both the token and owner are known. */
export function useRouterAllowance(token: `0x${string}` | undefined, ownerAddr?: `0x${string}`) {
  return useReadContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: ownerAddr ? [ownerAddr, swapRouter.address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !!ownerAddr && !!token },
  });
}
