import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

// usePreviewRefund reads FeeArenaV2Lens.previewRefund(epochId, tokenId) and normalizes the positional
// (bool refundable, uint256 amount) tuple to a struct. It must target the LENS, stay disabled without
// one (v1), and decode the tuple. Mirrors usePreviewClaim's read-surface pattern.

const LENS = '0x000000000000000000000000000000000000lens' as const;

let HAS_LENS = true;
vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => (HAS_LENS ? { lens: { address: LENS, abi: [] } } : {}),
}));
vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 7777 } }));

const useReadContract = vi.fn();
vi.mock('wagmi', () => ({ useReadContract: (cfg: unknown) => useReadContract(cfg) }));

import { usePreviewRefund } from '@/hooks/usePreviewRefund';

afterEach(() => { cleanup(); useReadContract.mockReset(); HAS_LENS = true; });

describe('usePreviewRefund', () => {
  it('targets the Lens with previewRefund(epochId, tokenId) enabled when a Lens exists', () => {
    useReadContract.mockReturnValue({ data: [true, 5_000_000n] });
    renderHook(() => usePreviewRefund(9n, 42n));
    const cfg = useReadContract.mock.calls[0][0] as { address: string; functionName: string; args: unknown[]; query: { enabled: boolean } };
    expect(cfg.address).toBe(LENS);
    expect(cfg.functionName).toBe('previewRefund');
    expect(cfg.args).toEqual([9n, 42n]);
    expect(cfg.query.enabled).toBe(true);
  });

  it('normalizes the (refundable, amount) tuple into a struct', () => {
    useReadContract.mockReturnValue({ data: [true, 5_000_000n] });
    const { result } = renderHook(() => usePreviewRefund(9n, 42n));
    expect(result.current.data).toEqual({ refundable: true, amount: 5_000_000n });
  });

  it('returns undefined data when the read has not resolved', () => {
    useReadContract.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => usePreviewRefund(9n, 42n));
    expect(result.current.data).toBeUndefined();
  });

  it('stays disabled (no Lens) on a v1 market', () => {
    HAS_LENS = false;
    useReadContract.mockReturnValue({ data: undefined });
    renderHook(() => usePreviewRefund(9n, 42n));
    const cfg = useReadContract.mock.calls[0][0] as { query: { enabled: boolean } };
    expect(cfg.query.enabled).toBe(false);
  });
});
