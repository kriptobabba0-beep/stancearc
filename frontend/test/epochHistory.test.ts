import { describe, it, expect, vi } from 'vitest';

// The hook module transitively imports lib/wagmi + lib/contracts (which touch ENV — a throwing
// Proxy in tests). Stub them so importing the PURE aggregation fns doesn't touch ENV.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/chain', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
}));
vi.mock('@/lib/contracts', () => ({
  feeArena: { address: '0x0000000000000000000000000000000000000000', abi: [] },
  MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11',
}));

import { buildEpochRows, buildEpochRowsV3, type DecodedLog } from '@/hooks/useEpochHistory';
import { Side } from '@/lib/types';

const started = (epochId: bigint, startPrice18: bigint): DecodedLog => ({
  args: { epochId, startPrice18, startTimeActual: 0n },
});
const settled = (
  epochId: bigint,
  winningSide: number,
  potWETH: bigint,
  potUSDC: bigint,
): DecodedLog => ({ args: { epochId, winningSide, winnerDenominator: 1n, potWETH, potUSDC } });
const resolved = (
  epochId: bigint,
  settlePrice18: bigint,
  winningSide: number,
  deltaBps: bigint,
): DecodedLog => ({ args: { epochId, settlePrice18, winningSide, deltaBps, settleTimeActual: 0n } });
const rollover = (epochId: bigint, winningSide: number, potWETH: bigint, potUSDC: bigint): DecodedLog => ({
  args: { epochId, winningSide, potWETH, potUSDC },
});

describe('buildEpochRows', () => {
  it('joins start + settle + resolved into one row per epoch, newest first', () => {
    const rows = buildEpochRows(
      [started(1n, 2000_000000000000000000n), started(2n, 2100_000000000000000000n)],
      [settled(1n, Side.UP, 1_000000000000000000n, 5000_000000n), settled(2n, Side.DOWN, 0n, 1000_000000n)],
      [
        resolved(1n, 2100_000000000000000000n, Side.UP, 500n),
        resolved(2n, 2050_000000000000000000n, Side.DOWN, -238n),
      ],
      [],
    );

    expect(rows).toHaveLength(2);
    // newest epoch first
    expect(rows[0].epochId).toBe(2n);
    expect(rows[1].epochId).toBe(1n);

    const e1 = rows[1];
    expect(e1.startPrice18).toBe(2000_000000000000000000n);
    expect(e1.settlePrice18).toBe(2100_000000000000000000n);
    expect(e1.winningSide).toBe(Side.UP);
    expect(e1.deltaBps).toBe(500n);
    expect(e1.potBase).toBe(1_000000000000000000n);
    expect(e1.potUSDC).toBe(5000_000000n);
    expect(e1.rolledOver).toBe(false);
  });

  it('flags a rolled-over epoch and sets 0 winners', () => {
    const rows = buildEpochRows(
      [started(3n, 1900_000000000000000000n)],
      [],
      [resolved(3n, 1899_000000000000000000n, Side.RANGE, -5n)],
      [rollover(3n, Side.RANGE, 0n, 0n)],
    );

    expect(rows).toHaveLength(1);
    const e3 = rows[0];
    expect(e3.epochId).toBe(3n);
    expect(e3.rolledOver).toBe(true);
    expect(e3.winnerCount).toBe(0);
    expect(e3.winningSide).toBe(Side.RANGE);
  });

  it('returns an empty array when there are no logs', () => {
    expect(buildEpochRows([], [], [], [])).toEqual([]);
  });

  it('still produces a row from a start log alone (settle pending)', () => {
    const rows = buildEpochRows([started(9n, 1000_000000000000000000n)], [], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].startPrice18).toBe(1000_000000000000000000n);
    expect(rows[0].settlePrice18).toBeUndefined();
    expect(rows[0].rolledOver).toBe(false);
  });

  it('leaves winnerCount undefined for settled rows (backfill happens in queryFn, not buildEpochRows)', () => {
    // buildEpochRows is pure and does NOT read from chain — winnerCount stays undefined for
    // settled non-rollover rows so the queryFn can detect and backfill them.
    const rows = buildEpochRows(
      [started(5n, 2000_000000000000000000n)],
      [settled(5n, Side.UP, 1_000000000000000000n, 3000_000000n)],
      [resolved(5n, 2050_000000000000000000n, Side.UP, 250n)],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rolledOver).toBe(false);
    expect(rows[0].winnerCount).toBeUndefined(); // not yet backfilled
  });
});

// ── winnerCount backfill (integration of the queryFn logic) ──────────────────
// We test the backfill logic directly by simulating what the queryFn does:
// call batchReads for settled rows and populate row.winnerCount.
describe('winnerCount backfill logic', () => {
  it('populates winnerCount from a mocked multicall result for a settled non-rollover row', async () => {
    // Build a settled row (winnerCount is undefined after buildEpochRows).
    const rows = buildEpochRows(
      [started(7n, 1800_000000000000000000n)],
      [settled(7n, Side.DOWN, 0n, 2000_000000n)],
      [resolved(7n, 1780_000000000000000000n, Side.DOWN, -111n)],
      [],
    );
    expect(rows[0].winnerCount).toBeUndefined();

    // Simulate the backfill: find settled non-rollover rows, mock a multicall result.
    const settledRows = rows.filter((r) => !r.rolledOver && r.winnerCount === undefined);
    // Mock multicall result: winnerCount(7) returns 42.
    const mockResults = settledRows.map(() => ({ status: 'success' as const, result: 42n }));
    for (let i = 0; i < settledRows.length; i++) {
      const res = mockResults[i];
      if (res.status === 'success') {
        settledRows[i].winnerCount = Number(res.result);
      }
    }

    expect(rows[0].winnerCount).toBe(42);
  });

  it('leaves winnerCount undefined when multicall returns a failure for that slot', async () => {
    const rows = buildEpochRows(
      [started(8n, 1700_000000000000000000n)],
      [settled(8n, Side.UP, 0n, 1000_000000n)],
      [resolved(8n, 1720_000000000000000000n, Side.UP, 118n)],
      [],
    );
    const settledRows = rows.filter((r) => !r.rolledOver && r.winnerCount === undefined);
    // Simulate a reverted read.
    const mockResults = settledRows.map(() => ({
      status: 'failure' as const,
      error: new Error('revert'),
    }));
    for (let i = 0; i < settledRows.length; i++) {
      const res = mockResults[i] as { status: string; result?: bigint };
      if (res.status === 'success' && res.result !== undefined) {
        settledRows[i].winnerCount = Number(res.result);
      }
      // on failure: leave winnerCount as undefined (column will show '—')
    }
    expect(rows[0].winnerCount).toBeUndefined();
  });

  it('does not try to backfill rolled-over rows (already winnerCount=0)', () => {
    const rows = buildEpochRows(
      [started(6n, 1500_000000000000000000n)],
      [],
      [],
      [rollover(6n, Side.NONE, 0n, 0n)],
    );
    expect(rows[0].rolledOver).toBe(true);
    expect(rows[0].winnerCount).toBe(0);
    // Verify the filter used in the queryFn correctly excludes this row.
    const toBackfill = rows.filter((r) => !r.rolledOver && r.winnerCount === undefined);
    expect(toBackfill).toHaveLength(0);
  });
});

// ── v3 (ENTRY-ANCHORED) rows: settlement price + correct-position count, no global winner ──
const settledV3 = (epochId: bigint, finalPrice18: bigint, winnerCount: number, potBase: bigint, potUSDC: bigint): DecodedLog => ({
  args: { epochId, finalPrice18, winnerCount, potBase, potUSDC },
});
const rolloverV3 = (epochId: bigint, potBase: bigint, potUSDC: bigint): DecodedLog => ({
  args: { epochId, potBase, potUSDC },
});

describe('buildEpochRowsV3', () => {
  it('builds a settled row from the v3 EpochSettled event (settlement price + winnerCount, no global side)', () => {
    const rows = buildEpochRowsV3([settledV3(3n, 63_720_000000000000000000n, 2, 0n, 60_000000n)], []);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.epochId).toBe(3n);
    expect(r.settlePrice18).toBe(63_720_000000000000000000n);
    expect(r.winnerCount).toBe(2);
    expect(r.potUSDC).toBe(60_000000n);
    expect(r.winningSide).toBe(Side.NONE); // per-position: no global winner
    expect(r.perPosition).toBe(true);
    expect(r.startPrice18).toBe(0n); // no global start price in v3
    expect(r.rolledOver).toBe(false);
  });

  it('marks an empty-winner v3 epoch rolled over with winnerCount 0 + carries the pot', () => {
    const rows = buildEpochRowsV3(
      [settledV3(4n, 64_000_000000000000000000n, 0, 0n, 0n)],
      [rolloverV3(4n, 0n, 80_000000n)],
    );
    const r = rows[0];
    expect(r.rolledOver).toBe(true);
    expect(r.winnerCount).toBe(0);
    expect(r.potUSDC).toBe(80_000000n); // rollover pot backfilled when settle pot was empty
    expect(r.perPosition).toBe(true);
  });

  it('sorts newest epoch first', () => {
    const rows = buildEpochRowsV3(
      [settledV3(1n, 1n, 0, 0n, 0n), settledV3(5n, 1n, 1, 0n, 0n), settledV3(3n, 1n, 0, 0n, 0n)],
      [],
    );
    expect(rows.map((r) => r.epochId)).toEqual([5n, 3n, 1n]);
  });

  it('empty inputs -> empty rows', () => {
    expect(buildEpochRowsV3([], [])).toEqual([]);
  });
});
