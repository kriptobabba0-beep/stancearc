// arb.ts — the price-keeper ARBITRAGE bot. A SEPARATE process with a SEPARATE key from
// the lifecycle keeper. Each poll it reads the market's Uniswap-V3 pool (slot0 +
// liquidity), reads the live Pyth reference from Hermes (READ-ONLY — it never posts Pyth
// updates on-chain), decides via the PURE decideArb() whether the pool has drifted far
// enough from the reference to trade, and on SWAP executes a single exactInputSingle that
// nudges the pool back toward the oracle. The AMM's real 0.3% fee on that swap accrues to
// LPs / the pot — which is the whole point: REAL fees fund the arena.
//
// Reuses the keeper skeleton:
//   - viem fallback([http...]) transport over KEEPER_RPC_URLS (one RPC outage != stall).
//   - every write pins maxFeePerGas/maxPriorityFeePerGas to the Arc gas floor.
//   - ONE in-flight tx per key: runArbOnce awaits the receipt before returning, so the
//     single arb key never races its own nonce.
//   - per-market exponential backoff + a loud WEDGED alert (backoff.ts helpers) on
//     repeated failure OR a non-shrinking divergence.
//
// SAFETY: the swap's sqrtPriceLimitX96 is PINNED to the ref-target tick, so the AMM bounds
// the trade — it can fill UP TO the oracle price and no further; it can never overshoot and
// push the pool past the reference. amountOutMinimum is set at slippageBps so a sandwich /
// adverse fill reverts instead of executing at a bad price.
import {
  WaitForTransactionReceiptTimeoutError,
  defineChain,
  fallback,
  http,
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { erc20Abi, swapRouterAbi, v3PoolAbi } from './abi.js';
import { fetchPythRef, fetchPythCrossRef, type PythRef } from './hermes.js';
import { escalatedGas, totalAttempts, type GasOverrides } from './gasEscalation.js';
import { sqrtPriceX96ToPrice18, price18ToSqrtPriceX96 } from './poolMath.js';
import { decideArb, type ArbDecision, type ArbState, type HeartbeatState } from './decideArb.js';
import {
  loadFlowLedger,
  saveFlowLedgerSync,
  recordFlow,
  pruneWindow,
  buildFlowState,
  type FlowLedger,
  type FlowState,
} from './flowLedger.js';
import {
  freshHeartbeatLedger,
  rollHeartbeatDay,
  recordHeartbeatSpend,
  recordHeartbeatAttempt,
  recordRebalanceAttempt,
  snapshotHeartbeat,
  type HeartbeatLedger,
} from './heartbeat.js';
import { loadArbConfig, type ArbConfig } from './config.js';
import {
  freshRuntime,
  recordFailure,
  recordSuccess,
  shouldSkip,
  type MarketRuntime,
} from './backoff.js';
import { startArbHealthServer, type ArbHealthState, type ArbMetricsSnapshot } from './arbHealth.js';
import {
  loadMetricsState,
  saveMetricsState,
  type PersistedMetrics,
} from './metricsState.js';
import { createAlerter } from './alert.js';

/** Structured single-line log record for one arb tick. */
export interface ArbTickLog {
  ts: string;
  market: string;
  kind: ArbDecision['kind'];
  direction?: ArbDecision['direction'];
  /** Why a SWAP was issued: 'arb' | 'rebalance' | 'heartbeat' (TASK 3). Present on SWAP. */
  purpose?: ArbDecision['purpose'];
  poolPrice18?: string;
  ref18?: string;
  divBps?: number;
  /**
   * |divergence| (bps) measured AFTER a successful swap settles — the pool is re-read
   * post-receipt and compared against the SAME ref18 used to size the trade, so the
   * shrink-watchdog (in main()) judges whether OUR swap moved the pool, not whether the
   * Pyth ref drifted between ticks. Present only after a successful SWAP. (LOW fix:
   * eliminates the watchdog false-positive when the live ref moves during volatility.)
   */
  postSwapDivBps?: number;
  amountInBase?: string;
  txHash?: string;
  reason: string;
  error?: string;
}

/** Emit a structured log line (bigint-safe). */
export function logArb(rec: ArbTickLog): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(rec, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** Signed pool-vs-ref divergence in bps (for logging/observability). */
export function divergenceBps(poolPrice18: bigint, ref18: bigint): number {
  if (ref18 <= 0n) return 0;
  return Number(((poolPrice18 - ref18) * 10_000n) / ref18);
}

/**
 * Resolve the arb's peg REFERENCE for a market. A single-feed market reads `feedId` directly
 * (base/USD). A CROSS-quoted market (quoteFeedId set, e.g. cirBTC/EURC) reads the cross rate
 * `feedId ÷ quoteFeedId` (BTC/USD ÷ EUR/USD = BTC/EUR) — the SAME math the on-chain
 * CompositePythOracle uses, so the keeper's peg target agrees with what the arena settles on.
 * GATED on quoteFeedId: a market WITHOUT it takes the EXACT pre-existing single-feed path, so the
 * cirBTC/USDC arb is byte-for-byte unchanged. This is the ONLY market-type branch in the engine.
 */
export function fetchArbRef(
  hermesUrl: string,
  m: ArbConfig['market'],
  timeoutMs: number,
): Promise<PythRef> {
  return m.quoteFeedId !== undefined
    ? fetchPythCrossRef(hermesUrl, m.feedId, m.quoteFeedId, timeoutMs)
    : fetchPythRef(hermesUrl, m.feedId, timeoutMs);
}

/** The outcome of evaluating the shrink-watchdog for one tick (PURE). */
export interface WatchdogEval {
  /** True if this tick should be counted as a FAILURE (arms the breaker). */
  fail: boolean;
  /**
   * The new watchdog baseline (|post-swap divergence|) to carry into the next tick, or
   * the unchanged previous baseline when this tick produced no attributable measurement.
   */
  nextBaseline: number | null;
  /** Why (for logging / test assertions). */
  reason: 'error' | 'non-shrinking' | 'shrinking' | 'unattributable';
}

/**
 * LOW fix — PURE shrink-watchdog decision. The OLD watchdog compared the PRE-trade divBps
 * across ticks, so it false-positived whenever the live Pyth ref moved between ticks
 * (normal during volatility). This judges the POST-SWAP divergence instead — the pool is
 * re-read AFTER the receipt and compared against the SAME ref used to size the trade
 * (rec.postSwapDivBps), isolating the effect of OUR swap.
 *
 * Rules:
 *   - rec.error set                          -> FAIL (already a real failure).
 *   - successful SWAP w/ a post-swap measure -> compare |postSwapDivBps| to the prior
 *       attributable baseline: it must SHRINK; >= prior is a non-shrink FAIL. The new
 *       baseline becomes this |postSwapDivBps|.
 *   - anything else (NONE/SKIP/ALERT, or a swap whose post-read failed) -> NOT a watchdog
 *       failure and the baseline is UNCHANGED (so the next comparison stays swap-to-swap).
 *
 * The first attributable swap (prevBaseline === null) can never non-shrink — there is
 * nothing to compare against — so it only SEEDS the baseline.
 */
export function evaluateWatchdog(rec: ArbTickLog, prevBaseline: number | null): WatchdogEval {
  if (rec.error !== undefined) {
    return { fail: true, nextBaseline: prevBaseline, reason: 'error' };
  }
  // TASK 3 — ONLY a price-convergence arb is judged by the shrink-watchdog. A rebalance or
  // heartbeat swap is NOT trying to close a price gap (a heartbeat at ~0 divergence may even
  // nudge it slightly), so judging it for "shrink" would false-positive a WEDGE. Its success
  // is judged by the receipt (a revert sets rec.error -> the FAIL path above) — not here.
  const isArbSwap = rec.kind === 'SWAP' && (rec.purpose === undefined || rec.purpose === 'arb');
  const attributable = isArbSwap && rec.postSwapDivBps !== undefined;
  if (!attributable) {
    return { fail: false, nextBaseline: prevBaseline, reason: 'unattributable' };
  }
  const postAbs = Math.abs(rec.postSwapDivBps!);
  if (prevBaseline !== null && postAbs >= prevBaseline) {
    return { fail: true, nextBaseline: postAbs, reason: 'non-shrinking' };
  }
  return { fail: false, nextBaseline: postAbs, reason: 'shrinking' };
}

/** Build the viem clients + account for the arb config. Pure construction — no I/O. */
export function buildArbClients(cfg: ArbConfig, chainId: number) {
  const account = privateKeyToAccount(cfg.privateKey);
  const chain: Chain = defineChain({
    id: chainId,
    name: `arc-${chainId}`,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
  const transport = fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  return { account, chain, publicClient, walletClient };
}

/** Whether the base token is token0 of the pool (resolved once at startup). */
export async function resolveBaseIsToken0(
  client: PublicClient,
  pool: ArbConfig['market']['pool'],
  base: ArbConfig['market']['base'],
): Promise<boolean> {
  const token0 = await client.readContract({ address: pool, abi: v3PoolAbi, functionName: 'token0' });
  return token0.toLowerCase() === base.toLowerCase();
}

/**
 * Read the pool's slot0 + liquidity + its REAL token balances and derive poolPrice18. The pool's
 * base/quote balanceOf are the hard ceilings the deliverability cap uses so a leg can never ask the
 * pool for more than it holds (the "Too little received" / one-sided-pool fix).
 */
async function readPool(
  client: PublicClient,
  m: ArbConfig['market'],
  baseIsToken0: boolean,
): Promise<{ poolPrice18: bigint; liquidity: bigint; sqrtPriceX96: bigint; poolBaseBal: bigint; poolQuoteBal: bigint }> {
  const [slot0, liquidity, poolBaseBal, poolQuoteBal] = await Promise.all([
    client.readContract({ address: m.pool, abi: v3PoolAbi, functionName: 'slot0' }),
    client.readContract({ address: m.pool, abi: v3PoolAbi, functionName: 'liquidity' }),
    client.readContract({ address: m.base, abi: erc20Abi, functionName: 'balanceOf', args: [m.pool] }) as Promise<bigint>,
    client.readContract({ address: m.quote, abi: erc20Abi, functionName: 'balanceOf', args: [m.pool] }) as Promise<bigint>,
  ]);
  const sqrtPriceX96 = slot0[0];
  const poolPrice18 = sqrtPriceX96ToPrice18(sqrtPriceX96, m.baseDecimals, m.quoteDecimals, baseIsToken0);
  return { poolPrice18, liquidity, sqrtPriceX96, poolBaseBal, poolQuoteBal };
}

/** Read the bot's spendable base + USDC inventory. */
async function readInventory(
  client: PublicClient,
  m: ArbConfig['market'],
  owner: `0x${string}`,
): Promise<{ inventoryBase: bigint; inventoryUsdc: bigint }> {
  const [inventoryBase, inventoryUsdc] = await Promise.all([
    client.readContract({ address: m.base, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    client.readContract({ address: m.quote, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  ]);
  return { inventoryBase, inventoryUsdc };
}

/** Max uint256 — the allowance we set so the router is approved once, not per-swap. */
const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * Approve the router for a token if its allowance is below this threshold. We use half of
 * max-uint256 so a token that was already approved to (or near) the max isn't needlessly
 * re-approved, while any practical shortfall (incl. exactly 0) triggers a fresh approval.
 */
const APPROVAL_THRESHOLD = MAX_UINT256 / 2n;

/** A token leg to preflight-approve, for structured logging. */
export type ApprovalLeg = 'base' | 'quote';

/**
 * One token's allowance-preflight result. `approvedTxHash` is set only when an approval
 * was actually sent; `sufficient` reflects the allowance found BEFORE any approval.
 */
export interface ApprovalResult {
  leg: ApprovalLeg;
  token: `0x${string}`;
  allowance: bigint;
  sufficient: boolean;
  approvedTxHash?: `0x${string}`;
}

/**
 * MEDIUM fix — router allowance preflight. Without a prior ERC20 approve, EVERY
 * exactInputSingle reverts with STF ("SafeTransferFrom failed") and the bot wedges
 * opaquely (the per-market breaker just keeps backing off with an inscrutable revert).
 * At startup we check allowance(owner, router) for BOTH the base AND the quote token
 * (a SELL_BASE spends base, a BUY_BASE spends quote — both must be approved) and, when
 * short, send ONE max-uint256 approval per token, awaiting each receipt so the first real
 * swap can't race an unconfirmed approval. If `autoApprove` is false we DON'T send a tx;
 * the caller can fail fast with an actionable "approve the router" error instead.
 *
 * Pure-ish: it performs chain reads/writes but holds no state and returns a structured
 * result per leg for logging. Threaded gas pins to the Arc floor like every other write.
 */
export async function ensureRouterApprovals(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  m: ArbConfig['market'],
  gasFloorWei: bigint,
  receiptTimeoutMs: number,
  autoApprove: boolean,
): Promise<ApprovalResult[]> {
  const legs: { leg: ApprovalLeg; token: `0x${string}` }[] = [
    { leg: 'base', token: m.base },
    { leg: 'quote', token: m.quote },
  ];
  const gas = { maxFeePerGas: gasFloorWei, maxPriorityFeePerGas: gasFloorWei } as const;
  const results: ApprovalResult[] = [];

  for (const { leg, token } of legs) {
    const allowance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [account.address, m.router],
    });
    const sufficient = allowance >= APPROVAL_THRESHOLD;
    if (sufficient) {
      results.push({ leg, token, allowance, sufficient: true });
      continue;
    }
    if (!autoApprove) {
      throw new Error(
        `[arb] router ${m.router} not approved for ${leg} token ${token} ` +
          `(allowance ${allowance}). Approve the router for this token, or enable auto-approve.`,
      );
    }
    const approvedTxHash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      account,
      chain,
      ...gas,
      args: [m.router, MAX_UINT256],
    });
    const receipt = await client.waitForTransactionReceipt({ hash: approvedTxHash, timeout: receiptTimeoutMs });
    if (receipt.status !== 'success') {
      throw new Error(`[arb] approval tx ${approvedTxHash} for ${leg} token ${token} reverted`);
    }
    results.push({ leg, token, allowance, sufficient: false, approvedTxHash });
  }
  return results;
}

/**
 * FINDING 1 fix — the direction-correct sqrtPriceLimit for a swap.
 *
 * The vendored Uniswap-V3 pool's `swap` enforces (the `SPL` require) that the limit be
 * STRICTLY past the CURRENT pool price in the swap direction:
 *   zeroForOne (tokenIn == token0)  -> limit < slot0.sqrtPriceX96
 *   !zeroForOne (tokenIn == token1) -> limit > slot0.sqrtPriceX96
 * A limit on the wrong side (or exactly equal — the pool==ref / in-band case) reverts SPL.
 *
 * `zeroForOne` is derived from the swap DIRECTION + the pool's token sort:
 *   SELL_BASE spends base  => zeroForOne = baseIsToken0      (base is the token going IN)
 *   BUY_BASE  spends quote => zeroForOne = !baseIsToken0     (quote is the token going IN)
 *
 * We offset the CURRENT pool sqrt by `offsetBps` in the required direction so the limit is
 * ALWAYS strictly past current (never equal), bounding the fill by a few bps of slippage:
 *   zeroForOne  -> currentSqrt * (10_000 - offsetBps) / 10_000   (strictly below)
 *   !zeroForOne -> currentSqrt * (10_000 + offsetBps) / 10_000   (strictly above)
 * offsetBps is clamped to >= 1 so the limit can never collapse back onto currentSqrt.
 * PURE.
 */
export function splOffsetLimit(
  currentSqrtPriceX96: bigint,
  direction: 'SELL_BASE' | 'BUY_BASE',
  baseIsToken0: boolean,
  offsetBps: number,
): bigint {
  const zeroForOne = direction === 'SELL_BASE' ? baseIsToken0 : !baseIsToken0;
  // Clamp to a strictly-positive offset so the limit is never exactly currentSqrt (SPL).
  const bps = BigInt(Math.max(1, Math.floor(offsetBps)));
  if (zeroForOne) {
    // Push the limit strictly BELOW current; floor-divide can only move it further below.
    return (currentSqrtPriceX96 * (10_000n - bps)) / 10_000n;
  }
  // Push strictly ABOVE current; +1 guards the case where the bps scaling floors back to
  // currentSqrt (e.g. a tiny currentSqrt) so it stays strictly greater.
  const above = (currentSqrtPriceX96 * (10_000n + bps)) / 10_000n;
  return above > currentSqrtPriceX96 ? above : currentSqrtPriceX96 + 1n;
}

/**
 * Ref-BOUNDED variant of the offset limit for the rebalance/heartbeat legs.
 *
 * Those legs take their DIRECTION from inventory, not from the side of the ref, and they can fire
 * when the pool sits slightly OFF the oracle (in-band but not exactly at ref). A plain offset limit
 * is only bounded relative to the CURRENT pool sqrt, so a fixed-notional leg can walk the pool clean
 * PAST the oracle — the cirBTC/EURC overshoot: a rebalance SELL fired at +49bps and dragged the pool
 * to ~-658bps. This clamps the offset so a leg can fill TOWARD the peg but never CROSS it:
 *   - start from the usual splOffsetLimit (strictly past current => SPL-valid), then
 *   - if the ref tick is on the same side the swap is heading (strictly past current in the trade
 *     direction), pull the limit back to whichever of {offset, ref} stops FIRST, so the fill halts
 *     at the peg at the latest;
 *   - if the ref is NOT past current (the leg heads AWAY from the ref — a wrong-side restock the
 *     executability guard should already skip), fall back to the plain offset so the limit stays
 *     strictly past current and the leg can still execute a tiny fill.
 * The result is ALWAYS strictly past current (never reverts SPL) AND never past the ref tick. PURE.
 */
export function pegBoundedOffsetLimit(
  currentSqrtPriceX96: bigint,
  refLimit: bigint,
  direction: 'SELL_BASE' | 'BUY_BASE',
  baseIsToken0: boolean,
  offsetBps: number,
): bigint {
  const offset = splOffsetLimit(currentSqrtPriceX96, direction, baseIsToken0, offsetBps);
  const zeroForOne = direction === 'SELL_BASE' ? baseIsToken0 : !baseIsToken0;
  if (zeroForOne) {
    // Limit must be strictly BELOW current (sqrt pushed DOWN). Stop at the HIGHER (nearer-current)
    // of {offset, ref} so the fill can't sink past the peg — but only when ref is genuinely below
    // current (this trade's side). Both bounds are < current => the result stays SPL-valid.
    if (refLimit < currentSqrtPriceX96) return offset > refLimit ? offset : refLimit;
    return offset;
  }
  // Limit must be strictly ABOVE current (sqrt pushed UP). Stop at the LOWER (nearer-current) of
  // {offset, ref} when ref is genuinely above current. Both bounds are > current => SPL-valid.
  if (refLimit > currentSqrtPriceX96) return offset < refLimit ? offset : refLimit;
  return offset;
}

/**
 * Compute the swap arguments for a SWAP decision.
 *   - tokenIn/tokenOut: SELL_BASE spends base for USDC; BUY_BASE spends USDC for base.
 *   - amountIn: for SELL_BASE it's the base amount directly; for BUY_BASE we convert the
 *     base target into the USDC to spend at the ref price (amountInBase is a base notional).
 *   - sqrtPriceLimitX96: direction-correct + STRICTLY past the current pool price.
 *       * 'arb' (real divergence): pinned to the ref tick — which is past current BY
 *         CONSTRUCTION (the arb only fires when |pool-ref| > band). We still VERIFY the ref
 *         limit lands strictly on the correct side of the supplied current sqrt and fall
 *         back to a bounded offset if a degenerate input ever put it on/over the line.
 *       * 'rebalance' / 'heartbeat' (fire INSIDE the no-trade band, where pool ~= ref): the
 *         ref pin would EQUAL slot0.sqrtPriceX96 (=> revert SPL) or sit on the wrong side
 *         (the direction comes from INVENTORY, not the side of ref). So these pin to a small
 *         bounded offset strictly PAST the live current pool sqrt instead (FINDING 1 fix).
 *   - amountOutMinimum: the expected out at the ref price, haircut by slippageBps (unchanged
 *     slippage guard — a sandwich/adverse fill still reverts on amountOutMinimum).
 *
 * `currentSqrtPriceX96` is the live pool slot0 sqrt at decision time (read by the executor)
 * and `maxSlippageBps` bounds how far past current the rebalance/heartbeat limit may sit.
 * Both default to the legacy behavior (ref pin, slippageBps offset) when omitted so the pure
 * unit tests that pre-date the SPL fix still exercise the arb path unchanged.
 * PURE given the decision + market + ref + current sqrt (no chain reads) -> unit-testable.
 */
export function buildSwapArgs(
  decision: Extract<ArbDecision, { kind: 'SWAP' }> | (ArbDecision & { kind: 'SWAP' }),
  m: ArbConfig['market'],
  ref18: bigint,
  baseIsToken0: boolean,
  slippageBps: number,
  currentSqrtPriceX96?: bigint,
  maxSlippageBps?: number,
): {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
} {
  const amountInBase = decision.amountInBase!;
  const baseScale = 10n ** BigInt(m.baseDecimals);
  // USDC value (6dp) of `amountInBase` base tokens at the ref price.
  //   usdc6 = amountInBase(raw base) / baseScale * (ref18 / 1e18) * quoteScale
  //         = amountInBase * ref18 * quoteScale / (baseScale * 1e18)
  const quoteScale = 10n ** BigInt(m.quoteDecimals);
  const usdcValue = (amountInBase * ref18 * quoteScale) / (baseScale * 10n ** 18n);

  const direction = decision.direction!;
  const purpose = decision.purpose ?? 'arb';
  // Bound the rebalance/heartbeat (and arb fallback) limit by maxSlippageBps when supplied,
  // else reuse the existing slippageBps guard so the offset and the amountOutMinimum haircut
  // stay consistent.
  const offsetBps = maxSlippageBps ?? slippageBps;

  // The ref-pinned limit (legacy arb behavior). For a real-divergence arb this is strictly
  // past current by construction; we keep using it so the AMM can fill UP TO the oracle.
  const refLimit = price18ToSqrtPriceX96(ref18, m.baseDecimals, m.quoteDecimals, baseIsToken0);

  let sqrtPriceLimitX96: bigint;
  if (currentSqrtPriceX96 === undefined) {
    // Legacy / pure-unit path: no live pool sqrt supplied -> pin to ref (arb-only callers).
    sqrtPriceLimitX96 = refLimit;
  } else if (purpose === 'rebalance' || purpose === 'heartbeat') {
    // FINDING 1 — these fire inside (or near) the no-trade band (pool ~= ref): a plain ref pin would
    // be at/over the current price (revert SPL) OR on the wrong side, so we use a bounded offset
    // STRICTLY past the live current sqrt in the direction this swap actually trades. But that offset
    // alone is only bounded vs CURRENT, so a fixed-notional leg fired slightly off-ref could walk the
    // pool clean PAST the oracle (the cirBTC/EURC overshoot). pegBoundedOffsetLimit additionally
    // clamps it to the ref tick so a restock fills TOWARD the peg but never CROSSES it.
    sqrtPriceLimitX96 = pegBoundedOffsetLimit(currentSqrtPriceX96, refLimit, direction, baseIsToken0, offsetBps);
  } else {
    // 'arb' — verify the ref pin lands STRICTLY on the correct (SPL-valid) side of current.
    // zeroForOne wants limit < current; !zeroForOne wants limit > current. If a degenerate
    // input ever put the ref pin on/over the line, fall back to the bounded offset so the
    // swap can never revert SPL.
    const zeroForOne = direction === 'SELL_BASE' ? baseIsToken0 : !baseIsToken0;
    const refIsStrictlyPast = zeroForOne
      ? refLimit < currentSqrtPriceX96
      : refLimit > currentSqrtPriceX96;
    sqrtPriceLimitX96 = refIsStrictlyPast
      ? refLimit
      : splOffsetLimit(currentSqrtPriceX96, direction, baseIsToken0, offsetBps);
  }

  const haircut = (x: bigint): bigint => (x * BigInt(10_000 - slippageBps)) / 10_000n;

  if (decision.direction === 'SELL_BASE') {
    // Sell base -> receive USDC. amountIn = base; min out = usdcValue - slippage.
    return {
      tokenIn: m.base,
      tokenOut: m.quote,
      amountIn: amountInBase,
      amountOutMinimum: haircut(usdcValue),
      sqrtPriceLimitX96,
    };
  }
  // BUY_BASE: spend USDC -> receive base. amountIn = usdcValue; min out = base - slippage.
  return {
    tokenIn: m.quote,
    tokenOut: m.base,
    amountIn: usdcValue,
    amountOutMinimum: haircut(amountInBase),
    sqrtPriceLimitX96,
  };
}

/**
 * TASK 4b — send the swap with BOUNDED gas-tip escalation (mirrors keeper.ts). Attempt 0
 * prices at the Arc floor (unchanged behavior). `buildArgs(gas)` returns the FULL
 * exactInputSingle write request for a given attempt — it's re-invoked per attempt so the
 * swap's `deadline` is refreshed on each re-send (a stuck tx's old deadline may have lapsed).
 * On a receipt-wait TIMEOUT with attempts remaining, the SAME logical swap is re-sent at a
 * higher (capped) tip (viem replaces the still-pending nonce — a speed-up); exhausting the
 * attempts rethrows the timeout so runArbOnce's catch records the failure (unchanged path).
 * A mined-but-reverted swap is returned (NOT escalated) — bidding more can't un-revert it.
 *
 * FINDING 2 — `onSent` mirrors keeper.ts's sendWriteWithEscalation: it's invoked with the
 * broadcast hash IMMEDIATELY after each writeContract returns, so a receipt-wait TIMEOUT (the
 * helper rethrows after exhausting escalation) still surfaces which tx may be pending via
 * runArbOnce's rec.txHash — instead of leaving rec.txHash undefined on a timeout.
 */
async function sendSwapWithEscalation(
  client: PublicClient,
  wallet: WalletClient,
  buildArgs: (gas: GasOverrides) => Parameters<WalletClient['writeContract']>[0],
  cfg: ArbConfig,
  onSent?: (hash: `0x${string}`) => void,
): Promise<{ txHash: `0x${string}`; receipt: { status: 'success' | 'reverted' } }> {
  const attempts = totalAttempts(cfg.gasEscalation);
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const gas = escalatedGas(attempt, cfg.gasEscalation);
    if (attempt > 0) {
      logArb({
        ts: new Date().toISOString(),
        market: cfg.market.id,
        kind: 'NONE',
        reason: `gas escalate attempt ${attempt}/${attempts - 1}: prior swap receipt-wait timed out (tx stuck/under-priced)`,
      });
    }
    const txHash = (await wallet.writeContract(buildArgs(gas))) as `0x${string}`;
    onSent?.(txHash);
    try {
      const receipt = (await client.waitForTransactionReceipt({
        hash: txHash,
        timeout: cfg.receiptTimeoutMs,
      })) as { status: 'success' | 'reverted' };
      return { txHash, receipt };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      if (attempt === attempts - 1) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('gas escalation exhausted');
}

/**
 * Run a single arb tick for the market: read pool + ref + inventory -> decideArb ->
 * execute at most one swap (awaiting the receipt). Never throws: failures are captured
 * into rec.error. Returns the structured log record (also emitted).
 */
export async function runArbOnce(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  cfg: ArbConfig,
  baseIsToken0: boolean,
  /**
   * TASK 3b — the injected heartbeat snapshot (the executor's ledger + clock). Omitted =>
   * heartbeat mode is OFF for this tick (existing callers/tests are unaffected).
   */
  heartbeat?: HeartbeatState,
  /**
   * The injected FLOW BUDGET snapshot (net cirBTC sold over the rolling window). Omitted => flow
   * budget OFF for this tick. The executor owns the persisted ledger + injects this so the decision
   * stays pure (mirrors `heartbeat`).
   */
  flow?: FlowState,
): Promise<ArbTickLog> {
  const m = cfg.market;
  const rec: ArbTickLog = { ts: new Date().toISOString(), market: m.id, kind: 'NONE', reason: '' };

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    const [{ poolPrice18, liquidity, sqrtPriceX96, poolBaseBal, poolQuoteBal }, ref] = await Promise.all([
      readPool(client, m, baseIsToken0),
      // Single-feed (base/USD) OR cross-quoted (base/USD ÷ quote/USD) per the market's quoteFeedId.
      fetchArbRef(cfg.hermesUrl, m, cfg.hermesTimeoutMs),
    ]);
    const { inventoryBase, inventoryUsdc } = await readInventory(client, m, account.address);

    const refAgeSec = Math.max(0, nowSec - ref.publishTimeSec);
    const state: ArbState = {
      poolPrice18,
      ref18: ref.price18,
      refAgeSec,
      liquidity,
      baseIsToken0,
      inventoryBase,
      inventoryUsdc,
      poolBaseBal,
      poolQuoteBal,
      flow,
      heartbeat,
    };

    rec.poolPrice18 = poolPrice18.toString();
    rec.ref18 = ref.price18.toString();
    rec.divBps = divergenceBps(poolPrice18, ref.price18);

    // decideArb's ArbParams is the tunable config PLUS the market's token decimals (so the
    // liquidity sizing + USDC->base conversion are decimals-generic, not hardcoded 8/6).
    const decision = decideArb(state, {
      ...cfg.params,
      baseDecimals: m.baseDecimals,
      quoteDecimals: m.quoteDecimals,
    });
    rec.kind = decision.kind;
    rec.direction = decision.direction;
    rec.purpose = decision.purpose;
    rec.amountInBase = decision.amountInBase?.toString();
    rec.reason = decision.reason;

    if (decision.kind !== 'SWAP') {
      logArb(rec);
      return rec;
    }

    // FINDING 1 — thread the LIVE pool sqrt so buildSwapArgs computes a direction-correct
    // limit that is STRICTLY past the current pool price for the chosen swap (the rebalance/
    // heartbeat legs fire inside the no-trade band where the ref pin would equal/cross the
    // current price and revert SPL). The arb leg keeps pinning toward ref (verified past
    // current). maxSlippageBps bounds the rebalance/heartbeat offset to the slippage guard.
    const swap = buildSwapArgs(
      decision as ArbDecision & { kind: 'SWAP' },
      m,
      ref.price18,
      baseIsToken0,
      cfg.params.slippageBps,
      sqrtPriceX96,
      cfg.params.slippageBps,
    );

    // Send with bounded gas escalation (TASK 4b). Attempt 0 is the Arc floor (unchanged); a
    // receipt-wait timeout re-sends at a higher capped tip. The deadline is recomputed inside
    // buildArgs each attempt so a re-sent swap isn't rejected on a lapsed deadline. AWAITing
    // the receipt keeps it nonce-safe (one swap lands per tick); a mined-but-reverted swap
    // (slippage guard tripped, pool moved) is a FAILURE handled below, not escalated.
    const { txHash, receipt } = await sendSwapWithEscalation(
      client,
      wallet,
      (gas) => ({
        address: m.router,
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        account,
        chain,
        ...gas,
        args: [
          {
            tokenIn: swap.tokenIn,
            tokenOut: swap.tokenOut,
            fee: m.feeTier,
            recipient: account.address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 30),
            amountIn: swap.amountIn,
            amountOutMinimum: swap.amountOutMinimum,
            sqrtPriceLimitX96: swap.sqrtPriceLimitX96,
          },
        ],
      } as Parameters<WalletClient['writeContract']>[0]),
      cfg,
      // FINDING 2 — record the broadcast hash immediately so a receipt-wait TIMEOUT (the
      // helper rethrows after exhausting escalation) still surfaces which tx may be pending
      // via rec.txHash, mirroring keeper.ts's sendWriteWithEscalation onSent callback.
      (h) => {
        rec.txHash = h;
      },
    );
    rec.txHash = txHash;

    if (receipt.status !== 'success') {
      rec.error = `swap reverted: ${decision.purpose ?? 'arb'} ${decision.direction}`;
    } else if (decision.purpose === undefined || decision.purpose === 'arb') {
      // LOW fix — re-read the pool AFTER the swap settles and recompute the divergence
      // against the SAME ref18 used to size this trade. The shrink-watchdog must judge
      // whether OUR swap actually moved the pool toward the ref; comparing the pre-trade
      // divBps across ticks would false-positive whenever the live Pyth ref drifted
      // between ticks (normal in volatility). Best-effort: a post-read failure leaves
      // postSwapDivBps undefined so the watchdog simply skips this tick rather than
      // firing a spurious WEDGE. ONLY the price-convergence arb is re-read for the
      // watchdog — a rebalance/heartbeat swap is judged by its receipt alone (TASK 3).
      try {
        const after = await readPool(client, m, baseIsToken0);
        rec.postSwapDivBps = divergenceBps(after.poolPrice18, ref.price18);
      } catch {
        /* leave postSwapDivBps undefined — watchdog skips an unattributable tick */
      }
    }
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) {
      rec.error = `receipt wait timed out after ${cfg.receiptTimeoutMs}ms (tx ${rec.txHash ?? '?'} may still be pending): ${err.shortMessage}`;
    } else {
      rec.error = err instanceof Error ? err.message : String(err);
    }
  }

  logArb(rec);
  return rec;
}

/**
 * FINDING 3/4 — PURE ledger-update step applied after each tick (extracted from main() so the
 * "stamp the rate-limit regardless of success" wiring is unit-testable). Given the prior
 * ledger + this tick's record:
 *   - a heartbeat/rebalance SWAP stamps its interval + per-day ATTEMPT counter REGARDLESS of
 *     success (so a reverting leg still advances the governor and can't retry unbounded), and
 *   - a SUCCESSFUL heartbeat SWAP additionally charges its base notional to the daily cap.
 * Any other tick (arb / NONE / SKIP / ALERT, or a non-swap) leaves the ledger unchanged.
 * Returns a NEW ledger (or the same reference when nothing applies).
 */
export function applyLedgerUpdate(
  ledger: HeartbeatLedger,
  rec: Pick<ArbTickLog, 'kind' | 'purpose' | 'error' | 'amountInBase'>,
  nowMs: number,
): HeartbeatLedger {
  if (rec.kind !== 'SWAP') return ledger;
  let next = ledger;
  if (rec.purpose === 'heartbeat') {
    next = recordHeartbeatAttempt(next, nowMs); // interval + attempt: ALWAYS (success or revert)
    if (rec.error === undefined && rec.amountInBase !== undefined) {
      next = recordHeartbeatSpend(next, BigInt(rec.amountInBase), nowMs); // notional: success only
    }
  } else if (rec.purpose === 'rebalance') {
    next = recordRebalanceAttempt(next, nowMs); // interval + attempt: ALWAYS (success or revert)
  }
  return next;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadArbConfig();
  const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

  // Real alerting (dead-man's-switch) — shares the keeper's alert env vars. OFF unless a URL
  // is set (log-only, unchanged). Non-blocking + crash-safe + deduped, like the keeper.
  const alerter = createAlerter(cfg.alert, { log });

  // Probe the chainId across the RPCs so testnet vs mainnet is never hardcoded.
  let chainId: number | undefined;
  let probeErr: unknown;
  for (const url of cfg.rpcUrls) {
    try {
      const probe = createPublicClient({ transport: http(url, { timeout: 10_000 }) });
      chainId = await probe.getChainId();
      break;
    } catch (err) {
      probeErr = err;
      log({ msg: 'arb.probe.error', rpc: url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (chainId === undefined) {
    throw new Error(`could not reach any RPC to probe chainId: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`);
  }

  const { account, chain, publicClient, walletClient } = buildArbClients(cfg, chainId);
  const baseIsToken0 = await resolveBaseIsToken0(publicClient, cfg.market.pool, cfg.market.base);

  log({
    msg: 'arb.start',
    signer: account.address,
    chainId,
    market: cfg.market.id,
    pool: cfg.market.pool,
    base: cfg.market.base,
    quote: cfg.market.quote,
    baseIsToken0,
    feeTier: cfg.market.feeTier,
    params: {
      feeBps: cfg.params.feeBps,
      thresholdBps: cfg.params.thresholdBps,
      closeFraction: cfg.params.closeFraction,
      maxTradeBase: cfg.params.maxTradeBase.toString(),
      minTradeBase: cfg.params.minTradeBase.toString(),
      reserveBase: cfg.params.reserveBase.toString(),
      reserveQuote: cfg.params.reserveQuote.toString(),
      maxRefAgeSec: cfg.params.maxRefAgeSec,
      slippageBps: cfg.params.slippageBps,
      // TASK 3a — inventory rebalancing (floor 0 => OFF).
      rebalanceFloorBps: cfg.params.rebalanceFloorBps,
      rebalanceTargetBps: cfg.params.rebalanceTargetBps,
      rebalanceMaxBase: cfg.params.rebalanceMaxBase.toString(),
      // TASK 3b — heartbeat VOLUME (distinct from the alert dead-man's-switch below).
      heartbeatVolume: {
        enabled: cfg.params.heartbeatEnabled,
        intervalMs: cfg.params.heartbeatIntervalMs,
        dailyCapBase: cfg.params.heartbeatDailyCapBase.toString(),
        tradeBase: cfg.params.heartbeatTradeBase.toString(),
      },
    },
    pollIntervalMs: cfg.pollIntervalMs,
    httpPort: cfg.httpPort,
    httpHost: cfg.httpHost,
    stallFactor: cfg.stallFactor,
    // URLs are NOT logged (may embed a token); only whether each channel is wired.
    alerting: {
      enabled: alerter.enabled,
      webhook: cfg.alert.webhookUrl !== undefined,
      heartbeat: cfg.alert.heartbeatUrl !== undefined,
      dedupeWindowMs: cfg.alert.dedupeWindowMs,
      heartbeatIntervalMs: cfg.alert.heartbeatIntervalMs,
    },
  });

  // Router allowance + the gas gate are LAZY, inside the loop (the swapbot's proven pattern): a freshly
  // deployed keeper with an UNFUNDED wallet must IDLE and start on its own the moment it's funded — NOT
  // crash-loop on the approval (no gas => the approve tx can't even send). `approved` flips true once
  // both legs are approved; an already-approved wallet is a no-op (allowance check only), so a re-deploy
  // never re-approves. Minimum native to operate an approve + a swap; below it the loop idles.
  const MIN_OPERATING_WEI = 5_000_000_000_000_000n; // 0.005 native
  let approved = false;
  // Carry the last known-good native balance across a transient getBalance failure so one flaky RPC
  // read can't idle a fully-funded keeper for a whole tick.
  let lastGoodBalanceWei = 0n;

  // Per-market backoff + a divergence-shrink watchdog. If a SWAP repeatedly fails to
  // shrink the divergence, treat it like a failure so the breaker backs off + alerts.
  let runtime: MarketRuntime = freshRuntime();
  let lastDivAbs: number | null = null;

  // TASK 3b — the heartbeat-VOLUME budget ledger (distinct from the alert dead-man's-switch).
  // Carries the day's spend + the last-fire timestamp across ticks; the day resets at UTC
  // midnight. OFF unless cfg.params.heartbeatEnabled, in which case a snapshot is injected
  // into decideArb each tick and the spend is recorded after a heartbeat swap settles.
  let hbLedger: HeartbeatLedger = freshHeartbeatLedger(Date.now());

  // FLOW BUDGET ledger — the rolling-window cap on NET cirBTC sold (raw base). Persisted so a
  // restart can't reset the budget (the worst-case daily bleed stays a known constant). OFF unless
  // a positive budget + window are configured; when ON, a FlowState snapshot is injected each tick
  // and every SETTLED swap is recorded (+sold / −bought) and saved.
  const flowEnabled = (cfg.flowBudgetBase ?? 0n) > 0n && (cfg.flowWindowMs ?? 0) > 0;
  let flowLedger: FlowLedger = flowEnabled && cfg.flowLedgerFile ? loadFlowLedger(cfg.flowLedgerFile) : { events: [] };

  // Loop heartbeat: updated at the end of each arb tick. null until the first tick
  // completes; the /health endpoint reports DEGRADED (stalled) while it's stale.
  let lastTickTs: number | null = null;

  // TASK 4a — restart-safe counters for the arb bot, mirroring the lifecycle keeper. SEED the
  // cumulative counters from KEEPER_ARB_METRICS_STATE_FILE (a SEPARATE file from the keeper's)
  // so a restart/crash-loop doesn't zero the Prometheus series. The shared PersistedMetrics
  // shape is reused: the arb's per-purpose swap counts live in `actionsTotal`, and its scalar
  // failure count lives in `failuresTotal` keyed by the (single) market id. recordRestart has
  // already bumped restartsTotal for THIS boot inside loadMetricsState; processStartTimeSec is
  // the standard uptime gauge (resets on restart).
  const processStartTimeSec = Math.floor(Date.now() / 1000);
  const { metrics: seed, loaded: metricsLoaded } = cfg.metricsStateFile
    ? loadMetricsState(cfg.metricsStateFile, log)
    : { metrics: { ticksTotal: 0, actionsTotal: {}, failuresTotal: {}, revertsTotal: 0, restartsTotal: 1 } as PersistedMetrics, loaded: false };

  const metrics: ArbMetricsSnapshot = {
    ticksTotal: seed.ticksTotal,
    swapsTotal: { ...seed.actionsTotal },
    failuresTotal: seed.failuresTotal[cfg.market.id] ?? 0,
    revertsTotal: seed.revertsTotal,
    balanceWei: 0n,
    lastTickTs: 0,
    wedged: 0,
    restartsTotal: seed.restartsTotal,
    processStartTimeSec,
  };

  // Snapshot the CUMULATIVE-counter slice into the shared PersistedMetrics shape for the
  // state file (gauges excluded — re-derived each tick). The scalar failuresTotal is stored
  // under the single market id so a future multi-market arb stays forward-compatible.
  const persistedSnapshot = (): PersistedMetrics => ({
    ticksTotal: metrics.ticksTotal,
    actionsTotal: metrics.swapsTotal,
    failuresTotal: { [cfg.market.id]: metrics.failuresTotal },
    revertsTotal: metrics.revertsTotal,
    restartsTotal: metrics.restartsTotal,
  });
  const persistMetrics = (): void => {
    if (cfg.metricsStateFile) saveMetricsState(cfg.metricsStateFile, persistedSnapshot(), log);
  };
  // Persist immediately so the bumped restartsTotal is durable even if the bot dies before
  // the first interval flush; track the last flush time to throttle in-loop writes.
  persistMetrics();
  let lastPersistTs = Date.now();

  // TASK 4a — surface the restart-safe metrics status (counters file-backed? prior state
  // loaded this boot? this boot's restart count + the uptime gauge).
  log({
    msg: 'arb.metrics',
    stateFile: cfg.metricsStateFile !== undefined,
    loadedPriorState: metricsLoaded,
    persistIntervalMs: cfg.metricsPersistIntervalMs,
    restartsTotal: metrics.restartsTotal,
    processStartTimeSec,
  });

  // Live snapshot for the HTTP server (always reflects the current loop state).
  const getArbHealthState = (): ArbHealthState => ({
    lastTickTs,
    market: { id: cfg.market.id, runtime },
  });
  const getMetrics = (): ArbMetricsSnapshot => metrics;

  // Optional /health + /metrics server — OFF unless KEEPER_ARB_HTTP_PORT > 0. Loopback-bound
  // by default so it isn't exposed externally. Mirrors the lifecycle keeper's health server.
  const healthServer =
    cfg.httpPort > 0
      ? startArbHealthServer({
          host: cfg.httpHost,
          port: cfg.httpPort,
          pollIntervalMs: cfg.pollIntervalMs,
          stallFactor: cfg.stallFactor,
          getArbHealthState,
          getMetrics,
          log,
        })
      : undefined;

  let running = true;
  const stop = (sig: string) => {
    log({ msg: 'arb.shutdown', signal: sig });
    running = false;
    healthServer?.close();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (running) {
    // Read native balance (gas) each pass; carry the last known-good value across a transient RPC
    // failure so one flaky read can't idle a funded keeper.
    let balance = lastGoodBalanceWei;
    try {
      balance = await publicClient.getBalance({ address: account.address });
      lastGoodBalanceWei = balance;
    } catch (err) {
      log({ msg: 'arb.balance.error', error: err instanceof Error ? err.message : String(err) });
    }
    metrics.balanceWei = balance; // TASK 4a — gauge for /metrics
    const low = balance < cfg.lowBalanceWei;
    log({ msg: low ? 'WARN low arb balance' : 'arb.balance', signer: account.address, balanceWei: balance.toString(), floorWei: cfg.lowBalanceWei.toString() });
    // Deduped low-balance page so an operator refills before the arb bot runs dry on gas. Fire-and-forget.
    if (low) {
      void alerter.notify({
        key: `lowbal:arb:${account.address}`,
        severity: 'warn',
        title: 'LOW BALANCE (arb)',
        message: `arb signer ${account.address} balance ${balance} wei below floor ${cfg.lowBalanceWei} wei`,
        context: { signer: account.address, balanceWei: balance.toString(), floorWei: cfg.lowBalanceWei.toString() },
      });
    }

    // GAS GATE — idle (don't crash-loop on the approval) until the wallet has enough native to operate;
    // it starts on its own once funded. A freshly deployed keeper waits here for its first top-up.
    if (balance < MIN_OPERATING_WEI) {
      log({ msg: 'arb.waiting', reason: 'insufficient gas — fund the arb wallet (gas + cirBTC reserve)', balanceWei: balance.toString() });
      await sleep(cfg.pollIntervalMs);
      continue;
    }
    // Lazy router allowance for BOTH legs (needs gas; retried each pass until it lands). Already-approved
    // legs are a no-op (allowance read only), so a re-deploy / restart never re-approves. Without this a
    // swap reverts STF and the bot wedges opaquely — so a failure here just idles + retries, never crashes.
    if (!approved) {
      try {
        const approvals = await ensureRouterApprovals(
          publicClient,
          walletClient,
          account,
          chain,
          cfg.market,
          cfg.gasFloorWei,
          cfg.receiptTimeoutMs,
          true,
        );
        approved = true;
        log({ msg: 'arb.approvals', router: cfg.market.router, legs: approvals.map((a) => ({ leg: a.leg, token: a.token, sufficient: a.sufficient, approvedTxHash: a.approvedTxHash })) });
      } catch (err) {
        log({ msg: 'arb.approvals.error', error: err instanceof Error ? err.message : String(err) });
        await sleep(cfg.pollIntervalMs);
        continue;
      }
    }

    const now = Date.now();
    if (shouldSkip(runtime, now)) {
      log({ msg: 'arb.backoff', consecutiveFailures: runtime.consecutiveFailures, backoffUntilMs: runtime.backoffUntilMs, waitMs: runtime.backoffUntilMs - now });
      await sleep(cfg.pollIntervalMs);
      continue;
    }

    // TASK 3b / FINDING 3 — roll the budget day if we've crossed UTC midnight, then snapshot
    // the ledger for the (pure) decision. Inject the snapshot when heartbeat OR rebalance mode
    // is enabled (both now read the ledger: heartbeat for its interval+cap, rebalance for its
    // FINDING 3 interval + FINDING 4 attempt governors). The decision path is unchanged when
    // BOTH are off (snapshot stays undefined).
    const tickNow = Date.now();
    hbLedger = rollHeartbeatDay(hbLedger, tickNow);
    const mmActive = cfg.params.heartbeatEnabled || cfg.params.rebalanceFloorBps > 0;
    const hbSnapshot = mmActive ? snapshotHeartbeat(hbLedger, tickNow) : undefined;

    // FLOW BUDGET — prune stale events, then snapshot net-sold + the cap for the (pure) decision.
    let flowSnapshot: FlowState | undefined;
    if (flowEnabled) {
      flowLedger = pruneWindow(flowLedger, tickNow, cfg.flowWindowMs ?? 0);
      flowSnapshot = buildFlowState(flowLedger, tickNow, cfg.flowWindowMs ?? 0, cfg.flowBudgetBase ?? 0n);
    }

    const rec = await runArbOnce(publicClient, walletClient, account, chain, cfg, baseIsToken0, hbSnapshot, flowSnapshot);

    // Record this tick's SETTLED swap into the flow ledger: +sold (SELL_BASE) / −bought (BUY_BASE),
    // so a SELL spends the budget and a BUY credits it back. Only a SUCCESSFUL swap moves cirBTC.
    if (flowEnabled && rec.kind === 'SWAP' && rec.error === undefined && rec.amountInBase !== undefined && rec.direction !== undefined) {
      const delta = rec.direction === 'SELL_BASE' ? BigInt(rec.amountInBase) : -BigInt(rec.amountInBase);
      flowLedger = recordFlow(flowLedger, Date.now(), delta);
      if (cfg.flowLedgerFile) saveFlowLedgerSync(flowLedger, cfg.flowLedgerFile);
    }

    // TASK 4a — count this tick's swap (by purpose) + any mined-but-reverted swap. A SWAP
    // that was broadcast then reverted (rec.txHash set + rec.error set) bumps reverts.
    if (rec.kind === 'SWAP') {
      const purpose = rec.purpose ?? 'arb';
      metrics.swapsTotal[purpose] = (metrics.swapsTotal[purpose] ?? 0) + 1;
      if (rec.error !== undefined && rec.txHash !== undefined) metrics.revertsTotal += 1;
    }

    // FINDING 3/4 + TASK 3b — apply the MM ledger update for this tick (PURE, unit-tested):
    // a heartbeat/rebalance swap stamps its interval + per-day ATTEMPT counter REGARDLESS of
    // success (so a reverting leg still advances its governor and can't retry unbounded), and
    // a SUCCESSFUL heartbeat swap additionally charges its notional to the daily cap.
    hbLedger = applyLedgerUpdate(hbLedger, rec, Date.now());

    const observedTs = Date.now();
    // LOW fix — judge the shrink-watchdog on the POST-SWAP divergence (the pool re-read
    // AFTER the receipt, compared against the same ref used to size the trade), NOT the
    // pre-trade divBps. The pure helper encodes the rules + is unit-tested; the loop just
    // applies its verdict and carries the new baseline forward.
    const wd = evaluateWatchdog(rec, lastDivAbs);

    if (wd.fail) {
      metrics.failuresTotal += 1; // TASK 4a — a failing/reverted/non-shrinking tick
      const next = recordFailure(runtime, observedTs, cfg.baseBackoffMs, cfg.maxBackoffMs);
      const wedged = next.consecutiveFailures >= cfg.wedgedAlertThreshold;
      runtime = { ...next, lastAction: rec.kind, lastActionTs: observedTs, wedged };
      metrics.wedged = wedged ? 1 : 0;
      if (wedged) {
        log({ msg: `ALERT arb market=${cfg.market.id} WEDGED — operator action needed`, market: cfg.market.id, consecutiveFailures: next.consecutiveFailures, lastError: rec.error ?? 'divergence not shrinking', divBps: rec.divBps, postSwapDivBps: rec.postSwapDivBps });
        // Page a human: arb bot wedged after >= WEDGED_ALERT_THRESHOLD consecutive failures
        // (repeated-failures trigger). Deduped per market so a stuck bot re-alerts at most
        // once per ALERT_DEDUPE_WINDOW_MS. Fire-and-forget + crash-safe.
        void alerter.notify({
          key: `wedged:arb:${cfg.market.id}`,
          severity: 'critical',
          title: 'WEDGED (arb)',
          message: `arb market=${cfg.market.id} wedged after ${next.consecutiveFailures} consecutive failures — operator action needed`,
          context: {
            market: cfg.market.id,
            consecutiveFailures: next.consecutiveFailures,
            lastError: rec.error ?? 'divergence not shrinking',
            divBps: rec.divBps,
            postSwapDivBps: rec.postSwapDivBps,
          },
        });
      }
    } else {
      runtime = { ...recordSuccess(runtime), lastAction: rec.kind, lastActionTs: observedTs, wedged: false };
      metrics.wedged = 0;
    }
    // Carry the watchdog baseline forward — updated only on an attributable swap, otherwise
    // unchanged so the next comparison stays swap-to-swap.
    lastDivAbs = wd.nextBaseline;

    // End of this tick: bump the heartbeat so /health can detect a silently-stalled loop.
    lastTickTs = Date.now();
    // TASK 4a — count the completed tick + stamp the gauge for /metrics.
    metrics.ticksTotal += 1;
    metrics.lastTickTs = lastTickTs;

    // Dead-man's-switch ping to the EXTERNAL monitor (rate-limited to the heartbeat interval).
    // If the arb bot dies/hangs, the ping stops and the monitor alerts on its absence.
    void alerter.heartbeat();

    // TASK 4a — flush the cumulative counters at most once per persist interval (no-op when
    // persistence is OFF; best-effort, never throws). A crash loses at most one interval.
    if (cfg.metricsStateFile && lastTickTs - lastPersistTs >= cfg.metricsPersistIntervalMs) {
      persistMetrics();
      lastPersistTs = lastTickTs;
    }

    if (!running) break;
    await sleep(cfg.pollIntervalMs);
  }

  // Final flush on a clean shutdown so the last interval's counts survive the restart.
  persistMetrics();
  healthServer?.close();
  log({ msg: 'arb.stopped' });
}

// Run only when executed directly (so test imports can construct without looping).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'arb.fatal', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
