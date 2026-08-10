// hooks/usePreviewRefund.ts — polled FeeArenaV2Lens.previewRefund(epochId, tokenId) -> (refundable, amount).
//
// v2-ONLY: the conviction refund (winning-side principal, 1:1 USDC) and its preview live on the
// FeeArenaV2Lens. There is NO v1 equivalent — the v1 arena has no conviction. So this hook reads the
// Lens directly and stays DISABLED unless the active market is v2 (has a Lens). Callers must treat an
// undefined result as "not refundable / unknown" and keep the refund button disabled.
//
// FINAL numbers (the refundable bool + exact principal) come from HERE, not client math.
import { useReadContract } from 'wagmi';
import { useMarketContracts } from '@/lib/contracts';
import { arcTestnet } from '@/lib/chain';

export interface RefundPreview {
  refundable: boolean;
  amount: bigint;
}

export function usePreviewRefund(
  epochId: bigint,
  tokenId: bigint,
  opts?: { blockNumber?: bigint },
) {
  const { lens } = useMarketContracts();
  const q = useReadContract({
    address: lens?.address,
    abi: lens?.abi,
    functionName: 'previewRefund',
    args: [epochId, tokenId],
    chainId: arcTestnet.id,
    blockNumber: opts?.blockNumber, // pin all projection reads to one block when provided
    query: { enabled: !!lens, refetchInterval: opts?.blockNumber ? false : 5000 },
  });

  // previewRefund returns a positional tuple (bool refundable, uint256 amount); normalize to a struct.
  const tuple = q.data as readonly [boolean, bigint] | undefined;
  const data: RefundPreview | undefined = tuple
    ? { refundable: tuple[0], amount: tuple[1] }
    : undefined;

  return { ...q, data } as ReturnType<typeof useReadContract> & { data: RefundPreview | undefined };
}
