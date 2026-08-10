import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// useRefundConviction calls FeeArenaV2.refundConviction(epochId, tokenId, recipient). We verify it
// (a) simulates with the correct 3 args (recipient defaults to the connected wallet, override honored),
// and (b) writes the simulated request WITH the Arc 20-gwei gas floor. Mocking mirrors useClaim.test.tsx.

const FEE_ARENA = '0x00000000000000000000000000000000feearena' as const;

vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => ({
    feeArena: { address: '0x00000000000000000000000000000000feearena' as const, abi: [] },
  }),
}));

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

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ refetchQueries: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() }, arcScanTxUrl: () => undefined }));
vi.mock('@/hooks/useTxToast', () => ({
  useTxToast: vi.fn(),
  useTxReceipt: () => ({ isLoading: false, isSuccess: false, isError: false, data: undefined }),
  TX_RECEIPT_TIMEOUT_MS: 1,
}));

import { useRefundConviction } from '@/hooks/useRefundConviction';

const USER = '0x1111111111111111111111111111111111111111' as const;

beforeEach(() => {
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

describe('useRefundConviction().refundConviction', () => {
  it('simulates refundConviction(epochId, tokenId, recipient) defaulting recipient to the connected wallet, then writes with the gas floor', async () => {
    const { result } = renderHook(() => useRefundConviction());
    await act(async () => {
      await result.current.refundConviction({ epochId: 4n, tokenId: 12n });
    });

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as {
      functionName: string;
      args: unknown[];
      account: string;
      address: string;
    };
    expect(simCfg.functionName).toBe('refundConviction');
    expect(simCfg.account).toBe(USER);
    expect(simCfg.address).toBe(FEE_ARENA);
    expect(simCfg.args).toEqual([4n, 12n, USER]); // recipient defaults to the connected address

    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n);
    expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n);
    expect(wcfg.__sim).toBe(true);
  });

  it('forwards an explicit recipient override (blocklisted-owner redirect)', async () => {
    const RECIP = '0x3333333333333333333333333333333333333333' as const;
    const { result } = renderHook(() => useRefundConviction());
    await act(async () => {
      await result.current.refundConviction({ epochId: 4n, tokenId: 12n, recipient: RECIP });
    });
    const simCfg = simulateContract.mock.calls[0][0] as { args: unknown[] };
    expect(simCfg.args).toEqual([4n, 12n, RECIP]);
  });

  it('simulates before it writes (simulate-then-write order holds)', async () => {
    const { result } = renderHook(() => useRefundConviction());
    await act(async () => {
      await result.current.refundConviction({ epochId: 1n, tokenId: 1n });
    });
    expect(writeStartedAfterSimulate).toBe(true);
  });
});
