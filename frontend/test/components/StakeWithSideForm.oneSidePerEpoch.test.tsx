// Mirrors the contract's OneSidePerEpoch rule in the UI EXACTLY: the contract locks on
// userEpochTokenIds[user][epoch][0].side unconditionally (unstake never pops the tokenId), so ANY
// stake the connected user holds in the CURRENT epoch — even one later unstaked — locks the side to
// that side: the other two side buttons are disabled and an inline explanation is shown. With no
// current-epoch stake, all three sides stay selectable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../utils/renderWithProviders';
import { makeEpochView, makeStakeView, TEST_USER } from '../utils/fixtures';
import { PhaseView, Side } from '@/lib/types';

const stakeFn = vi.fn();

vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: vi.fn() }));
vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: vi.fn() }));
vi.mock('@/hooks/useStakeWithSide', () => ({
  useStakeWithSide: () => ({ stake: stakeFn, isPending: false, error: undefined }),
}));
// v1 (side-only) path: mock useStakeWithConviction so the form's static import of it doesn't pull in
// lib/contracts (which touches the live ENV). The active market here is the v1 placeholder, so the
// conviction input is never rendered and the OneSidePerEpoch behavior under test is unchanged.
vi.mock('@/hooks/useStakeWithConviction', () => ({
  useStakeWithConviction: () => ({ stake: vi.fn(), isPending: false, error: undefined }),
}));
// Stub PositionPicker to avoid its deep hook chain.
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
import { useUserStakes } from '@/hooks/useUserStakes';

const mockedUseCurrentEpoch = vi.mocked(useCurrentEpoch);
const mockedUseUserStakes = vi.mocked(useUserStakes);

const CURRENT_EPOCH = 7n;

function primeEpoch() {
  mockedUseCurrentEpoch.mockReturnValue({
    data: makeEpochView({ epochId: CURRENT_EPOCH, phase: PhaseView.EntryOpen }),
    isLoading: false,
    isError: false,
  } as ReturnType<typeof useCurrentEpoch>);
}

function primeStakes(stakes: ReturnType<typeof makeStakeView>[]) {
  mockedUseUserStakes.mockReturnValue({ data: stakes } as ReturnType<typeof useUserStakes>);
}

describe('StakeWithSideForm — OneSidePerEpoch side lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stakeFn.mockReset();
    primeEpoch();
  });

  it('locks the side to UP and disables DOWN/RANGE when the user already staked UP this epoch', () => {
    primeStakes([makeStakeView({ epochId: CURRENT_EPOCH, side: Side.UP, unstaked: false })]);
    renderWithProviders(<StakeWithSideForm />);

    expect(screen.getByTestId(`side-${Side.UP}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.DOWN}`)).toBeDisabled();
    expect(screen.getByTestId(`side-${Side.RANGE}`)).toBeDisabled();

    // Inline explanation names the locked side and tells the user they can add more on the same side.
    const note = screen.getByTestId('one-side-lock');
    expect(note).toHaveTextContent(/staked the UP side this epoch/i);
    expect(note).toHaveTextContent(/same side/i);
  });

  it('locks to DOWN when the existing current-epoch stake is DOWN', () => {
    primeStakes([makeStakeView({ epochId: CURRENT_EPOCH, side: Side.DOWN, unstaked: false })]);
    renderWithProviders(<StakeWithSideForm />);

    expect(screen.getByTestId(`side-${Side.DOWN}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.UP}`)).toBeDisabled();
    expect(screen.getByTestId(`side-${Side.RANGE}`)).toBeDisabled();
    expect(screen.getByTestId('one-side-lock')).toHaveTextContent(/staked the DOWN side this epoch/i);
  });

  it('leaves all three sides selectable when the user has NO stake this epoch', () => {
    primeStakes([]);
    renderWithProviders(<StakeWithSideForm />);

    expect(screen.getByTestId(`side-${Side.UP}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.DOWN}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.RANGE}`)).not.toBeDisabled();
    expect(screen.queryByTestId('one-side-lock')).toBeNull();
  });

  it('STILL locks when the only current-epoch stake was unstaked (contract locks on the first tokenId.side unconditionally — unstake never pops the id)', () => {
    primeStakes([makeStakeView({ epochId: CURRENT_EPOCH, side: Side.UP, unstaked: true })]);
    renderWithProviders(<StakeWithSideForm />);

    // Mirrors userEpochTokenIds[user][epoch][0].side: the side is fixed by the FIRST stake of the
    // epoch regardless of a later unstake, so the UI must keep the lock to match the on-chain rule.
    expect(screen.getByTestId(`side-${Side.UP}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.DOWN}`)).toBeDisabled();
    expect(screen.getByTestId(`side-${Side.RANGE}`)).toBeDisabled();
    expect(screen.getByTestId('one-side-lock')).toHaveTextContent(/staked the UP side this epoch/i);
  });

  it('does NOT lock when the stake belongs to a DIFFERENT (past) epoch', () => {
    primeStakes([makeStakeView({ epochId: CURRENT_EPOCH - 1n, side: Side.DOWN, unstaked: false })]);
    renderWithProviders(<StakeWithSideForm />);

    expect(screen.getByTestId(`side-${Side.UP}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.DOWN}`)).not.toBeDisabled();
    expect(screen.getByTestId(`side-${Side.RANGE}`)).not.toBeDisabled();
    expect(screen.queryByTestId('one-side-lock')).toBeNull();
  });
});
