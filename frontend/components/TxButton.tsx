'use client';

import { ENV } from '@/lib/env';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { External } from '@/components/ui/icons';

interface TxButtonProps {
  label: string;
  disabled?: boolean;
  isPending?: boolean;
  onClick: () => void;
  txHash?: `0x${string}`;
  className?: string;
  /** Optional test/automation hook applied to the underlying <button>. */
  testId?: string;
}

/**
 * Transaction button: wraps preflight + pending state + optimistic disable + friendly errors.
 * Shows an ArcScan link once txHash is known.
 */
export function TxButton({
  label,
  disabled = false,
  isPending = false,
  onClick,
  txHash,
  className = '',
  testId,
}: TxButtonProps) {
  return (
    <div className="inline-flex flex-col items-start gap-1.5">
      <button
        type="button"
        data-testid={testId}
        disabled={disabled || isPending}
        onClick={onClick}
        className={buttonClass('secondary', 'sm', className)}
      >
        {isPending ? `${label}…` : label}
        <Stars />
      </button>
      {txHash && (
        <a
          href={`${ENV.EXPLORER_URL}/tx/${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
        >
          View on ArcScan
          <External className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
