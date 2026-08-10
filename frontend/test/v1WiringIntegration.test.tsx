// v1WiringIntegration.test.tsx — INTEGRATION test that the LEGACY v1 path still resolves correctly
// through the REAL marketContracts()/readSurface() against the REAL v1 feeArenaAbi (Task 3 STRICT:
// the app must keep supporting BOTH a v1 'legacy' market and the v2 market by version). The v2 sibling
// (v2WiringIntegration.test.tsx) asserts the Lens/3-arg surface; this one pins the v1 contrast:
//   - readSurface() resolves to the ARENA (v1 has no Lens) for getStakesByEpoch/previewClaim, and
//   - useClaim simulates the 2-arg claim(epochId, tokenId) (no recipient) on the v1 arena.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Readable ENV snapshot (contracts.ts touches ENV at module load).
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

const ARENA_V1 = '0xD0aEDc19E1C27E7643255432006942ccFba5B8CE' as const;
const ORACLE = '0xeC6214cB521D4C7178B8CDEfaEf76e5b021Dde59' as const;
const POOL = '0x969f2e3CB9929b5D50B6A59Cf49CF30870e1658b' as const;
const FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43' as const;
const USER = '0x1111111111111111111111111111111111111111' as const;

import type { Market } from '@/lib/markets';

// A REAL legacy v1 market (no version field -> resolves to 'v1'; no lens/treasury/conviction bounds).
const V1_MARKET: Market = {
  id: 'btc', label: 'BTC / USDC', baseSymbol: 'cirBTC', baseDecimals: 8,
  feeArena: ARENA_V1, oracle: ORACLE, pool: POOL, feedId: FEED, fromBlock: 0n,
};

vi.mock('@/components/MarketProvider', () => ({ useActiveMarket: () => V1_MARKET }));
vi.mock('@/hooks/usePollInterval', () => ({ usePollInterval: () => 5000, bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() }, arcScanTxUrl: () => undefined }));
vi.mock('@/hooks/useTxToast', () => ({
  useTxToast: vi.fn(),
  useTxReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
  TX_RECEIPT_TIMEOUT_MS: 1,
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ refetchQueries: vi.fn(), invalidateQueries: vi.fn() }) }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002 },
  withGasFloor: <T,>(r: T) => ({ ...r, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
}));

const reads = vi.hoisted(() => ({
  calls: [] as { address?: string; abi?: unknown; functionName?: string; args?: unknown[] }[],
  dataByFn: {} as Record<string, unknown>,
}));
const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
const writeContractAsync = vi.fn(async () => '0xhash');

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useReadContract: (cfg: { address?: string; abi?: unknown; functionName?: string; args?: unknown[] }) => {
    reads.calls.push(cfg);
    return { data: cfg.functionName ? reads.dataByFn[cfg.functionName] : undefined, isLoading: false, isError: false };
  },
  useReadContracts: () => ({ data: undefined, isLoading: false, isError: false }),
  useAccount: () => ({ address: USER }),
  usePublicClient: () => ({ simulateContract, waitForTransactionReceipt: vi.fn(async () => ({})) }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
}));

import { feeArenaAbi, feeArenaV2LensAbi } from '@/abis';
import { marketContracts, readSurface } from '@/lib/contracts';
import { useStakesByEpoch } from '@/hooks/useStakesByEpoch';
import { useClaim } from '@/hooks/useClaim';

function lastReadFor(name: string) {
  return [...reads.calls].reverse().find((c) => c.functionName === name);
}

beforeEach(() => {
  reads.calls = [];
  reads.dataByFn = {};
  simulateContract.mockClear();
  writeContractAsync.mockClear();
});
afterEach(cleanup);

describe('v1 (legacy) wiring still resolves through the REAL marketContracts/readSurface', () => {
  it('a v1 market has NO lens; readSurface() falls back to the ARENA with the v1 ABI', () => {
    const c = marketContracts(V1_MARKET);
    expect(c.lens).toBeUndefined(); // v1 carries no Lens handle
    expect(c.feeArena.abi).toBe(feeArenaAbi); // v1 arena ABI
    const s = readSurface(c);
    expect(s.address).toBe(ARENA_V1);
    expect(s.abi).toBe(feeArenaAbi);
    expect(s.abi).not.toBe(feeArenaV2LensAbi);
  });

  it('useStakesByEpoch reads getStakesByEpoch from the v1 ARENA (not a Lens)', () => {
    renderHook(() => useStakesByEpoch(7n));
    const call = lastReadFor('getStakesByEpoch');
    expect(call, 'getStakesByEpoch must be issued').toBeTruthy();
    expect(call!.address).toBe(ARENA_V1);
    expect(call!.abi).toBe(feeArenaAbi);
    expect(call!.args).toEqual([7n]);
  });

  it('useClaim (v1) simulates the 2-arg claim(epochId, tokenId) on the arena — NO recipient', async () => {
    const { result } = renderHook(() => useClaim());
    await act(async () => { await result.current.claim({ epochId: 3n, tokenId: 88n }); });
    const cfg = simulateContract.mock.calls[0][0] as { address: string; functionName: string; args: unknown[] };
    expect(cfg.address).toBe(ARENA_V1);
    expect(cfg.functionName).toBe('claim');
    expect(cfg.args).toEqual([3n, 88n]); // v1 is the 2-arg form (owner-routed payout)
  });
});
