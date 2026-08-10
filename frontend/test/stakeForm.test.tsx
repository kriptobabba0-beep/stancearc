import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Side, PhaseView } from '@/lib/types';

const stake = vi.fn();

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }));
vi.mock('@/hooks/useStakeWithSide', () => ({ useStakeWithSide: () => ({ stake, isPending: false, error: undefined }) }));
// This suite exercises the v1 (side-only) path. useStakeWithConviction is mocked so the form can import
// it without driving the real allowance read; the active market stays v1 (no version marker) so the
// conviction input is never rendered and this v1 stake flow is unchanged.
vi.mock('@/hooks/useStakeWithConviction', () => ({ useStakeWithConviction: () => ({ stake: vi.fn(), isPending: false, error: undefined }) }));
vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: () => ({ data: { phase: PhaseView.EntryOpen } }) }));
// No current-epoch stake → side selector stays fully selectable (OneSidePerEpoch lock not engaged).
vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: () => ({ data: [] }) }));
// Stub PositionPicker so the form can select a tokenId deterministically.
vi.mock('@/components/PositionPicker', () => ({
  PositionPicker: ({ onSelect }: { onSelect: (id: bigint) => void }) => (
    <button data-testid="pick" onClick={() => onSelect(42n)}>pick</button>
  ),
}));

import { StakeWithSideForm } from '@/components/StakeWithSideForm';

afterEach(() => {
  cleanup();
  stake.mockReset();
});

describe('StakeWithSideForm', () => {
  it('submits one stake tx only after position + side + ack', () => {
    render(<StakeWithSideForm />);
    const submit = screen.getByTestId('stake-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pick'));
    fireEvent.click(screen.getByTestId(`side-${Side.UP}`));
    fireEvent.click(screen.getByTestId('risk-ack'));
    expect((screen.getByTestId('stake-submit') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('stake-submit'));
    expect(stake).toHaveBeenCalledWith({ tokenId: 42n, side: Side.UP });
  });

  // Fix 5: side-picker buttons must expose aria-pressed for a11y (toggle-group pattern).
  it('side buttons expose aria-pressed=false when unselected and aria-pressed=true when active', () => {
    render(<StakeWithSideForm />);
    const upBtn = screen.getByTestId(`side-${Side.UP}`) as HTMLButtonElement;
    const downBtn = screen.getByTestId(`side-${Side.DOWN}`) as HTMLButtonElement;
    // Initially none selected → all aria-pressed="false".
    expect(upBtn.getAttribute('aria-pressed')).toBe('false');
    expect(downBtn.getAttribute('aria-pressed')).toBe('false');
    // Click UP → aria-pressed="true" on UP, stays false on DOWN.
    fireEvent.click(upBtn);
    expect(upBtn.getAttribute('aria-pressed')).toBe('true');
    expect(downBtn.getAttribute('aria-pressed')).toBe('false');
    // Switch to DOWN → UP resets.
    fireEvent.click(downBtn);
    expect(upBtn.getAttribute('aria-pressed')).toBe('false');
    expect(downBtn.getAttribute('aria-pressed')).toBe('true');
  });
});
