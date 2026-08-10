import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PhaseView } from '@/lib/types';

// Idle must NOT show a ticking countdown: on-chain the entry clock starts at createEpoch, a few
// seconds before openEntry flips the phase — so a countdown under "Starting soon" reads as "the
// epoch starts in 3:00" when it is really the entry window. Idle renders the pulsing
// "Opening entry…" instead; EntryOpen keeps the real countdown.

let epoch: Record<string, unknown>;

const baseEpoch = {
  epochId: 42n,
  phase: PhaseView.Idle,
  entryOpenTime: 0n,
  entryCloseTime: 180n, // entry clock already running on-chain (create at t=0, close at t=180)
  startTime: 180n,
  endTime: 300n,
  startPrice18: 60000_000000000000000000n,
  settlePrice18: 0n,
  stakedCount: 0,
  potWETH: 0n,
  potUSDC: 0n,
};

epoch = baseEpoch;

vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: () => ({ data: epoch, isLoading: false }) }));
vi.mock('@/hooks/useOraclePrice', () => ({ useOraclePrice: () => ({ data: { price18: 60000_000000000000000000n, updatedAt: 1n } }) }));
vi.mock('@/hooks/useChainTime', () => ({ useChainTime: () => ({ now: 10n, offsetMs: 0 }) })); // mid entry clock
vi.mock('@/hooks/usePriceSamples', () => ({ usePriceSamples: () => [] }));
vi.mock('@/hooks/useFeesSettled', () => ({ useFeesSettled: () => ({ data: { feeBase: 0n, feeUSDC: 0n } }) }));
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({ id: 'cirbtc', baseDecimals: 8, quoteSymbol: 'USDC' }),
}));

import { EpochCenterPanel } from '@/components/arena/EpochCenterPanel';

afterEach(() => {
  cleanup();
  epoch = baseEpoch;
});

describe('EpochCenterPanel — Idle vs EntryOpen countdown honesty', () => {
  it('Idle names the just-settled epoch and shows NO ticking countdown, even mid entry clock', () => {
    render(<EpochCenterPanel />);
    expect(screen.getByText(/Starting soon/i)).toBeTruthy();
    // v3 lifecycle: an Idle epoch 42 exists only because epoch 41 just settled — say so.
    expect(screen.getByText(/Epoch #41 settled — opening entry…/i)).toBeTruthy();
    // No countdown digits: the 170s remaining on the (not-yet-open) entry clock must not render.
    expect(screen.queryByText('02')).toBeNull();
    expect(screen.queryByLabelText('Time remaining')).toBeNull();
  });

  it('EntryOpen shows the real entry-close countdown', () => {
    epoch = { ...baseEpoch, phase: PhaseView.EntryOpen };
    render(<EpochCenterPanel />);
    expect(screen.getByText(/Entry open/i)).toBeTruthy();
    // 180 - 10 = 170s remaining -> 00:02:50 rendered as stacked cells.
    expect(screen.getByLabelText('Time remaining')).toBeTruthy();
    expect(screen.getByText('50')).toBeTruthy();
  });

  it('an epochId jump straight into EntryOpen shows the transient "settled — new round open" notice', () => {
    // First render: old epoch mid-round. The pipeline then settles + opens the next epoch so fast
    // that polling never sees Settled/Idle — the UI must still confirm the settlement.
    epoch = { ...baseEpoch, phase: PhaseView.Running };
    const view = render(<EpochCenterPanel />);
    expect(screen.queryByTestId('settled-notice')).toBeNull();

    epoch = { ...baseEpoch, epochId: 43n, phase: PhaseView.EntryOpen };
    view.rerender(<EpochCenterPanel />);
    expect(screen.getByTestId('settled-notice').textContent).toMatch(/Epoch #42 settled — new round open/i);
  });
});
