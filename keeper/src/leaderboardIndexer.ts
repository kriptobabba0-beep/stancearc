// keeper/src/leaderboardIndexer.ts - the single writer behind the site's leaderboard.
//
// WHY THIS EXISTS. The leaderboard used to be indexed by the website itself: every Cloudflare
// isolate advanced its own copy of the index and cached it per-colo. That gives you N different
// leaderboards, each at a different block, and whichever one a visitor lands on is the one they
// see - so the page appeared to jump between "current" and "a week stale", and a visitor unlucky
// enough to land on a cold copy paid ten seconds of chain-scanning to read a web page.
//
// One writer fixes that. This process owns the index, keeps it on disk so it never re-scans what
// it already knows, and pushes a ready-to-serve payload to the site. The site then does nothing
// but hand that payload back, which is why it can answer instantly and always with the same
// numbers.
//
// BEING A GOOD NEIGHBOUR. This runs on the same one-vCPU droplet as the keeper, whose settlement
// work must never be starved, so the design is deliberately unhurried:
//   · steady state needs ~19 getLogs a day (one 9k-block window per ~76 minutes of chain), which
//     is a rounding error next to the arb's 20-second poll;
//   · every RPC call is spaced by THROTTLE_MS, so even the one-time backfill trickles instead of
//     bursting;
//   · it reads through its OWN rpc url, so it queues behind its own rate limit, not the keeper's;
//   · the container is capped at 256 MB / 0.35 CPU in compose - it cannot crowd anyone out.
//
// CRASH BEHAVIOUR. The snapshot is written atomically (tmp + rename) every PERSIST_EVERY_MS. A
// hard kill loses at most that much progress and the cursor rewinds with it, so the lost blocks
// are simply re-scanned. Folding is NOT idempotent - aggregates would double-count - which is
// exactly why the cursor is saved with the aggregates it belongs to and never separately.
import { createPublicClient, http, parseEventLogs, type Abi, type Log, type PublicClient } from 'viem';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { feeArenaV3Abi } from './feeArenaV3Abi.js';
import {
  applyLogs,
  buildLeaderboardPayload,
  buildSelfIndex,
  emptySnapshot,
  snapshotFromJson,
  snapshotToJson,
  type IndexLog,
  type LeaderboardSnapshot,
  type PayloadMarketMeta,
} from './leaderboardIndex.js';

// ── event ABIs ──────────────────────────────────────────────────────────────────────────
// Only the events that move the standings. Address-only getLogs returns everything a contract
// emitted, so anything not named here is decoded away to nothing.

// The arena ABI is the REAL one, synced from the frontend - never hand-written. An event
// fragment that differs from the contract by so much as a parameter width hashes to a different
// topic0, and a log whose topic0 doesn't match is skipped with no error at all. The standings
// would keep rendering, keep showing volume (that comes from the pool), and quietly report zero
// epochs, zero fees and empty 7D/30D windows.
const ARENA_EVENTS = feeArenaV3Abi.filter((f) => f.type === 'event') as unknown as Abi;

const POOL_EVENTS = [
  { type: 'event', name: 'Swap', anonymous: false, inputs: [
    { name: 'sender', type: 'address', indexed: true },
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'amount0', type: 'int256', indexed: false },
    { name: 'amount1', type: 'int256', indexed: false },
    { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'tick', type: 'int24', indexed: false },
  ] },
  { type: 'event', name: 'Mint', anonymous: false, inputs: [
    { name: 'sender', type: 'address', indexed: false },
    { name: 'owner', type: 'address', indexed: true },
    { name: 'tickLower', type: 'int24', indexed: true },
    { name: 'tickUpper', type: 'int24', indexed: true },
    { name: 'amount', type: 'uint128', indexed: false },
    { name: 'amount0', type: 'uint256', indexed: false },
    { name: 'amount1', type: 'uint256', indexed: false },
  ] },
] as const satisfies Abi;

const NPM_EVENTS = [
  { type: 'event', name: 'Transfer', anonymous: false, inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ] },
  { type: 'event', name: 'IncreaseLiquidity', anonymous: false, inputs: [
    { name: 'tokenId', type: 'uint256', indexed: true },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'amount0', type: 'uint256', indexed: false },
    { name: 'amount1', type: 'uint256', indexed: false },
  ] },
] as const satisfies Abi;

// ── config ──────────────────────────────────────────────────────────────────────────────

export interface IndexerMarket extends PayloadMarketMeta {
  pool: string;
  npm: string;
  fromBlock: bigint;
  baseDecimals: number;
  baseIsToken0: boolean;
}

export interface IndexerConfig {
  markets: IndexerMarket[];
  rpcUrl: string;
  chainId: number;
  ingestUrl: string | null;
  ingestSecret: string | null;
  stateDir: string;
  windowBlocks: bigint;
  /** Minimum gap between RPC calls - the whole politeness budget in one number. */
  throttleMs: number;
  /** How often a fully caught-up market re-checks the head. */
  idleMs: number;
  persistEveryMs: number;
  pushEveryMs: number;
}

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function loadIndexerConfig(env: NodeJS.ProcessEnv = process.env): IndexerConfig {
  const raw = env.LEADERBOARD_MARKETS;
  if (!raw) throw new Error('LEADERBOARD_MARKETS is required (JSON array of market configs)');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LEADERBOARD_MARKETS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LEADERBOARD_MARKETS must be a non-empty JSON array');
  }
  const markets = parsed.map((m, i) => {
    const o = m as Record<string, unknown>;
    for (const k of ['id', 'arena', 'pool', 'npm', 'baseSymbol']) {
      if (typeof o[k] !== 'string' || !o[k]) throw new Error(`LEADERBOARD_MARKETS[${i}].${k} is required`);
    }
    return {
      id: String(o.id),
      arena: String(o.arena).toLowerCase(),
      pool: String(o.pool).toLowerCase(),
      npm: String(o.npm).toLowerCase(),
      baseSymbol: String(o.baseSymbol),
      quoteSymbol: typeof o.quoteSymbol === 'string' && o.quoteSymbol ? o.quoteSymbol : 'USDC',
      fromBlock: BigInt(String(o.fromBlock ?? '0')),
      baseDecimals: Number(o.baseDecimals ?? 8),
      baseIsToken0: o.baseIsToken0 === true,
    } satisfies IndexerMarket;
  });

  const rpcUrl = env.LEADERBOARD_RPC_URL || env.KEEPER_RPC_URL;
  if (!rpcUrl) throw new Error('LEADERBOARD_RPC_URL (or KEEPER_RPC_URL) is required');

  return {
    markets,
    rpcUrl,
    chainId: num(env.LEADERBOARD_CHAIN_ID ?? env.KEEPER_CHAIN_ID, 5042002),
    ingestUrl: env.LEADERBOARD_INGEST_URL || null,
    ingestSecret: env.LEADERBOARD_INGEST_SECRET || null,
    stateDir: env.LEADERBOARD_STATE_DIR || '/app/state',
    windowBlocks: BigInt(num(env.LEADERBOARD_WINDOW_BLOCKS, 9_000)),
    throttleMs: num(env.LEADERBOARD_THROTTLE_MS, 1_000),
    idleMs: num(env.LEADERBOARD_IDLE_MS, 30_000),
    persistEveryMs: num(env.LEADERBOARD_PERSIST_MS, 300_000),
    pushEveryMs: num(env.LEADERBOARD_PUSH_MS, 30_000),
  };
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────────────────

/** The next window to scan, or null when the cursor has caught up with the head. */
export function nextWindow(cursor: bigint, head: bigint, windowBlocks: bigint): [bigint, bigint] | null {
  if (cursor > head) return null;
  const end = cursor + windowBlocks - 1n;
  return [cursor, end > head ? head : end];
}

/** Split one address-only getLogs response into the three contracts' decoded logs. */
export function decodeWindow(
  raw: Log[],
  market: Pick<IndexerMarket, 'arena' | 'pool' | 'npm'>,
): IndexLog[] {
  const out: IndexLog[] = [];
  const take = (want: string, source: IndexLog['source'], abi: Abi) => {
    const subset = raw.filter((l) => l.address.toLowerCase() === want);
    if (subset.length === 0) return;
    // strict:false - an address emits events we don't model; those must be skipped, not throw.
    for (const d of parseEventLogs({ abi, logs: subset, strict: false })) {
      if (d.blockNumber == null || d.logIndex == null) continue;
      out.push({
        source,
        eventName: d.eventName,
        blockNumber: d.blockNumber,
        logIndex: d.logIndex,
        args: (d.args ?? {}) as Record<string, unknown>,
      });
    }
  };
  take(market.arena, 'arena', ARENA_EVENTS);
  take(market.pool, 'pool', POOL_EVENTS as unknown as Abi);
  take(market.npm, 'npm', NPM_EVENTS as unknown as Abi);
  return out;
}

// ── state on disk ───────────────────────────────────────────────────────────────────────

const snapshotPath = (dir: string, market: IndexerMarket) => join(dir, `leaderboard-${market.id}.json`);

export function loadSnapshot(
  cfg: IndexerConfig,
  market: IndexerMarket,
  log: (o: Record<string, unknown>) => void,
): LeaderboardSnapshot {
  const fresh = () => emptySnapshot(market.arena, market.fromBlock, market.baseDecimals, market.baseIsToken0);
  try {
    const snap = snapshotFromJson(readFileSync(snapshotPath(cfg.stateDir, market), 'utf8'));
    // A snapshot for a REPLACED arena (or an older format) must never be reused - those numbers
    // belong to a different contract.
    if (!snap || snap.arena !== market.arena) return fresh();
    return snap;
  } catch {
    return fresh(); // first boot, or an unreadable file - re-index rather than serve nothing
  }
}

export function saveSnapshot(
  cfg: IndexerConfig,
  market: IndexerMarket,
  snap: LeaderboardSnapshot,
  log: (o: Record<string, unknown>) => void,
): boolean {
  const path = snapshotPath(cfg.stateDir, market);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, snapshotToJson(snap), 'utf8');
    renameSync(tmp, path); // atomic: a crash mid-write leaves the previous good snapshot
    return true;
  } catch (err) {
    log({ msg: 'leaderboard.persist.error', market: market.id, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// ── the loop ────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a cached chain head stays good enough to plan the next window against. */
const HEAD_TTL_MS = 30_000;

function log(rec: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), svc: 'leaderboard', ...rec })}\n`);
}

export async function pushPayload(
  cfg: IndexerConfig,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  if (!cfg.ingestUrl || !cfg.ingestSecret) return { ok: false, status: 0, detail: 'ingest not configured' };
  try {
    const res = await fetchImpl(cfg.ingestUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Leaderboard-Secret': cfg.ingestSecret },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, detail: res.ok ? undefined : (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function run(): Promise<void> {
  const cfg = loadIndexerConfig();
  const client = createPublicClient({
    transport: http(cfg.rpcUrl, { retryCount: 3, retryDelay: 2_000 }),
  }) as PublicClient;

  log({
    msg: 'leaderboard.start',
    markets: cfg.markets.map((m) => m.id),
    windowBlocks: Number(cfg.windowBlocks),
    throttleMs: cfg.throttleMs,
    stateDir: cfg.stateDir,
    ingest: cfg.ingestUrl ? 'configured' : 'MISSING',
  });

  const state = cfg.markets.map((market) => ({
    market,
    snap: loadSnapshot(cfg, market, log),
    lastPersist: 0,
    lastPush: 0,
    lastError: null as string | null,
    head: 0n,
    headAt: 0,
  }));
  for (const s of state) {
    log({ msg: 'leaderboard.loaded', market: s.market.id, cursor: s.snap.cursor.toString(), participants: s.snap.all.size });
  }

  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log({ msg: 'leaderboard.stopping', signal: sig });
    for (const s of state) saveSnapshot(cfg, s.market, s.snap, log);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // One RPC call at a time, spaced by throttleMs - the politeness budget, enforced in one place.
  let lastCall = 0;
  const throttled = async <T>(fn: () => Promise<T>): Promise<T> => {
    const wait = cfg.throttleMs - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    return fn();
  };

  while (!stopping) {
    let didWork = false;

    for (const s of state) {
      if (stopping) break;
      const { market } = s;
      try {
        // The head is re-read only when it might matter: once the cursor has reached the last
        // known head, or after HEAD_TTL_MS. During a backfill the cursor is millions of blocks
        // behind, so asking the chain "how far is the tip?" before every window would double the
        // RPC calls to learn something that cannot change the answer.
        const now0 = Date.now();
        if (s.head === 0n || s.snap.cursor > s.head || now0 - s.headAt >= HEAD_TTL_MS) {
          s.head = await throttled(() => client.getBlockNumber());
          s.headAt = now0;
        }
        const head = s.head;
        const win = nextWindow(s.snap.cursor, head, cfg.windowBlocks);

        if (win) {
          const raw = await throttled(() =>
            client.getLogs({
              address: [market.arena as `0x${string}`, market.pool as `0x${string}`, market.npm as `0x${string}`],
              fromBlock: win[0],
              toBlock: win[1],
            }),
          );
          applyLogs(s.snap, decodeWindow(raw as Log[], market), win[1], Date.now());
          s.lastError = null;
          didWork = true;
          if (s.snap.cursor % 500_000n < cfg.windowBlocks) {
            log({ msg: 'leaderboard.progress', market: market.id, cursor: s.snap.cursor.toString(), behind: (head - s.snap.cursor).toString() });
          }
        }

        const now = Date.now();
        if (now - s.lastPersist >= cfg.persistEveryMs) {
          if (saveSnapshot(cfg, market, s.snap, log)) s.lastPersist = now;
        }
        if (now - s.lastPush >= cfg.pushEveryMs) {
          // Two artifacts: the capped board everyone reads, and the per-address index the API
          // uses to answer "where do I stand?" for someone outside it. The index never reaches a
          // browser, so publishing it costs nothing the visitor pays for.
          const payload = buildLeaderboardPayload(s.snap, market, head, now, s.lastError);
          const index = buildSelfIndex(s.snap, now);
          const r = await pushPayload(cfg, { payload, index });
          s.lastPush = now;
          if (!r.ok) log({ msg: 'leaderboard.push.error', market: market.id, status: r.status, detail: r.detail });
        }
      } catch (err) {
        // Serve-what-we-have: a bad window must never kill the loop. The cursor stays put, so
        // the same range is retried on the next pass.
        s.lastError = (err instanceof Error ? err.message.split('\n')[0] : String(err)) || 'scan failed';
        log({ msg: 'leaderboard.scan.error', market: market.id, cursor: s.snap.cursor.toString(), error: s.lastError });
        await sleep(cfg.idleMs);
      }
    }

    // Caught up on every market - stop asking the chain so often.
    if (!didWork) await sleep(cfg.idleMs);
  }
}

// Only run the loop when executed directly; importing this file (tests) must not start it.
const isEntry = process.argv[1] && process.argv[1].includes('leaderboardIndexer');
if (isEntry) {
  run().catch((err) => {
    log({ msg: 'leaderboard.fatal', error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
