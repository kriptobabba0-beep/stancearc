'use client';

// components/circle/CircleTxStatus.tsx - a small, on-brand status strip that makes the ALREADY-REAL
// Circle write path visible on the arena's stake/claim flows. When the embedded (Circle) wallet is
// active, every write goes through Circle's Smart Contract Platform `contractExecution`; this surfaces
// that with a Circle badge + a phase label (and an ArcScan link once a hash is known). For MetaMask it
// stays neutral - the standard wallet UI already covers that path.
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';
import { External } from '@/components/ui/icons';

export type CircleTxPhase = 'idle' | 'pending' | 'success' | 'error';

function txUrl(hash: string): string {
  return `${ENV.EXPLORER_URL.replace(/\/$/, '')}/tx/${hash}`;
}

const PHASE_TEXT: Record<CircleTxPhase, { embedded: string; plain: string }> = {
  idle: { embedded: 'Signed & submitted via Circle Smart Contract Platform', plain: '' },
  pending: { embedded: 'Submitting via Circle - confirm with your PIN', plain: 'Submitting transaction…' },
  success: { embedded: 'Confirmed on Arc via Circle', plain: 'Confirmed on Arc' },
  error: { embedded: 'Transaction failed', plain: 'Transaction failed' },
};

export function CircleTxStatus({
  phase,
  isEmbedded,
  txHash,
  className,
}: {
  phase: CircleTxPhase;
  isEmbedded: boolean;
  txHash?: `0x${string}`;
  className?: string;
}) {
  // Nothing to show for an idle MetaMask flow - the standard wallet UI already covers it.
  if (phase === 'idle' && !isEmbedded) return null;

  const text = isEmbedded ? PHASE_TEXT[phase].embedded : PHASE_TEXT[phase].plain;
  const tone = phase === 'error' ? 'text-side-down' : phase === 'success' ? 'text-side-up' : 'text-ink-muted';

  return (
    <div data-testid="circle-tx-status" className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs', className)}>
      {isEmbedded && (
        <span
          data-testid="circle-tx-badge"
          className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-muted px-2 py-0.5 font-medium text-ink-soft"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[#1AAE9F]" aria-hidden />
          Circle
        </span>
      )}
      {text && <span className={cn('font-medium', tone)}>{text}</span>}
      {txHash && (
        <a
          data-testid="circle-tx-arcscan"
          href={txUrl(txHash)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium text-brand hover:text-brand-hover"
        >
          ArcScan
          <External className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
