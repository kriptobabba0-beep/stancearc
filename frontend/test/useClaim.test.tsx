import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// useClaim is VERSION-AWARE. We verify:
//  - v1: simulates claim(epochId, tokenId) [2 args] then writes WITH the Arc 20-gwei gas floor.
//  - v2: simulates claim(epochId, tokenId, recipient) [3 args]; recipient defaults to the connected
//        wallet, and an explicit recipient override is forwarded (blocklisted-owner redirect).
// Mocking mirrors useMintPosition.test.tsx.

const FEE_ARENA = '0x00000000000000000000000000000000feearena' as const;

let IS_V2 = false;
vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => ({
    feeArena: { address: '0x00000000000000000000000000000000feearena' as const, abi: [] },
  }),
}));
vi.mock('@/components/MarketProvider', () => ({ useActiveMarket: () => ({ id: 'test' }) }));
vi.mock('@/lib/markets', () => ({ isV2Market: () => IS_V2, isV3Market: () => false }));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  withGasFloor: <T,>(request: T) => ({
    ...request,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  }),
}));

vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

const simulateContract = vi.fn(async (cfg: unknown) => ({ request: { ...(cfg as object), __sim: true } }));
let writeStartedAfterSimulate = false;
let simulateResolved = false;
const writeContractAsync = vi.fn(async (_cfg: Record<string, unknown>) => {
  writeStartedAfterSimulate = simulateResolved;
  return '0xhash';
});
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  usePublicClient: () => ({ simulateContract }),
  useWriteContract: () => ({ writeContractAsync, data: undefined, isPending: false }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries: vi.fn() }) }));
// Toast lifecycle calls are not under test here — stub the centralized toast module so they no-op.
vi.mock('@/lib/toast', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() }, arcScanTxUrl: () => undefined }));
vi.mock('@/hooks/useTxToast', () => ({
  useTxToast: vi.fn(),
  // useTxReceipt is the shared receipt-wait wrapper the hook now calls — return an inert pending shape.
  useTxReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
  TX_RECEIPT_TIMEOUT_MS: 1,
}));

import { useClaim } from '@/hooks/useClaim';

const USER = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
  IS_V2 = false;
  simulateContract.mockClear();
  writeContractAsync.mockClear();
  writeStartedAfterSimulate = false;
  simulateResolved = false;
  simulateContract.mockImplementation(async (cfg: unknown) => {
    simulateResolved = true;
    return { request: { ...(cfg as object), __sim: true } };
  });
});
afterEach(cleanup);

describe('useClaim().claim', () => {
  it('v1: simulates claim(epochId, tokenId) [2 args] then writes with the gas floor', async () => {
    const { result } = renderHook(() => useClaim());
    await act(async () => {
      await result.current.claim({ epochId: 3n, tokenId: 88n });
    });

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as {
      functionName: string;
      args: unknown[];
      account: string;
      address: string;
    };
    expect(simCfg.functionName).toBe('claim');
    expect(simCfg.account).toBe(USER);
    expect(simCfg.address).toBe(FEE_ARENA);
    expect(simCfg.args).toEqual([3n, 88n]);

    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n); // 20-gwei Arc floor
    expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n); // 1-gwei priority
    expect(wcfg.__sim).toBe(true); // simulated request forwarded to the write
  });

  it('v2: simulates claim(epochId, tokenId, recipient) [3 args] defaulting recipient to the connected wallet', async () => {
    IS_V2 = true;
    const { result } = renderHook(() => useClaim());
    await act(async () => {
      await result.current.claim({ epochId: 7n, tokenId: 42n });
    });
    const simCfg = simulateContract.mock.calls[0][0] as { functionName: string; args: unknown[] };
    expect(simCfg.functionName).toBe('claim');
    expect(simCfg.args).toEqual([7n, 42n, USER]); // recipient defaults to connected address
  });

  it('v2: forwards an explicit recipient override (blocklisted-owner redirect)', async () => {
    IS_V2 = true;
    const RECIP = '0x2222222222222222222222222222222222222222' as const;
    const { result } = renderHook(() => useClaim());
    await act(async () => {
      await result.current.claim({ epochId: 7n, tokenId: 42n, recipient: RECIP });
    });
    const simCfg = simulateContract.mock.calls[0][0] as { args: unknown[] };
    expect(simCfg.args).toEqual([7n, 42n, RECIP]);
  });

  it('simulates before it writes (simulate-then-write order holds)', async () => {
    const { result } = renderHook(() => useClaim());
    await act(async () => {
      await result.current.claim({ epochId: 1n, tokenId: 1n });
    });
    expect(writeStartedAfterSimulate).toBe(true);
  });
});
