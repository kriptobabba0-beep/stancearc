import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { maxUint256 } from 'viem';

// useTokenApproval does ERC-20 approve(spender, MAX) for the on-ramp — one approval covers all future
// mints so the user isn't re-prompted each time. This hook applies the Arc gas floor; this test LOCKS
// both invariants. We verify (a) it simulates approve with the MAX amount, and (b) it writes with the
// 20-gwei floor + 1-gwei priority fee. Mocking mirrors useMintPosition.test.tsx.

const TOKEN = '0x00000000000000000000000000000000000token0' as const;
const SPENDER = '0x0000000000000000000000000000000000spender0' as const;

vi.mock('@/abis', () => ({ erc20Abi: [] }));

vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
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
  // allowance read: 0 so needsApproval would be true; not under test here, just keeps the hook happy.
  useReadContract: () => ({ data: 0n, isLoading: false }),
}));

vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn(), refetchQueries: vi.fn() }) }));
// Toast lifecycle calls are not under test here — stub the centralized toast module so they no-op.
vi.mock('@/lib/toast', () => ({ toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() }, arcScanTxUrl: () => undefined }));

import { useTokenApproval } from '@/hooks/useTokenApproval';

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

describe('useTokenApproval().approve', () => {
  it('simulates approve(spender, MAX) then writes with the gas floor', async () => {
    const amount = 1_000_000n;
    const { result } = renderHook(() => useTokenApproval(TOKEN, SPENDER, amount));
    await act(async () => {
      await result.current.approve();
    });

    expect(simulateContract).toHaveBeenCalledTimes(1);
    const simCfg = simulateContract.mock.calls[0][0] as {
      functionName: string;
      args: unknown[];
      account: string;
      address: string;
    };
    expect(simCfg.functionName).toBe('approve');
    expect(simCfg.account).toBe(USER);
    expect(simCfg.address).toBe(TOKEN);
    // MAX approval (not the exact requiredAmount) so one grant covers all future mints.
    expect(simCfg.args).toEqual([SPENDER, maxUint256]);

    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const wcfg = writeContractAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(wcfg.maxFeePerGas).toBe(20_000_000_000n); // 20-gwei Arc floor
    expect(wcfg.maxPriorityFeePerGas).toBe(1_000_000_000n); // 1-gwei priority
    expect(wcfg.__sim).toBe(true); // simulated request forwarded to the write
  });

  it('simulates before it writes (simulate-then-write order holds)', async () => {
    const { result } = renderHook(() => useTokenApproval(TOKEN, SPENDER, 500n));
    await act(async () => {
      await result.current.approve();
    });
    expect(writeStartedAfterSimulate).toBe(true);
  });
});
