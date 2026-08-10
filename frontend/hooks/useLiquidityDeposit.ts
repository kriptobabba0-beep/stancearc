'use client';

// hooks/useLiquidityDeposit.ts — the deposit mechanics for a range-selected V3 mint, lifted out of
// ProvideLiquidity so the new chart-driven /pool/[id] page reuses the EXACT same, battle-tested flow:
//   • reads the pool's live slot0 (sqrtPriceX96 / tick / human price) — also the source the chart +
//     presets use, so there's one price read;
//   • LINKED AMOUNTS — the last-edited leg drives, the other is the bigint-exact counterpart for the
//     CALLER-SUPPLIED range (the range comes from the chart handles OR a preset button);
//   • out-of-range one-sided handling, balances + insufficiency, NPM approvals, the mint + receipt→
//     tokenId parse, and the faucet-needed flag.
// The RANGE is an INPUT here (owned by the page); range SELECTION (chart/presets) lives in the page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useReadContract } from 'wagmi';
import { parseEventLogs, parseUnits } from 'viem';
import { useMintPosition, tickSpacingForFee } from '@/hooks/useMintPosition';
import { useTokenApproval } from '@/hooks/useTokenApproval';
import { useTxReceipt } from '@/hooks/useTxToast';
import { npm } from '@/lib/contracts';
import type { PoolInfo } from '@/lib/pools';
import { erc20Abi, uniswapV3PoolAbi } from '@/abis';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';
import { arcTestnet } from '@/lib/chain';
import {
  counterpartAmount,
  sqrtRatioAtTick,
  sqrtPriceX96ToPrice,
  tickRangeStatus,
  type TickRange,
} from '@/lib/rangeMath';
import { decodeSlot0 } from '@/lib/rangeDisplay';
import { formatBase, formatUSDC } from '@/lib/format';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

function parseAmount(s: string, decimals: number): bigint {
  try {
    return parseUnits((s || '0').trim(), decimals);
  } catch {
    return 0n;
  }
}

export function useLiquidityDeposit(pool: PoolInfo, range: TickRange | undefined, onMinted?: (tokenId: bigint) => void) {
  const { address, isConnected } = useAccount();
  const quote = pool.quote;
  const baseToken = pool.base.address;
  const baseDecimals = pool.base.decimals;
  const baseSymbol = pool.base.symbol;
  const baseIsToken0 = pool.baseIsToken0;
  const spacing = tickSpacingForFee(pool.feeTier);

  const [baseInput, setBaseInput] = useState('');
  const [usdcInput, setUsdcInput] = useState('');
  const [driver, setDriver] = useState<'base' | 'usdc' | null>(null);
  const [awaitingReceipt, setAwaitingReceipt] = useState(false);

  // Reset amounts when the pool (pair) switches.
  useEffect(() => {
    setBaseInput('');
    setUsdcInput('');
    setDriver(null);
    setAwaitingReceipt(false);
  }, [pool.id]);

  // ── Live pool price ──────────────────────────────────────────────────────────────
  const { data: slot0Raw } = useReadContract({
    address: pool.address,
    abi: uniswapV3PoolAbi,
    functionName: 'slot0',
    chainId: arcTestnet.id,
  });
  const slot0 = decodeSlot0(slot0Raw);
  const sqrtPriceX96 = slot0?.sqrtPriceX96 ?? 0n;
  const currentTick = slot0?.tick;
  const dec0 = baseIsToken0 ? baseDecimals : quote.decimals;
  const dec1 = baseIsToken0 ? quote.decimals : baseDecimals;
  const currentPrice = sqrtPriceX96 > 0n ? sqrtPriceX96ToPrice(sqrtPriceX96, dec0, dec1, baseIsToken0) : undefined;

  // ── Range status (one-sided when the band excludes the current price) ──────────────
  const rangeStatus =
    range && currentTick !== undefined
      ? tickRangeStatus(currentTick, range.tickLower, range.tickUpper)
      : undefined;
  const outOfRange = rangeStatus === 'below' || rangeStatus === 'above';
  const activeIsToken0 = rangeStatus === 'below';
  const baseActive = baseIsToken0 === activeIsToken0;
  const baseExcluded = outOfRange && !baseActive;
  const usdcExcluded = outOfRange && baseActive;

  const baseTyped = parseAmount(baseInput, baseDecimals);
  const usdcTyped = parseAmount(usdcInput, quote.decimals);

  const sqrtBounds = useMemo(
    () => (range ? { lower: sqrtRatioAtTick(range.tickLower), upper: sqrtRatioAtTick(range.tickUpper) } : undefined),
    [range],
  );

  const effectiveDriver: 'base' | 'usdc' | null = outOfRange ? (baseActive ? 'base' : 'usdc') : driver;
  const linked = effectiveDriver !== null && !!sqrtBounds && sqrtPriceX96 > 0n;

  let baseAmount = baseTyped;
  let usdcAmount = usdcTyped;
  let baseValue = baseInput;
  let usdcValue = usdcInput;
  if (linked && sqrtBounds) {
    if (effectiveDriver === 'base') {
      usdcAmount = outOfRange
        ? 0n
        : counterpartAmount({
            amountIn: baseTyped,
            inputIsToken0: baseIsToken0,
            sqrtPriceX96,
            sqrtLowerX96: sqrtBounds.lower,
            sqrtUpperX96: sqrtBounds.upper,
          });
      usdcValue = usdcExcluded ? '0' : usdcAmount > 0n ? formatUSDC(usdcAmount) : '';
    } else {
      baseAmount = outOfRange
        ? 0n
        : counterpartAmount({
            amountIn: usdcTyped,
            inputIsToken0: !baseIsToken0,
            sqrtPriceX96,
            sqrtLowerX96: sqrtBounds.lower,
            sqrtUpperX96: sqrtBounds.upper,
          });
      baseValue = baseExcluded ? '0' : baseAmount > 0n ? formatBase(baseAmount, baseDecimals) : '';
    }
  }
  const baseApprox = linked && effectiveDriver === 'usdc' && !baseExcluded && baseValue !== '';
  const usdcApprox = linked && effectiveDriver === 'base' && !usdcExcluded && usdcValue !== '';

  // ── Balances ───────────────────────────────────────────────────────────────────────
  const { data: baseBal } = useReadContract({
    address: baseToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: isConnected },
  });
  const { data: usdcBal } = useReadContract({
    address: quote.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: isConnected },
  });
  const baseBalance = (baseBal as bigint | undefined) ?? 0n;
  const usdcBalance = (usdcBal as bigint | undefined) ?? 0n;

  // ── Approvals + mint ─────────────────────────────────────────────────────────────
  const baseApproval = useTokenApproval(baseToken, npm.address, baseAmount, baseSymbol);
  const usdcApproval = useTokenApproval(quote.address, npm.address, usdcAmount, quote.symbol);
  const { mint, isPending: minting, error: mintError, hash: mintHash, isPoolLoading } = useMintPosition({
    baseToken,
    quoteToken: quote.address,
    baseIsToken0: pool.baseIsToken0,
    feeTier: pool.feeTier,
  });
  const { data: mintReceipt, isError: mintReceiptError } = useTxReceipt(mintHash, {
    chainId: arcTestnet.id,
    query: { enabled: !!mintHash },
  });

  useEffect(() => {
    if (!mintReceipt) return;
    if (address) {
      try {
        const logs = parseEventLogs({ abi: nonfungiblePositionManagerAbi, eventName: 'Transfer', logs: mintReceipt.logs });
        const mintLog = logs.find(
          (l) => l.args.from?.toLowerCase() === ZERO_ADDR && l.args.to?.toLowerCase() === address.toLowerCase(),
        );
        if (mintLog?.args.tokenId !== undefined) onMinted?.(mintLog.args.tokenId);
      } catch {
        /* non-fatal: the positions list refetches anyway */
      }
    }
    setAwaitingReceipt(false);
    setBaseInput('');
    setUsdcInput('');
    setDriver(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintReceipt, address]);
  useEffect(() => {
    if (mintReceiptError) setAwaitingReceipt(false);
  }, [mintReceiptError]);
  const prevHashRef = useRef<`0x${string}` | undefined>(undefined);
  useEffect(() => {
    const prev = prevHashRef.current;
    prevHashRef.current = mintHash;
    if (prev !== undefined && prev !== mintHash) setAwaitingReceipt(false);
  }, [mintHash]);

  const insufficientBase = isConnected && baseBal !== undefined && baseAmount > baseBalance;
  const insufficientUsdc = isConnected && usdcBal !== undefined && usdcAmount > usdcBalance;
  const needsApproval = baseApproval.needsApproval || usdcApproval.needsApproval;
  const amountsEntered = outOfRange
    ? (baseActive ? baseAmount : usdcAmount) > 0n
    : baseAmount > 0n && usdcAmount > 0n;
  const rangeReady = !!range;
  const approvalsReady = baseApproval.allowanceReady && usdcApproval.allowanceReady;
  const provideBusy = minting || awaitingReceipt;

  const canMint =
    isConnected &&
    !isPoolLoading &&
    approvalsReady &&
    rangeReady &&
    amountsEntered &&
    !insufficientBase &&
    !insufficientUsdc &&
    !needsApproval &&
    !provideBusy;

  const baseLow = baseBalance < baseAmount || baseBalance === 0n;

  const onBaseChange = (v: string) => {
    setBaseInput(v);
    setDriver('base');
  };
  const onUsdcChange = (v: string) => {
    setUsdcInput(v);
    setDriver('usdc');
  };
  const onMaxBase = () => {
    setBaseInput(formatBase(baseBalance, baseDecimals));
    setDriver('base');
  };
  const onMaxUsdc = () => {
    setUsdcInput(formatUSDC(usdcBalance));
    setDriver('usdc');
  };
  /** Set a fraction (0..1) of the wallet balance for a leg. */
  const onFractionBase = (frac: number) => {
    setBaseInput(formatBase((baseBalance * BigInt(Math.round(frac * 1000))) / 1000n, baseDecimals));
    setDriver('base');
  };
  const onFractionUsdc = (frac: number) => {
    setUsdcInput(formatUSDC((usdcBalance * BigInt(Math.round(frac * 1000))) / 1000n));
    setDriver('usdc');
  };

  const onMint = async () => {
    if (!range) return;
    setAwaitingReceipt(true);
    try {
      await mint({ baseAmount, usdcAmount, tickLower: range.tickLower, tickUpper: range.tickUpper });
    } catch {
      setAwaitingReceipt(false);
    }
  };

  return {
    // live pool state (the chart + presets read these)
    sqrtPriceX96,
    currentTick,
    currentPrice,
    dec0,
    dec1,
    spacing,
    slot0Loaded: slot0 !== undefined,
    // amounts
    baseValue,
    usdcValue,
    baseAmount,
    usdcAmount,
    baseApprox,
    usdcApprox,
    outOfRange,
    baseActive,
    baseExcluded,
    usdcExcluded,
    // balances
    baseBalance,
    usdcBalance,
    insufficientBase,
    insufficientUsdc,
    baseLow,
    // approvals + mint
    baseApproval,
    usdcApproval,
    needsApproval,
    canMint,
    provideBusy,
    rangeReady,
    amountsEntered,
    mintHash,
    mintError,
    isConnected,
    // handlers
    onBaseChange,
    onUsdcChange,
    onMaxBase,
    onMaxUsdc,
    onFractionBase,
    onFractionUsdc,
    onMint,
  };
}

export type LiquidityDeposit = ReturnType<typeof useLiquidityDeposit>;
