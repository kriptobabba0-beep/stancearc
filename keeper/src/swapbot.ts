// swapbot.ts - the VOLUME bot. A SEPARATE process with a SEPARATE key (SWAPBOT_PRIVATE_KEY)
// whose ONLY job is to generate continuous trading volume on the cirBTC/USDC pool so that LP
// positions - whether staked into an epoch or just providing liquidity - accrue REAL,
// claimable trading fees even in quiet rounds with no organic swaps.
//
// It does small BALANCE-AWARE round-trip swaps at a fixed rate (default 15/min): each tick it
// reads the pool price + its own inventory and sells whichever leg is currently heavier (in
// value), nudging the price a hair and paying the AMM's 0.3% fee - which is exactly the fee
// LPs earn. The arb bot (a separate process) keeps the price pegged to Pyth, so the swap bot's
// tiny nudges are continuously corrected; net effect = steady fee generation, ~price-neutral.
//
// Reuses the arb's tested helpers: buildArbClients-style client setup, resolveBaseIsToken0,
// ensureRouterApprovals (one max approval per token), and buildSwapArgs (the exact swap-arg +
// bounded-sqrtPriceLimit + slippage math) - driven here with the pool's OWN price as the
// reference and purpose='heartbeat' so the limit is a small bounded offset past current.
import {
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  createPublicClient,
  createWalletClient,
  WaitForTransactionReceiptTimeoutError,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { erc20Abi, feeArenaV3Abi, swapRouterAbi, v3PoolAbi } from './abi.js';
import { sqrtPriceX96ToPrice18, poolDeliverableQuote, maxBaseSellForUsdcOut, baseAmountToMovePrice } from './poolMath.js';
import { fetchPythRef } from './hermes.js';
import { buildSwapArgs, resolveBaseIsToken0, ensureRouterApprovals } from './arb.js';
import { escalatedGas, totalAttempts, type GasOverrides } from './gasEscalation.js';
import { loadSwapbotConfig, type SwapbotConfig } from './config.js';
import { decideMaker } from './swapMaker.js';
import {
  loadEpochLedger,
  recordEpochActed,
  saveEpochLedgerSync,
  shouldActThisEpoch,
  type EpochLedger,
} from './epochLedger.js';
import type { ArbDecision } from './decideArb.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const log = (o: Record<string, unknown>): void =>
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

export type SwapDir = 'SELL_BASE' | 'BUY_BASE' | 'NONE';

/**
 * PURE direction picker for the VOLUME bot: STRICT ALTERNATION (sell, buy, sell, buy …). Each
 * sell↔buy pair is a round-trip that nets ~zero price impact and ~zero inventory change - it only
 * bleeds the 0.3% fee it exists to donate to LPs. So the bot is provably price-NEUTRAL: it never
 * drifts the pool or fights the arb, it ignores the pool price entirely (no peg logic, never stops),
 * and its own inventory stays balanced (a sell is matched by the next buy). Alternates away from the
 * last EXECUTED direction; falls back to whichever leg can fund a trade if the alternation pick
 * can't; returns NONE only when NEITHER leg can fund a swap. Unit-testable (no I/O).
 */
export function decideSwapDirection(
  lastDir: SwapDir,
  inventoryBase: bigint,
  inventoryQuote: bigint,
  poolPrice18: bigint,
  tradeBase: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): SwapDir {
  const baseScale = 10n ** BigInt(baseDecimals);
  const quoteScale = 10n ** BigInt(quoteDecimals);
  const tradeQuote = (tradeBase * poolPrice18 * quoteScale) / (baseScale * 10n ** 18n);
  const canSell = inventoryBase >= tradeBase;
  const canBuy = inventoryQuote >= tradeQuote;
  if (!canSell && !canBuy) return 'NONE';
  // Alternate away from the last executed direction; fall back to the only fundable side.
  const want: SwapDir = lastDir === 'SELL_BASE' ? 'BUY_BASE' : 'SELL_BASE';
  if (want === 'SELL_BASE') return canSell ? 'SELL_BASE' : 'BUY_BASE';
  return canBuy ? 'BUY_BASE' : 'SELL_BASE';
}

/**
 * PEG GATE (the swap-bot↔arb sync fix). PURE. Returns whether the pool is close ENOUGH to the live
 * reference for the volume bot to safely trade. When the pool is off-peg by more than `maxDevBps`, the
 * swap bot must STAND DOWN and let the arb re-peg - pumping round-trip volume into an off-peg pool is
 * pointless (wrong price) and dangerous (it churns/feeds the very divergence the arb is fighting, and
 * when the arb is depleted it's what let the pool run away). maxDevBps <= 0 disables the gate (legacy
 * strict-alternation behavior). A non-positive ref is treated as un-verifiable => CLOSED (fail-safe:
 * don't trade if we can't confirm the peg).
 */
export function pegWithinBand(poolPrice18: bigint, ref18: bigint, maxDevBps: number): boolean {
  if (maxDevBps <= 0) return true; // gate disabled
  if (ref18 <= 0n || poolPrice18 <= 0n) return false; // can't verify => stand down
  const diff = poolPrice18 > ref18 ? poolPrice18 - ref18 : ref18 - poolPrice18;
  const devBps = (diff * 10_000n) / ref18;
  return devBps <= BigInt(maxDevBps);
}

/** Build viem clients + account for the swap-bot config. */
function buildClients(cfg: SwapbotConfig, chainId: number) {
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

/** Read the pool's slot0 sqrt + derive poolPrice18 (USDC-per-base, 18dp). */
async function readPoolPrice(
  client: PublicClient,
  cfg: SwapbotConfig,
  baseIsToken0: boolean,
): Promise<{ poolPrice18: bigint; sqrtPriceX96: bigint }> {
  const slot0 = await client.readContract({ address: cfg.market.pool, abi: v3PoolAbi, functionName: 'slot0' });
  const sqrtPriceX96 = slot0[0];
  const poolPrice18 = sqrtPriceX96ToPrice18(
    sqrtPriceX96,
    cfg.market.baseDecimals,
    cfg.market.quoteDecimals,
    baseIsToken0,
  );
  return { poolPrice18, sqrtPriceX96 };
}

/** One swap tick: read price + inventory, pick direction, send a bounded swap, await receipt. */
export async function runSwapOnce(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  cfg: SwapbotConfig,
  baseIsToken0: boolean,
  lastDir: SwapDir,
): Promise<{ ok: boolean; dir: SwapDir; txHash?: `0x${string}`; error?: string }> {
  try {
    const [{ poolPrice18, sqrtPriceX96 }, invBase, invQuote] = await Promise.all([
      readPoolPrice(client, cfg, baseIsToken0),
      client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
      client.readContract({ address: cfg.market.quote, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }),
    ]);

    // PEG GATE (swap-bot↔arb sync): stand down when the pool is off-peg so we never pump volume into a
    // pool the arb is still re-pegging (or can't, when depleted) - the failure mode that let the pool
    // run away. Reference is the live Pyth price (same feed the arb uses); a Hermes failure fails CLOSED
    // (skip this tick) so we never trade blind. Gate OFF (maxPegDeviationBps<=0) => unchanged behavior.
    if (cfg.maxPegDeviationBps > 0) {
      let ref18: bigint;
      try {
        ({ price18: ref18 } = await fetchPythRef(cfg.hermesUrl, cfg.market.feedId, cfg.hermesTimeoutMs));
      } catch (err) {
        log({ msg: 'swapbot.peg-gate.skip', reason: 'hermes ref unavailable (failing closed)', error: err instanceof Error ? err.message : String(err) });
        return { ok: false, dir: 'NONE', error: 'peg-gate: no ref' };
      }
      if (!pegWithinBand(poolPrice18, ref18, cfg.maxPegDeviationBps)) {
        const diff = poolPrice18 > ref18 ? poolPrice18 - ref18 : ref18 - poolPrice18;
        const devBps = ref18 > 0n ? Number((diff * 10_000n) / ref18) : -1;
        log({ msg: 'swapbot.peg-gate.paused', reason: 'pool off-peg - deferring to arb', poolPrice18, ref18, devBps, maxDevBps: cfg.maxPegDeviationBps });
        return { ok: false, dir: 'NONE', error: 'peg-gate: off-peg' };
      }
    }

    // STRICT ALTERNATION (within the peg band): neutral round-trips (sell↔buy) at a fixed rate while
    // the pool is pegged; the arb is the sole peg-keeper and the gate above keeps the two in sync.
    const dir = decideSwapDirection(
      lastDir,
      invBase,
      invQuote,
      poolPrice18,
      cfg.tradeBase,
      cfg.market.baseDecimals,
      cfg.market.quoteDecimals,
    );
    if (dir === 'NONE') {
      log({ msg: 'swapbot.skip', reason: 'out of inventory - refill the swap-bot wallet', invBase, invQuote });
      return { ok: false, dir };
    }

    // Reuse the arb's exact swap-arg math, using the POOL's own price as the reference and
    // purpose='heartbeat' so the sqrtPriceLimit is a small bounded offset past the live price
    // (a ref-pin would equal the current price here and revert SPL).
    const decision = {
      kind: 'SWAP' as const,
      direction: dir,
      amountInBase: cfg.tradeBase,
      purpose: 'heartbeat' as const,
      reason: 'swapbot volume',
    } as unknown as ArbDecision & { kind: 'SWAP' };
    const swap = buildSwapArgs(
      decision,
      cfg.market,
      poolPrice18,
      baseIsToken0,
      cfg.slippageBps,
      sqrtPriceX96,
      cfg.slippageBps,
    );

    // Build the full write for a given gas attempt - re-invoked per attempt so the deadline is
    // refreshed (a stuck tx's old deadline may have lapsed by the time we re-send).
    const buildWrite = (gas: GasOverrides): Parameters<WalletClient['writeContract']>[0] =>
      ({
        address: cfg.market.router,
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        account,
        chain,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        args: [
          {
            tokenIn: swap.tokenIn,
            tokenOut: swap.tokenOut,
            fee: cfg.market.feeTier,
            recipient: account.address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 30),
            amountIn: swap.amountIn,
            amountOutMinimum: swap.amountOutMinimum,
            sqrtPriceLimitX96: swap.sqrtPriceLimitX96,
          },
        ],
      } as Parameters<WalletClient['writeContract']>[0]);

    // BOUNDED gas-tip escalation (reuses the arb's pure primitives). Attempt 0 is the floor; on a
    // receipt-wait TIMEOUT the SAME swap is re-sent at a higher capped tip - viem replaces the
    // still-pending nonce (RBF), so a stuck/under-priced tx gets unstuck WITHOUT firing a second
    // independent leg (no double-fill). A mined revert is returned (not escalated - can't un-revert).
    const attempts = totalAttempts(cfg.gasEscalation);
    let txHash: `0x${string}` | undefined;
    let receipt: { status: 'success' | 'reverted' } | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) log({ msg: 'swapbot.gas.escalate', attempt, of: attempts - 1 });
      txHash = (await wallet.writeContract(buildWrite(escalatedGas(attempt, cfg.gasEscalation)))) as `0x${string}`;
      try {
        receipt = (await client.waitForTransactionReceipt({ hash: txHash, timeout: cfg.receiptTimeoutMs })) as {
          status: 'success' | 'reverted';
        };
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
        if (attempt === attempts - 1) throw err; // exhausted - surface the timeout to the catch below
      }
    }
    if (receipt === undefined) throw lastErr instanceof Error ? lastErr : new Error('gas escalation exhausted');
    if (receipt.status !== 'success') {
      log({ msg: 'swapbot.swap.reverted', dir, txHash });
      return { ok: false, dir, txHash, error: 'reverted' };
    }
    log({ msg: 'swapbot.swap', dir, amountIn: swap.amountIn, txHash });
    return { ok: true, dir, txHash };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ msg: 'swapbot.error', error });
    return { ok: false, dir: 'NONE', error };
  }
}

/** PURE: base amount to sell to return to the flat `targetBase` (also cleans up a leftover long). */
export function sellToFlatAmount(baseBalance: bigint, targetBase: bigint): bigint {
  return baseBalance > targetBase ? baseBalance - targetBase : 0n;
}

/**
 * PURE: cap a desired SELL at what the pool can physically pay - a safety fraction of the pool's real
 * USDC, converted to base at the pool price. On a one-sided (USDC-empty) pool this is ~0, so the
 * caller idles instead of firing a "Too little received" SELL. safetyBps<=0 => no cap (returns want).
 */
export function cappedSell(
  want: bigint,
  poolQuoteBal: bigint,
  poolPrice18: bigint,
  safetyBps: number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (safetyBps <= 0) return want;
  const cap = maxBaseSellForUsdcOut(
    poolDeliverableQuote(poolQuoteBal, safetyBps),
    poolPrice18,
    baseDecimals,
    quoteDecimals,
  );
  return want < cap ? want : cap;
}

/** Read the pool's real USDC (quote) balance - the hard ceiling on what a SELL can extract. */
async function readPoolQuoteBal(client: PublicClient, cfg: SwapbotConfig): Promise<bigint> {
  return (await client.readContract({
    address: cfg.market.quote,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [cfg.market.pool],
  })) as bigint;
}

/**
 * PURE: size a SELL so it can actually FILL - bounded by BOTH (a) price impact, via the pool's own
 * depth: the cirBTC that moves the pool down by HALF the slippage tolerance (so the realized fill
 * clears the slippage-priced amountOutMinimum - no "Too little received" from over-sizing into a thin
 * pool); and (b) deliverability: a safety fraction of the pool's real USDC (the one-sided-pool guard).
 * Returns min(want, impactCap, deliverableCap). This is why a 0.01-cirBTC long is sold in small
 * slippage-safe clips over many ticks instead of dumped in one reverting trade.
 */
export function safeSellSize(
  want: bigint,
  liquidity: bigint,
  poolQuoteBal: bigint,
  poolPrice18: bigint,
  slippageBps: number,
  safetyBps: number,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  let s = want;
  // (a) price-impact cap: move the pool down by at most half the slippage tolerance.
  if (liquidity > 0n && poolPrice18 > 0n) {
    const fracBps = BigInt(Math.max(1, Math.floor(slippageBps / 2)));
    const target = (poolPrice18 * (10_000n - fracBps)) / 10_000n;
    const impactCap = baseAmountToMovePrice(liquidity, poolPrice18, target, baseDecimals, quoteDecimals, baseIsToken0);
    if (impactCap > 0n && s > impactCap) s = impactCap;
  }
  // (b) deliverability cap: never ask the pool for more USDC than a safety fraction of what it holds.
  s = cappedSell(s, poolQuoteBal, poolPrice18, safetyBps, baseDecimals, quoteDecimals);
  return s;
}

/**
 * PURE: the per-EPOCH pair notional - the base amount of EACH leg of the once-per-epoch balanced
 * pair. It is the SMALLER of two ideas so the pair is always safe on a thin pool: (1) the operator's
 * `pairTradeBase` intent, and (2) a depth-derived size = the base that moves the pool from its spot
 * to a target UNDERSHOOTING the oracle by `closeFraction` (reusing baseAmountToMovePrice exactly as
 * decideMaker does), so even sized "to land AT the oracle" a single leg can never blow a paper-thin
 * pool past peg. The result is capped at `maxTradeBase` and dust-floored: below `minTradeBase` it
 * returns 0 (=> the caller skips the pair this epoch rather than fire a doomed dust swap). When the
 * pool is already AT the oracle (gap 0) the depth size is 0 → returns 0, which is correct: there's
 * nothing to arb, and the SELL/BUY legs would each just pay fees around the peg - the caller still
 * fires `pairTradeBase` in that AT-peg case (see below) since the whole point is fee VOLUME. To keep
 * this function honest as a pure "max safe leg size", it returns min(intent, depthCap) ONLY when a
 * meaningful gap exists; at/above peg with no gap it returns the intent (depth doesn't bound a
 * round-trip that nets to zero). devBps sign is irrelevant - |gap| is used.
 */
export function pairSizeBase(
  liquidity: bigint,
  poolPrice18: bigint,
  ref18: bigint,
  closeFraction: number,
  pairTradeBase: bigint,
  maxTradeBase: bigint,
  minTradeBase: bigint,
  baseIsToken0: boolean,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  if (pairTradeBase <= 0n) return 0n;
  let size = pairTradeBase;

  // Depth cap: the base that moves the pool to a price undershooting the oracle by closeFraction of
  // the gap. Only bounds the leg when there's a real gap AND the inputs are sane; an AT-peg pool
  // (gap 0) leaves `size` at the intent so the round-trip still generates volume.
  if (liquidity > 0n && poolPrice18 > 0n && ref18 > 0n && poolPrice18 !== ref18) {
    const gap18 = ref18 - poolPrice18; // signed
    // scale |gap| by closeFraction in 1e6 fixed-point, then apply toward the ref (undershoot).
    const f = closeFraction < 0 ? 0 : closeFraction > 1 ? 1 : closeFraction;
    const num = BigInt(Math.round(f * 1_000_000));
    const target18 = poolPrice18 + (gap18 * num) / 1_000_000n;
    const depthCap = baseAmountToMovePrice(liquidity, poolPrice18, target18, baseDecimals, quoteDecimals, baseIsToken0);
    if (depthCap > 0n && depthCap < size) size = depthCap;
  }

  if (maxTradeBase > 0n && size > maxTradeBase) size = maxTradeBase;
  if (size < minTradeBase) return 0n; // dust => skip the pair this epoch
  return size;
}

/**
 * Send ONE prepared swap with bounded gas-tip escalation + a receipt wait. Shared inner primitive for
 * the round-trip legs (mirrors runSwapOnce's send loop: RBF on a receipt timeout, never a second leg).
 */
async function sendSwapLeg(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  cfg: SwapbotConfig,
  swap: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint },
): Promise<{ ok: boolean; txHash?: `0x${string}`; error?: string }> {
  const buildWrite = (gas: GasOverrides): Parameters<WalletClient['writeContract']>[0] =>
    ({
      address: cfg.market.router,
      abi: swapRouterAbi,
      functionName: 'exactInputSingle',
      account,
      chain,
      maxFeePerGas: gas.maxFeePerGas,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
      args: [
        {
          tokenIn: swap.tokenIn,
          tokenOut: swap.tokenOut,
          fee: cfg.market.feeTier,
          recipient: account.address,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 30),
          amountIn: swap.amountIn,
          amountOutMinimum: swap.amountOutMinimum,
          sqrtPriceLimitX96: swap.sqrtPriceLimitX96,
        },
      ],
    } as Parameters<WalletClient['writeContract']>[0]);

  const attempts = totalAttempts(cfg.gasEscalation);
  let txHash: `0x${string}` | undefined;
  let receipt: { status: 'success' | 'reverted' } | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) log({ msg: 'swapbot.gas.escalate', attempt, of: attempts - 1 });
    txHash = (await wallet.writeContract(buildWrite(escalatedGas(attempt, cfg.gasEscalation)))) as `0x${string}`;
    try {
      receipt = (await client.waitForTransactionReceipt({ hash: txHash, timeout: cfg.receiptTimeoutMs })) as {
        status: 'success' | 'reverted';
      };
      break;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
      if (attempt === attempts - 1) throw err;
    }
  }
  if (receipt === undefined) throw lastErr instanceof Error ? lastErr : new Error('gas escalation exhausted');
  if (receipt.status !== 'success') return { ok: false, txHash, error: 'reverted' };
  return { ok: true, txHash };
}

/**
 * One NEUTRAL round-trip - the peg-safe volume primitive. BUY `tradeBase`-worth of base, then SELL it
 * back down to `targetBase`, as two back-to-back txns. Net base position ≈ 0 and net price impact ≈ 0
 * (the sell undoes the buy), so it generates 2 swaps of fee volume WITHOUT moving the peg, and the arb
 * almost never has to intervene. Self-correcting: if a previous sell leg failed and left a long, this
 * SELLS the excess FIRST and skips the buy, so it can never accumulate a directional position. Peg-gated
 * (stands down when off-peg). Funds from the QUOTE (USDC) leg only.
 */
export async function runRoundTripOnce(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  cfg: SwapbotConfig,
  baseIsToken0: boolean,
  flatTargetBase?: bigint,
): Promise<{ ok: boolean; legs: number; error?: string }> {
  // The inventory level the round-trip returns to ("flat"). Legacy callers use cfg.targetBase (0 =
  // sell everything). The MAKER passes its WORKING RESERVE here so the round-trip buys+sells a small
  // clip around the reserve for volume - and NEVER dumps the reserve as if it were a leftover long.
  const flatTarget = flatTargetBase ?? cfg.targetBase;
  try {
    const { poolPrice18, sqrtPriceX96 } = await readPoolPrice(client, cfg, baseIsToken0);

    const mkDecision = (direction: SwapDir, amountInBase: bigint) =>
      ({ kind: 'SWAP', direction, amountInBase, purpose: 'heartbeat', reason: 'swapbot roundtrip' } as unknown as ArbDecision & { kind: 'SWAP' });

    // RECOVERY FIRST - UN-GATED. A leftover long (from a prior failed sell leg) is the one way the
    // swap bot can distort the peg: it bought base (pushed the pool UP) but never sold it back. So we
    // ALWAYS sell it back to flat BEFORE the peg gate - selling a long never pushes the pool up, and
    // when the pool is off-peg HIGH it actively helps the arb re-peg. (Gating this behind the peg band
    // was the bug: an off-peg leftover could never be cleared, leaving a permanent up-push.) Only acts
    // on a MEANINGFUL leftover (>= one tradeBase), and skips the buy this tick.
    const [baseBefore, poolQuoteBal, liquidity] = await Promise.all([
      client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
      readPoolQuoteBal(client, cfg),
      client.readContract({ address: cfg.market.pool, abi: v3PoolAbi, functionName: 'liquidity' }) as Promise<bigint>,
    ]);
    const leftover = sellToFlatAmount(baseBefore, flatTarget);
    if (leftover >= cfg.tradeBase) {
      // Sell the leftover long in a SLIPPAGE-SAFE clip sized to the pool's depth (price-impact) AND
      // bounded by the pool's USDC (deliverability) - NOT the whole long, which would blow past
      // slippage and revert "Too little received". A long is worked down over many ticks. When the
      // pool is genuinely too thin to even sell one safe clip, we IDLE (and don't buy more - that
      // would grow the un-sellable long) until the pool deepens.
      const sellable = safeSellSize(leftover, liquidity, poolQuoteBal, poolPrice18, cfg.slippageBps, cfg.poolDeliverableSafetyBps ?? 0, baseIsToken0, cfg.market.baseDecimals, cfg.market.quoteDecimals);
      if (sellable <= 0n) {
        log({ msg: 'swapbot.roundtrip.defer', reason: 'pool too thin to sell even a slippage-safe clip - idling', leftover, poolQuoteBal, liquidity });
        return { ok: false, legs: 0, error: 'deferred: thin pool' };
      }
      const recoverSwap = buildSwapArgs(mkDecision('SELL_BASE', sellable), cfg.market, poolPrice18, baseIsToken0, cfg.slippageBps, sqrtPriceX96, cfg.slippageBps);
      const r = await sendSwapLeg(client, wallet, account, chain, cfg, recoverSwap);
      log({ msg: 'swapbot.roundtrip.recover', reason: 'sold a slippage-safe clip of the leftover long (skipped buy)', soldBase: sellable, leftover, ok: r.ok, txHash: r.txHash, error: r.error });
      return { ok: r.ok, legs: r.ok ? 1 : 0, error: r.error };
    }

    // PEG GATE - gates only the BUY+SELL round-trip (a BUY adds volume by pushing the pool UP, which is
    // pointless/dangerous when it's already off-peg). Defer to the arb. Fails CLOSED on a Hermes error.
    if (cfg.maxPegDeviationBps > 0) {
      let ref18: bigint;
      try {
        ({ price18: ref18 } = await fetchPythRef(cfg.hermesUrl, cfg.market.feedId, cfg.hermesTimeoutMs));
      } catch (err) {
        log({ msg: 'swapbot.peg-gate.skip', reason: 'hermes ref unavailable (failing closed)', error: err instanceof Error ? err.message : String(err) });
        return { ok: false, legs: 0, error: 'peg-gate: no ref' };
      }
      if (!pegWithinBand(poolPrice18, ref18, cfg.maxPegDeviationBps)) {
        const diff = poolPrice18 > ref18 ? poolPrice18 - ref18 : ref18 - poolPrice18;
        const devBps = ref18 > 0n ? Number((diff * 10_000n) / ref18) : -1;
        log({ msg: 'swapbot.peg-gate.paused', reason: 'pool off-peg - deferring to arb', poolPrice18, ref18, devBps, maxDevBps: cfg.maxPegDeviationBps });
        return { ok: false, legs: 0, error: 'peg-gate: off-peg' };
      }
    }

    // BUY leg - acquire ~tradeBase of base (spends USDC at the pool price).
    const buySwap = buildSwapArgs(mkDecision('BUY_BASE', cfg.tradeBase), cfg.market, poolPrice18, baseIsToken0, cfg.slippageBps, sqrtPriceX96, cfg.slippageBps);
    const buy = await sendSwapLeg(client, wallet, account, chain, cfg, buySwap);
    if (!buy.ok) {
      log({ msg: 'swapbot.roundtrip.buy.failed', error: buy.error, txHash: buy.txHash });
      return { ok: false, legs: 0, error: buy.error }; // no position change - buy didn't settle
    }

    // SELL leg - sell back down to target (undoes the buy + any dust), re-pricing off the post-buy
    // slot0 so the limit/min are correct. The BUY just added USDC to the pool, so the sell-back is
    // normally deliverable; we still cap by the pool's (post-buy) USDC defensively - a partial cap
    // sells what it can and the residual is recovered next tick.
    const after = await readPoolPrice(client, cfg, baseIsToken0);
    const [baseAfter, poolQuoteBalAfter, liquidityAfter] = await Promise.all([
      client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
      readPoolQuoteBal(client, cfg),
      client.readContract({ address: cfg.market.pool, abi: v3PoolAbi, functionName: 'liquidity' }) as Promise<bigint>,
    ]);
    const sellAmt = safeSellSize(
      sellToFlatAmount(baseAfter, flatTarget),
      liquidityAfter,
      poolQuoteBalAfter,
      after.poolPrice18,
      cfg.slippageBps,
      cfg.poolDeliverableSafetyBps ?? 0,
      baseIsToken0,
      cfg.market.baseDecimals,
      cfg.market.quoteDecimals,
    );
    if (sellAmt <= 0n) {
      log({ msg: 'swapbot.roundtrip.buy.empty', reason: 'no deliverable base to sell back (pool USDC thin or buy produced nothing)', baseAfter, poolQuoteBalAfter });
      return { ok: false, legs: 1 };
    }
    const sellSwap = buildSwapArgs(mkDecision('SELL_BASE', sellAmt), cfg.market, after.poolPrice18, baseIsToken0, cfg.slippageBps, after.sqrtPriceX96, cfg.slippageBps);
    const sell = await sendSwapLeg(client, wallet, account, chain, cfg, sellSwap);
    if (!sell.ok) {
      // Left holding `sellAmt` base - the NEXT tick's RECOVERY sells it off before buying again.
      log({ msg: 'swapbot.roundtrip.sell.failed', error: sell.error, heldBase: sellAmt, buyTx: buy.txHash, sellTx: sell.txHash });
      return { ok: false, legs: 1, error: sell.error };
    }
    log({ msg: 'swapbot.roundtrip', boughtBase: sellAmt, soldBase: sellAmt, buyTx: buy.txHash, sellTx: sell.txHash });
    return { ok: true, legs: 2 };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ msg: 'swapbot.error', error });
    return { ok: false, legs: 0, error };
  }
}

/**
 * MARKET-MAKER tick - the peg-band MM that replaces the one-way arb battery. Reads the pool price +
 * in-range liquidity + the bot's own inventory + the live Pyth ref, asks decideMaker for the single
 * inventory-skewed action, and executes it:
 *   - NEUTRAL  -> a peg-neutral round-trip (volume without moving the peg) - inside the deadband;
 *   - SELL/BUY -> a single peg-CORRECTING leg, ref-pinned (purpose 'arb' so the AMM can fill UP TO the
 *                 oracle but never past it), sized by decideMaker (skewed + hard cirBTC floor);
 *   - NONE     -> idle (rationing near the floor on a high pool, or no USDC budget) - logged.
 * Fails CLOSED on a missing Pyth ref (never trades blind). Never throws out of the loop.
 */
export async function runMakerOnce(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  cfg: SwapbotConfig,
  baseIsToken0: boolean,
): Promise<{ ok: boolean; kind: string; error?: string }> {
  const maker = cfg.maker;
  if (maker === undefined) return { ok: false, kind: 'NONE', error: 'maker disabled' };
  try {
    const [{ poolPrice18, sqrtPriceX96 }, liquidity, invBase, invQuote] = await Promise.all([
      readPoolPrice(client, cfg, baseIsToken0),
      client.readContract({ address: cfg.market.pool, abi: v3PoolAbi, functionName: 'liquidity' }) as Promise<bigint>,
      client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
      client.readContract({ address: cfg.market.quote, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    ]);

    // The live Pyth reference (same feed the arena/arb use). A Hermes failure FAILS CLOSED - never
    // make a market against a price we can't verify.
    let ref18: bigint;
    try {
      ({ price18: ref18 } = await fetchPythRef(cfg.hermesUrl, cfg.market.feedId, cfg.hermesTimeoutMs));
    } catch (err) {
      log({ msg: 'swapmaker.skip', reason: 'hermes ref unavailable (failing closed)', error: err instanceof Error ? err.message : String(err) });
      return { ok: false, kind: 'NONE', error: 'no ref' };
    }

    const decision = decideMaker(
      { poolPrice18, ref18, invBase, invQuote, liquidity, baseIsToken0 },
      {
        deadbandBps: maker.deadbandBps,
        floorBase: maker.floorBase,
        targetBase: maker.targetBase,
        reserveQuote: maker.reserveQuote,
        maxTradeBase: maker.maxTradeBase,
        minTradeBase: maker.minTradeBase,
        closeFraction: maker.closeFraction,
        skewK: maker.skewK,
        baseDecimals: cfg.market.baseDecimals,
        quoteDecimals: cfg.market.quoteDecimals,
      },
    );

    if (decision.kind === 'NONE') {
      log({ msg: 'swapmaker.idle', reason: decision.reason, devBps: decision.devBps, invBase, invQuote });
      return { ok: false, kind: 'NONE' };
    }
    if (decision.kind === 'NEUTRAL') {
      // Inside the deadband - generate volume with a round-trip AROUND the working reserve (NOT down
      // to zero). Passing maker.targetBase as the flat target means: below target it net-accumulates
      // toward target, AT target it's a true buy==sell neutral round-trip, above target it net-sells
      // toward target - volume + soft inventory centering, and the reserve is never dumped.
      log({ msg: 'swapmaker.neutral', devBps: decision.devBps, invBase, target: maker.targetBase });
      const rt = await runRoundTripOnce(client, wallet, account, chain, cfg, baseIsToken0, maker.targetBase);
      return { ok: rt.ok, kind: 'NEUTRAL', error: rt.error };
    }

    // SELL_BASE / BUY_BASE - a peg-correcting leg. purpose 'arb' pins the limit at the ref so the AMM
    // fills up to the oracle and can NEVER push the pool past it (the same safety the arb uses).
    const dir = decision.kind; // 'SELL_BASE' | 'BUY_BASE'
    const dec = {
      kind: 'SWAP' as const,
      direction: dir,
      amountInBase: decision.sizeBase!,
      purpose: 'arb' as const,
      reason: decision.reason,
    } as unknown as ArbDecision & { kind: 'SWAP' };
    const swap = buildSwapArgs(dec, cfg.market, ref18, baseIsToken0, cfg.slippageBps, sqrtPriceX96, cfg.slippageBps);
    const r = await sendSwapLeg(client, wallet, account, chain, cfg, swap);
    log({ msg: 'swapmaker.correct', dir, devBps: decision.devBps, sizeBase: decision.sizeBase, ok: r.ok, txHash: r.txHash, error: r.error });
    return { ok: r.ok, kind: dir, error: r.error };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ msg: 'swapbot.error', error });
    return { ok: false, kind: 'NONE', error };
  }
}

/**
 * EPOCH-PAIR tick - the once-per-epoch balanced, peg-NEUTRAL pair (the drift-proof replacement for
 * the continuous round-trip). Reads the pool price + in-range liquidity + the live Pyth ref (fails
 * CLOSED on a Hermes miss - never trades blind), STANDS DOWN if the pool is off-peg (same gate as
 * everywhere else so it never pumps volume into a pool the arb is re-pegging), sizes the pair by
 * pool depth via pairSizeBase, and fires ONE atomic router.multicall([SELL tradeBase, BUY
 * tradeBase]). SELL-first, both legs' sqrtPriceLimitX96 pinned to the oracle (purpose 'arb') so
 * neither leg can push the pool past the peg. Atomicity is the whole point: if either leg reverts
 * (slippage / thin pool / limit), the WHOLE tx reverts and the pool is provably never left pushed
 * and no residual long can EVER form. NEVER throws. On a successful pair the CALLER stamps the
 * epoch ledger (so it fires at most once per epoch); a revert leaves the ledger untouched to retry.
 */
export async function runEpochPairOnce(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  cfg: SwapbotConfig,
  baseIsToken0: boolean,
  epochId: bigint,
): Promise<{ ok: boolean; legs: number; sizeBase?: bigint; txHash?: `0x${string}`; error?: string }> {
  const epoch = cfg.epoch;
  if (epoch === undefined) return { ok: false, legs: 0, error: 'epoch mode disabled' };
  try {
    const [{ poolPrice18, sqrtPriceX96 }, liquidity] = await Promise.all([
      readPoolPrice(client, cfg, baseIsToken0),
      client.readContract({ address: cfg.market.pool, abi: v3PoolAbi, functionName: 'liquidity' }) as Promise<bigint>,
    ]);

    // The live Pyth reference (same feed the arena/arb use). A Hermes failure FAILS CLOSED - never
    // fire the pair against a price we can't verify (and we DON'T stamp the ledger, so it retries).
    let ref18: bigint;
    try {
      ({ price18: ref18 } = await fetchPythRef(cfg.hermesUrl, cfg.market.feedId, cfg.hermesTimeoutMs));
    } catch (err) {
      log({ msg: 'swapbot.epoch.skip', epochId, reason: 'hermes ref unavailable (failing closed)', error: err instanceof Error ? err.message : String(err) });
      return { ok: false, legs: 0, error: 'no ref' };
    }

    // PEG GATE - stand down (do NOT stamp) when the pool is off-peg; let the arb re-peg first. Same
    // fail-closed band as the round-trip/maker gate. Gate OFF (maxPegDeviationBps<=0) => no check.
    if (!pegWithinBand(poolPrice18, ref18, cfg.maxPegDeviationBps)) {
      const diff = poolPrice18 > ref18 ? poolPrice18 - ref18 : ref18 - poolPrice18;
      const devBps = ref18 > 0n ? Number((diff * 10_000n) / ref18) : -1;
      log({ msg: 'swapbot.epoch.paused', epochId, reason: 'pool off-peg - deferring to arb (will retry this epoch)', poolPrice18, ref18, devBps, maxDevBps: cfg.maxPegDeviationBps });
      return { ok: false, legs: 0, error: 'peg-gate: off-peg' };
    }

    // Size the pair by pool depth so a single leg can't blow a thin pool past peg (see pairSizeBase).
    const sizeBase = pairSizeBase(
      liquidity,
      poolPrice18,
      ref18,
      epoch.pairCloseFraction,
      epoch.pairTradeBase,
      epoch.pairMaxTradeBase,
      epoch.pairMinTradeBase,
      baseIsToken0,
      cfg.market.baseDecimals,
      cfg.market.quoteDecimals,
    );
    if (sizeBase <= 0n) {
      // Dust after depth-sizing - skip the pair this epoch but STAMP (we "acted": there was nothing
      // safe to trade). Returning ok here lets the caller stamp so we don't re-evaluate every tick.
      log({ msg: 'swapbot.epoch.dust', epochId, reason: 'sized pair below the dust floor - skipping this epoch', liquidity, poolPrice18, ref18 });
      return { ok: true, legs: 0, sizeBase: 0n };
    }

    // Build BOTH legs ref-pinned (purpose 'arb'): each fills UP TO the oracle and cannot cross it -
    // the SELL stops at the peg from above, the BUY stops at the peg from below. SELL-first so, even
    // if the router were ever non-atomic, the pool is only ever transiently at-or-BELOW the oracle.
    const mkDecision = (direction: SwapDir) =>
      ({ kind: 'SWAP', direction, amountInBase: sizeBase, purpose: 'arb', reason: 'swapbot epoch pair' } as unknown as ArbDecision & { kind: 'SWAP' });
    const sell = buildSwapArgs(mkDecision('SELL_BASE'), cfg.market, ref18, baseIsToken0, cfg.slippageBps, sqrtPriceX96, cfg.slippageBps);
    const buy = buildSwapArgs(mkDecision('BUY_BASE'), cfg.market, ref18, baseIsToken0, cfg.slippageBps, sqrtPriceX96, cfg.slippageBps);

    const encodeLeg = (s: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint }): `0x${string}` =>
      encodeFunctionData({
        abi: swapRouterAbi,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: s.tokenIn,
            tokenOut: s.tokenOut,
            fee: cfg.market.feeTier,
            recipient: account.address,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 30),
            amountIn: s.amountIn,
            amountOutMinimum: s.amountOutMinimum,
            sqrtPriceLimitX96: s.sqrtPriceLimitX96,
          },
        ],
      });

    // ONE atomic multicall([SELL, BUY]) sent through the same bounded gas-tip escalation as a single
    // leg (RBF on a receipt timeout, never a second independent multicall - no double-fill). The
    // deadline is refreshed per attempt (rebuild the calldata) exactly like the single-leg send.
    const buildWrite = (gas: GasOverrides): Parameters<WalletClient['writeContract']>[0] =>
      ({
        address: cfg.market.router,
        abi: swapRouterAbi,
        functionName: 'multicall',
        account,
        chain,
        maxFeePerGas: gas.maxFeePerGas,
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas,
        args: [[encodeLeg(sell), encodeLeg(buy)]],
      } as Parameters<WalletClient['writeContract']>[0]);

    const attempts = totalAttempts(cfg.gasEscalation);
    let txHash: `0x${string}` | undefined;
    let receipt: { status: 'success' | 'reverted' } | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) log({ msg: 'swapbot.gas.escalate', attempt, of: attempts - 1 });
      txHash = (await wallet.writeContract(buildWrite(escalatedGas(attempt, cfg.gasEscalation)))) as `0x${string}`;
      try {
        receipt = (await client.waitForTransactionReceipt({ hash: txHash, timeout: cfg.receiptTimeoutMs })) as {
          status: 'success' | 'reverted';
        };
        break;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof WaitForTransactionReceiptTimeoutError)) throw err;
        if (attempt === attempts - 1) throw err;
      }
    }
    if (receipt === undefined) throw lastErr instanceof Error ? lastErr : new Error('gas escalation exhausted');
    if (receipt.status !== 'success') {
      log({ msg: 'swapbot.epoch.reverted', epochId, sizeBase, txHash });
      return { ok: false, legs: 0, sizeBase, txHash, error: 'reverted' };
    }
    log({ msg: 'swapbot.epoch.pair', epochId, sizeBase, txHash });
    return { ok: true, legs: 2, sizeBase, txHash };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log({ msg: 'swapbot.error', error });
    return { ok: false, legs: 0, error };
  }
}

async function main(): Promise<void> {
  const cfg = loadSwapbotConfig();

  // Probe chainId across the RPCs (testnet vs mainnet never hardcoded).
  let chainId: number | undefined;
  for (const url of cfg.rpcUrls) {
    try {
      chainId = await createPublicClient({ transport: http(url, { timeout: 10_000 }) }).getChainId();
      break;
    } catch (err) {
      log({ msg: 'swapbot.probe.error', rpc: url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (chainId === undefined) throw new Error('could not reach any RPC to probe chainId');

  const { account, chain, publicClient, walletClient } = buildClients(cfg, chainId);
  const baseIsToken0 = await resolveBaseIsToken0(publicClient, cfg.market.pool, cfg.market.base);

  log({
    msg: 'swapbot.start',
    signer: account.address,
    chainId,
    market: cfg.market.id,
    pool: cfg.market.pool,
    baseIsToken0,
    feeTier: cfg.market.feeTier,
    swapsPerMin: cfg.swapsPerMin,
    intervalMs: cfg.intervalMs,
    tradeBase: cfg.tradeBase,
    slippageBps: cfg.slippageBps,
    mode: cfg.epoch?.enabled
      ? 'epoch-gated pair (peg-neutral, once/epoch)'
      : cfg.maker?.enabled
        ? 'maker (peg-band MM)'
        : cfg.roundTrip
          ? 'roundtrip (peg-neutral)'
          : 'alternate',
    maxPegDeviationBps: cfg.maxPegDeviationBps,
    maker: cfg.maker?.enabled
      ? { deadbandBps: cfg.maker.deadbandBps, floorBase: cfg.maker.floorBase, targetBase: cfg.maker.targetBase, skewK: cfg.maker.skewK }
      : false,
    epoch: cfg.epoch?.enabled
      ? {
          arena: cfg.epoch.arena,
          ledgerFile: cfg.epoch.ledgerFile,
          pairTradeBase: cfg.epoch.pairTradeBase,
          pairCloseFraction: cfg.epoch.pairCloseFraction,
          // Reminder for the operator: keep this much cirBTC in the wallet to fund the SELL-first leg
          // (it round-trips atomically, so it's held, not spent).
          workingReserveBase: cfg.epoch.workingReserveBase,
        }
      : false,
  });

  let running = true;
  const stop = (sig: string) => {
    log({ msg: 'swapbot.shutdown', signal: sig });
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // The bot TOLERATES being unfunded: it does not approve or swap until the wallet has enough
  // native gas, and starts automatically once funded - no container restart needed after a top-up.
  // 0.005 native is enough to attempt a router approval + a swap; below it we idle and wait.
  const MIN_OPERATING_WEI = 5_000_000_000_000_000n;
  let approved = false; // router approval is done LAZILY (it needs gas), retried until it lands.
  let sinceBalanceCheck = 0;
  // Last SUCCESSFUL balance read. On a transient getBalance failure we carry this forward instead
  // of treating the bot as broke - otherwise one flaky RPC read would idle a FULLY-FUNDED bot for
  // the minute. Stays 0n until the first successful read (so a never-funded bot still idles).
  let lastGoodBal = 0n;
  // Strict alternation state: start at BUY_BASE so the first executed swap is a SELL_BASE. Only
  // advanced on a SUCCESSFUL swap, so a reverted tick re-tries the same direction (keeps it balanced).
  let lastDir: SwapDir = 'BUY_BASE';

  // EPOCH mode state: the persisted lastEpochActed scalar, loaded ONCE at boot so a restart mid-epoch
  // can't double-fire the pair. Only touched when cfg.epoch is enabled.
  let epochLedger: EpochLedger = cfg.epoch?.enabled ? loadEpochLedger(cfg.epoch.ledgerFile) : { lastEpochActed: null };
  if (cfg.epoch?.enabled) {
    log({ msg: 'swapbot.epoch.ledger.loaded', ledgerFile: cfg.epoch.ledgerFile, lastEpochActed: epochLedger.lastEpochActed });
  }

  while (running) {
    const t0 = Date.now();

    // Read the gas balance each tick (cheap); periodically log it so a drained bot is visible. On a
    // transient read failure, CARRY the last known-good balance (don't fall back to 0n and idle a
    // funded bot for the minute over one flaky RPC call).
    let bal = lastGoodBal;
    try {
      bal = await publicClient.getBalance({ address: account.address });
      lastGoodBal = bal;
    } catch { /* transient - reuse lastGoodBal for this tick */ }
    if (sinceBalanceCheck <= 0) {
      log({ msg: bal < cfg.lowBalanceWei ? 'WARN low swapbot balance' : 'swapbot.balance', signer: account.address, balanceWei: bal.toString() });
      sinceBalanceCheck = 30;
    }
    sinceBalanceCheck -= 1;

    // Gas gate: not enough native to operate -> idle (don't spam failing estimateGas). Starts
    // working on its own the moment the wallet is funded.
    if (bal < MIN_OPERATING_WEI) {
      log({ msg: 'swapbot.waiting', reason: 'insufficient gas - fund the swap-bot wallet (gas + cirBTC + USDC)', balanceWei: bal.toString() });
      await sleep(Math.max(2000, cfg.intervalMs));
      continue;
    }

    // Lazy one-time router approval for BOTH legs (needs gas; without it every swap reverts STF).
    // Retried on the next tick if it fails (e.g. a transient RPC error).
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
        log({ msg: 'swapbot.approvals', legs: approvals.map((a) => ({ leg: a.leg, sufficient: a.sufficient, approvedTxHash: a.approvedTxHash })) });
      } catch (err) {
        log({ msg: 'swapbot.approve.error', error: err instanceof Error ? err.message : String(err) });
        await sleep(Math.max(2000, cfg.intervalMs));
        continue;
      }
    }

    // EPOCH mode (once-per-epoch balanced peg-neutral pair): supersedes maker/round-trip/alternate.
    // Read the arena's current epoch; if we haven't already acted in it, fire ONE atomic
    // multicall([SELL, BUY]) pinned to the oracle, and on success STAMP + persist the epoch so it
    // fires at most once per epoch (crash-safe via the ledger). A revert/off-peg tick leaves the
    // ledger untouched to retry within the same epoch. A failed arena read just idles this tick.
    if (cfg.epoch?.enabled) {
      let epochId: bigint | undefined;
      try {
        epochId = (await publicClient.readContract({ address: cfg.epoch.arena, abi: feeArenaV3Abi, functionName: 'currentEpochId' })) as bigint;
      } catch (err) {
        log({ msg: 'swapbot.epoch.read.error', reason: 'could not read currentEpochId - idling this tick', error: err instanceof Error ? err.message : String(err) });
      }
      if (epochId !== undefined && shouldActThisEpoch(epochLedger, epochId)) {
        const res = await runEpochPairOnce(publicClient, walletClient, account, chain, cfg, baseIsToken0, epochId);
        if (res.ok) {
          // Stamp only on a successful pair (or a deliberate dust-skip): fire at most once per epoch.
          epochLedger = recordEpochActed(epochLedger, epochId);
          saveEpochLedgerSync(epochLedger, cfg.epoch.ledgerFile);
        }
      }
    } else if (cfg.maker?.enabled) {
      // MARKET-MAKER mode (peg-band MM): supersedes round-trip/alternate. Trades toward the peg with a
      // hard cirBTC floor + buy-refill, neutral round-trip inside the deadband. Else legacy modes.
      await runMakerOnce(publicClient, walletClient, account, chain, cfg, baseIsToken0);
    } else if (cfg.roundTrip) {
      await runRoundTripOnce(publicClient, walletClient, account, chain, cfg, baseIsToken0);
    } else {
      const res = await runSwapOnce(publicClient, walletClient, account, chain, cfg, baseIsToken0, lastDir);
      if (res.ok && res.dir !== 'NONE') lastDir = res.dir; // advance alternation only on success
    }

    if (!running) break;
    // Maintain the target rate: sleep the remainder of the interval after the swap settled.
    const elapsed = Date.now() - t0;
    await sleep(Math.max(0, cfg.intervalMs - elapsed));
  }
  log({ msg: 'swapbot.stopped' });
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'swapbot.fatal', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
