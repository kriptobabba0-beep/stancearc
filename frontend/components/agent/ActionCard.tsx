'use client';

// components/agent/ActionCard.tsx — the Limen Copilot's transaction confirmation card.
//
// The copilot never signs anything: it proposes, this card shows exactly what will happen,
// and the USER confirms — the signing runs through the app's existing, battle-tested hooks
// (useStakeWithSide, the same path the Stance modals use). Every outcome (executed, failed,
// declined) is reported back into the conversation so the copilot can acknowledge honestly.
import { useCallback, useEffect, useRef, useState } from 'react';
import { erc20Abi, formatUnits, maxUint256, parseUnits } from 'viem';
import { useAccount, usePublicClient } from 'wagmi';
import { ARC_CHAIN_ID, withGasFloor } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { uniswapV3PoolAbi } from '@/abis/uniswapV3Pool';
import { useMintPosition } from '@/hooks/useMintPosition';
import { planLiquidity } from '@/lib/agent/lpPlan';
import { decodeSlot0, formatHumanPrice } from '@/lib/rangeDisplay';
import { useStakeWithSide } from '@/hooks/useStakeWithSide';
import { useOwnedPositions } from '@/hooks/useOwnedPositions';
import { useSwap } from '@/hooks/useSwap';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useActiveMarket } from '@/components/MarketProvider';
import { tokenBySymbol, quoteToken } from '@/lib/tokens';
import { Side } from '@/lib/types';
import { cn } from '@/lib/cn';
import { TokenGlyph } from '@/components/TokenGlyph';
import type { ActionProposal } from '@/lib/agent/copilot';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

const SIDE_ENUM: Record<string, Side> = { UP: Side.UP, DOWN: Side.DOWN, RANGE: Side.RANGE };
const SIDE_BADGE: Record<string, string> = {
  UP: 'border-side-up/40 bg-side-up-soft text-side-up',
  DOWN: 'border-side-down/40 bg-side-down-soft text-side-down',
  RANGE: 'border-side-range/40 bg-surface-muted text-side-range',
};

export function ActionCard({
  action,
  onResult,
  onDismiss,
  autoConfirm = false,
}: {
  action: ActionProposal;
  /** Reports the outcome back into the conversation (becomes the next user turn). */
  onResult: (summary: string) => void;
  onDismiss: () => void;
  /** Autopilot auto-enter: fire the stake immediately on mount (the wallet still prompts). */
  autoConfirm?: boolean;
}) {
  const { stake, isPending: stakePending } = useStakeWithSide();
  const { swap, isPending: swapPending } = useSwap();
  const { data: oracle } = useOraclePrice();
  const market = useActiveMarket();
  const [failed, setFailed] = useState<string | null>(null);

  const { data: positions } = useOwnedPositions();
  const stakeable = positions ?? [];
  // The card executes against the ACTIVE market's contracts — a proposal for another
  // market must not sign here (wrong pool, wrong arena). The user switches first.
  const marketMismatch = action.marketId !== market.id;
  const canStake = action.type === 'stake' && stakeable.length > 0 && !marketMismatch;
  const tokenId = canStake ? stakeable[0]!.tokenId : undefined;
  const isPending = stakePending || swapPending;

  const confirmSwap = async () => {
    if (action.amountUsdc === undefined) return;
    setFailed(null);
    try {
      const tokenIn = quoteToken(market.quoteSymbol);
      const tokenOut = tokenBySymbol(market.baseSymbol);
      if (!tokenOut) throw new Error(`unknown base token ${market.baseSymbol}`);
      const price18 = oracle?.price18 ?? 0n;
      if (price18 <= 0n) throw new Error('live price unavailable — try again in a moment');
      // toFixed clamps the model's number to the token's own precision — parseUnits throws
      // on excess fractional digits (e.g. "100.1234567" into 6dp USDC).
      const amountIn = parseUnits(action.amountUsdc.toFixed(tokenIn.decimals), tokenIn.decimals);
      // Expected base out at the live oracle price, floored 2% for pool slippage/fees.
      const expectedOut = (amountIn * 10n ** BigInt(18 + tokenOut.decimals - tokenIn.decimals)) / price18;
      const amountOutMinimum = (expectedOut * 9_800n) / 10_000n;
      await swap({ tokenIn: tokenIn.address, tokenOut: tokenOut.address, amountIn, amountOutMinimum });
      onResult(
        `[Action result] I confirmed the swap and it was submitted: ${action.amountUsdc} ${tokenIn.symbol} -> ${market.baseSymbol} (min out ${amountOutMinimum.toString()} raw). Acknowledge briefly.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'swap failed';
      setFailed(msg);
      onResult(`[Action result] The swap FAILED: ${msg}. Explain briefly and suggest what to check.`);
    }
  };

  const confirmStake = async () => {
    if (tokenId === undefined || action.side === undefined) return;
    setFailed(null);
    try {
      await stake({ tokenId, side: SIDE_ENUM[action.side]! });
      onResult(
        `[Action result] I confirmed the proposal and the stake transaction was submitted: side ${action.side}, LP position #${tokenId.toString()}. Acknowledge briefly.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'transaction failed';
      setFailed(msg);
      onResult(`[Action result] The stake transaction FAILED before signing/confirmation: ${msg}. Explain briefly and suggest what to check.`);
    }
  };

  const decline = () => {
    onDismiss();
    onResult('[Action result] I declined the proposed action. Acknowledge briefly and do not re-propose unless I ask.');
  };

  // Auto-enter (autopilot): submit the stake as soon as the card can act — once. The
  // user's wallet still shows its own signing prompt; only the in-app card step is skipped.
  const autoFired = useRef(false);
  useEffect(() => {
    if (autoConfirm && !autoFired.current && action.type === 'stake' && canStake && !isPending) {
      autoFired.current = true;
      void confirmStake();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConfirm, canStake]);

  return (
    <div
      data-testid="agent-action-card"
      className={cn(
        'mt-3 rounded-2xl border px-5 py-4',
        action.type === 'claim'
          ? 'border-brand/60 bg-surface shadow-[0_0_36px_rgb(229_72_77/0.18)]'
          : 'border-brand/35 bg-surface',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        {action.type === 'claim' ? (
          <>
            <span className="text-[15px] font-semibold text-ink">Claimable reward detected</span>
            <span className="rounded-full border border-side-up/50 px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-side-up">
              Claimable
            </span>
          </>
        ) : (
          <span className="kicker font-mono text-brand">
            {autoConfirm ? 'Autopilot · auto-entering (confirm in your wallet)' : 'Action · needs your confirmation'}
          </span>
        )}
        {action.type === 'stake' && action.side && (
          <span className={cn('rounded-md border px-2 py-0.5 font-mono text-xs font-bold uppercase', SIDE_BADGE[action.side])}>
            {action.side}
          </span>
        )}
      </div>

      {action.type !== 'claim' && <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">{action.note}</p>}

      {marketMismatch && action.type !== 'claim' && (
        <p className="mt-2 font-mono text-[12.5px] text-[#d99e3b]">
          This proposal targets {action.marketId}, but you are viewing {market.id} — switch markets (top right) and ask again.
        </p>
      )}

      {action.type === 'stake' && (
        <>
          <p className="mt-2 font-mono text-[12.5px] text-ink-muted">
            {canStake
              ? `Enters the current ${action.marketId} epoch with LP position #${tokenId!.toString()} — your wallet signs; only this epoch's fee allocation is at stake, never LP principal.`
              : 'You have no stakeable LP position on this market yet — add liquidity first, then ask me again.'}
          </p>
          {failed && <p className="mt-2 font-mono text-[12.5px] text-side-down">Failed: {failed}</p>}
          <div className="mt-3 flex items-center gap-2">
            {canStake ? (
              <button
                type="button"
                onClick={() => void confirmStake()}
                disabled={isPending}
                className="rounded-lg bg-brand px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {isPending ? 'Submitting…' : `Confirm ${action.side}`}
              </button>
            ) : (
              <a
                href="/stance"
                className="rounded-lg bg-brand px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90"
              >
                Add liquidity
              </a>
            )}
            <DeclineButton onClick={decline} disabled={isPending} />
          </div>
        </>
      )}

      {action.type === 'swap' && (
        <>
          <p className="mt-2 font-mono text-[12.5px] text-ink-muted">
            Swaps {action.amountUsdc} {quoteToken(market.quoteSymbol).symbol} → {market.baseSymbol} on the {action.marketId} pool at the live
            oracle rate (2% slippage floor — reverts rather than fill worse). Your wallet signs.
          </p>
          {failed && <p className="mt-2 font-mono text-[12.5px] text-side-down">Failed: {failed}</p>}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void confirmSwap()}
              disabled={isPending || marketMismatch}
              className="rounded-lg bg-brand px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? 'Submitting…' : `Confirm swap $${action.amountUsdc}`}
            </button>
            <DeclineButton onClick={decline} disabled={isPending} />
          </div>
        </>
      )}

      {action.type === 'add_liquidity' && (
        <AddLiquidityInline action={action} blocked={marketMismatch} onResult={onResult} onDecline={decline} />
      )}

      {action.type === 'claim' && <ClaimInline tokenIds={action.tokenIds} onResult={onResult} onDecline={decline} />}
    </div>
  );
}

/** In-chat LP mint: the proposal's amount + optional price band become a REAL position.
 *  Both token legs are computed from the live pool price for the exact range, approvals are
 *  topped up as needed, and the user's wallet signs — no page handoff. */
function AddLiquidityInline({
  action,
  blocked = false,
  onResult,
  onDecline,
}: {
  action: ActionProposal;
  /** True when the proposal targets a market other than the one on screen. */
  blocked?: boolean;
  onResult: (summary: string) => void;
  onDecline: () => void;
}) {
  const market = useActiveMarket();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { address } = useAccount();
  const { writeContractAsync } = useArcWriteContract();
  const { mint, isPending: mintPending } = useMintPosition();
  const base = tokenBySymbol(market.baseSymbol);
  const quote = quoteToken(market.quoteSymbol);

  interface Plan {
    tickLower: number;
    tickUpper: number;
    baseLeg: bigint;
    usdcLeg: bigint;
    rangeLabel: string;
    priceNow: number;
    outOfBand: boolean;
    shortfall: string | null;
  }
  const [plan, setPlan] = useState<Plan | null>(null);
  const [phase, setPhase] = useState<'reading' | 'ready' | 'approving' | 'minting'>('reading');
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const build = async () => {
      try {
        if (!publicClient || !address || !base || action.amountUsdc === undefined) {
          if (alive) {
            setFailed(!address ? 'connect your wallet first' : 'the proposal is missing its amount');
            setPhase('ready');
          }
          return;
        }
        const slot0 = decodeSlot0(
          await publicClient.readContract({ address: market.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' }),
        );
        if (!slot0) throw new Error('pool price unavailable — try again in a moment');
        // The size-and-split math is pure (lib/agent/lpPlan) — this component only reads
        // the pool + balances and signs.
        const sized = planLiquidity({
          amountUsdc: action.amountUsdc,
          priceLower: action.priceLower,
          priceUpper: action.priceUpper,
          sqrtPriceX96: slot0.sqrtPriceX96,
          baseDecimals: base.decimals,
          quoteDecimals: quote.decimals,
          baseIsToken0: BigInt(base.address) < BigInt(quote.address),
          feeTier: ENV.FEE_TIER,
        });

        const [baseBal, usdcBal] = await Promise.all([
          publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
          publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
        ]);
        const missing: string[] = [];
        if (baseBal < sized.baseLeg) missing.push(`${formatUnits(sized.baseLeg - baseBal, base.decimals)} more ${base.symbol}`);
        if (usdcBal < sized.usdcLeg) missing.push(`${formatUnits(sized.usdcLeg - usdcBal, quote.decimals)} more ${quote.symbol}`);

        if (!alive) return;
        setPlan({
          ...sized,
          rangeLabel:
            action.priceLower !== undefined && action.priceUpper !== undefined
              ? `${formatHumanPrice(action.priceLower)} – ${formatHumanPrice(action.priceUpper)} ${quote.symbol}`
              : 'Full range',
          shortfall: missing.length > 0 ? `You are short ${missing.join(' and ')}.` : null,
        });
        setPhase('ready');
      } catch (err) {
        if (!alive) return;
        setFailed(err instanceof Error ? err.message : 'could not read the pool');
        setPhase('ready');
      }
    };
    void build();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, address, market.id, action.amountUsdc, action.priceLower, action.priceUpper]);

  const confirm = async () => {
    if (plan === null || !publicClient || !address || !base) return;
    setFailed(null);
    try {
      // Top up NPM allowances for exactly the legs the mint will pull.
      setPhase('approving');
      for (const { token, amount } of [
        { token: base.address, amount: plan.baseLeg },
        { token: quote.address, amount: plan.usdcLeg },
      ]) {
        if (amount <= 0n) continue;
        const allowance = (await publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, ENV.NPM_ADDRESS],
        })) as bigint;
        if (allowance >= amount) continue;
        const { request } = await publicClient.simulateContract({
          account: address,
          address: token,
          abi: erc20Abi,
          functionName: 'approve',
          args: [ENV.NPM_ADDRESS, maxUint256],
        });
        const tx = await writeContractAsync(withGasFloor(request) as Parameters<typeof writeContractAsync>[0]);
        await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
      }
      setPhase('minting');
      await mint({ baseAmount: plan.baseLeg, usdcAmount: plan.usdcLeg, tickLower: plan.tickLower, tickUpper: plan.tickUpper });
      setPhase('ready');
      onResult(
        `[Action result] I confirmed the liquidity add and the mint was submitted: ~${formatUnits(plan.baseLeg, base.decimals)} ${base.symbol} + ${formatUnits(plan.usdcLeg, quote.decimals)} ${quote.symbol}, range ${plan.rangeLabel}. Acknowledge briefly.`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'mint failed';
      setFailed(msg);
      setPhase('ready');
      onResult(`[Action result] The liquidity add FAILED: ${msg}. Explain briefly and suggest what to check.`);
    }
  };

  const busy = phase === 'approving' || phase === 'minting' || mintPending;
  return (
    <>
      {plan === null && failed === null && (
        <p className="mt-2 font-mono text-[12.5px] text-ink-muted">Reading the pool price and sizing both legs…</p>
      )}
      {plan !== null && base && (
        <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1 font-mono text-[12.5px] text-ink-muted">
          <span className="text-ink-faint">RANGE</span>
          <span className="text-ink-faint">TOTAL</span>
          <span className="text-ink-faint">LEGS</span>
          <span className="text-ink">{plan.rangeLabel}</span>
          <span className="text-ink">
            {action.amountUsdc} {quote.symbol}
          </span>
          <span className="text-ink">
            {Number(formatUnits(plan.baseLeg, base.decimals)).toFixed(6)} {base.symbol} + {Number(formatUnits(plan.usdcLeg, quote.decimals)).toFixed(2)}{' '}
            {quote.symbol}
          </span>
        </div>
      )}
      {plan !== null && plan.outOfBand && (
        <p className="mt-2 font-mono text-[12.5px] text-[#d99e3b]">
          The live price ({formatHumanPrice(plan.priceNow)} {quote.symbol}) is OUTSIDE this band — the position starts one-sided and earns no fees
          until the price enters the range.
        </p>
      )}
      {plan?.shortfall && <p className="mt-2 font-mono text-[12.5px] text-side-down">{plan.shortfall}</p>}
      {failed && <p className="mt-2 font-mono text-[12.5px] text-side-down">Failed: {failed}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={plan === null || plan.shortfall !== null || busy || blocked}
          className="rounded-lg bg-brand px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {phase === 'approving' ? 'Approving…' : phase === 'minting' ? 'Minting…' : `Add $${action.amountUsdc} liquidity`}
        </button>
        <DeclineButton onClick={onDecline} disabled={busy} />
      </div>
    </>
  );
}

/** In-chat claiming: exact amounts per position from previewClaim, claimed right here. */
function ClaimInline({
  tokenIds,
  onResult,
  onDecline,
}: {
  tokenIds?: string[];
  onResult: (summary: string) => void;
  onDecline: () => void;
}) {
  const market = useActiveMarket();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { writeContractAsync } = useArcWriteContract();
  interface Row {
    id: string;
    epochId: string;
    usdc: bigint;
    base: bigint;
    state: 'ready' | 'claiming' | 'claimed' | 'failed';
  }
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!publicClient) return;
      try {
        const ids = [...new Set(tokenIds ?? [])];
        const out: Row[] = [];
        for (const id of ids.slice(0, 12)) {
          const [pv, st] = await Promise.all([
            publicClient.readContract({
              address: market.feeArena,
              abi: feeArenaV3Abi,
              functionName: 'previewClaim',
              args: [BigInt(id)],
            }) as Promise<{ claimable: boolean; ownFeeBase: bigint; ownFeeUSDC: bigint; potShareBase: bigint; potShareUSDC: bigint }>,
            publicClient.readContract({
              address: market.feeArena,
              abi: feeArenaV3Abi,
              functionName: 'getStake',
              args: [BigInt(id)],
            }) as Promise<{ epochId: bigint }>,
          ]);
          if (pv.claimable) {
            out.push({
              id,
              epochId: st.epochId.toString(),
              usdc: pv.ownFeeUSDC + pv.potShareUSDC,
              base: pv.ownFeeBase + pv.potShareBase,
              state: 'ready',
            });
          }
        }
        if (alive) setRows(out);
      } catch {
        if (alive) setRows([]);
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [publicClient, market.feeArena, tokenIds]);

  const claimOne = useCallback(
    async (row: Row) => {
      if (!publicClient) return;
      setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, state: 'claiming' } : r)) ?? null);
      try {
        const { request } = await publicClient.simulateContract({
          address: market.feeArena,
          abi: feeArenaV3Abi,
          functionName: 'claim',
          args: [BigInt(row.id)],
          gas: 800_000n,
        });
        const tx = await writeContractAsync(withGasFloor(request) as Parameters<typeof writeContractAsync>[0]);
        await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
        setRows((prev) => {
          const next = prev?.map((r) => (r.id === row.id ? { ...r, state: 'claimed' as const } : r)) ?? null;
          if (next !== null && next.every((r) => r.state === 'claimed')) {
            const totalU = next.reduce((a, r) => a + r.usdc, 0n);
            const totalB = next.reduce((a, r) => a + r.base, 0n);
            onResult(
              `[Action result] I claimed ${next.length} win${next.length > 1 ? 's' : ''} directly from the chat: $${formatUnits(totalU, 6)} + ${formatUnits(totalB, market.baseDecimals)} ${market.baseSymbol} paid out. Acknowledge briefly.`,
            );
          }
          return next;
        });
      } catch {
        setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, state: 'failed' } : r)) ?? null);
      }
    },
    [publicClient, market.feeArena, market.baseDecimals, market.baseSymbol, writeContractAsync, onResult],
  );

  return (
    <>
      {rows === null ? (
        <p className="mt-2 font-mono text-[12.5px] text-ink-muted">Reading your claimable winnings…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 font-mono text-[12.5px] text-ink-muted">
          Nothing is claimable right now — wins appear here the moment their epoch settles.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-line bg-surface-muted/30 px-5 py-3.5">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Epoch</div>
                <div className="mt-1 text-[16px] font-bold text-ink">{r.epochId}</div>
              </div>
              <div className="h-9 w-px bg-line" aria-hidden="true" />
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Market</div>
                <div className="mt-1 flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                  <TokenGlyph symbol="cirBTC" className="h-[18px] w-[18px]" />
                  {market.label}
                </div>
              </div>
              <div className="h-9 w-px bg-line" aria-hidden="true" />
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Amount to claim</div>
                <div className="mt-1 text-[16px] font-bold text-ink">
                  ${formatUnits(r.usdc, 6)}{r.base > 0n ? ` + ${formatUnits(r.base, market.baseDecimals)} ${market.baseSymbol}` : ' USDC'}
                </div>
              </div>
              <div className="ml-auto">
                {r.state === 'claimed' ? (
                  <span className="font-mono text-[13px] font-semibold text-side-up">Claimed ✓</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void claimOne(r)}
                    disabled={r.state === 'claiming'}
                    className="flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-[14px] font-semibold text-white shadow-[0_6px_24px_rgb(229_72_77/0.35)] transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {r.state === 'claiming' ? 'Claiming…' : r.state === 'failed' ? 'Retry claim' : `Claim ${formatUnits(r.usdc, 6)} USDC`}
                    <span aria-hidden="true">→</span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <DeclineButton onClick={onDecline} />
        <a href="/stance#arena-claim" className="font-mono text-[11px] uppercase tracking-wide text-ink-faint underline-offset-2 hover:text-ink hover:underline">
          open the full claim panel
        </a>
      </div>
    </>
  );
}

function DeclineButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-line px-4 py-2 font-mono text-[13px] font-semibold uppercase tracking-wide text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
    >
      Decline
    </button>
  );
}
