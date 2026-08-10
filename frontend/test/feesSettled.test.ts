import { describe, it, expect, vi } from 'vitest';

// useFeesSettled transitively imports lib/wagmi + lib/chain + lib/events→lib/contracts, which touch ENV
// (a throwing Proxy in tests). Stub them so importing the PURE summation fn doesn't touch ENV.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/chain', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
}));
vi.mock('@/lib/contracts', () => ({ feeArena: { address: '0x0000000000000000000000000000000000000000', abi: [] } }));

import { sumFeesSettled } from '@/hooks/useFeesSettled';

// Mirrors the on-chain PositionProcessed shape: each log carries feeBase (base decimals) + feeUSDC (6dp).
const log = (feeBase: bigint, feeUSDC: bigint) => ({ args: { feeBase, feeUSDC } });

describe('sumFeesSettled — cumulative total fees across PositionProcessed logs', () => {
  it('sums both legs across logs (winner-kept fees included, not just the loser pot)', () => {
    const logs = [log(0n, 225n), log(0n, 225n), log(187n, 129270n)]; // epoch-217 shape
    expect(sumFeesSettled(logs)).toEqual({ feeBase: 187n, feeUSDC: 129720n });
  });

  it('empty logs → zero', () => {
    expect(sumFeesSettled([])).toEqual({ feeBase: 0n, feeUSDC: 0n });
  });

  it('treats a missing leg as zero (defensive against a malformed log)', () => {
    expect(sumFeesSettled([{ args: { feeUSDC: 500n } }, { args: {} }])).toEqual({ feeBase: 0n, feeUSDC: 500n });
  });
});
