// readSurface.test.ts — the stake/preview read-surface picker + the v2 recent-epoch window helper.
//
// v2 moved getStake(sByEpoch) / previewClaim / previewRefund OFF the arena onto the FeeArenaV2Lens.
// readSurface() must therefore return the Lens handle for a v2 market (which carries `lens`) and the
// arena handle for v1 (no lens). recentEpochIds() builds the descending epoch window useUserStakes
// scans for a user's positions on the v2 Lens.
import { describe, it, expect, vi } from 'vitest';

// readSurface lives in lib/contracts, which reads ENV at module load (pythContract/npm/etc.). In the
// test env NEXT_PUBLIC_* are unset (the ENV proxy throws), so provide a readable ENV snapshot with the
// fields contracts + the single-market markets fallback touch. MARKETS:'' -> the ETH fallback path.
vi.mock('@/lib/env', () => {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const ENV = {
    CHAIN_ID: 5042002,
    PYTH_ADDRESS: ZERO, NPM_ADDRESS: ZERO, SWAP_ROUTER_ADDRESS: ZERO, FACTORY_ADDRESS: ZERO,
    USDC_ADDRESS: ZERO, WETH_ADDRESS: ZERO, MULTICALL3_ADDRESS: ZERO, FEE_ARENA_ADDRESS: ZERO,
    ORACLE_ADDRESS: ZERO, POOL_ADDRESS: ZERO, FEE_ARENA_FROM_BLOCK: 0n, FEE_TIER: 3000,
    PYTH_ETHUSD_ID: `0x${'0'.repeat(64)}`, HERMES_URL: 'https://hermes.pyth.network', MARKETS: '',
  };
  return { ENV, parseEnv: () => ENV, parseAddress: (s: string) => s, parseBytes32: (s: string) => s };
});

import { readSurface, type MarketContracts } from '@/lib/contracts';
import { recentEpochIds } from '@/hooks/useUserStakes';
import { feeArenaAbi, feeArenaV2Abi, feeArenaV2LensAbi } from '@/abis';

const ARENA = '0x00000000000000000000000000000000000aReNa' as `0x${string}`;
const LENS = '0x000000000000000000000000000000000000LeNs' as `0x${string}`;

describe('readSurface — stake/preview read surface picker', () => {
  it('returns the Lens handle for a v2 market (lens present)', () => {
    const contracts: MarketContracts = {
      feeArena: { address: ARENA, abi: feeArenaV2Abi },
      oracle: { address: ARENA, abi: [] as never },
      pool: { address: ARENA, abi: [] as never },
      lens: { address: LENS, abi: feeArenaV2LensAbi },
    };
    const s = readSurface(contracts);
    expect(s.address).toBe(LENS);
    expect(s.abi).toBe(feeArenaV2LensAbi);
  });

  it('returns the arena handle for a v1 market (no lens)', () => {
    const contracts: MarketContracts = {
      feeArena: { address: ARENA, abi: feeArenaAbi },
      oracle: { address: ARENA, abi: [] as never },
      pool: { address: ARENA, abi: [] as never },
    };
    const s = readSurface(contracts);
    expect(s.address).toBe(ARENA);
    expect(s.abi).toBe(feeArenaAbi);
  });

  it('the Lens ABI carries getStakesByEpoch + previewClaim (the functions the read hooks call)', () => {
    const names = feeArenaV2LensAbi.filter((e) => e.type === 'function').map((e) => e.name);
    expect(names).toContain('getStakesByEpoch');
    expect(names).toContain('previewClaim');
    expect(names).toContain('getStake');
    expect(names).toContain('previewRefund');
  });

  it('the v2 ARENA ABI does NOT carry getUserStakes / getStakesByEpoch / previewClaim (lens-only)', () => {
    const names = feeArenaV2Abi.filter((e) => e.type === 'function').map((e) => e.name);
    expect(names).not.toContain('getUserStakes');
    expect(names).not.toContain('getStakesByEpoch');
    expect(names).not.toContain('previewClaim');
  });
});

describe('recentEpochIds — descending epoch window for the v2 owner-filtered scan', () => {
  it('returns [current .. current-(lookback-1)] descending', () => {
    expect(recentEpochIds(10n, 4)).toEqual([10n, 9n, 8n, 7n]);
  });

  it('clamps at epoch id 1 (epoch ids are 1-based; never 0 / negative)', () => {
    expect(recentEpochIds(3n, 8)).toEqual([3n, 2n, 1n]);
  });

  it('returns [] when there is no epoch yet (current id 0)', () => {
    expect(recentEpochIds(0n, 8)).toEqual([]);
  });

  it('returns just the current id for lookback 1', () => {
    expect(recentEpochIds(5n, 1)).toEqual([5n]);
  });
});
