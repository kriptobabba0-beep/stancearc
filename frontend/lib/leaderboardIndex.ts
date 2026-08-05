// lib/leaderboardIndex.ts - the PURE incremental engine behind /api/leaderboard.
//
// The standings are built exclusively from on-chain events - the FeeArena (entries, fee
// contributions, claims), the market's Uniswap pool (swaps, liquidity mints) and the NPM
// (position ownership) - folded into a compact snapshot the API route advances one bounded
// block-window at a time. Visitors never pay for a chain scan.
//
// Metrics, and why they are honest:
//   VOLUME = swaps + liquidity added + fees staked, all in the market's quote token (6dp):
//     · swaps: |quote leg| of every pool Swap, attributed to the swap's recipient. The
//       Swap event carries its own sqrtPriceX96, which also keeps a running price fresh.
//     · liquidity: both legs of every NPM IncreaseLiquidity that provably belongs to THIS
//       market's pool (joined against the pool's Mint in the same block with identical
//       liquidity+amounts), base leg valued at the latest on-chain price. Owner comes from
//       NPM Transfer logs.
//     · fees staked: PositionProcessed.contributionUsd6 - the contract's own valuation.
//   PnL = Σ usd(Claimed payouts) − Σ contributionUsd6 (realized: collected minus put at
//       stake). A claim's base leg is valued at the claimed epoch's settlement price
//       (EpochSettled.finalPrice18) - claims can only happen after settlement.
//   entered/won are per POSITION (one entry = one processed position).
//
// Day buckets power the 7D/30D windows. Arena events bucket by their epoch's settlement
// time; swap/liquidity events bucket by the running chain clock (the latest EpochCreated's
// entryOpenTime - epochs open every few minutes, so the skew is minutes at worst).

export interface AddrAgg {
  feeUsd6: bigint; // fees put at stake (contributionUsd6)
  swapUsd6: bigint; // swap notional, quote side
  liqUsd6: bigint; // liquidity added, both legs quote-valued
  pnlUsd6: bigint;
  claimedUsd6: bigint;
  claimedBase: bigint; // raw base-leg payout sum (for the welcome table's two-line display)
  claimedQuote: bigint; // raw quote-leg payout sum
  entered: number;
  won: number;
}

export interface LeaderboardSnapshot {
  version: 2;
  arena: string;
  baseDecimals: number;
  /** Uniswap sorts the pair by address - whether the BASE token is token0 in this pool. */
  baseIsToken0: boolean;
  fromBlock: bigint;
  /** Next block to scan (everything below is folded in). */
  cursor: bigint;
  updatedAt: number;
  /** epochId -> settlement price (1e18) once EpochSettled is seen. */
  epochPrice: Map<string, bigint>;
  /** epochId -> settlementTime (unix sec) from EpochCreated. */
  epochTime: Map<string, number>;
  /** `${epochId}:${tokenId}` -> owner (lowercase); consumed+deleted at PositionProcessed. */
  stakeOwner: Map<string, string>;
  /** NPM tokenId -> owner (lowercase), maintained from NPM Transfer logs. */
  npmOwner: Map<string, string>;
  /** Latest quote-per-base price (1e18) seen on-chain (swaps + settlements). */
  lastPrice18: bigint;
  /** Running chain clock (unix sec) from the latest EpochCreated. */
  lastTimeSec: number;
  all: Map<string, AddrAgg>;
  /** dayNumber -> addr -> agg; pruned past RETAIN_DAYS. */
  days: Map<number, Map<string, AddrAgg>>;
  totals: {
    epochsSettled: number;
    feeUsd6: bigint;
    swapUsd6: bigint;
    liqUsd6: bigint;
    redistributedUsd6: bigint;
  };
}

export const RETAIN_DAYS = 45;
const NPM_OWNER_CAP = 4_000;

// Growth bounds. Epochs open every couple of minutes - roughly 720/day, 260k/year - so any map
// keyed by epochId grows without limit unless it is pruned. Left alone, epochPrice + epochTime
// alone add ~14 MB/year, which eventually makes every save and reload of the snapshot slower
// than the indexing it protects. These caps make the snapshot's size a function of the retention
// window instead of the arena's age, so a node that has run for years costs the same as a fresh
// one.
//
// The retention is the same RETAIN_DAYS the day buckets use: epochPrice only values `Claimed`
// payouts and epochTime only assigns day buckets, and neither reaches further back than the
// windows do. A claim older than the window values its base leg at 0, which under-counts rather
// than invents - the same trade the pre-existing missing-price path already makes.
export const EPOCH_RETAIN_DAYS = RETAIN_DAYS;
/** Backstop for epoch entries we cannot date (EpochSettled seen without its EpochCreated).
 *  Maps iterate in insertion order, so eviction drops the oldest first. */
const EPOCH_MAP_CAP = 60_000;
/** Stakes are consumed by PositionProcessed; one that never is would otherwise leak forever. */
const STAKE_OWNER_CAP = 10_000;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
const Q192 = 2n ** 192n;

/** Drop the oldest entries until `map` is within `cap` (insertion order = age order). */
function capMap(map: Map<string, unknown>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/** One decoded log, already tagged with the contract it came from. */
export interface IndexLog {
  source: 'arena' | 'pool' | 'npm';
  eventName: string;
  blockNumber: bigint;
  logIndex: number;
  args: Record<string, unknown>;
}

export function emptySnapshot(
  arena: string,
  fromBlock: bigint,
  baseDecimals: number,
  baseIsToken0: boolean,
): LeaderboardSnapshot {
  return {
    version: 2,
    arena: arena.toLowerCase(),
    baseDecimals,
    baseIsToken0,
    fromBlock,
    cursor: fromBlock,
    updatedAt: 0,
    epochPrice: new Map(),
    epochTime: new Map(),
    stakeOwner: new Map(),
    npmOwner: new Map(),
    lastPrice18: 0n,
    lastTimeSec: 0,
    all: new Map(),
    days: new Map(),
    totals: { epochsSettled: 0, feeUsd6: 0n, swapUsd6: 0n, liqUsd6: 0n, redistributedUsd6: 0n },
  };
}

function blankAgg(): AddrAgg {
  return {
    feeUsd6: 0n,
    swapUsd6: 0n,
    liqUsd6: 0n,
    pnlUsd6: 0n,
    claimedUsd6: 0n,
    claimedBase: 0n,
    claimedQuote: 0n,
    entered: 0,
    won: 0,
  };
}

function aggFor(map: Map<string, AddrAgg>, addr: string): AddrAgg {
  let a = map.get(addr);
  if (!a) {
    a = blankAgg();
    map.set(addr, a);
  }
  return a;
}

function dayAgg(snap: LeaderboardSnapshot, day: number | undefined, addr: string): AddrAgg | null {
  if (day === undefined || day <= 0) return null;
  let bucket = snap.days.get(day);
  if (!bucket) {
    bucket = new Map();
    snap.days.set(day, bucket);
  }
  return aggFor(bucket, addr);
}

/** The day bucket for an epoch - undefined when the epoch's creation predates the scan. */
function epochDay(snap: LeaderboardSnapshot, epochId: string): number | undefined {
  const t = snap.epochTime.get(epochId);
  return t === undefined ? undefined : Math.floor(t / 86_400);
}

/** The day bucket for "around now" pool events, from the running chain clock. */
function clockDay(snap: LeaderboardSnapshot): number | undefined {
  return snap.lastTimeSec > 0 ? Math.floor(snap.lastTimeSec / 86_400) : undefined;
}

/** usd6 value of (base, quote) legs: quote passes through, base × price18. */
export function payoutUsd6(payBase: bigint, payQuote: bigint, price18: bigint, baseDecimals: number): bigint {
  const scale = 10n ** BigInt(baseDecimals + 12);
  return payQuote + (payBase * price18) / scale;
}

/** sqrtPriceX96 → quote-per-base price (1e18), respecting the pool's token order. */
export function sqrtPriceToPrice18(sqrtPriceX96: bigint, baseDecimals: number, baseIsToken0: boolean): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  // raw = token1-per-token0; scale to 1e18 with the decimal gap (quote is always 6dp here).
  const factor = 10n ** BigInt(18 + baseDecimals - 6);
  return baseIsToken0 ? (sq * factor) / Q192 : (Q192 * factor) / sq;
}

const absBig = (v: bigint) => (v < 0n ? -v : v);

/**
 * Fold a batch of decoded logs (any order - sorted internally) into the snapshot, then
 * advance the cursor to `scannedTo + 1`. Pool Mint ↔ NPM IncreaseLiquidity joins happen
 * within a batch; both logs share a transaction (and therefore a block), and windows never
 * split a block, so the join can never straddle two calls.
 */
export function applyLogs(snap: LeaderboardSnapshot, logs: IndexLog[], scannedTo: bigint, now: number): void {
  const sorted = [...logs].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  // Pool Mints awaiting their NPM IncreaseLiquidity twin (same block, same amounts).
  const poolMints = new Set<string>();

  for (const log of sorted) {
    const a = log.args;
    const key = `${log.source}:${log.eventName}`;
    switch (key) {
      case 'arena:EpochCreated': {
        const epochId = String(a.epochId);
        const settle = Number(a.settlementTime ?? 0);
        const open = Number(a.entryOpenTime ?? 0);
        if (settle > 0) snap.epochTime.set(epochId, settle);
        if (open > 0) snap.lastTimeSec = open;
        else if (settle > 0) snap.lastTimeSec = settle;
        break;
      }
      case 'arena:Staked': {
        const owner = typeof a.owner === 'string' ? a.owner.toLowerCase() : undefined;
        if (!owner) break;
        snap.stakeOwner.set(`${String(a.epochId)}:${String(a.tokenId)}`, owner);
        capMap(snap.stakeOwner as Map<string, unknown>, STAKE_OWNER_CAP);
        break;
      }
      case 'arena:PositionProcessed': {
        const epochId = String(a.epochId);
        const joinKey = `${epochId}:${String(a.tokenId)}`;
        const owner = snap.stakeOwner.get(joinKey);
        snap.stakeOwner.delete(joinKey);
        if (!owner) break; // stake predates the scan window - nothing to attribute
        const contribution = (a.contributionUsd6 as bigint) ?? 0n;
        const won = a.won === true;
        const day = epochDay(snap, epochId);
        for (const agg of [aggFor(snap.all, owner), dayAgg(snap, day, owner)]) {
          if (!agg) continue;
          agg.entered += 1;
          if (won) agg.won += 1;
          agg.feeUsd6 += contribution;
          agg.pnlUsd6 -= contribution; // fees at stake are spent here; claims add back
        }
        snap.totals.feeUsd6 += contribution;
        break;
      }
      case 'arena:EpochSettled': {
        const epochId = String(a.epochId);
        const price = (a.finalPrice18 as bigint) ?? 0n;
        if (price > 0n) {
          snap.epochPrice.set(epochId, price);
          snap.lastPrice18 = price;
        }
        snap.totals.epochsSettled += 1;
        break;
      }
      case 'arena:Claimed': {
        const owner = typeof a.owner === 'string' ? a.owner.toLowerCase() : undefined;
        if (!owner) break;
        const epochId = String(a.epochId);
        const payBase = (a.payBase as bigint) ?? 0n;
        const payQuote = (a.payUSDC as bigint) ?? 0n;
        // Claims only exist after settlement; a zero fallback under-counts rather than invents.
        const price = snap.epochPrice.get(epochId) ?? 0n;
        const usd = payoutUsd6(payBase, payQuote, price, snap.baseDecimals);
        const day = epochDay(snap, epochId);
        for (const agg of [aggFor(snap.all, owner), dayAgg(snap, day, owner)]) {
          if (!agg) continue;
          agg.pnlUsd6 += usd;
          agg.claimedUsd6 += usd;
          agg.claimedBase += payBase;
          agg.claimedQuote += payQuote;
        }
        snap.totals.redistributedUsd6 += usd;
        break;
      }
      case 'pool:Swap': {
        const recipient = typeof a.recipient === 'string' ? a.recipient.toLowerCase() : undefined;
        const amount0 = (a.amount0 as bigint) ?? 0n;
        const amount1 = (a.amount1 as bigint) ?? 0n;
        const sqrtP = (a.sqrtPriceX96 as bigint) ?? 0n;
        const p = sqrtPriceToPrice18(sqrtP, snap.baseDecimals, snap.baseIsToken0);
        if (p > 0n) snap.lastPrice18 = p;
        if (!recipient) break;
        const quoteLeg = absBig(snap.baseIsToken0 ? amount1 : amount0);
        if (quoteLeg === 0n) break;
        const day = clockDay(snap);
        for (const agg of [aggFor(snap.all, recipient), dayAgg(snap, day, recipient)]) {
          if (!agg) continue;
          agg.swapUsd6 += quoteLeg;
        }
        snap.totals.swapUsd6 += quoteLeg;
        break;
      }
      case 'pool:Mint': {
        // Remember this mint so the NPM IncreaseLiquidity twin (same tx) can prove the
        // position belongs to THIS pool. Key = block + liquidity + both amounts.
        poolMints.add(`${log.blockNumber}:${String(a.amount)}:${String(a.amount0)}:${String(a.amount1)}`);
        break;
      }
      case 'npm:Transfer': {
        const tokenId = String(a.tokenId);
        const to = typeof a.to === 'string' ? a.to.toLowerCase() : undefined;
        if (!to) break;
        if (to === ZERO_ADDR) {
          snap.npmOwner.delete(tokenId);
        } else {
          if (!snap.npmOwner.has(tokenId) && snap.npmOwner.size >= NPM_OWNER_CAP) {
            const oldest = snap.npmOwner.keys().next();
            if (!oldest.done) snap.npmOwner.delete(oldest.value);
          }
          snap.npmOwner.set(tokenId, to);
        }
        break;
      }
      case 'npm:IncreaseLiquidity': {
        const joinKey = `${log.blockNumber}:${String(a.liquidity)}:${String(a.amount0)}:${String(a.amount1)}`;
        if (!poolMints.has(joinKey)) break; // a different pool's position - not this market
        poolMints.delete(joinKey);
        const owner = snap.npmOwner.get(String(a.tokenId));
        if (!owner) break;
        const amount0 = (a.amount0 as bigint) ?? 0n;
        const amount1 = (a.amount1 as bigint) ?? 0n;
        const baseLeg = snap.baseIsToken0 ? amount0 : amount1;
        const quoteLeg = snap.baseIsToken0 ? amount1 : amount0;
        const usd = payoutUsd6(baseLeg, quoteLeg, snap.lastPrice18, snap.baseDecimals);
        if (usd === 0n) break;
        const day = clockDay(snap);
        for (const agg of [aggFor(snap.all, owner), dayAgg(snap, day, owner)]) {
          if (!agg) continue;
          agg.liqUsd6 += usd;
        }
        snap.totals.liqUsd6 += usd;
        break;
      }
      default:
        break; // keeper/ops events don't affect standings
    }
  }

  snap.cursor = scannedTo + 1n;
  snap.updatedAt = now;
  pruneDays(snap, now);
  pruneEpochs(snap);
}

/** Drop day buckets older than RETAIN_DAYS (windows never look back further). */
function pruneDays(snap: LeaderboardSnapshot, now: number): void {
  const minDay = Math.floor(now / 1000 / 86_400) - RETAIN_DAYS;
  for (const day of snap.days.keys()) {
    if (day < minDay) snap.days.delete(day);
  }
}

/**
 * Drop epoch metadata the windows can no longer reach, so the snapshot's size tracks the
 * retention window rather than the arena's age.
 *
 * Cutoff is the CHAIN clock, not the wall clock. A backfill replays months-old blocks in
 * minutes, so wall-clock pruning would delete each epoch in the same batch that created it and
 * every `Claimed` behind it would lose its settlement price. Against the chain clock the
 * retention window travels with the blocks being read, which is what "45 days of history" is
 * supposed to mean. Before the first EpochCreated arrives there is no chain clock, so pruning
 * waits - the maps are empty then anyway.
 */
function pruneEpochs(snap: LeaderboardSnapshot): void {
  if (snap.lastTimeSec > 0) {
    const cutoff = snap.lastTimeSec - EPOCH_RETAIN_DAYS * 86_400;
    for (const [epochId, t] of snap.epochTime) {
      if (t < cutoff) {
        snap.epochTime.delete(epochId);
        snap.epochPrice.delete(epochId);
      }
    }
  }
  // Backstop for entries that carry no time at all (EpochSettled without its EpochCreated).
  capMap(snap.epochTime as Map<string, unknown>, EPOCH_MAP_CAP);
  capMap(snap.epochPrice as Map<string, unknown>, EPOCH_MAP_CAP);
}

// ── Window reads ────────────────────────────────────────────────────────────────────────

export interface LeaderRowOut {
  address: string;
  /** Composite volume: swaps + liquidity added + fees staked. */
  volumeUsd6: string;
  swapUsd6: string;
  liqUsd6: string;
  feeUsd6: string;
  pnlUsd6: string;
  claimedUsd6: string;
  claimedBase: string;
  claimedQuote: string;
  entered: number;
  won: number;
}

function toRow(addr: string, a: AddrAgg): LeaderRowOut {
  return {
    address: addr,
    volumeUsd6: (a.swapUsd6 + a.liqUsd6 + a.feeUsd6).toString(),
    swapUsd6: a.swapUsd6.toString(),
    liqUsd6: a.liqUsd6.toString(),
    feeUsd6: a.feeUsd6.toString(),
    pnlUsd6: a.pnlUsd6.toString(),
    claimedUsd6: a.claimedUsd6.toString(),
    claimedBase: a.claimedBase.toString(),
    claimedQuote: a.claimedQuote.toString(),
    entered: a.entered,
    won: a.won,
  };
}

// Row order is address-sorted for determinism (the client re-sorts by the active metric;
// JSON round-trips would otherwise reorder integer-like day keys and flip insertion order).
const byAddress = (a: LeaderRowOut, b: LeaderRowOut) => (a.address < b.address ? -1 : 1);

/** All-time rows (address-sorted; the client sorts by the active metric). */
export function rowsAll(snap: LeaderboardSnapshot): LeaderRowOut[] {
  return [...snap.all.entries()].map(([addr, a]) => toRow(addr, a)).sort(byAddress);
}

/** Rows summed over the trailing `windowDays` day buckets. */
export function rowsWindow(snap: LeaderboardSnapshot, windowDays: number, now: number): LeaderRowOut[] {
  const minDay = Math.floor(now / 1000 / 86_400) - windowDays;
  const sum = new Map<string, AddrAgg>();
  for (const [day, bucket] of snap.days) {
    if (day < minDay) continue;
    for (const [addr, a] of bucket) {
      const acc = aggFor(sum, addr);
      acc.feeUsd6 += a.feeUsd6;
      acc.swapUsd6 += a.swapUsd6;
      acc.liqUsd6 += a.liqUsd6;
      acc.pnlUsd6 += a.pnlUsd6;
      acc.claimedUsd6 += a.claimedUsd6;
      acc.claimedBase += a.claimedBase;
      acc.claimedQuote += a.claimedQuote;
      acc.entered += a.entered;
      acc.won += a.won;
    }
  }
  return [...sum.entries()].map(([addr, a]) => toRow(addr, a)).sort(byAddress);
}

// ── API payload ─────────────────────────────────────────────────────────────────────────
//
// Shaped here, in the shared engine, because the process that BUILDS the payload (the keeper's
// indexer) and the one that SERVES it (the site) are different programs. Keeping the shape in
// one place is what stops them disagreeing about what a row means.

/** Market facts the snapshot itself doesn't carry. */
export interface PayloadMarketMeta {
  id: string;
  arena: string;
  baseSymbol: string;
  quoteSymbol: string;
}

/**
 * How many rows a published board carries per window.
 *
 * The payload used to carry every participant, so its size tracked the number of wallets that had
 * ever played: fine at 44, about half a megabyte at a thousand, and past KV's 25 MB ceiling around
 * fifty thousand - sent to every visitor, every poll, to render fifteen rows at a time. Capping it
 * makes the response the same size whether a hundred wallets have played or a hundred thousand.
 *
 * Both metrics are kept because the board sorts by either: a wallet can be top-ten by PnL and
 * nowhere near the top by volume, and trimming on one metric would erase it from the other.
 */
export const MAX_BOARD_ROWS = 100;

export interface LeaderboardPayload {
  market: string;
  arena: string;
  baseSymbol: string;
  quoteSymbol: string;
  head: string;
  cursor: string;
  syncing: boolean;
  /** 0..100 - how much of the arena's history is folded in. */
  progress: number;
  /** When the indexer last folded logs in (ms). */
  updatedAt: number;
  /** When this payload was built (ms) - lets a reader see that the indexer itself went quiet. */
  generatedAt: number;
  /** How many rows each window was capped at. */
  maxRows: number;
  /** True when at least one window had rows trimmed off, so the UI can say "top 100 of N". */
  truncated: boolean;
  lastError: string | null;
  totals: {
    epochsSettled: number;
    /** Composite volume: swaps + liquidity added + fees staked. */
    volumeUsd6: string;
    swapUsd6: string;
    liqUsd6: string;
    feeUsd6: string;
    redistributedUsd6: string;
    participants: number;
  };
  rows: LeaderRowOut[];
  d30: LeaderRowOut[];
  d7: LeaderRowOut[];
  /**
   * The viewer's own standing, when they asked for it (`?self=0x…`) and fell outside the published
   * rows. Added by the API, never by the indexer - it is the one part of the response that differs
   * per reader, which is also why a request carrying it is not edge-cached.
   */
  self?: {
    address: string;
    all: LeaderRowOut | null;
    d30: LeaderRowOut | null;
    d7: LeaderRowOut | null;
  } | null;
}

/** The rows worth publishing: the top `limit` by volume and by PnL, unioned, address-sorted. */
export function topRows(rows: LeaderRowOut[], limit: number): LeaderRowOut[] {
  if (rows.length <= limit) return rows;
  const desc = (pick: (r: LeaderRowOut) => bigint) => (a: LeaderRowOut, b: LeaderRowOut) => {
    const ka = pick(a);
    const kb = pick(b);
    return ka === kb ? 0 : kb > ka ? 1 : -1;
  };
  const keep = new Map<string, LeaderRowOut>();
  for (const pick of [(r: LeaderRowOut) => BigInt(r.volumeUsd6), (r: LeaderRowOut) => BigInt(r.pnlUsd6)]) {
    for (const r of [...rows].sort(desc(pick)).slice(0, limit)) keep.set(r.address, r);
  }
  return [...keep.values()].sort(byAddress);
}

export function buildLeaderboardPayload(
  snap: LeaderboardSnapshot,
  meta: PayloadMarketMeta,
  head: bigint,
  now: number,
  lastError: string | null = null,
  maxRows: number = MAX_BOARD_ROWS,
): LeaderboardPayload {
  const total = head >= snap.fromBlock ? head - snap.fromBlock + 1n : 1n;
  const done = snap.cursor > snap.fromBlock ? snap.cursor - snap.fromBlock : 0n;
  const progress = Number((done * 1000n) / total) / 10;
  const full = { all: rowsAll(snap), d30: rowsWindow(snap, 30, now), d7: rowsWindow(snap, 7, now) };
  const cut = {
    all: topRows(full.all, maxRows),
    d30: topRows(full.d30, maxRows),
    d7: topRows(full.d7, maxRows),
  };
  const truncated =
    cut.all.length < full.all.length || cut.d30.length < full.d30.length || cut.d7.length < full.d7.length;
  return {
    market: meta.id,
    arena: meta.arena,
    baseSymbol: meta.baseSymbol,
    quoteSymbol: meta.quoteSymbol,
    head: head.toString(),
    cursor: snap.cursor.toString(),
    syncing: snap.cursor < head,
    progress: Math.max(0, Math.min(100, progress)),
    updatedAt: snap.updatedAt,
    generatedAt: now,
    maxRows,
    truncated,
    lastError,
    totals: {
      epochsSettled: snap.totals.epochsSettled,
      volumeUsd6: (snap.totals.swapUsd6 + snap.totals.liqUsd6 + snap.totals.feeUsd6).toString(),
      swapUsd6: snap.totals.swapUsd6.toString(),
      liqUsd6: snap.totals.liqUsd6.toString(),
      feeUsd6: snap.totals.feeUsd6.toString(),
      redistributedUsd6: snap.totals.redistributedUsd6.toString(),
      // The TRUE participant count, not the number of rows published - the board says "top 100 of
      // 3,482" off this, and the trimmed arrays could never tell it that.
      participants: snap.all.size,
    },
    rows: cut.all,
    d30: cut.d30,
    d7: cut.d7,
  };
}

/**
 * Every participant's rows, keyed by address, per window.
 *
 * This never goes to a browser. It is published beside the board so the site can answer "where do
 * I stand?" for someone outside the top rows: the API looks up that one address and returns that
 * one row. Sending the whole map instead would undo exactly what capping the board achieved.
 */
export interface LeaderboardSelfIndex {
  all: Record<string, LeaderRowOut>;
  d30: Record<string, LeaderRowOut>;
  d7: Record<string, LeaderRowOut>;
}

export function buildSelfIndex(snap: LeaderboardSnapshot, now: number): LeaderboardSelfIndex {
  const byAddr = (rows: LeaderRowOut[]) => Object.fromEntries(rows.map((r) => [r.address, r]));
  return {
    all: byAddr(rowsAll(snap)),
    d30: byAddr(rowsWindow(snap, 30, now)),
    d7: byAddr(rowsWindow(snap, 7, now)),
  };
}

// ── (De)serialization - Cache API stores JSON ───────────────────────────────────────────

interface AggJson {
  f: string; s: string; l: string; p: string; c: string; cb: string; cq: string; e: number; w: number;
}
interface SnapshotJson {
  version: 2;
  arena: string;
  baseDecimals: number;
  baseIsToken0: boolean;
  fromBlock: string;
  cursor: string;
  updatedAt: number;
  lastPrice18: string;
  lastTimeSec: number;
  epochPrice: Record<string, string>;
  epochTime: Record<string, number>;
  stakeOwner: Record<string, string>;
  npmOwner: Record<string, string>;
  all: Record<string, AggJson>;
  days: Record<string, Record<string, AggJson>>;
  totals: { epochsSettled: number; feeUsd6: string; swapUsd6: string; liqUsd6: string; redistributedUsd6: string };
}

const aggToJson = (a: AddrAgg): AggJson => ({
  f: a.feeUsd6.toString(),
  s: a.swapUsd6.toString(),
  l: a.liqUsd6.toString(),
  p: a.pnlUsd6.toString(),
  c: a.claimedUsd6.toString(),
  cb: a.claimedBase.toString(),
  cq: a.claimedQuote.toString(),
  e: a.entered,
  w: a.won,
});
const aggFromJson = (j: AggJson): AddrAgg => ({
  feeUsd6: BigInt(j.f),
  swapUsd6: BigInt(j.s),
  liqUsd6: BigInt(j.l),
  pnlUsd6: BigInt(j.p),
  claimedUsd6: BigInt(j.c),
  claimedBase: BigInt(j.cb),
  claimedQuote: BigInt(j.cq),
  entered: j.e,
  won: j.w,
});

export function snapshotToJson(snap: LeaderboardSnapshot): string {
  const days: SnapshotJson['days'] = {};
  for (const [day, bucket] of snap.days) {
    const b: Record<string, AggJson> = {};
    for (const [addr, a] of bucket) b[addr] = aggToJson(a);
    days[String(day)] = b;
  }
  const out: SnapshotJson = {
    version: 2,
    arena: snap.arena,
    baseDecimals: snap.baseDecimals,
    baseIsToken0: snap.baseIsToken0,
    fromBlock: snap.fromBlock.toString(),
    cursor: snap.cursor.toString(),
    updatedAt: snap.updatedAt,
    lastPrice18: snap.lastPrice18.toString(),
    lastTimeSec: snap.lastTimeSec,
    epochPrice: Object.fromEntries([...snap.epochPrice].map(([k, v]) => [k, v.toString()])),
    epochTime: Object.fromEntries(snap.epochTime),
    stakeOwner: Object.fromEntries(snap.stakeOwner),
    npmOwner: Object.fromEntries(snap.npmOwner),
    all: Object.fromEntries([...snap.all].map(([k, v]) => [k, aggToJson(v)])),
    days,
    totals: {
      epochsSettled: snap.totals.epochsSettled,
      feeUsd6: snap.totals.feeUsd6.toString(),
      swapUsd6: snap.totals.swapUsd6.toString(),
      liqUsd6: snap.totals.liqUsd6.toString(),
      redistributedUsd6: snap.totals.redistributedUsd6.toString(),
    },
  };
  return JSON.stringify(out);
}

export function snapshotFromJson(raw: string): LeaderboardSnapshot | null {
  try {
    const j = JSON.parse(raw) as SnapshotJson;
    if (j.version !== 2) return null; // older formats re-index from scratch
    const snap = emptySnapshot(j.arena, BigInt(j.fromBlock), j.baseDecimals, j.baseIsToken0);
    snap.cursor = BigInt(j.cursor);
    snap.updatedAt = j.updatedAt;
    snap.lastPrice18 = BigInt(j.lastPrice18);
    snap.lastTimeSec = j.lastTimeSec;
    snap.epochPrice = new Map(Object.entries(j.epochPrice).map(([k, v]) => [k, BigInt(v)]));
    snap.epochTime = new Map(Object.entries(j.epochTime));
    snap.stakeOwner = new Map(Object.entries(j.stakeOwner));
    snap.npmOwner = new Map(Object.entries(j.npmOwner));
    snap.all = new Map(Object.entries(j.all).map(([k, v]) => [k, aggFromJson(v)]));
    for (const [day, bucket] of Object.entries(j.days)) {
      snap.days.set(Number(day), new Map(Object.entries(bucket).map(([k, v]) => [k, aggFromJson(v)])));
    }
    snap.totals = {
      epochsSettled: j.totals.epochsSettled,
      feeUsd6: BigInt(j.totals.feeUsd6),
      swapUsd6: BigInt(j.totals.swapUsd6),
      liqUsd6: BigInt(j.totals.liqUsd6),
      redistributedUsd6: BigInt(j.totals.redistributedUsd6),
    };
    return snap;
  } catch {
    return null;
  }
}
