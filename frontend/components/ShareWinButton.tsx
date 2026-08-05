'use client';

// components/ShareWinButton.tsx - "Share" affordance for a win. Uses the Web Share API when available
// (mobile-first), otherwise copies the share text + URL to the clipboard and surfaces a toast. The
// share URL points at the per-epoch route (/epoch/<id>) whose OG image renders the branded result card.
import { useCallback, useState } from 'react';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { External, Check } from '@/components/ui/icons';
import { epochShareUrl, winShareText } from '@/lib/quant';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

interface ShareWinButtonProps {
  epochId: bigint;
  winningLabel: string;
  /** The user's earned payout for this epoch, in 6dp USD. */
  usd6: bigint;
  variant?: 'primary' | 'secondary' | 'ghost' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/** Best-effort site origin (SSR-safe). Empty string ⇒ epochShareUrl yields a relative path. */
function originSafe(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

export function ShareWinButton({
  epochId,
  winningLabel,
  usd6,
  variant = 'secondary',
  size = 'sm',
  className,
}: ShareWinButtonProps) {
  const [copied, setCopied] = useState(false);

  const onShare = useCallback(async () => {
    const url = epochShareUrl(originSafe(), epochId);
    const text = winShareText({ epochId, winningLabel, usd6 });
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;

    // Prefer the native share sheet (mobile). Fall back to clipboard on unsupported/cancelled.
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({ title: 'Limen Finance', text, url });
        return;
      } catch {
        // User cancelled or share failed - fall through to the clipboard path.
      }
    }
    try {
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        await nav.clipboard.writeText(`${text} ${url}`);
        setCopied(true);
        toast.success('Link copied - share your win', { id: 'share-win' });
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error('Sharing is not available in this browser', { id: 'share-win' });
      }
    } catch {
      toast.error('Could not copy the share link', { id: 'share-win' });
    }
  }, [epochId, winningLabel, usd6]);

  return (
    <button
      type="button"
      data-testid="share-win"
      onClick={onShare}
      className={cn(buttonClass(variant, size), className)}
    >
      {copied ? (
        <>
          <Check className="h-4 w-4" aria-hidden="true" /> Copied
        </>
      ) : (
        <>
          <External className="h-4 w-4" aria-hidden="true" /> Share
        </>
      )}
      {(variant === 'primary' || variant === 'secondary') && <Stars />}
    </button>
  );
}
