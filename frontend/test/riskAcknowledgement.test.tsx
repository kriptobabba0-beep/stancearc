import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { RiskAcknowledgement } from '@/components/RiskAcknowledgement';

afterEach(cleanup);

describe('RiskAcknowledgement', () => {
  it('reports check state and lists all four disclosures', () => {
    const onChange = vi.fn();
    render(<RiskAcknowledgement acknowledged={false} onChange={onChange} />);
    expect(screen.getByText(/forfeit this epoch/)).toBeTruthy();
    expect(screen.getByText(/impermanent-loss/)).toBeTruthy();
    expect(screen.getByText(/atomic and immutable/)).toBeTruthy();
    expect(screen.getByText(/locked in escrow/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('risk-ack'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
