// leaderboardIndex.test.ts — the pure incremental engine behind /api/leaderboard (v2):
// composite VOLUME = swaps + liquidity added + fees staked; PnL = claimed − contributed
// (base legs at the epoch's settlement price); pool/NPM joins; day buckets; JSON round-trip.
import { describe, it, expect } from 'vitest';
import {
  emptySnapshot,
  applyLogs,
  rowsAll,
  rowsWindow,
  payoutUsd6,
  sqrtPriceToPrice18,
  snapshotToJson,
  snapshotFromJson,
  type IndexLog,
  RETAIN_DAYS,
  topRows,
  buildLeaderboardPayload,
  buildSelfIndex,
  type LeaderRowOut,
  buildCampaignPayload,
  prizeForVolume,
  hasStanceActivity,
} from '@/lib/leaderboardIndex';

const ARENA = '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2';
const ALICE = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BOB = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ZERO = '0x0000000000000000000000000000000000000000';

const DAY = 86_400;
const NOW_MS = 130 * DAY * 1000; // "today" = day 130

let seq = 0;
function log(
  eventName: string,
  args: Record<string, unknown>,
  source: IndexLog['source'] = 'arena',
  block = 10n,
): IndexLog {
  return { source, eventName, blockNumber: block, logIndex: seq++, args };
}

function epochCreated(epochId: bigint, settlementDay: number): IndexLog {
  return log('EpochCreated', {
    epochId,
    entryOpenTime: BigInt(settlementDay * DAY - 300),
    settlementTime: BigInt(settlementDay * DAY),
  });
}
const staked = (epochId: bigint, owner: string, tokenId: bigint) =>
  log('Staked', { epochId, owner, tokenId });
const processed = (epochId: bigint, tokenId: bigint, won: boolean, contributionUsd6: bigint) =>
  log('PositionProcessed', { epochId, tokenId, won, contributionUsd6 });
const settledE = (epochId: bigint, finalPrice18: bigint) =>
  log('EpochSettled', { epochId, finalPrice18, winnerCount: 1 });
const claimed = (epochId: bigint, owner: string, tokenId: bigint, payBase: bigint, payUSDC: bigint) =>
  log('Claimed', { epochId, owner, tokenId, payBase, payUSDC });

// base = token0 (8dp), quote = token1 (6dp) in these fixtures.
const swap = (recipient: string, amount0: bigint, amount1: bigint, sqrtPriceX96: bigint, block = 10n) =>
  log('Swap', { sender: ZERO, recipient, amount0, amount1, sqrtPriceX96, liquidity: 1n, tick: 0 }, 'pool', block);
const poolMint = (liquidity: bigint, amount0: bigint, amount1: bigint, block = 10n) =>
  log('Mint', { sender: ZERO, owner: ZERO, tickLower: 0, tickUpper: 0, amount: liquidity, amount0, amount1 }, 'pool', block);
const npmTransfer = (tokenId: bigint, to: string, block = 10n) =>
  log('Transfer', { from: ZERO, to, tokenId }, 'npm', block);
const npmIncrease = (tokenId: bigint, liquidity: bigint, amount0: bigint, amount1: bigint, block = 10n) =>
  log('IncreaseLiquidity', { tokenId, liquidity, amount0, amount1 }, 'npm', block);

function snap() {
  return emptySnapshot(ARENA, 100n, 8, true); // cirBTC (8dp) = token0
}

const META = { id: 'btc', arena: ARENA, baseSymbol: 'cirBTC', quoteSymbol: 'USDC' };

describe('payoutUsd6 / sqrtPriceToPrice18', () => {
  it('values the base leg at the given price', () => {
    // 0.5 base (8dp) at price 2e18 → 1.0 quote (6dp) + 3 USDC quote leg
    expect(payoutUsd6(50_000_000n, 3_000_000n, 2n * 10n ** 18n, 8)).toBe(4_000_000n);
  });

  it('derives a quote-per-base price from sqrtPriceX96 in both orientations', () => {
    // sqrtP = 2^96 → raw ratio 1; the 8dp→6dp gap scales BOTH orientations to 1e20.
    expect(sqrtPriceToPrice18(2n ** 96n, 8, true)).toBe(10n ** 20n);
    expect(sqrtPriceToPrice18(2n ** 96n, 8, false)).toBe(10n ** 20n);
    // sqrtP = 2^97 → raw ratio 4: base-as-token0 rises with it, base-as-token1 inverts.
    expect(sqrtPriceToPrice18(2n ** 97n, 8, true)).toBe(4n * 10n ** 20n);
    expect(sqrtPriceToPrice18(2n ** 97n, 8, false)).toBe(25n * 10n ** 18n);
    expect(sqrtPriceToPrice18(0n, 8, true)).toBe(0n);
  });
});

describe('arena accounting (fees + PnL)', () => {
  it('fees staked feed volume; loser PnL = −contribution; winner PnL = claim − contribution', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(1n, 100),
        staked(1n, ALICE, 11n),
        staked(1n, BOB, 22n),
        processed(1n, 11n, true, 5_000_000n),
        processed(1n, 22n, false, 2_000_000n),
        settledE(1n, 2n * 10n ** 18n),
        claimed(1n, ALICE, 11n, 50_000_000n, 3_000_000n), // 1.0 (base@2) + 3.0 = $4
      ],
      50n,
      NOW_MS,
    );
    const alice = rowsAll(s).find((r) => r.address === ALICE)!;
    const bob = rowsAll(s).find((r) => r.address === BOB)!;

    expect(alice.feeUsd6).toBe('5000000');
    expect(alice.volumeUsd6).toBe('5000000'); // no swaps/liquidity in this fixture
    expect(alice.entered).toBe(1);
    expect(alice.won).toBe(1);
    expect(alice.pnlUsd6).toBe('-1000000');
    expect(alice.claimedUsd6).toBe('4000000');
    expect(alice.claimedBase).toBe('50000000');
    expect(alice.claimedQuote).toBe('3000000');

    expect(bob.pnlUsd6).toBe('-2000000');
    expect(bob.won).toBe(0);

    expect(s.totals.feeUsd6).toBe(7_000_000n);
    expect(s.totals.redistributedUsd6).toBe(4_000_000n);
    expect(s.totals.epochsSettled).toBe(1);
    expect(s.cursor).toBe(51n);
  });

  it('a claim without a known epoch price counts only the quote leg (never invents a price)', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(2n, 101),
        staked(2n, ALICE, 5n),
        processed(2n, 5n, true, 1_000_000n),
        claimed(2n, ALICE, 5n, 10_000_000n, 2_500_000n), // EpochSettled log missed
      ],
      60n,
      NOW_MS,
    );
    expect(rowsAll(s).find((r) => r.address === ALICE)!.claimedUsd6).toBe('2500000');
  });

  it('skips processed positions whose stake predates the scan, and consumes join entries', () => {
    const s = snap();
    applyLogs(
      s,
      [epochCreated(3n, 102), processed(3n, 99n, true, 9_000_000n), staked(3n, BOB, 7n), processed(3n, 7n, false, 1n)],
      70n,
      NOW_MS,
    );
    expect(rowsAll(s).find((r) => r.address === BOB)).toBeTruthy();
    expect(rowsAll(s)).toHaveLength(1); // the orphan tokenId 99 attributed to nobody
    expect(s.stakeOwner.size).toBe(0);
  });
});

describe('pool volume (swaps + liquidity)', () => {
  it('credits swap notional (quote side) to the recipient and tracks the price', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(1n, 128), // seeds the chain clock → day buckets work
        swap(ALICE, -50_000_000n, 10_000_000n, 2n ** 96n), // |quote|=+$10, price → 1e20
      ],
      80n,
      NOW_MS,
    );
    const alice = rowsAll(s).find((r) => r.address === ALICE)!;
    expect(alice.swapUsd6).toBe('10000000');
    expect(alice.volumeUsd6).toBe('10000000');
    expect(s.lastPrice18).toBe(10n ** 20n);
    expect(s.totals.swapUsd6).toBe(10_000_000n);
    // …and it landed in today's bucket (settled day 128, inside the 7D window)
    expect(rowsWindow(s, 7, NOW_MS).find((r) => r.address === ALICE)!.swapUsd6).toBe('10000000');
  });

  it('values a liquidity add (pool Mint + NPM twin) with both legs at the running price', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(1n, 128),
        settledE(1n, 2n * 10n ** 18n), // lastPrice = 2e18
        npmTransfer(77n, ALICE),
        poolMint(123n, 50_000_000n, 3_000_000n), // 0.5 base + $3 quote
        npmIncrease(77n, 123n, 50_000_000n, 3_000_000n),
      ],
      90n,
      NOW_MS,
    );
    const alice = rowsAll(s).find((r) => r.address === ALICE)!;
    expect(alice.liqUsd6).toBe('4000000'); // 0.5×$2 + $3
    expect(alice.volumeUsd6).toBe('4000000');
    expect(s.totals.liqUsd6).toBe(4_000_000n);
  });

  it('ignores IncreaseLiquidity from OTHER pools (no matching pool Mint in the batch)', () => {
    const s = snap();
    applyLogs(
      s,
      [epochCreated(1n, 128), settledE(1n, 10n ** 18n), npmTransfer(9n, BOB), npmIncrease(9n, 55n, 1_000n, 1_000n)],
      95n,
      NOW_MS,
    );
    expect(rowsAll(s).find((r) => r.address === BOB)).toBeUndefined();
    expect(s.totals.liqUsd6).toBe(0n);
  });

  it('follows NPM ownership transfers (new owner gets later adds)', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(1n, 128),
        settledE(1n, 10n ** 18n),
        npmTransfer(5n, ALICE),
        log('Transfer', { from: ALICE, to: BOB, tokenId: 5n }, 'npm'),
        poolMint(70n, 0n, 9_000_000n),
        npmIncrease(5n, 70n, 0n, 9_000_000n),
      ],
      99n,
      NOW_MS,
    );
    expect(rowsAll(s).find((r) => r.address === BOB)!.liqUsd6).toBe('9000000');
    expect(rowsAll(s).find((r) => r.address === ALICE)).toBeUndefined();
  });
});

describe('day windows', () => {
  it('7D window excludes older epochs that the 30D window still includes', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(1n, 105), // 25 days ago
        epochCreated(2n, 128), // 2 days ago
        staked(1n, ALICE, 1n),
        processed(1n, 1n, false, 3_000_000n),
        staked(2n, ALICE, 2n),
        processed(2n, 2n, false, 1_000_000n),
      ],
      90n,
      NOW_MS,
    );
    expect(rowsWindow(s, 30, NOW_MS).find((r) => r.address === ALICE)!.volumeUsd6).toBe('4000000');
    expect(rowsWindow(s, 7, NOW_MS).find((r) => r.address === ALICE)!.volumeUsd6).toBe('1000000');
  });

  it('a late claim lands in the day its epoch SETTLED, not the day it was collected', () => {
    const s = snap();
    applyLogs(
      s,
      [epochCreated(1n, 128), staked(1n, ALICE, 1n), processed(1n, 1n, true, 1_000_000n), settledE(1n, 10n ** 18n)],
      95n,
      NOW_MS,
    );
    applyLogs(s, [claimed(1n, ALICE, 1n, 0n, 5_000_000n)], 120n, NOW_MS);
    const d7 = rowsWindow(s, 7, NOW_MS).find((r) => r.address === ALICE)!;
    expect(d7.claimedUsd6).toBe('5000000');
    expect(d7.pnlUsd6).toBe('4000000');
  });

  it('prunes buckets older than the retention horizon', () => {
    const s = snap();
    applyLogs(
      s,
      [epochCreated(1n, 10), staked(1n, ALICE, 1n), processed(1n, 1n, false, 1_000_000n)],
      99n,
      NOW_MS,
    );
    expect(s.days.size).toBe(0);
    expect(rowsAll(s).find((r) => r.address === ALICE)!.feeUsd6).toBe('1000000');
  });
});

describe('serialization', () => {
  it('JSON round-trips the whole snapshot including pool state', () => {
    const s = snap();
    applyLogs(
      s,
      [
        epochCreated(1n, 128),
        staked(1n, ALICE, 1n),
        processed(1n, 1n, true, 5_000_000n),
        settledE(1n, 3n * 10n ** 18n),
        claimed(1n, ALICE, 1n, 1_000_000n, 500_000n),
        swap(BOB, -1n, 2_000_000n, 2n ** 96n),
        npmTransfer(4n, BOB),
      ],
      123n,
      NOW_MS,
    );
    const revived = snapshotFromJson(snapshotToJson(s))!;
    expect(revived).not.toBeNull();
    expect(revived.cursor).toBe(124n);
    expect(revived.lastPrice18).toBe(10n ** 20n);
    expect(revived.npmOwner.get('4')).toBe(BOB);
    expect(rowsAll(revived)).toEqual(rowsAll(s));
    expect(rowsWindow(revived, 7, NOW_MS)).toEqual(rowsWindow(s, 7, NOW_MS));
  });

  it('rejects malformed and old-version payloads', () => {
    expect(snapshotFromJson('{"version":1}')).toBeNull();
    expect(snapshotFromJson('not json')).toBeNull();
  });
});

// The snapshot has to survive years of uptime, and epochs open every couple of minutes, so any
// map keyed by epochId is the growth risk. These lock the bounds AND the thing that makes them
// safe: the cutoff travels with the chain, so a backfill of old blocks still values its claims.
describe('growth bounds', () => {
  it('forgets epoch metadata once the chain clock passes the retention window', () => {
    const s = snap();
    applyLogs(s, [epochCreated(1n, 100), settledE(1n, 3n * 10n ** 18n)], 10n, NOW_MS);
    expect(s.epochPrice.has('1')).toBe(true);

    // Day 100 + RETAIN_DAYS is still inside the window; day 100 + RETAIN_DAYS + 10 is not.
    applyLogs(s, [epochCreated(2n, 100 + RETAIN_DAYS)], 11n, NOW_MS);
    expect(s.epochPrice.has('1')).toBe(true);

    applyLogs(s, [epochCreated(3n, 100 + RETAIN_DAYS + 10)], 12n, NOW_MS);
    expect(s.epochPrice.has('1')).toBe(false);
    expect(s.epochTime.has('1')).toBe(false);
    expect(s.epochPrice.has('3') || s.epochTime.has('3')).toBe(true);
  });

  // The regression that a wall-clock cutoff would cause: replaying months-old blocks would drop
  // each epoch in the batch that created it, and every claim behind it would silently value its
  // base leg at 0. Here the whole batch is far older than RETAIN_DAYS in wall-clock terms.
  it('still values a claim when backfilling blocks far older than the window', () => {
    const s = snap();
    const ancientDay = 10; // ~120 days before NOW_MS — outside any wall-clock window
    // Two batches on purpose: pruning runs at the END of a batch, so a settle and a claim folded
    // together would keep their price no matter which clock is used. The claim only survives a
    // wall-clock cutoff if the price outlives the batch that recorded it.
    applyLogs(
      s,
      [
        epochCreated(7n, ancientDay),
        staked(7n, ALICE, 1n),
        processed(7n, 1n, true, 1_000_000n),
        settledE(7n, 2n * 10n ** 18n),
      ],
      20n,
      NOW_MS,
    );
    applyLogs(
      s,
      [claimed(7n, ALICE, 1n, 50_000_000n, 0n)], // 0.5 base @ 2.0 => 1_000_000 quote
      21n,
      NOW_MS,
    );
    const alice = rowsAll(s).find((r) => r.address === ALICE)!;
    expect(alice.claimedUsd6).toBe('1000000');
    expect(alice.pnlUsd6).toBe('0'); // 1_000_000 claimed − 1_000_000 contributed
  });

  it('caps the stake-owner map so an unprocessed stake cannot leak forever', () => {
    const s = snap();
    const many: IndexLog[] = [];
    for (let i = 0; i < 10_050; i++) many.push(staked(BigInt(i), ALICE, BigInt(i)));
    applyLogs(s, many, 30n, NOW_MS);
    expect(s.stakeOwner.size).toBeLessThanOrEqual(10_000);
    // Eviction is oldest-first, so the most recent stakes are the ones still attributable.
    expect(s.stakeOwner.has('10049:10049')).toBe(true);
    expect(s.stakeOwner.has('0:0')).toBe(false);
  });
});

// The payload used to carry every participant, so its size grew with the arena's population:
// ~23 KB at 44 wallets, half a megabyte at a thousand, past KV's 25 MB ceiling around fifty
// thousand — shipped to every visitor, every poll, to render fifteen rows.
describe('board capping', () => {
  const row = (addr: string, volume: bigint, pnl: bigint): LeaderRowOut => ({
    address: addr, volumeUsd6: volume.toString(), swapUsd6: '0', liqUsd6: '0', feeUsd6: '0',
    pnlUsd6: pnl.toString(), claimedUsd6: '0', claimedBase: '0', claimedQuote: '0', entered: 0, won: 0,
  });
  const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

  it('keeps the leaders of BOTH metrics, not just one', () => {
    // Ascending volume, descending PnL: the volume leader is last and the PnL leader is first, so
    // trimming on a single metric would erase whoever tops the other one.
    const rows = Array.from({ length: 50 }, (_, i) => row(addr(i), BigInt(i), BigInt(50 - i)));
    const kept = new Set(topRows(rows, 5).map((r) => r.address));
    expect(kept.has(addr(49))).toBe(true); // top by volume
    expect(kept.has(addr(0))).toBe(true); // top by PnL
    expect(kept.size).toBeLessThanOrEqual(10); // at most `limit` from each metric
  });

  it('returns everything untouched when the board is smaller than the cap', () => {
    const rows = [row(addr(1), 5n, 5n), row(addr(2), 3n, 3n)];
    expect(topRows(rows, 100)).toBe(rows);
  });

  it('caps every window and reports the TRUE participant count', () => {
    const s = snap();
    // 30 wallets, each with a swap, so all-time rows exist for every one of them.
    const logs: IndexLog[] = [epochCreated(1n, 128)];
    for (let i = 1; i <= 30; i++) {
      logs.push(swap(addr(i), -BigInt(i), BigInt(i) * 1_000_000n, 2n ** 96n));
    }
    applyLogs(s, logs, 200n, NOW_MS);

    const p = buildLeaderboardPayload(s, META, 300n, NOW_MS, null, 10);
    expect(p.rows.length).toBeLessThanOrEqual(20); // ≤ limit per metric, unioned
    expect(p.rows.length).toBeLessThan(30);
    expect(p.truncated).toBe(true);
    // The board is capped; the headline count must still be the real one.
    expect(p.totals.participants).toBe(30);
    expect(p.maxRows).toBe(10);
  });

  it('does not claim truncation when nothing was trimmed', () => {
    const s = snap();
    applyLogs(s, [epochCreated(1n, 128), swap(addr(1), -1n, 2_000_000n, 2n ** 96n)], 200n, NOW_MS);
    expect(buildLeaderboardPayload(s, META, 300n, NOW_MS, null, 100).truncated).toBe(false);
  });

  it('indexes every participant for self-lookup, including those cut from the board', () => {
    const s = snap();
    const logs: IndexLog[] = [epochCreated(1n, 128)];
    for (let i = 1; i <= 30; i++) {
      logs.push(swap(addr(i), -BigInt(i), BigInt(i) * 1_000_000n, 2n ** 96n));
    }
    applyLogs(s, logs, 200n, NOW_MS);

    const p = buildLeaderboardPayload(s, META, 300n, NOW_MS, null, 5);
    const idx = buildSelfIndex(s, NOW_MS);
    const onBoard = new Set(p.rows.map((r) => r.address));
    const cut = [...Array(30).keys()].map((i) => addr(i + 1)).filter((a) => !onBoard.has(a));

    expect(cut.length).toBeGreaterThan(0);
    // The whole point: someone off the board can still be told where they stand.
    for (const a of cut) expect(idx.all[a], `${a} missing from the self index`).toBeTruthy();
    expect(Object.keys(idx.all)).toHaveLength(30);
  });
});

// Liquidity provided is NETTED. Before this, only IncreaseLiquidity was read, so the metric was
// "every deposit ever made" — add 1000, withdraw it, add it again and the board showed 2000 off
// 1000 of capital. With prizes attached to the number that is not defensible.
describe('net liquidity', () => {
  const addLiq = (tokenId: bigint, L: bigint, a0: bigint, a1: bigint, block = 10n) => [
    poolMint(L, a0, a1, block),
    npmIncrease(tokenId, L, a0, a1, block),
  ];
  const removeLiq = (tokenId: bigint, L: bigint, a0: bigint, a1: bigint, block = 10n) =>
    log('DecreaseLiquidity', { tokenId, liquidity: L, amount0: a0, amount1: a1 }, 'npm', block);

  const seeded = () => {
    const s = snap();
    // A settled epoch gives the engine a price to value the base leg with.
    applyLogs(s, [epochCreated(1n, 128), settledE(1n, 2n * 10n ** 18n), npmTransfer(9n, ALICE)], 20n, NOW_MS);
    return s;
  };
  const liqOf = (s: ReturnType<typeof snap>) =>
    rowsAll(s).find((r) => r.address === ALICE)?.liqUsd6 ?? '0';

  it('returns to where it started after add, withdraw, add', () => {
    const s = seeded();
    applyLogs(s, addLiq(9n, 1_000n, 50_000_000n, 3_000_000n), 30n, NOW_MS);
    const afterFirstAdd = liqOf(s);
    expect(afterFirstAdd).not.toBe('0');

    applyLogs(s, [removeLiq(9n, 1_000n, 50_000_000n, 3_000_000n)], 40n, NOW_MS);
    expect(liqOf(s)).toBe('0');

    applyLogs(s, addLiq(9n, 1_000n, 50_000_000n, 3_000_000n, 50n), 50n, NOW_MS);
    // The whole point: cycling does not accumulate.
    expect(liqOf(s)).toBe(afterFirstAdd);
  });

  // The reason each unit is pinned to the rate it was credited at: a V3 position's contents move
  // with the price, so valuing the withdrawal at the price of the day could subtract more than the
  // deposit ever added and push a wallet negative for doing nothing.
  it('cancels exactly even when the price moved in between', () => {
    const s = seeded();
    applyLogs(s, addLiq(9n, 1_000n, 50_000_000n, 3_000_000n), 30n, NOW_MS);
    // Price triples before the withdrawal.
    applyLogs(s, [settledE(2n, 6n * 10n ** 18n)], 35n, NOW_MS);
    applyLogs(s, [removeLiq(9n, 1_000n, 50_000_000n, 3_000_000n)], 40n, NOW_MS);
    expect(liqOf(s)).toBe('0');
  });

  it('floors at zero when a position added before the scan is withdrawn', () => {
    const s = seeded();
    // No add was ever credited for tokenId 77, so there is nothing to undo.
    applyLogs(s, [npmTransfer(77n, ALICE), removeLiq(77n, 5_000n, 1n, 1n)], 30n, NOW_MS);
    expect(liqOf(s)).toBe('0');
    expect(s.totals.liqUsd6).toBe(0n);
  });

  it('halves the total when half the liquidity is withdrawn', () => {
    const s = seeded();
    applyLogs(s, addLiq(9n, 1_000n, 50_000_000n, 3_000_000n), 30n, NOW_MS);
    const full = BigInt(liqOf(s));
    applyLogs(s, [removeLiq(9n, 500n, 25_000_000n, 1_500_000n)], 40n, NOW_MS);
    expect(BigInt(liqOf(s))).toBe(full - full / 2n);
  });
});

// Campaign standings decide who gets paid, so the parts that could quietly favour someone are the
// parts under test: who is counted, how ties break, and which volume picks the prize tier.
describe('campaign standings', () => {
  const BOT = '0xbbbb000000000000000000000000000000000bot'.slice(0, 42);
  const TIERS = [
    { minVolumeUsd6: 0n, prizeUsd: 300 },
    { minVolumeUsd6: 250_000_000_000n, prizeUsd: 400 },
    { minVolumeUsd6: 500_000_000_000n, prizeUsd: 500 },
  ];
  const cfg = (over: Partial<Parameters<typeof buildCampaignPayload>[1]> = {}) => ({
    id: 'aug', startBlock: 100n, endBlock: 0n,
    excluded: new Set<string>(), tiers: TIERS, topN: 5, ...over,
  });

  const withSwaps = (entries: Array<[string, bigint]>) => {
    const s = snap();
    const logs: IndexLog[] = [epochCreated(1n, 128)];
    for (const [addr, quote] of entries) logs.push(swap(addr, -1n, quote, 2n ** 96n));
    applyLogs(s, logs, 200n, NOW_MS);
    return s;
  };

  it('ranks by volume, and leaves the PnL board to Stance participants', () => {
    // Both wallets only swapped. They belong on the volume board and nowhere near a realized-PnL
    // one: listing them there at zero is what let swap-only wallets outrank an actual winner.
    const s = withSwaps([[ALICE, 5_000_000n], [BOB, 9_000_000n]]);
    const p = buildCampaignPayload(s, cfg(), NOW_MS);
    expect(p.volume.map((r) => r.address)).toEqual([BOB, ALICE]);
    expect(p.volume[0]!.rank).toBe(1);
    expect(p.pnl).toHaveLength(0);
  });

  it('keeps house wallets out of the standings AND out of the tier total', () => {
    const s = withSwaps([[ALICE, 5_000_000n], [BOT, 600_000_000_000n]]);
    const p = buildCampaignPayload(s, cfg({ excluded: new Set([BOT]) }), NOW_MS);
    expect(p.volume.map((r) => r.address)).toEqual([ALICE]);
    expect(p.totals.participants).toBe(1);
    // Without the exclusion the bot alone would have bought the top tier.
    expect(p.totals.volumeUsd6).toBe('5000000');
    expect(p.prize.prizeUsd).toBe(300);
  });

  it('picks the prize tier from campaign volume and names the next one', () => {
    expect(prizeForVolume(0n, TIERS)).toMatchObject({ prizeUsd: 300 });
    expect(prizeForVolume(250_000_000_000n, TIERS)).toMatchObject({ prizeUsd: 400 });
    expect(prizeForVolume(900_000_000_000n, TIERS)).toMatchObject({ prizeUsd: 500, nextTierAtUsd6: null });
    expect(prizeForVolume(100_000_000_000n, TIERS).nextTierAtUsd6).toBe(250_000_000_000n);
  });

  it('breaks ties by address so equal scores never depend on insertion order', () => {
    const s = withSwaps([[BOB, 5_000_000n], [ALICE, 5_000_000n]]);
    expect(buildCampaignPayload(s, cfg(), NOW_MS).volume.map((r) => r.address)).toEqual([ALICE, BOB]);
  });

  it('stays live until the chain past the end block is actually folded in', () => {
    const s = withSwaps([[ALICE, 1n]]);
    expect(buildCampaignPayload(s, cfg({ endBlock: 500n }), NOW_MS).live).toBe(true);
    expect(buildCampaignPayload(s, cfg({ endBlock: 150n }), NOW_MS).live).toBe(false);
  });
});

// Found on a live campaign, not imagined: two wallets that had only ever swapped sat at ranks 2
// and 3 on the realized-PnL board, above the wallet that had won both epochs it entered. Early in
// a campaign everyone is still at zero, ties break on address, and a prize paid to "top 5 by PnL"
// would have gone to people who never took a Stance position at all.
describe('the PnL board lists Stance participants, not everyone', () => {
  const row = (address: string, over: Partial<Record<string, unknown>> = {}) => ({
    address, volumeUsd6: '1000', swapUsd6: '1000', liqUsd6: '0', feeUsd6: '0',
    pnlUsd6: '0', claimedUsd6: '0', claimedBase: '0', claimedQuote: '0', entered: 0, won: 0,
    ...over,
  }) as never;

  it('keeps a swap-only wallet off it', () => {
    expect(hasStanceActivity(row('0xa'))).toBe(false);
  });

  it('keeps everyone who entered an epoch, win or lose, including at zero', () => {
    // A loser at zero still belongs: they took the position, and their rank is the result.
    expect(hasStanceActivity(row('0xb', { entered: 2, won: 0 }))).toBe(true);
    expect(hasStanceActivity(row('0xc', { entered: 1, won: 1 }))).toBe(true);
  });

  it('keeps a wallet whose only record in this window is a claim', () => {
    // Entered in an earlier window, claimed in this one: the payout is realized here.
    expect(hasStanceActivity(row('0xd', { claimedUsd6: '5000000', pnlUsd6: '5000000' }))).toBe(true);
  });

  it('keeps a wallet carrying a loss with no entry recorded in-window', () => {
    expect(hasStanceActivity(row('0xe', { pnlUsd6: '-2000000' }))).toBe(true);
  });
});

// Ties are not an edge case on a prize board: early in a campaign every participant is at zero,
// and a settlement that pays nothing leaves them there. What breaks the tie is what decides the
// prize. Measured live: a wallet that had won both its epochs sat below two that had won none.
describe('campaign ties break on effort before address', () => {
  const TIERS = [{ minVolumeUsd6: 0n, prizeUsd: 300 }];
  const cfg = { id: 't', startBlock: 0n, endBlock: 0n, excluded: new Set<string>(), tiers: TIERS, topN: 10 };

  // ALICE sorts before BOB, so an address-only tiebreak puts ALICE first whatever they did.
  const twoEpochs = (winner: string, loser: string, contribution: bigint) => {
    const s = snap();
    applyLogs(s, [
      epochCreated(1n, 128),
      staked(1n, winner, 11n), staked(1n, loser, 22n),
      processed(1n, 11n, true, contribution), processed(1n, 22n, false, contribution),
      epochCreated(2n, 128),
      staked(2n, winner, 11n), staked(2n, loser, 22n),
      processed(2n, 11n, true, contribution), processed(2n, 22n, false, contribution),
    ], 200n, NOW_MS);
    return s;
  };

  it('puts the wallet that won more epochs first when the score is equal', () => {
    // Contribution 0 is the real case that exposed this: a settlement that paid nothing leaves
    // every participant on exactly zero.
    const p = buildCampaignPayload(twoEpochs(BOB, ALICE, 0n), cfg, NOW_MS);
    expect(p.pnl.map((r) => r.address)).toEqual([BOB, ALICE]);
    expect(p.pnl[0]!.won).toBe(2);
  });

  it('still ranks on the score itself when the scores differ', () => {
    // A real contribution makes the loser negative, so merit never overrides the number.
    const p = buildCampaignPayload(twoEpochs(BOB, ALICE, 3_000_000n), cfg, NOW_MS);
    expect(p.pnl.map((r) => r.address)).toEqual([BOB, ALICE]);
    expect(BigInt(p.pnl[1]!.pnlUsd6)).toBeLessThan(0n);
  });
});
