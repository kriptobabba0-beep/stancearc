import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils/renderWithProviders';
import { makeEpochView, TEST_USER } from '../utils/fixtures';
import { PhaseView, Side } from '@/lib/types';

// ---- Mock every hook/component the form renders. ----
const stakeFn = vi.fn();

vi.mock('@/hooks/useCurrentEpoch', () => ({
  useCurrentEpoch: vi.fn(),
}));
vi.mock('@/hooks/useStakeWithSide', () => ({
  useStakeWithSide: () => ({ stake: stakeFn, isPending: false, error: undefined }),
}));
// v1 (side-only) path: mock useStakeWithConviction so the form's static import of it doesn't pull in
// lib/contracts (which touches the live ENV). The active market here is the v1 placeholder, so the
// conviction input is never rendered and the v1 phase-gating under test is unchanged.
vi.mock('@/hooks/useStakeWithConviction', () => ({
  useStakeWithConviction: () => ({ stake: vi.fn(), isPending: false, error: undefined }),
}));
// No current-epoch stake → OneSidePerEpoch lock stays disengaged (all sides selectable).
vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: () => ({ data: [] }) }));
// Stub PositionPicker to avoid its deep hook chain; phase gating is independent of position selection.
vi.mock('@/components/PositionPicker', () => ({
  PositionPicker: ({ onSelect }: { onSelect: (id: bigint) => void }) => (
    <button data-testid="pick-pos" onClick={() => onSelect(101n)}>pick</button>
  ),
}));
vi.mock('wagmi', async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, useAccount: () => ({ address: TEST_USER, isConnected: true }) };
});

import { StakeWithSideForm } from '@/components/StakeWithSideForm';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';

const mockedUseCurrentEpoch = vi.mocked(useCurrentEpoch);

function primePhase(phase: PhaseView) {
  mockedUseCurrentEpoch.mockReturnValue({
    data: makeEpochView({ phase }),
    isLoading: false,
    isError: false,
    // Satisfy the rest of the hook shape with null-ish values
  } as ReturnType<typeof useCurrentEpoch>);
}

describe('StakeWithSideForm phase gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stakeFn.mockReset();
  });

  it('keeps the Stake button disabled when phase is Running', () => {
    primePhase(PhaseView.Running);
    renderWithProviders(<StakeWithSideForm />);
    expect(screen.getByTestId('stake-submit')).toBeDisabled();
  });

  it('keeps the Stake button disabled when phase is Settled', () => {
    primePhase(PhaseView.Settled);
    renderWithProviders(<StakeWithSideForm />);
    expect(screen.getByTestId('stake-submit')).toBeDisabled();
  });

  it('keeps the Stake button disabled when phase is Idle', () => {
    primePhase(PhaseView.Idle);
    renderWithProviders(<StakeWithSideForm />);
    expect(screen.getByTestId('stake-submit')).toBeDisabled();
  });

  it('does NOT call stake() while disabled outside EntryOpen', async () => {
    primePhase(PhaseView.Running);
    renderWithProviders(<StakeWithSideForm />);
    const stakeBtn = screen.getByTestId('stake-submit');
    // userEvent respects the disabled attribute and will not fire the click handler.
    await userEvent.click(stakeBtn);
    expect(stakeFn).not.toHaveBeenCalled();
  });

  it('enables Stake button during EntryOpen when position + side + ack are set', async () => {
    primePhase(PhaseView.EntryOpen);
    renderWithProviders(<StakeWithSideForm />);
    // Stake button must start disabled (no position + no side + no ack yet).
    expect(screen.getByTestId('stake-submit')).toBeDisabled();
    // Pick a position.
    await userEvent.click(screen.getByTestId('pick-pos'));
    // Pick a side.
    await userEvent.click(screen.getByTestId(`side-${Side.UP}`));
    // Acknowledge risks.
    await userEvent.click(screen.getByRole('checkbox'));
    // Now the stake button must be enabled.
    expect(screen.getByTestId('stake-submit')).not.toBeDisabled();
  });
});
