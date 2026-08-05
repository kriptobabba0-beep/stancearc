'use client';

import { Alert } from '@/components/ui/icons';

interface RiskAcknowledgementProps {
  acknowledged: boolean;
  onChange: (acknowledged: boolean) => void;
}

const RISKS = [
  'If your side loses, you forfeit this epoch’s fees (no reward).',
  'You still carry the AMM / impermanent-loss risk on your LP position.',
  'Your side choice is atomic and immutable for this epoch - it cannot be changed.',
  'Your NFT is locked in escrow until the operator settles this epoch.',
];

export function RiskAcknowledgement({ acknowledged, onChange }: RiskAcknowledgementProps) {
  return (
    <div className="rounded-2xl border border-amber-300/60 bg-amber-50 p-4 text-sm dark:border-amber-400/25 dark:bg-amber-400/10">
      <p className="flex items-center gap-2 font-semibold text-amber-800 dark:text-amber-300">
        <Alert className="h-4 w-4 shrink-0" />
        Before you stake, acknowledge:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-soft">
        {RISKS.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <label className="mt-3 flex cursor-pointer items-center gap-2 font-medium text-ink">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="risk-ack"
          className="h-4 w-4 cursor-pointer rounded border-line accent-brand"
        />
        <span>I understand and accept these risks.</span>
      </label>
    </div>
  );
}
