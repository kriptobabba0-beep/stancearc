'use client';

import { PhaseView } from '@/lib/types';
import { phaseViewLabel } from '@/lib/phase';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';

const PHASE_TONE = {
  [PhaseView.Idle]: 'neutral',
  [PhaseView.EntryOpen]: 'brand',
  [PhaseView.Running]: 'success',
  [PhaseView.Settled]: 'info',
} as const;

interface PhaseBadgeProps {
  phase: PhaseView;
}

export function PhaseBadge({ phase }: PhaseBadgeProps) {
  const tone = PHASE_TONE[phase] ?? 'neutral';
  const live = phase === PhaseView.Running;
  return (
    <Badge tone={tone} data-testid="phase-badge">
      <span className={cn('h-1.5 w-1.5 rounded-full bg-current', live && 'animate-pulse-soft')} />
      {phaseViewLabel(phase)}
    </Badge>
  );
}
