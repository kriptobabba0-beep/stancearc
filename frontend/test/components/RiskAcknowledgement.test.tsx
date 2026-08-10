import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../utils/renderWithProviders';
import { RiskAcknowledgement } from '@/components/RiskAcknowledgement';

describe('RiskAcknowledgement', () => {
  it('renders the four mandatory disclosures', () => {
    renderWithProviders(<RiskAcknowledgement acknowledged={false} onChange={() => {}} />);
    // "forfeit this epoch" covers the losing-side disclosure
    expect(screen.getByText(/forfeit this epoch/i)).toBeInTheDocument();
    // AMM / impermanent-loss
    expect(screen.getByText(/(AMM|impermanent)/i)).toBeInTheDocument();
    // atomic and immutable
    expect(screen.getByText(/(immutable|atomic)/i)).toBeInTheDocument();
    // locked in escrow
    expect(screen.getByText(/locked in escrow/i)).toBeInTheDocument();
  });

  it('starts unchecked and reports check via onChange', async () => {
    const onChange = vi.fn();
    renderWithProviders(<RiskAcknowledgement acknowledged={false} onChange={onChange} />);
    const box = screen.getByRole('checkbox');
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('reflects the acknowledged prop as the checkbox checked state', () => {
    const { rerender } = renderWithProviders(
      <RiskAcknowledgement acknowledged={false} onChange={() => {}} />,
    );
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    rerender(<RiskAcknowledgement acknowledged={true} onChange={() => {}} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
