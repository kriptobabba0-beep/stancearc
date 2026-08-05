// index.ts - keeper entry point. Loads + validates config, builds a viem public +
// wallet client (account from KEEPER_PRIVATE_KEY, chain derived from the RPC's
// chainId so it works on Arc testnet AND mainnet with no hardcoded id), then runs a
// poll loop: every POLL_INTERVAL_MS, for EACH market SEQUENTIALLY (one keeper key ->
// no nonce races) call runMarketOnce. Structured JSON logs; graceful SIGINT/SIGTERM.
//
// Phase 4 reliability: the viem transport is a fallback([http...]) over KEEPER_RPC_URLS
// so one RPC outage doesn't stall the keeper; per-market runtime tracks lastAction /
// wedged; a per-pass keeper.heartbeat log + an optional /health + /metrics HTTP server
// (KEEPER_HTTP_PORT) let an uptime monitor detect a dead/stalled keeper.
import { createPublicClient, createWalletClient, defineChain, fallback, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type KeeperConfig } from './config.js';
import { runMarketOnce, type SendControls, type TickLog } from './keeper.js';
import { runMarketOnceV3 } from './keeperV3.js';
import { createSpendGuard } from './spendGuard.js';
import {
  freshReserveHistory,
  recordReserve,
  evaluateReserve,
  type ReserveHistory,
} from './reserveGovernor.js';
import {
  freshRuntime,
  recordFailure,
  recordSuccess,
  shouldSkip,
  type MarketRuntime,
} from './backoff.js';
import {
  startHealthServer,
  type HealthState,
  type MetricsSnapshot,
} from './health.js';
import {
  loadMetricsState,
  saveMetricsState,
  type PersistedMetrics,
} from './metricsState.js';
import { createAlerter } from './alert.js';

/** Build the viem clients + account for a config. Pure construction - no I/O at call. */
export function buildClients(cfg: KeeperConfig, chainId: number) {
  const account = privateKeyToAccount(cfg.privateKey);
  const chain: Chain = defineChain({
    id: chainId,
    name: `arc-${chainId}`,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
  // Multi-RPC fallback: viem rotates to the next URL when one errors/times out, so a
  // single RPC outage degrades latency instead of stalling the whole keeper. A lone
  // KEEPER_RPC_URL yields a 1-element list -> behaves exactly like the old http(url).
  const transport = fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  // OPTIONAL owner signer for wedge auto-recovery (KEEPER_OWNER_PRIVATE_KEY). Built as a
  // SEPARATE account + wallet client so the owner key is used SOLELY for emergencySettle
  // recovery - every normal lifecycle crank still signs with the restricted keeper key.
  // undefined when no owner key is configured (recovery OFF - behavior unchanged).
  const owner = cfg.ownerPrivateKey
    ? (() => {
        const ownerAccount = privateKeyToAccount(cfg.ownerPrivateKey!);
        const ownerWallet = createWalletClient({ account: ownerAccount, chain, transport });
        return { account: ownerAccount, wallet: ownerWallet };
      })()
    : undefined;

  return { account, chain, publicClient, walletClient, owner };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Race a promise against a hard deadline. If `p` doesn't settle within `ms`, REJECT with a timeout
 * error so the caller can treat it as a failed tick and move on - the orphaned `p` is abandoned (it
 * may still settle later into the void). This is the only defense against an await that neither
 * resolves nor rejects (a black-holed socket, a proxy that accepts but never answers): viem's
 * transport timeout doesn't cover every such case, so we bound it here at the call site.
 */
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

  // Real alerting (dead-man's-switch). OFF unless ALERT_WEBHOOK_URL / ALERT_HEARTBEAT_URL is
  // set -> then behavior is the unchanged log-only path. Every notify/heartbeat is
  // non-blocking + crash-safe (an alerting failure can never throw out of the crank loop), and
  // deduped so a persistent WEDGE / low balance doesn't spam the webhook each tick.
  const alerter = createAlerter(cfg.alert, { log });

  // Detect the chain id by probing the RPCs in order so we never hardcode testnet vs
  // mainnet - and so a dead first RPC at boot doesn't block startup.
  let chainId: number | undefined;
  let probeErr: unknown;
  for (const url of cfg.rpcUrls) {
    try {
      const probe = createPublicClient({ transport: http(url, { timeout: 10_000 }) });
      chainId = await probe.getChainId();
      break;
    } catch (err) {
      probeErr = err;
      log({ msg: 'keeper.probe.error', rpc: url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (chainId === undefined) {
    throw new Error(`could not reach any RPC to probe chainId: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`);
  }

  const { account, chain, publicClient, walletClient, owner } = buildClients(cfg, chainId);

  // v2 markets settle on a TIGHT pinned publishTime window (~12s). If any market is v2 the loop
  // must poll faster than the window or a single 15s poll could step clean over it and wedge the
  // epoch. Cap the effective poll at v2PollIntervalMs whenever ≥1 v2 market is configured;
  // all-v1 keeps the exact original pollIntervalMs cadence.
  const hasV2Market = cfg.markets.some((m) => m.version === 'v2');
  const effectivePollMs = hasV2Market ? Math.min(cfg.pollIntervalMs, cfg.v2PollIntervalMs) : cfg.pollIntervalMs;

  // TASK 4a - restart-safe counters. SEED the cumulative counters from the persisted state
  // file (if KEEPER_METRICS_STATE_FILE is set) so a restart/crash-loop doesn't zero the
  // Prometheus series and break rate()/increase() alerts. recordRestart has already bumped
  // restartsTotal for THIS boot inside loadMetricsState. processStartTimeSec is the standard
  // uptime gauge (it RESETS on each restart, which is the documented bounce signal). When no
  // path is set, `seed` is a fresh set with restartsTotal=1 - counters are in-memory only.
  const processStartTimeSec = Math.floor(Date.now() / 1000);
  const { metrics: seed, loaded: metricsLoaded } = cfg.metricsStateFile
    ? loadMetricsState(cfg.metricsStateFile, log)
    : { metrics: { ticksTotal: 0, actionsTotal: {}, failuresTotal: {}, revertsTotal: 0, restartsTotal: 1 } as PersistedMetrics, loaded: false };

  log({
    msg: 'keeper.start',
    signer: account.address,
    chainId,
    // OPTIONAL owner-key wedge auto-recovery: report whether it's armed and, if so, the
    // owner signer address. TESTNET convenience - on mainnet keep the owner key cold.
    recovery: owner ? { enabled: true, ownerSigner: owner.account.address } : { enabled: false },
    rpc: cfg.rpcUrl,
    rpcUrls: cfg.rpcUrls,
    // Report each market's id + version + whether a v2 subsidy is armed (amount NOT logged here
    // to keep the line compact; it's in the per-tick keeper.subsidy.funded line).
    markets: cfg.markets.map((m) => ({ id: m.id, version: m.version, subsidy: m.subsidyPerEpoch !== undefined })),
    pollIntervalMs: cfg.pollIntervalMs,
    // The EFFECTIVE poll cadence: capped to v2PollIntervalMs when ≥1 market is v2 (tight pin window).
    effectivePollMs,
    hasV2Market,
    v2WindowMarginSec: Number(cfg.v2WindowMarginSec),
    sweepBatch: cfg.sweepBatch,
    gasFloorGwei: Number(cfg.gasFloorWei / 1_000_000_000n),
    hermesTimeoutMs: cfg.hermesTimeoutMs,
    baseBackoffMs: cfg.baseBackoffMs,
    maxBackoffMs: cfg.maxBackoffMs,
    wedgedAlertThreshold: cfg.wedgedAlertThreshold,
    lowBalanceWei: cfg.lowBalanceWei.toString(),
    httpPort: cfg.httpPort,
    httpHost: cfg.httpHost,
    stallFactor: cfg.stallFactor,
    // Report whether external alerting is wired (URLs themselves are NOT logged - they may
    // embed a Slack/Telegram token). Off => unchanged log-only behavior.
    alerting: {
      enabled: alerter.enabled,
      webhook: cfg.alert.webhookUrl !== undefined,
      heartbeat: cfg.alert.heartbeatUrl !== undefined,
      dedupeWindowMs: cfg.alert.dedupeWindowMs,
      heartbeatIntervalMs: cfg.alert.heartbeatIntervalMs,
    },
    // TASK 4a - restart-safe metrics. Report whether the counters are file-backed, whether
    // prior state was loaded this boot, this boot's restart count, and the uptime gauge.
    metrics: {
      stateFile: cfg.metricsStateFile !== undefined,
      loadedPriorState: metricsLoaded,
      persistIntervalMs: cfg.metricsPersistIntervalMs,
      restartsTotal: seed.restartsTotal,
      processStartTimeSec,
    },
  });

  // Per-market circuit-breaker state lives in the LOOP, NOT in runMarketOnce (which
  // stays stateless per tick). Pure helpers in backoff.ts compute the windows; the
  // loop additionally tracks lastAction / lastActionTs / wedged for observability.
  const runtime = new Map<string, MarketRuntime>();
  const rt = (id: string): MarketRuntime => {
    let s = runtime.get(id);
    if (!s) {
      s = freshRuntime();
      runtime.set(id, s);
    }
    return s;
  };

  // Loop heartbeat: updated at the end of each full poll pass. null until the first
  // pass completes; the health endpoint reports DEGRADED while it's stale.
  let lastTickTs: number | null = null;

  // --- DRAIN-ELIMINATION wiring ---
  // Persisted spend circuit-breaker. Loaded from disk so a prior sticky trip is honored on boot
  // (a crash-loop cannot reset it). Disabled (no-op) unless a cap is configured.
  const spendGuard = createSpendGuard({
    enabled: cfg.spendCap?.enabled ?? false,
    path: cfg.spendCap?.ledgerFile,
    caps: cfg.spendCap?.caps ?? { hourCapWei: 0n, hourWindowMs: 3_600_000, burstCapWei: 0n, burstWindowMs: 600_000 },
    retainMs: cfg.spendCap?.retainMs ?? 3_600_000,
    log,
  });
  // The send controls every keeper-key crank runs under: pre-flight simulate + the spend cap.
  const send: SendControls = {
    simulate: cfg.simPreflight ?? true,
    guard: spendGuard.enabled ? spendGuard : undefined,
    fallbackGasLimit: cfg.fallbackGasLimit ?? 1_500_000n,
  };
  // Owner-reserve drawdown governor state (only meaningful when an owner key is configured).
  let reserveHistory: ReserveHistory = freshReserveHistory();
  const reserveCfg = cfg.reserve;
  // Once the spend cap trips (or boots tripped) the keeper STOPS cranking entirely until an
  // operator clears the ledger. Sticky in-process; the on-disk ledger keeps it sticky across boots.
  let keeperStopped = false;
  let stoppedReason: string | null = null;
  // Per-market StalePrice / freshness-defer streak - a DISTINCT diagnosis from a generic wedge
  // (it means the price window is too tight vs mine latency, not an RPC/contract fault). A
  // persistent streak still rides the normal failure/backoff path, so a silent stall can't hide.
  const staleStreak = new Map<string, number>();

  // refill-safe sentinel: a tiny file the gas-watchdog reads to decide whether it's safe to refill
  // the keeper signer from the owner reserve. We REwrite it every pass with a fresh timestamp; the
  // watchdog refills ONLY when the sentinel is fresh AND refillSafe - so a crash-looping keeper
  // (stale sentinel) or a spend-cap-tripped keeper (refillSafe:false) stops the refill pump cold.
  const refillSafeFile = cfg.refillSafeFile;
  const writeRefillSafe = (refillSafe: boolean, reason: string | null, nowMs: number): void => {
    if (!refillSafeFile) return;
    try {
      mkdirSync(dirname(refillSafeFile), { recursive: true });
      writeFileSync(refillSafeFile, JSON.stringify({ ts: nowMs, refillSafe, reason }), 'utf8');
    } catch (err) {
      log({ msg: 'keeper.refillsafe.write.error', error: err instanceof Error ? err.message : String(err) });
    }
  };

  // If the persisted ledger booted already tripped, start STOPPED (don't crank a known-bad signer).
  {
    const boot = spendGuard.status(Date.now());
    if (boot.tripped) {
      keeperStopped = true;
      stoppedReason = boot.reason;
      log({ msg: 'ALERT keeper STOPPED on boot - spend cap latched on disk', reason: boot.reason });
      void alerter.notify({
        key: 'spendcap',
        severity: 'critical',
        title: 'SPEND CAP TRIPPED',
        message: `keeper booted with the spend cap LATCHED (${boot.reason}) - cranking halted until the ledger file is cleared by an operator`,
        context: { reason: boot.reason },
      });
    }
  }

  // In-memory metrics (incremented in the loop; rendered by /metrics on demand). The
  // cumulative counters are SEEDED from `seed` (loaded above) so they continue across
  // restarts; gauges (balanceWei/lastTickTs/marketWedged) always reflect the live tick,
  // never the file.
  const metrics: MetricsSnapshot = {
    ticksTotal: seed.ticksTotal,
    actionsTotal: { ...seed.actionsTotal },
    failuresTotal: { ...seed.failuresTotal },
    revertsTotal: seed.revertsTotal,
    balanceWei: 0n,
    lastTickTs: 0,
    marketWedged: {},
    restartsTotal: seed.restartsTotal,
    processStartTimeSec,
  };

  // Snapshot the CUMULATIVE-counter slice of the live metrics for persistence (gauges are
  // intentionally excluded - they're re-derived each tick and must not be carried forward).
  const persistedSnapshot = (): PersistedMetrics => ({
    ticksTotal: metrics.ticksTotal,
    actionsTotal: metrics.actionsTotal,
    failuresTotal: metrics.failuresTotal,
    revertsTotal: metrics.revertsTotal,
    restartsTotal: metrics.restartsTotal,
  });
  // Best-effort flush of the counters to disk (no-op when persistence is OFF). Never throws.
  const persistMetrics = (): void => {
    if (cfg.metricsStateFile) saveMetricsState(cfg.metricsStateFile, persistedSnapshot(), log);
  };
  // Persist immediately so the bumped restartsTotal is durable even if the keeper dies before
  // the first interval flush, then track the last flush time to throttle in-loop writes.
  persistMetrics();
  let lastPersistTs = Date.now();

  // Live snapshots for the HTTP server (always reflect current loop state).
  const getHealthState = (): HealthState => ({
    lastTickTs,
    markets: cfg.markets.map((m) => ({ id: m.id, runtime: rt(m.id) })),
  });
  const getMetrics = (): MetricsSnapshot => metrics;

  // Optional /health + /metrics server - OFF unless KEEPER_HTTP_PORT > 0.
  const healthServer =
    cfg.httpPort > 0
      ? startHealthServer({
          host: cfg.httpHost,
          port: cfg.httpPort,
          // Stall detection keys off the EFFECTIVE cadence so a v2 keeper (fast poll) isn't
          // wrongly flagged DEGRADED for completing passes faster than the configured 15s.
          pollIntervalMs: effectivePollMs,
          stallFactor: cfg.stallFactor,
          getHealthState,
          getMetrics,
          log,
        })
      : undefined;

  let running = true;
  let stallWatch: ReturnType<typeof setInterval> | undefined;
  const stop = (sig: string) => {
    log({ msg: 'keeper.shutdown', signal: sig });
    running = false;
    if (stallWatch) clearInterval(stallWatch);
    healthServer?.close();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // HARD LIVENESS BACKSTOP (dead-man's-switch of last resort). lastTickTs advances at the end of
  // every full pass; if it goes stale beyond stallExitMs - a freeze even the per-tick deadline can't
  // unblock (e.g. a hung getBalance at the top of the loop, or an event-loop wedge) - exit so the
  // container supervisor (restart: unless-stopped) restarts a truly frozen process. Seeded from loop
  // start so it has a baseline before the first tick completes. unref so it never holds the process up.
  const loopStartTs = Date.now();
  stallWatch = setInterval(() => {
    const since = Date.now() - (lastTickTs ?? loopStartTs);
    if (since > cfg.stallExitMs) {
      log({ msg: 'FATAL keeper loop stalled - exiting for supervisor restart', sinceMs: since, stallExitMs: cfg.stallExitMs });
      try { healthServer?.close(); } catch { /* best effort */ }
      process.exit(1);
    }
  }, Math.min(30_000, Math.max(5_000, Math.floor(cfg.stallExitMs / 4))));
  stallWatch.unref?.();

  while (running) {
    // SPEND CAP gate: if the persisted breaker is OPEN, do NO cranking this pass - just keep the
    // heartbeat alive, page (deduped), and tell the gas-watchdog it is NOT safe to refill so a
    // tripped keeper can never be fed back into a drain. Sticky until an operator clears the ledger.
    if (keeperStopped || (spendGuard.enabled && spendGuard.status(Date.now()).tripped)) {
      const nowMs = Date.now();
      if (!keeperStopped) {
        keeperStopped = true;
        stoppedReason = spendGuard.status(nowMs).reason;
      }
      writeRefillSafe(false, stoppedReason ?? 'spend-cap', nowMs);
      lastTickTs = nowMs;
      log({ msg: 'keeper.halted', reason: stoppedReason });
      void alerter.notify({
        key: 'spendcap',
        severity: 'critical',
        title: 'SPEND CAP TRIPPED',
        message: `keeper halted (${stoppedReason}) - the spend circuit-breaker is latched; clear the spend ledger file to resume`,
        context: { reason: stoppedReason },
      });
      void alerter.heartbeat();
      await sleep(effectivePollMs);
      continue;
    }

    // Whether the reserve governor wants the loop to slow down (throttle) or pause cranking
    // entirely (stop) this pass - both set in the reserve block below.
    let reserveThrottle = false;
    let reserveStop = false;

    // Once per tick: surface the signer's native balance + warn loudly when low so the
    // operator can refill before the keeper runs dry on gas + Pyth fees.
    try {
      const balance = await publicClient.getBalance({ address: account.address });
      metrics.balanceWei = balance;
      const low = balance < cfg.lowBalanceWei;
      log({ msg: low ? 'WARN low keeper balance' : 'keeper.balance', signer: account.address, balanceWei: balance.toString(), floorWei: cfg.lowBalanceWei.toString() });
      // Dispatch a (deduped) low-balance alert so an operator refills before the keeper runs
      // dry on gas + Pyth fees. Fire-and-forget: notify is non-blocking + crash-safe, so a
      // slow/failing webhook never stalls or crashes the balance check.
      if (low) {
        void alerter.notify({
          key: `lowbal:${account.address}`,
          severity: 'warn',
          title: 'LOW BALANCE',
          message: `keeper signer ${account.address} balance ${balance} wei below floor ${cfg.lowBalanceWei} wei`,
          context: { signer: account.address, balanceWei: balance.toString(), floorWei: cfg.lowBalanceWei.toString() },
        });
      }
    } catch (err) {
      log({ msg: 'keeper.balance.error', error: err instanceof Error ? err.message : String(err) });
    }

    // OWNER-RESERVE DRAWDOWN GOVERNOR. The gas-watchdog refills the signer from the owner reserve,
    // so a sustained LEGITIMATE burn that outpaces faucet top-ups bleeds the reserve to empty and
    // wedges everything - the spend cap (tuned above legit burn) can't see that. So we measure the
    // reserve's drawdown RATE and page HOURS before depletion, and throttle/stop near the floor.
    if (reserveCfg?.enabled && owner) {
      try {
        const nowMs = Date.now();
        const reserveWei = await publicClient.getBalance({ address: owner.account.address });
        reserveHistory = recordReserve(reserveHistory, nowMs, reserveWei, reserveCfg.retainMs);
        const d = evaluateReserve(reserveHistory, nowMs, {
          currentWei: reserveWei,
          floorWei: reserveCfg.floorWei,
          throttleWei: reserveCfg.throttleWei,
          warnDrawdownWeiPerHour: reserveCfg.warnDrawdownWeiPerHour,
          projectDryWarnMs: reserveCfg.projectDryWarnMs,
        });
        reserveThrottle = d.throttle;
        reserveStop = d.stop;
        log({
          msg: 'keeper.reserve',
          owner: owner.account.address,
          reserveWei: reserveWei.toString(),
          drawdownWeiPerHour: d.drawdownWeiPerHour?.toString() ?? null,
          projectedDryMs: d.projectedDryMs,
          alert: d.alert,
          throttle: d.throttle,
        });
        if (d.alert !== 'none') {
          const projHrs = d.projectedDryMs !== null ? (d.projectedDryMs / 3_600_000).toFixed(1) : '?';
          const msg =
            d.alert === 'floor'
              ? `owner reserve ${owner.account.address} at/below the floor - the gas-watchdog can no longer refill the keeper; FUND the reserve from the faucet NOW`
              : d.alert === 'projection'
                ? `owner reserve draining - projected to hit the floor in ~${projHrs}h at the current rate; top up from the faucet`
                : `owner reserve draining fast (${d.drawdownWeiPerHour} wei/hour); top up from the faucet before it depletes`;
          void alerter.notify({
            key: `reserve:${d.alert}`,
            severity: d.alert === 'floor' ? 'critical' : 'warn',
            title: 'RESERVE DRAWDOWN',
            message: msg,
            context: { reserveWei: reserveWei.toString(), alert: d.alert, drawdownWeiPerHour: d.drawdownWeiPerHour?.toString() ?? null, projectedDryMs: d.projectedDryMs },
          });
        }
      } catch (err) {
        log({ msg: 'keeper.reserve.error', error: err instanceof Error ? err.message : String(err) });
      }
    }

    // RESERVE STOP: the owner reserve is at/below its floor, so the gas-watchdog can no longer
    // refill the keeper signer - every further crank just races the signer to a messy
    // insufficient-funds wedge. Pause cranking THIS pass (keep the heartbeat + page loudly) and
    // re-check next pass: the moment an operator funds the reserve, d.stop clears and cranking
    // resumes automatically. This is a SOFT, self-recovering halt - distinct from the sticky
    // spend-cap trip (which stays latched until the ledger is cleared).
    if (reserveStop) {
      log({ msg: 'ALERT keeper PAUSED - owner reserve at floor, gas refill impossible; FUND the reserve to resume', reserveStop: true });
      void alerter.notify({
        key: 'reserve:stop',
        severity: 'critical',
        title: 'RESERVE AT FLOOR - keeper paused',
        message: 'owner reserve at/below the floor: the gas-watchdog cannot refill the keeper signer, so cranking is paused to avoid an insufficient-funds wedge. Fund the reserve from the faucet to auto-resume.',
      });
    }

    // Adaptive-wake plumbing: the smallest boundary hint any v3 market reports this pass (ms until
    // its pre-sample start / settlement moment). Shortens the end-of-pass sleep below.
    let minWakeHintMs: number | undefined;

    for (const market of cfg.markets) {
      if (!running || reserveStop) break;
      const state = rt(market.id);
      const now = Date.now();

      // Circuit-breaker: while a market is inside its backoff window, skip it entirely.
      if (shouldSkip(state, now)) {
        log({ msg: 'keeper.backoff', market: market.id, consecutiveFailures: state.consecutiveFailures, backoffUntilMs: state.backoffUntilMs, waitMs: state.backoffUntilMs - now });
        continue;
      }

      // Sequential per market: one key -> one in-flight tx at a time -> nonce-safe.
      // v3 (entry-anchored) markets run their own crank (no startEpoch; settle-average +
      // process/finalize path); v1/v2 keep the EXACT existing runMarketOnce. The TickLog
      // contract is identical, so all the breaker/metrics/alerting below is shared.
      // Each market's crank is raced against a hard per-tick deadline: a black-holed RPC/Hermes
      // await can never freeze the whole sequential loop. runMarketOnce* never throws on its own
      // (it captures errors into rec), so the ONLY way this rejects is the deadline - which we turn
      // into a synthetic failure tick so the breaker backs off and the loop proceeds to the next market.
      let rec: TickLog;
      try {
        rec = await withDeadline(
          market.version === 'v3'
            ? runMarketOnceV3(publicClient, walletClient, account, chain, market, cfg, send, owner)
            : runMarketOnce(publicClient, walletClient, account, chain, market, cfg, state.lastSweptEpochId, owner, send),
          cfg.tickDeadlineMs,
          `tick ${market.id}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log({ msg: 'keeper.tick.timeout', market: market.id, deadlineMs: cfg.tickDeadlineMs, error: msg });
        rec = { ts: new Date().toISOString(), market: market.id, epochId: '?', phase: '?', action: 'NONE', error: `tick deadline exceeded: ${msg}` };
      }

      // SPEND CAP tripped mid-pass (a broadcast pushed cumulative spend over the cap, or a prior
      // trip is latched): stop the keeper. The top-of-loop guard halts every subsequent pass.
      if (rec.spendCapTripped) {
        keeperStopped = true;
        stoppedReason = rec.spendCapTripped;
        metrics.marketWedged[market.id] = 1;
        log({ msg: 'ALERT keeper STOPPING - spend cap tripped', market: market.id, reason: rec.spendCapTripped });
      }

      // Metrics: count the action + any revert this tick produced.
      metrics.actionsTotal[rec.action] = (metrics.actionsTotal[rec.action] ?? 0) + 1;
      if (rec.error !== undefined && rec.txHash !== undefined) {
        metrics.revertsTotal += 1; // a tx was sent but mined-reverted
      }

      // Adaptive wake: remember the smallest settlement-boundary hint reported this pass.
      if (rec.nextWakeMsHint !== undefined) {
        minWakeHintMs = minWakeHintMs === undefined ? rec.nextWakeMsHint : Math.min(minWakeHintMs, rec.nextWakeMsHint);
      }

      // OPTIONAL owner-key wedge recovery fired and cleared the wedge this tick: surface it
      // loudly (epochId + tx hash) so the operator sees the self-heal. rec.error is undefined
      // here, so the success branch below resets the breaker and normal cranking resumes.
      if (rec.recoveredEpochId !== undefined) {
        log({ msg: `RECOVERED market=${market.id} wedged epoch auto-settled via owner key`, market: market.id, epochId: rec.recoveredEpochId.toString(), txHash: rec.txHash });
      }

      // A tick is a FAILURE iff runMarketOnce set rec.error (RPC error, STUCK/wedged, or
      // a mined-but-reverted crank). On failure: bump the breaker + arm backoff; once the
      // failure streak crosses the threshold, emit one loud WEDGED alert. On success: reset.
      // v2 liveness observability - a MISSED pinned window is a DISTINCT failure mode from a
      // generic wedge: it specifically means the keeper couldn't land the start/end blob inside
      // the contract's tight [endpoint, endpoint+settleWindow] window before its safe tail. Track
      // the consecutive-MISSED streak so a chronically-too-tight 12s settle window (vs measured
      // mine latency) is diagnosed BEFORE it silently relies on the owner's emergencySettle. Reset
      // on any non-MISSED tick. Computed here (independent of the success/failure branches below)
      // so it's carried onto whichever runtime the branch writes.
      const consecutiveMissedWindows =
        rec.windowState === 'MISSED' ? (state.consecutiveMissedWindows ?? 0) + 1 : 0;

      // DISTINCT StalePrice / freshness streak: a settle that's sim-skipped StalePrice or deferred by
      // the freshness gate means the price window is too tight vs mine latency - a config diagnosis,
      // NOT an RPC/contract wedge. Crucially, ZERO gas is burned (the crank never broadcasts), so this
      // alert tells the operator to widen maxPriceAge rather than hunt a phantom drain. Reset on any
      // non-stale tick. Still rides the normal failure/backoff path so it can't spin silently.
      const staleish = rec.revertReason === 'StalePrice' || rec.freshnessDeferred === true;
      const consecutiveStale = staleish ? (staleStreak.get(market.id) ?? 0) + 1 : 0;
      staleStreak.set(market.id, consecutiveStale);

      const observedTs = Date.now();
      if (rec.error !== undefined) {
        metrics.failuresTotal[market.id] = (metrics.failuresTotal[market.id] ?? 0) + 1;
        const next = recordFailure(state, observedTs, cfg.baseBackoffMs, cfg.maxBackoffMs);
        const wedged = next.consecutiveFailures >= cfg.wedgedAlertThreshold;
        // Loop assigns the observability fields onto the (otherwise pure) breaker state.
        runtime.set(market.id, { ...next, lastAction: rec.action, lastActionTs: observedTs, wedged, consecutiveMissedWindows });
        metrics.marketWedged[market.id] = wedged ? 1 : 0;

        // DISTINCT repeated-MISSED-window alert (v2). A MISSED window already counts toward the
        // generic WEDGED path (rec.error is set), but a SPECIFIC alert lets the operator tell a
        // too-tight settle window apart from an RPC/Hermes/revert wedge and widen
        // KEEPER_V2_WINDOW_MARGIN_SEC (or the on-chain settleWindow) accordingly. Threshold reuses
        // wedgedAlertThreshold; deduped per market so a persistent miss doesn't spam the webhook.
        if (consecutiveMissedWindows >= cfg.wedgedAlertThreshold) {
          log({ msg: `ALERT market=${market.id} PINNED WINDOW repeatedly MISSED - settle window too tight`, market: market.id, consecutiveMissedWindows, lastError: rec.error });
          void alerter.notify({
            key: `missedwindow:${market.id}`,
            severity: 'critical',
            title: 'PINNED WINDOW MISSED',
            message: `market=${market.id} missed its pinned start/end window ${consecutiveMissedWindows} ticks in a row - settle window likely too tight vs mine latency; widen KEEPER_V2_WINDOW_MARGIN_SEC / settleWindow before it relies on owner emergencySettle`,
            context: { market: market.id, consecutiveMissedWindows, lastError: rec.error },
          });
        }

        if (consecutiveStale >= cfg.wedgedAlertThreshold) {
          log({ msg: `ALERT market=${market.id} PRICE WINDOW TOO TIGHT - settle keeps going stale before it can mine`, market: market.id, consecutiveStale, lastError: rec.error });
          void alerter.notify({
            key: `stale:${market.id}`,
            severity: 'critical',
            title: 'PRICE WINDOW TOO TIGHT',
            message: `market=${market.id} settle was StalePrice/freshness-deferred ${consecutiveStale} ticks in a row - the on-chain maxPriceAge is too tight vs mine latency. Widen maxPriceAge (or lower KEEPER_MINE_LATENCY_SEC). NO gas is being burned (the crank is sim-blocked), so this is a config fix, not a drain.`,
            context: { market: market.id, consecutiveStale, lastError: rec.error },
          });
        }

        if (wedged) {
          log({ msg: `ALERT market=${market.id} WEDGED - operator action needed`, market: market.id, consecutiveFailures: next.consecutiveFailures, lastError: rec.error });
          // Page a human: market wedged after >= WEDGED_ALERT_THRESHOLD consecutive failures
          // (this IS the repeated-failures trigger). Deduped per market so a stuck market
          // re-alerts at most once per ALERT_DEDUPE_WINDOW_MS instead of every tick.
          void alerter.notify({
            key: `wedged:${market.id}`,
            severity: 'critical',
            title: 'WEDGED',
            message: `market=${market.id} wedged after ${next.consecutiveFailures} consecutive failures - operator action needed`,
            context: { market: market.id, consecutiveFailures: next.consecutiveFailures, lastError: rec.error },
          });
        }
      } else {
        // Success: reset the circuit-breaker fields, and if the tick was a successful
        // SWEEP update lastSweptEpochId so we don't send a second sweep for the same epoch.
        const afterSuccess = recordSuccess(state);
        runtime.set(market.id, {
          ...afterSuccess,
          lastSweptEpochId: rec.sweptEpochId !== undefined ? rec.sweptEpochId : afterSuccess.lastSweptEpochId,
          lastAction: rec.action,
          lastActionTs: observedTs,
          wedged: false,
          // A non-MISSED tick (incl. a WAIT no-op success) clears the pinned-window miss streak.
          consecutiveMissedWindows,
        });
        metrics.marketWedged[market.id] = 0;
      }
    }
    if (!running) break;

    // End of a full poll pass: bump the heartbeat + emit a periodic line so a log-absence
    // alert can fire if the loop ever silently stops ticking.
    lastTickTs = Date.now();
    metrics.ticksTotal += 1;
    metrics.lastTickTs = lastTickTs;
    // Tell the gas-watchdog it's safe to refill the signer - a FRESH timestamp + refillSafe:true.
    // (If a crank tripped the cap mid-pass, keeperStopped is now true and we publish refillSafe:false
    // so the watchdog fails closed.) A crash-looping keeper never reaches here, so the sentinel goes
    // stale and the watchdog fails closed on staleness too.
    writeRefillSafe(!keeperStopped, keeperStopped ? stoppedReason : null, lastTickTs);
    log({
      msg: 'keeper.heartbeat',
      lastTickTs,
      ticks: metrics.ticksTotal,
      markets: cfg.markets.map((m) => {
        const s = rt(m.id);
        return { id: m.id, lastAction: s.lastAction ?? null, consecutiveFailures: s.consecutiveFailures, wedged: s.wedged ?? false };
      }),
    });

    // Dead-man's-switch ping: tell the EXTERNAL monitor the loop is alive (rate-limited to
    // ALERT_HEARTBEAT_INTERVAL_MS). If the keeper dies/hangs, the ping stops and the monitor
    // alerts on its ABSENCE - catching failures the in-process WEDGED alert never could.
    // Fire-and-forget + crash-safe like every other alert call.
    void alerter.heartbeat();

    // TASK 4a - flush the cumulative counters to the state file at most once per
    // KEEPER_METRICS_PERSIST_INTERVAL_MS so a crash loses at most one interval. No-op (and no
    // disk I/O) when persistence is OFF; saveMetricsState is best-effort and never throws.
    if (cfg.metricsStateFile && lastTickTs - lastPersistTs >= cfg.metricsPersistIntervalMs) {
      persistMetrics();
      lastPersistTs = lastTickTs;
    }

    // Reserve throttle: when the owner reserve is near its floor, slow the cadence so the steady-
    // state burn drops below the faucet top-up rate (fewer settles/Pyth updates per hour) - buying
    // the operator time to fund the reserve instead of racing it to empty.
    if (reserveThrottle) {
      log({ msg: 'keeper.reserve.throttle', factor: 3, effectivePollMs, throttledPollMs: effectivePollMs * 3 });
      await sleep(effectivePollMs * 3);
    } else {
      // Adaptive wake: when a v3 settlement boundary (pre-sample start / settlement moment) lands
      // inside the default poll window, sleep only up to it (floored at 1.5s against hot-spinning)
      // so the boundary crank fires within ~2s instead of up to a full poll late. No hint => the
      // exact legacy cadence.
      const sleepMs =
        minWakeHintMs === undefined ? effectivePollMs : Math.max(1_500, Math.min(effectivePollMs, minWakeHintMs));
      await sleep(sleepMs);
    }
  }

  // Final flush on a clean shutdown so the last interval's counts survive the restart.
  if (stallWatch) clearInterval(stallWatch);
  persistMetrics();
  healthServer?.close();
  log({ msg: 'keeper.stopped' });
}

// Run only when executed directly (so test/DRY imports can construct without looping).
// pathToFileURL makes the comparison correct cross-platform - on Windows import.meta.url
// is file:///C:/... (three slashes), which a hand-built `file://${path}` never matches.
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'keeper.fatal', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
