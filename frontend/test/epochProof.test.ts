import { describe, it, expect } from 'vitest';
import {
  deriveWinningSide,
  buildEpochProof,
  type ProofLog,
} from '@/lib/epochProof';
import { Side } from '@/lib/types';

// ── deriveWinningSide — the verifiable settlement rule (|Δbps| vs band) ──────────
describe('deriveWinningSide — |Δ| vs band reconstructs the winner', () => {
  it('Δ strictly beyond +band → UP', () => {
    expect(deriveWinningSide(50n, 20)).toBe(Side.UP);
  });
  it('Δ strictly beyond −band → DOWN', () => {
    expect(deriveWinningSide(-50n, 20)).toBe(Side.DOWN);
  });
  it('|Δ| within the band → RANGE', () => {
    expect(deriveWinningSide(10n, 20)).toBe(Side.RANGE);
    expect(deriveWinningSide(-10n, 20)).toBe(Side.RANGE);
  });
  it('|Δ| exactly equal to the band → RANGE (band is inclusive)', () => {
    expect(deriveWinningSide(20n, 20)).toBe(Side.RANGE);
    expect(deriveWinningSide(-20n, 20)).toBe(Side.RANGE);
  });
  it('a flat epoch (Δ=0) with a zero band → RANGE', () => {
    expect(deriveWinningSide(0n, 0)).toBe(Side.RANGE);
  });
  it('uses |band| so a malformed negative band still reads sanely', () => {
    expect(deriveWinningSide(50n, -20)).toBe(Side.UP);
  });
});

// ── buildEpochProof — reconstruct a settled epoch from on-chain events ──────────

const A = '0xAAaAaAAAaAaAAaaAAAAAAaAaAaAaAaAaAaAaAaAa' as const;
const B = '0xbBBbBBBBbBBbbBBbBBBbBbBbBBbBbbBbBbbBbBBb' as const;

const started = (epochId: bigint, startPrice18: bigint, startTimeActual: bigint): ProofLog => ({
  args: { epochId, startPrice18, startTimeActual },
});
const resolved = (
  epochId: bigint,
  settlePrice18: bigint,
  winningSide: number,
  deltaBps: bigint,
  settleTimeActual: bigint,
): ProofLog => ({ args: { epochId, settlePrice18, winningSide, deltaBps, settleTimeActual } });
const settled = (
  epochId: bigint,
  winningSide: number,
  winnerDenominator: bigint,
  potWETH: bigint,
  potUSDC: bigint,
): ProofLog => ({ args: { epochId, winningSide, winnerDenominator, potWETH, potUSDC } });
const staked = (
  epochId: bigint,
  owner: `0x${string}`,
  tokenId: bigint,
  side: number,
): ProofLog => ({ args: { epochId, owner, tokenId, side, stakedCount: 1 } });
const swept = (
  epochId: bigint,
  tokenId: bigint,
  feeWETH: bigint,
  feeUSDC: bigint,
  contribution6: bigint,
): ProofLog => ({ args: { epochId, tokenId, feeWETH, feeUSDC, contribution6 } });
const rollover = (
  epochId: bigint,
  winningSide: number,
  potWETH: bigint,
  potUSDC: bigint,
): ProofLog => ({ args: { epochId, winningSide, potWETH, potUSDC } });

describe('buildEpochProof — honest settlement reconstruction', () => {
  it('reconstructs a settled UP epoch with per-position split (§4.5 conservation)', () => {
    // Pot: 4 WETH + 6000 USDC. Two UP winners split 5/8 and 3/8 by contribution6.
    const potWETH = 4n * 10n ** 18n;
    const potUSDC = 6000n * 10n ** 6n;
    const denom = 8_000_000_000n; // sideContribution6[UP]

    const proof = buildEpochProof({
      epochId: 1n,
      bandBps: 20,
      started: [started(1n, 100_000n * 10n ** 18n, 1000n)],
      resolved: [resolved(1n, 101_000n * 10n ** 18n, Side.UP, 100n, 2000n)],
      settled: [settled(1n, Side.UP, denom, potWETH, potUSDC)],
      rollovers: [],
      staked: [staked(1n, A, 11n, Side.UP), staked(1n, B, 22n, Side.UP), staked(1n, A, 33n, Side.DOWN)],
      swept: [
        swept(1n, 11n, 0n, 0n, 5_000_000_000n), // A: 5/8 of the UP pool
        swept(1n, 22n, 0n, 0n, 3_000_000_000n), // B: 3/8 of the UP pool
        swept(1n, 33n, 0n, 0n, 2_000_000_000n), // A's DOWN position forfeits (loser)
      ],
    });

    expect(proof).not.toBeNull();
    const p = proof!;
    expect(p.epochId).toBe(1n);
    expect(p.settled).toBe(true);
    expect(p.rolledOver).toBe(false);
    expect(p.startPrice18).toBe(100_000n * 10n ** 18n);
    expect(p.settlePrice18).toBe(101_000n * 10n ** 18n);
    expect(p.deltaBps).toBe(100n);
    expect(p.winningSide).toBe(Side.UP);
    // The reconstructed winner (from Δ vs band) MUST match the event's winningSide.
    expect(p.derivedWinningSide).toBe(Side.UP);
    expect(p.winningSideVerified).toBe(true);
    expect(p.winnerDenominator).toBe(denom);
    expect(p.potBase).toBe(potWETH);
    expect(p.potUSDC).toBe(potUSDC);
    expect(p.startTimeActual).toBe(1000n);
    expect(p.settleTimeActual).toBe(2000n);

    // Positions: 3 total, sorted winners-first then by contribution desc.
    expect(p.positions).toHaveLength(3);
    const pos11 = p.positions.find((x) => x.tokenId === 11n)!;
    const pos22 = p.positions.find((x) => x.tokenId === 22n)!;
    const pos33 = p.positions.find((x) => x.tokenId === 33n)!;

    expect(pos11.owner.toLowerCase()).toBe(A.toLowerCase());
    expect(pos11.side).toBe(Side.UP);
    expect(pos11.isWinner).toBe(true);
    expect(pos11.contribution6).toBe(5_000_000_000n);
    // 5/8 of 4 WETH = 2.5 WETH; 5/8 of 6000 USDC = 3750 USDC.
    expect(pos11.payBase).toBe(2_500_000_000_000_000_000n);
    expect(pos11.payUSDC).toBe(3750n * 10n ** 6n);

    expect(pos22.isWinner).toBe(true);
    expect(pos22.payBase).toBe(1_500_000_000_000_000_000n);
    expect(pos22.payUSDC).toBe(2250n * 10n ** 6n);

    // The DOWN position lost: it contributed but won nothing.
    expect(pos33.side).toBe(Side.DOWN);
    expect(pos33.isWinner).toBe(false);
    expect(pos33.payBase).toBe(0n);
    expect(pos33.payUSDC).toBe(0n);

    // Conservation: winners' payouts sum to the pot.
    const sumBase = p.positions.reduce((s, x) => s + x.payBase, 0n);
    const sumUsdc = p.positions.reduce((s, x) => s + x.payUSDC, 0n);
    expect(sumBase).toBe(potWETH);
    expect(sumUsdc).toBe(potUSDC);

    // Winners list is the winning-side positions only.
    expect(p.winnerCount).toBe(2);
  });

  it('sorts positions winners-first, then by contribution descending', () => {
    const proof = buildEpochProof({
      epochId: 2n,
      bandBps: 20,
      started: [started(2n, 100n * 10n ** 18n, 1n)],
      resolved: [resolved(2n, 100n * 10n ** 18n, Side.RANGE, 0n, 2n)],
      settled: [settled(2n, Side.RANGE, 4_000_000n, 0n, 1000_000000n)],
      rollovers: [],
      staked: [
        staked(2n, A, 1n, Side.UP), // loser
        staked(2n, B, 2n, Side.RANGE), // small winner
        staked(2n, A, 3n, Side.RANGE), // big winner
      ],
      swept: [
        swept(2n, 1n, 0n, 0n, 9_000_000n),
        swept(2n, 2n, 0n, 0n, 1_000_000n),
        swept(2n, 3n, 0n, 0n, 3_000_000n),
      ],
    });
    const order = proof!.positions.map((x) => x.tokenId);
    // winners (3 then 2) before the loser (1)
    expect(order).toEqual([3n, 2n, 1n]);
  });

  it('flags a rolled-over (empty-winner) epoch — pot rolled forward, no winners', () => {
    const proof = buildEpochProof({
      epochId: 3n,
      bandBps: 20,
      started: [started(3n, 100n * 10n ** 18n, 1n)],
      resolved: [resolved(3n, 100n * 10n ** 18n, Side.UP, 50n, 2n)],
      settled: [],
      rollovers: [rollover(3n, Side.UP, 2n * 10n ** 18n, 500_000000n)],
      staked: [staked(3n, A, 1n, Side.DOWN)], // nobody on the winning side
      swept: [swept(3n, 1n, 0n, 0n, 1_000_000n)],
    });
    const p = proof!;
    expect(p.rolledOver).toBe(true);
    expect(p.settled).toBe(true);
    expect(p.winningSide).toBe(Side.UP);
    expect(p.potBase).toBe(2n * 10n ** 18n);
    expect(p.potUSDC).toBe(500_000000n);
    expect(p.winnerCount).toBe(0);
    // No position wins in a rollover.
    expect(p.positions.every((x) => !x.isWinner)).toBe(true);
  });

  it('returns a non-settled proof when only a start log exists (epoch in progress)', () => {
    const proof = buildEpochProof({
      epochId: 9n,
      bandBps: 20,
      started: [started(9n, 100n * 10n ** 18n, 5n)],
      resolved: [],
      settled: [],
      rollovers: [],
      staked: [staked(9n, A, 1n, Side.UP)],
      swept: [],
    });
    const p = proof!;
    expect(p.settled).toBe(false);
    expect(p.startPrice18).toBe(100n * 10n ** 18n);
    expect(p.settlePrice18).toBeUndefined();
    expect(p.positions).toHaveLength(1);
    expect(p.positions[0].contribution6).toBe(0n); // not yet swept
  });

  it('returns null when there is no event for the epoch at all', () => {
    expect(
      buildEpochProof({
        epochId: 99n,
        bandBps: 20,
        started: [],
        resolved: [],
        settled: [],
        rollovers: [],
        staked: [],
        swept: [],
      }),
    ).toBeNull();
  });

  it('flags winningSideVerified=false when Δ-vs-band disagrees with the event (tamper signal)', () => {
    // Event claims UP, but Δ=10 within a 20-bps band would imply RANGE → mismatch.
    const proof = buildEpochProof({
      epochId: 4n,
      bandBps: 20,
      started: [started(4n, 100n * 10n ** 18n, 1n)],
      resolved: [resolved(4n, 100n * 10n ** 18n, Side.UP, 10n, 2n)],
      settled: [settled(4n, Side.UP, 1n, 0n, 0n)],
      rollovers: [],
      staked: [],
      swept: [],
    });
    const p = proof!;
    expect(p.winningSide).toBe(Side.UP); // as the event reported
    expect(p.derivedWinningSide).toBe(Side.RANGE); // what Δ vs band implies
    expect(p.winningSideVerified).toBe(false);
  });

  it('only includes positions/sweeps for the requested epoch (ignores other epochs)', () => {
    const proof = buildEpochProof({
      epochId: 1n,
      bandBps: 20,
      started: [started(1n, 100n * 10n ** 18n, 1n)],
      resolved: [resolved(1n, 100n * 10n ** 18n, Side.RANGE, 0n, 2n)],
      settled: [settled(1n, Side.RANGE, 1_000_000n, 0n, 1000_000000n)],
      rollovers: [],
      staked: [staked(1n, A, 1n, Side.RANGE), staked(2n, B, 2n, Side.RANGE)],
      swept: [swept(1n, 1n, 0n, 0n, 1_000_000n), swept(2n, 2n, 0n, 0n, 5_000_000n)],
    });
    expect(proof!.positions).toHaveLength(1);
    expect(proof!.positions[0].tokenId).toBe(1n);
  });
});
