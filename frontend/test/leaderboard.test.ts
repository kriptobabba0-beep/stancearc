import { describe, it, expect, vi } from 'vitest';

// The hook modules transitively import lib/wagmi + lib/contracts (which touch ENV — a throwing
// Proxy in tests). Stub them so importing the PURE aggregation fns doesn't touch ENV.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/chain', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
}));
vi.mock('@/lib/contracts', () => ({ feeArena: { address: '0x0000000000000000000000000000000000000000', abi: [] } }));

import { buildLeaderboard, type LeaderboardRow } from '@/hooks/useLeaderboard';
import type { DecodedLog } from '@/hooks/useEpochHistory';

const A = '0xAAaAaAAAaAaAAaaAAAAAAaAaAaAaAaAaAaAaAaAa' as const; // big winner
const B = '0xbBBbBBBBbBBbbBBbBBBbBbBbBBbBbbBbBbbBbBBb' as const; // winner, smaller
const C = '0xccccCcCcCcCccCcCccCCCcCCccCcCcCCCCcCcCCcC' as const; // entered, never won
const D = '0xdddDdddDdDdDDddDDDDdDDDdDdDdDddDdDdDDDDdD' as const; // rolled-over epoch entrant

const staked = (epochId: bigint, owner: `0x${string}`): DecodedLog => ({ args: { epochId, owner } });
const claimed = (
  epochId: bigint,
  owner: `0x${string}`,
  payWETH: bigint,
  payUSDC: bigint,
): DecodedLog => ({ args: { epochId, owner, payWETH, payUSDC } });

const byAddr = (rows: LeaderboardRow[], addr: string) =>
  rows.find((r) => r.address.toLowerCase() === addr.toLowerCase());

describe('buildLeaderboard', () => {
  it('aggregates entered/won/claimed and ranks by claimedUSDC desc', () => {
    const stakedLogs = [
      staked(1n, A), staked(2n, A), // A entered epochs 1 & 2
      staked(1n, B),                // B entered epoch 1
      staked(1n, C), staked(2n, C), // C entered 1 & 2 but never claims
      staked(3n, D),                // D entered the rolled-over epoch 3
    ];
    const claimedLogs = [
      claimed(1n, A, 1_000000000000000000n, 5000_000000n), // A wins epoch 1
      claimed(2n, A, 0n, 2000_000000n),                    // A wins epoch 2 (USDC only)
      claimed(1n, B, 2_000000000000000000n, 1000_000000n), // B wins epoch 1
      // C: no claims at all -> entered, not won
      // D: epoch 3 rolled over -> no claim -> entered, not won
    ];

    const rows = buildLeaderboard(stakedLogs, claimedLogs);

    // Ranking: A (7000 USDC) > B (1000 USDC) > C/D (0). A first.
    expect(rows[0].address.toLowerCase()).toBe(A.toLowerCase());

    const a = byAddr(rows, A)!;
    expect(a.entered).toBe(2);
    expect(a.won).toBe(2);
    expect(a.claimedBase).toBe(1_000000000000000000n);
    expect(a.claimedUSDC).toBe(7000_000000n);

    const b = byAddr(rows, B)!;
    expect(b.entered).toBe(1);
    expect(b.won).toBe(1);
    expect(b.claimedUSDC).toBe(1000_000000n);

    // C entered two epochs, never claimed -> won 0
    const c = byAddr(rows, C)!;
    expect(c.entered).toBe(2);
    expect(c.won).toBe(0);
    expect(c.claimedUSDC).toBe(0n);

    // D entered the rolled-over epoch, never claimed -> won 0
    const d = byAddr(rows, D)!;
    expect(d.entered).toBe(1);
    expect(d.won).toBe(0);
  });

  it('does NOT count a zero-payout Claimed as a win (out-of-range winner)', () => {
    // E staked, then a Claimed fired with zero payout (e.g. zero contribution) -> entered, not won.
    const rows = buildLeaderboard(
      [staked(5n, A)],
      [claimed(5n, A, 0n, 0n)],
    );
    const a = byAddr(rows, A)!;
    expect(a.entered).toBe(1);
    expect(a.won).toBe(0);
    expect(a.claimedBase).toBe(0n);
    expect(a.claimedUSDC).toBe(0n);
  });

  it('counts an address with a claim but no Staked log as entered (claim implies entry)', () => {
    const rows = buildLeaderboard([], [claimed(7n, B, 0n, 500_000000n)]);
    const b = byAddr(rows, B)!;
    expect(b.entered).toBe(1);
    expect(b.won).toBe(1);
  });

  it('returns an empty array for no logs', () => {
    expect(buildLeaderboard([], [])).toEqual([]);
  });

  it('tie-breaks equal USDC by claimedBase desc', () => {
    const rows = buildLeaderboard(
      [staked(1n, A), staked(1n, B)],
      [claimed(1n, A, 1n, 100_000000n), claimed(1n, B, 5n, 100_000000n)],
    );
    // Same USDC (100); B has more base -> B ranks first.
    expect(rows[0].address.toLowerCase()).toBe(B.toLowerCase());
  });
});
