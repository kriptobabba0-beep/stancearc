// keeperV3.ts - the per-market crank for ENTRY-ANCHORED (v3) markets.
//
// Mirrors keeper.ts's runMarketOnce contract exactly (read -> pure decide -> execute AT
// MOST ONE action -> TickLog), but against the v3 lifecycle: no startEpoch; instead a
// SETTLE action that (a) samples the live Pyth price off-chain for a short window
// (default 60s, the PDF's settlement average), (b) submits the average with the sample
// window + a keccak hash of the samples for auditability, and (c) posts a FRESH Pyth
// blob in the same tx - the contract anchors the submitted average against that on-chain
// read (settleSanityBps), so this keeper can never write a price Pyth doesn't corroborate.
import { keccak256, encodePacked, type Abi, type PublicClient, type WalletClient, type Account, type Chain } from 'viem';
import { feeArenaV3Abi } from './abi.js';
import { fetchPythRef, fetchPythCrossRef } from './hermes.js';
import {
  decideActionV3,
  decideRecoveryV3,
  PhaseViewV3,
  type ActionV3,
  type KeeperStateV3,
} from './decideV3.js';
import {
  sendWriteWithEscalation,
  fetchUpdateAndFee,
  logTick,
  WouldRevertError,
  type SendControls,
  type TickLog,
} from './keeper.js';
import { SpendCapTrippedError } from './spendGuard.js';
import { fitBatchUnderCap } from './gasFit.js';
import type { KeeperConfig, MarketConfig } from './config.js';

const PHASE_NAME_V3: Record<number, string> = {
  [PhaseViewV3.Idle]: 'Idle',
  [PhaseViewV3.EntryOpen]: 'EntryOpen',
  [PhaseViewV3.Locked]: 'Locked',
  [PhaseViewV3.Settling]: 'Settling',
  [PhaseViewV3.Settled]: 'Settled',
};

function logLine(o: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** One settlement sample set: average + the audit fields the contract records. */
export interface SettlementSamples {
  avgPrice18: bigint;
  sampleStart: bigint; // first sample's publishTime (unix sec)
  sampleEnd: bigint; // last sample's publishTime (unix sec)
  samplesHash: `0x${string}`; // keccak256(encodePacked(uint256[] prices))
  count: number;
}

/** PURE aggregation of collected sample prices (exported for unit tests). */
export function aggregateSamples(prices18: bigint[], startSec: number, endSec: number): SettlementSamples {
  if (prices18.length === 0) throw new Error('no settlement samples collected');
  let sum = 0n;
  for (const p of prices18) sum += p;
  return {
    avgPrice18: sum / BigInt(prices18.length),
    sampleStart: BigInt(startSec),
    sampleEnd: BigInt(endSec),
    samplesHash: keccak256(encodePacked(['uint256[]'], [prices18])),
    count: prices18.length,
  };
}

/**
 * Sample Hermes for `sampleSec` seconds (every `intervalMs`) and aggregate. Individual
 * fetch failures are skipped; fewer than 3 good samples is a hard error (the tick fails
 * and retries next pass - never settle on a near-empty average).
 */
async function sampleSettlementWindow(
  cfg: KeeperConfig,
  market: MarketConfig,
): Promise<SettlementSamples> {
  const sampleSec = cfg.v3SampleSec;
  const intervalMs = cfg.v3SampleIntervalMs;
  const prices: bigint[] = [];
  let first = 0;
  let last = 0;
  const deadline = Date.now() + sampleSec * 1000;
  logLine({ msg: 'keeper.v3.sampling', market: market.id, sampleSec, intervalMs });
  while (Date.now() < deadline) {
    try {
      // CROSS market (e.g. cirBTC/EURC = BTC/EUR): sample feedId÷quoteFeedId; else the single feed.
      const ref = market.quoteFeedId
        ? await fetchPythCrossRef(cfg.hermesUrl, market.feedId, market.quoteFeedId, cfg.hermesTimeoutMs)
        : await fetchPythRef(cfg.hermesUrl, market.feedId, cfg.hermesTimeoutMs);
      prices.push(ref.price18);
      if (first === 0) first = ref.publishTimeSec;
      last = ref.publishTimeSec;
    } catch {
      // transient Hermes hiccup - skip this sample, keep the window going
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  if (prices.length < 3) throw new Error(`settlement sampling too sparse (${prices.length} samples)`);
  return aggregateSamples(prices, first, last);
}

// ─── Settlement PRE-SAMPLING ─────────────────────────────────────────────────────────────
// The contract documents the settlement average as "the last 60s of Pyth prices" - the window
// ENDING at settlementTime. Sampling it AFTER the moment (the original implementation) both
// shifted the measured window past the epoch boundary and blocked the tick for the whole
// v3SampleSec - the single biggest chunk of the "Settlement in progress…" dead time. Instead,
// a tick that lands inside [settlementTime - v3SampleSec, settlementTime) spawns a background
// sampler that collects until EXACTLY settlementTime; the SETTLE crank then submits within ~2s
// of the boundary. The sampler is consumed EXACTLY once - every fallback (keeper restarted
// mid-window, <3 samples, or a submit the sanity anchor rejected after a violent last-minute
// move) re-samples with the legacy post-settlement window, so this path is strictly additive:
// no failure mode exists here that did not exist before.

interface PreSampleEntry {
  epochId: bigint;
  prices: bigint[];
  firstSec: number;
  lastSec: number;
  done: boolean;
  promise: Promise<void>;
}

const preSamplers = new Map<string, PreSampleEntry>();

/** Test hook: drop all in-flight pre-samplers (they run against real wall-clock deadlines). */
export function resetPreSamplersForTests(): void {
  preSamplers.clear();
}

/** PURE: should this tick spawn the background pre-sampler for the current epoch? */
export function shouldPreSample(state: KeeperStateV3, sampleSec: number, enabled: boolean): boolean {
  if (!enabled || state.paused) return false;
  if (state.phase !== PhaseViewV3.EntryOpen && state.phase !== PhaseViewV3.Locked) return false;
  const startSec = state.settlementTime - BigInt(sampleSec);
  return state.nowSec >= startSec && state.nowSec < state.settlementTime;
}

/** Spawn (idempotently) the pre-sampler for this market's current epoch. Never blocks the tick. */
function maybeSpawnPreSampler(cfg: KeeperConfig, market: MarketConfig, state: KeeperStateV3): void {
  if (!shouldPreSample(state, cfg.v3SampleSec, cfg.v3PreSampleEnabled === true)) return;
  const existing = preSamplers.get(market.id);
  if (existing !== undefined && existing.epochId === state.currentEpochId) return; // already running
  const endMs = Number(state.settlementTime) * 1000;
  const entry: PreSampleEntry = {
    epochId: state.currentEpochId,
    prices: [],
    firstSec: 0,
    lastSec: 0,
    done: false,
    promise: Promise.resolve(),
  };
  entry.promise = (async () => {
    logLine({
      msg: 'keeper.v3.presample.start',
      market: market.id,
      epochId: state.currentEpochId,
      sampleSec: cfg.v3SampleSec,
      endsAtSec: state.settlementTime,
    });
    while (Date.now() < endMs) {
      try {
        const ref = market.quoteFeedId
          ? await fetchPythCrossRef(cfg.hermesUrl, market.feedId, market.quoteFeedId, cfg.hermesTimeoutMs)
          : await fetchPythRef(cfg.hermesUrl, market.feedId, cfg.hermesTimeoutMs);
        entry.prices.push(ref.price18);
        if (entry.firstSec === 0) entry.firstSec = ref.publishTimeSec;
        entry.lastSec = ref.publishTimeSec;
      } catch {
        // transient Hermes hiccup - skip this sample, keep the window going
      }
      const remaining = endMs - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(cfg.v3SampleIntervalMs, remaining)));
    }
    entry.done = true;
    logLine({ msg: 'keeper.v3.presample.done', market: market.id, epochId: entry.epochId, samples: entry.prices.length });
  })();
  preSamplers.set(market.id, entry);
}

/**
 * PEEK the pre-sampled window for (market, epoch): wait briefly for the tail sample, then
 * aggregate. Returns undefined when absent/stale/sparse - the caller falls back to the legacy
 * post-settlement window. Deliberately NON-consuming: the [T-window, T] average stays valid
 * across an anchor-too-early retry (SettlePriceTooOld) - only a COMPLETED settle attempt or a
 * REJECTED average (SettlePriceOutOfBounds) discards it, via discardPreSamples below.
 */
async function peekPreSamples(marketId: string, epochId: bigint, waitMs: number): Promise<SettlementSamples | undefined> {
  const entry = preSamplers.get(marketId);
  if (entry === undefined) return undefined;
  if (entry.epochId !== epochId) {
    preSamplers.delete(marketId); // stale epoch - discard
    return undefined;
  }
  await Promise.race([entry.promise, new Promise((r) => setTimeout(r, waitMs))]);
  if (!entry.done || entry.prices.length < 3) return undefined;
  return aggregateSamples(entry.prices, entry.firstSec, entry.lastSec);
}

/** Drop the pre-sample for a market (settle attempt completed, or its average was rejected). */
function discardPreSamples(marketId: string): void {
  preSamplers.delete(marketId);
}

/**
 * PURE: bounded ms the SETTLE crank must still wait past the settlement moment so the anchor
 * blob it fetches is stamped AT/AFTER it (the contract's SettlePriceTooOld bound). Zero when
 * already past the margin (the legacy late-arrival path never waits).
 */
export function anchorWaitMs(settlementTimeSec: bigint, nowMs: number, marginSec: number): number {
  const dueMs = Number(settlementTimeSec) * 1000 + marginSec * 1000;
  const wait = dueMs - nowMs;
  return wait > 0 ? wait : 0;
}

// ─── Settlement pipeline CHAINING + adaptive wake ────────────────────────────────────────

/** PURE: may the chain START another step? The first action of a tick is never gated. */
export function chainMayContinue(stepsDone: number, elapsedMs: number, budgetMs: number, maxSteps: number): boolean {
  return budgetMs > 0 && stepsDone < maxSteps && elapsedMs < budgetMs;
}

/**
 * PURE: did the on-chain state ADVANCE between two reads? The chain proceeds only when it did -
 * so a lagging RPC view (a mined tx whose effect isn't visible yet) can never re-fire the same
 * crank twice; the tick simply ends on its last success and the normal poll resumes.
 */
export function stateAdvancedV3(prev: KeeperStateV3, next: KeeperStateV3): boolean {
  return (
    next.currentEpochId !== prev.currentEpochId ||
    next.phase !== prev.phase ||
    next.processedCursor !== prev.processedCursor ||
    (next.unstakeDone ?? -1) !== (prev.unstakeDone ?? -1) ||
    (next.lastSettledEpochId ?? -1n) !== (prev.lastSettledEpochId ?? -1n)
  );
}

/**
 * PURE: ms until this market next needs the loop's attention - the pre-sample start (so the
 * window opens on time) or the settlement moment itself (so SETTLE fires within ~2s of the
 * boundary). undefined when no boundary is near - the default poll cadence is fine.
 */
export function hintNextWakeMs(state: KeeperStateV3, sampleSec: number, preSampleEnabled: boolean): number | undefined {
  if (state.paused) return undefined;
  if (state.phase !== PhaseViewV3.EntryOpen && state.phase !== PhaseViewV3.Locked) return undefined;
  if (state.nowSec >= state.settlementTime) return undefined; // already due - the action path owns it
  const preStart = state.settlementTime - BigInt(sampleSec);
  const target = preSampleEnabled && state.nowSec < preStart ? preStart : state.settlementTime;
  // +250ms so the wake lands just PAST the boundary, never a hair before it.
  return Number(target - state.nowSec) * 1000 + 250;
}

/** Read the v3 on-chain state slice (epoch view + auto-return backlog, best-effort). */
async function readStateV3(
  client: PublicClient,
  market: MarketConfig,
  nowSec: bigint,
): Promise<KeeperStateV3> {
  const arena = market.arena;
  const abi = feeArenaV3Abi as unknown as Abi;
  const [currentEpochId, epoch, paused] = await Promise.all([
    client.readContract({ address: arena, abi, functionName: 'currentEpochId' }) as Promise<bigint>,
    client.readContract({ address: arena, abi, functionName: 'currentEpoch' }) as Promise<{
      phase: number | bigint;
      entryCloseTime: bigint;
      settlementTime: bigint;
      processedCursor: number;
      stakedCount: number;
    }>,
    client.readContract({ address: arena, abi, functionName: 'paused' }) as Promise<boolean>,
  ]);

  // Auto-return backlog (best-effort - a failed read must never fail the lifecycle tick).
  let lastSettledEpochId: bigint | undefined;
  let unstakeDone: number | undefined;
  let unstakeTotal: number | undefined;
  try {
    lastSettledEpochId = (await client.readContract({
      address: arena,
      abi,
      functionName: 'lastSettledEpochId',
    })) as bigint;
    if (lastSettledEpochId !== 0n && lastSettledEpochId !== undefined) {
      const [cursor, progress] = await Promise.all([
        client.readContract({ address: arena, abi, functionName: 'unstakeCursor', args: [lastSettledEpochId] }),
        client.readContract({ address: arena, abi, functionName: 'processProgress', args: [lastSettledEpochId] }),
      ]);
      unstakeDone = Number(cursor as number | bigint);
      unstakeTotal = Number((progress as readonly [number, number])[1]);
    }
  } catch {
    lastSettledEpochId = undefined;
    unstakeDone = undefined;
    unstakeTotal = undefined;
  }

  return {
    currentEpochId,
    phase: Number(epoch.phase) as PhaseViewV3,
    entryCloseTime: epoch.entryCloseTime,
    settlementTime: epoch.settlementTime,
    processedCursor: Number(epoch.processedCursor),
    stakedCount: Number(epoch.stakedCount),
    nowSec,
    paused,
    lastSettledEpochId,
    unstakeDone,
    unstakeTotal,
  };
}

/**
 * Size a position-iterating crank (processPositions / unstakeBatch) to fit under the RPC's hard
 * per-tx gas cap and return the explicit gas-limit to submit it with. Probes eth_estimateGas per
 * candidate batch (shrinking on the over-cap signal), so it self-tunes to the actual per-position
 * cost - large batches when positions are cheap, one-at-a-time when a single position approaches
 * the cap. A non-gas estimate error (real revert / transport) bubbles to the normal failure path.
 */
async function fitPositionCrank(
  client: PublicClient,
  base: { address: `0x${string}`; abi: Abi; account: Account; chain: Chain },
  functionName: 'processPositions' | 'unstakeBatch',
  epochId: bigint,
  remaining: number,
  cfg: KeeperConfig,
  ctx: { market: string; action: string },
): Promise<{ count: number; gas: bigint }> {
  const desired = Math.min(cfg.sweepBatch, Math.max(1, remaining));
  const fit = await fitBatchUnderCap({
    desired,
    cap: cfg.txGasCap,
    estimate: (count) =>
      client.estimateContractGas({
        ...base,
        functionName,
        args: [epochId, BigInt(count)],
      } as Parameters<PublicClient['estimateContractGas']>[0]),
  });
  // Surface only the non-trivial outcomes: a shrunk batch or a call sitting right at the cap.
  if (fit.count < desired || fit.capped) {
    logLine({
      msg: 'keeper.v3.gasfit',
      market: ctx.market,
      action: ctx.action,
      function: functionName,
      epochId: epochId.toString(),
      desired,
      count: fit.count,
      gasLimit: fit.gasLimit.toString(),
      cap: cfg.txGasCap.toString(),
      note:
        fit.count === 1 && fit.capped
          ? 'single position at the RPC gas cap (heaviest case) - submitting one at a time'
          : 'batch shrunk to fit the RPC gas cap',
    });
  }
  return { count: fit.count, gas: fit.gasLimit };
}

/**
 * Run a single tick for one v3 market: read -> decideActionV3 -> execute (awaiting each receipt).
 * Never throws; failures land in rec.error (same breaker/backoff contract as runMarketOnce).
 *
 * PIPELINE CHAINING: with cfg.v3ChainBudgetMs > 0, a successful settlement-path action does NOT
 * end the tick - the state is re-read and the next decided action executes back-to-back
 * (SETTLE -> PROCESS.. -> FINALIZE -> UNSTAKE.. -> CREATE -> OPEN), eliminating the full poll gap
 * the legacy cadence paid between every step (the bulk of the "Settlement in progress…" dead
 * time). Every chained step keeps the exact lone-action safety rails (simulate gate, spend cap,
 * gas escalation, receipt wait); the FIRST failure returns that step's error rec so the loop's
 * breaker/backoff sees it exactly as before; and the chain only proceeds while the re-read state
 * actually ADVANCED, so a lagging RPC view can never double-fire a crank. Budget 0 = the legacy
 * one-action-per-tick behavior, unchanged.
 */
export async function runMarketOnceV3(
  client: PublicClient,
  wallet: WalletClient,
  account: Account,
  chain: Chain,
  market: MarketConfig,
  cfg: KeeperConfig,
  send?: SendControls,
  owner?: { wallet: WalletClient; account: Account },
): Promise<TickLog> {
  const abi = feeArenaV3Abi as unknown as Abi;
  // Owner-key cranks (emergencySettle recovery) draw on the SEPARATE owner reserve, so they get the
  // simulate gate but NOT the keeper signer's spend cap.
  const sendOwner: SendControls | undefined = send ? { ...send, guard: undefined } : undefined;
  const tickStartMs = Date.now();
  const chainBudgetMs = cfg.v3ChainBudgetMs ?? 0;
  const chainMaxSteps = cfg.v3ChainMaxSteps ?? 24;

  let lastExecuted: TickLog | undefined;
  let prevState: KeeperStateV3 | undefined;

  for (let step = 0; ; step += 1) {
    const rec: TickLog = {
      ts: new Date().toISOString(),
      market: market.id,
      epochId: '?',
      phase: '?',
      action: 'NONE',
    };

    try {
      const nowSec = BigInt(Math.floor(Date.now() / 1000));
      const state = await readStateV3(client, market, nowSec);
      rec.epochId = state.currentEpochId.toString();
      rec.phase = PHASE_NAME_V3[state.phase] ?? `Unknown(${state.phase})`;

      // Background settlement pre-sampler: no-op outside its [T-window, T) arm window, idempotent
      // inside it, and never blocks the tick.
      maybeSpawnPreSampler(cfg, market, state);

      // OWNER-KEY SELF-HEAL: if an epoch is stuck UNSETTLED past the on-chain grace (dead oracle /
      // every submit rejected), emergencySettle it with the separate owner wallet so the lifecycle
      // never freezes. Checked BEFORE the normal action: while WAIT_GRACE we still attempt SETTLE
      // (the oracle may recover); only once grace elapses do we fall to recovery. A v3 market with no
      // owner key behaves exactly as before (the wedge surfaces via the loop's failure/backoff path).
      // Only ever the FIRST consideration of a tick - a mid-chain state can't be a recovery shape.
      if (step === 0) {
        const recovery = decideRecoveryV3(state, owner !== undefined);
        if (recovery === 'RECOVER') {
          rec.action = 'RECOVER';
          const ownerSigner = owner!; // RECOVER implies owner !== undefined (decideRecoveryV3 gate)
          const { txHash: recoverTx, receipt: recoverReceipt } = await sendWriteWithEscalation(
            client,
            ownerSigner.wallet,
            { address: market.arena, abi, account: ownerSigner.account, chain },
            { functionName: 'emergencySettle', args: [state.currentEpochId] }, // v3: ONE arg, no Side
            cfg,
            { market: market.id, action: 'RECOVER' },
            (h) => {
              rec.txHash = h;
            },
            sendOwner,
          );
          rec.txHash = recoverTx;
          if (recoverReceipt.status !== 'success') {
            rec.error = `owner recovery emergencySettle reverted for epoch ${state.currentEpochId}`;
          } else {
            rec.recoveredEpochId = state.currentEpochId;
          }
          logTick(rec);
          return rec;
        }
      }

      const action: ActionV3 = decideActionV3(state);
      rec.action = action;

      if (action === 'NONE') {
        // Idle read: attach the adaptive-wake hint (pre-sample start / settlement moment) so the
        // loop can sleep exactly up to the boundary instead of a full poll past it.
        rec.nextWakeMsHint = hintNextWakeMs(state, cfg.v3SampleSec, cfg.v3PreSampleEnabled === true);
        logTick(rec);
        if (lastExecuted !== undefined) {
          // The chain drained the pipeline to idle: return the last EXECUTED action (the loop's
          // success/metrics anchor), carrying the fresh wake hint from this final read.
          lastExecuted.nextWakeMsHint = rec.nextWakeMsHint;
          return lastExecuted;
        }
        return rec;
      }

      // Chain gates (the FIRST action of a tick is never gated): stop cleanly on the last
      // successful step when the re-read state did not advance (lagging view - never re-fire the
      // same crank on it) or when the step/wall-clock budget is spent; the next poll resumes.
      if (step > 0) {
        if (prevState !== undefined && !stateAdvancedV3(prevState, state)) return lastExecuted!;
        if (!chainMayContinue(step, Date.now() - tickStartMs, chainBudgetMs, chainMaxSteps)) return lastExecuted!;
      }

      const base = { address: market.arena, abi, account, chain } as const;
      let fields: { functionName: string; args?: readonly unknown[]; value?: bigint; gas?: bigint } | undefined;

      switch (action) {
        case 'CREATE':
          fields = { functionName: 'createEpoch' };
          break;

        case 'OPEN':
          fields = { functionName: 'openEntry' };
          break;

        case 'SETTLE': {
          // 0) PROJECTED-MINE FRESHNESS GATE. The contract's _requireFresh reverts StalePrice when
          // `block.timestamp > updatedAt + maxPriceAge`. The keeper posts a FRESH blob (updatedAt ~=
          // now), so the only way a settle is structurally doomed is when maxPriceAge is too TIGHT to
          // survive the simulate->mine gap - and because each retry re-fetches a fresh-at-sim blob, a
          // plain simulate is fooled identically every tick and the settle burns gas + the Pyth fee on
          // every mine. So we read the on-chain maxPriceAge and, if it can't cover the worst-case mine
          // latency, DEFER (don't sample, don't send - zero gas) and let the loop fire a distinct
          // "maxPriceAge too tight" alert instead of bleeding. A comfortable maxPriceAge never trips.
          const mineLatencySec = cfg.v3MineLatencySec ?? 15;
          let maxPriceAge: number | undefined;
          try {
            maxPriceAge = Number(
              (await client.readContract({ address: market.arena, abi, functionName: 'maxPriceAge' })) as number | bigint,
            );
          } catch {
            // Best-effort gate - a failed read must NOT defer a legit settle (the sim gate + spend cap
            // are the real backstops); proceed and let those catch any residual.
            maxPriceAge = undefined;
          }
          if (maxPriceAge !== undefined && Number.isFinite(maxPriceAge) && maxPriceAge < mineLatencySec) {
            rec.freshnessDeferred = true;
            rec.error = `settle deferred: maxPriceAge ${maxPriceAge}s < mine-latency budget ${mineLatencySec}s - a posted price can't survive to the mine block (widen maxPriceAge); not burning gas`;
            logTick(rec);
            return rec;
          }
          // 0b) ANCHOR-FRESHNESS GATE. The contract rejects a settle whose anchor blob is stamped
          //     BEFORE settlementTime (SettlePriceTooOld) - and the adaptive wake lands this tick
          //     essentially AT that moment, when Hermes's freshest aggregate can lag wall-clock by
          //     several seconds. A blind margin guesses that lag; instead, after the bounded floor
          //     wait, POLL Hermes until its blob is PROVABLY stamped >= settlementTime (checked via
          //     the ref's publishTime - the same value the on-chain oracle records). Bounded at
          //     ~12s: past that we proceed and let the sim gate + backoff handle it (a Hermes that
          //     stale is its own incident). The legacy late path (arriving 60s+ after T) passes
          //     both gates instantly.
          const anchorLagMs = anchorWaitMs(state.settlementTime, Date.now(), cfg.v3AnchorMarginSec ?? 2);
          if (anchorLagMs > 0) await new Promise((r) => setTimeout(r, anchorLagMs));
          const anchorPollDeadline = Date.now() + 12_000;
          for (;;) {
            try {
              const probe = market.quoteFeedId
                ? await fetchPythCrossRef(cfg.hermesUrl, market.feedId, market.quoteFeedId, cfg.hermesTimeoutMs)
                : await fetchPythRef(cfg.hermesUrl, market.feedId, cfg.hermesTimeoutMs);
              if (BigInt(probe.publishTimeSec) >= state.settlementTime) break; // anchor will qualify
            } catch {
              // transient Hermes hiccup - retry within the bound
            }
            if (Date.now() >= anchorPollDeadline) {
              logLine({ msg: 'keeper.v3.anchor.stale', market: market.id, epochId: state.currentEpochId, note: 'Hermes still serving a pre-settlement blob after the poll bound - proceeding (sim gate protects)' });
              break;
            }
            await new Promise((r) => setTimeout(r, 500));
          }
          // 1) the settlement average: prefer the PRE-SAMPLED [T - window, T] set (the contract's
          //    documented "last 60s of Pyth prices"), collected in the background while the epoch
          //    was still locked - so the submit fires within ~2s of the settlement moment. Falls
          //    back to the legacy post-settlement window when absent or sparse (keeper restarted
          //    mid-window, or presample disabled). The 6s wait bounds the tail sample; the
          //    sampler's own deadline IS the settlement moment, so it is already (or imminently)
          //    done whenever SETTLE runs. PEEK, not consume: an anchor-too-early retry reuses the
          //    same (still valid) [T-window, T] average; only a completed attempt or a rejected
          //    average discards it below.
          const pre = await peekPreSamples(market.id, state.currentEpochId, 6_000);
          const s = pre ?? (await sampleSettlementWindow(cfg, market));
          // 2) fetch a FRESH blob for the on-chain sanity anchor + its update fee
          const { priceData, fee } = await fetchUpdateAndFee(client, cfg, market.feedId, market.quoteFeedId);
          logLine({
            msg: 'keeper.v3.settle',
            market: market.id,
            epochId: state.currentEpochId,
            avgPrice18: s.avgPrice18,
            samples: s.count,
            sampleStart: s.sampleStart,
            sampleEnd: s.sampleEnd,
            samplesHash: s.samplesHash,
            presampled: pre !== undefined,
          });
          fields = {
            functionName: 'submitSettlementPrice',
            args: [state.currentEpochId, s.avgPrice18, s.sampleStart, s.sampleEnd, s.samplesHash, priceData],
            value: fee,
          };
          break;
        }

        case 'PROCESS': {
          // Size the batch to fit under the RPC's per-tx gas cap: a single high-volume LP position
          // can cost ~16.6M gas, so processing the whole backlog at once would exceed the 2^24 cap
          // and wedge the keeper. fitBatchUnderCap shrinks until it fits + returns an explicit limit.
          const remaining = state.stakedCount - state.processedCursor;
          const fit = await fitPositionCrank(client, base, 'processPositions', state.currentEpochId, remaining, cfg, {
            market: market.id,
            action,
          });
          fields = { functionName: 'processPositions', args: [state.currentEpochId, BigInt(fit.count)], gas: fit.gas };
          rec.swept = `${state.processedCursor}->~${state.processedCursor + fit.count}/${state.stakedCount}`;
          break;
        }

        case 'FINALIZE':
          fields = { functionName: 'finalizeEpoch', args: [state.currentEpochId] };
          break;

        case 'UNSTAKE': {
          const target = state.lastSettledEpochId!; // UNSTAKE only fires when backlog exists
          const remaining = (state.unstakeTotal ?? 0) - (state.unstakeDone ?? 0);
          const fit = await fitPositionCrank(client, base, 'unstakeBatch', target, remaining, cfg, {
            market: market.id,
            action,
          });
          fields = { functionName: 'unstakeBatch', args: [target, BigInt(fit.count)], gas: fit.gas };
          rec.unstaked = `${state.unstakeDone}->~${(state.unstakeDone ?? 0) + fit.count}/${state.unstakeTotal} (epoch ${target})`;
          break;
        }
      }

      if (fields) {
        const { txHash, receipt, gasSpentWei } = await sendWriteWithEscalation(
          client,
          wallet,
          base,
          fields,
          cfg,
          { market: market.id, action },
          (h) => {
            rec.txHash = h;
          },
          send,
        );
        rec.txHash = txHash;
        rec.gasSpentWei = gasSpentWei;
        if (receipt.status !== 'success') {
          rec.error = `tx reverted: ${action}`;
        }
        // A COMPLETED settle attempt (mined success or revert) retires its pre-sample: a success
        // is done with it; a mined revert's cause is unknown, so the retry re-samples fresh.
        if (action === 'SETTLE') discardPreSamples(market.id);
      }

      logTick(rec);
      if (rec.error !== undefined) return rec; // a failed step surfaces exactly like a lone failed tick
      if (step > 0) rec.chainedActions = step;
      lastExecuted = rec;
      prevState = state;
      if (chainBudgetMs <= 0) return rec; // legacy: exactly one action per tick
      // else: chain - re-read the (now advanced) state and execute the next pipeline step.
    } catch (err) {
      if (err instanceof SpendCapTrippedError) {
        // Persisted spend cap OPEN - the loop reads spendCapTripped and STOPS all cranking (sticky).
        rec.error = err.message;
        rec.spendCapTripped = err.reason ?? 'cap';
      } else if (err instanceof WouldRevertError) {
        // Pre-flight simulation caught a doomed crank - NO tx sent, ZERO gas (the drain we eliminate).
        rec.error = `would revert: ${err.info.name} (${rec.action}) - skipped before broadcast`;
        rec.revertReason = err.info.name;
        rec.simSkipped = true;
        // A REJECTED average (outside the sanity anchor after a violent last-minute move) must be
        // discarded so the retry re-samples; an anchor-too-early skip (SettlePriceTooOld) KEEPS the
        // still-valid [T-window, T] pre-sample for the imminent retry.
        if (rec.action === 'SETTLE' && err.info.name !== 'SettlePriceTooOld') discardPreSamples(market.id);
      } else {
        rec.error = err instanceof Error ? err.message : String(err);
      }
      logTick(rec);
      return rec;
    }
  }
}
