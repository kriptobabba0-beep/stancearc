import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app' } }));

import { CircleTxStatus } from '@/components/circle/CircleTxStatus';

afterEach(cleanup);

describe('CircleTxStatus', () => {
  it('shows the Circle badge + PIN copy for the embedded pending phase', () => {
    render(<CircleTxStatus phase="pending" isEmbedded />);
    expect(screen.getByTestId('circle-tx-status')).toBeTruthy();
    expect(screen.getByTestId('circle-tx-badge')).toBeTruthy();
    expect(screen.getByText(/Submitting via Circle/i)).toBeTruthy();
  });

  it('stays neutral (no Circle badge) for the MetaMask pending phase', () => {
    render(<CircleTxStatus phase="pending" isEmbedded={false} />);
    expect(screen.getByTestId('circle-tx-status')).toBeTruthy();
    expect(screen.queryByTestId('circle-tx-badge')).toBeNull();
    expect(screen.getByText('Submitting transaction…')).toBeTruthy();
  });

  it('renders nothing for an idle MetaMask flow', () => {
    render(<CircleTxStatus phase="idle" isEmbedded={false} />);
    expect(screen.queryByTestId('circle-tx-status')).toBeNull();
  });

  it('shows the Circle affordance for an idle embedded flow', () => {
    render(<CircleTxStatus phase="idle" isEmbedded />);
    expect(screen.getByTestId('circle-tx-badge')).toBeTruthy();
    expect(screen.getByText(/Signed & submitted via Circle/i)).toBeTruthy();
  });

  it('renders an ArcScan link when a txHash is present', () => {
    render(<CircleTxStatus phase="success" isEmbedded txHash="0xabc123" />);
    const link = screen.getByTestId('circle-tx-arcscan');
    expect(link.getAttribute('href')).toBe('https://testnet.arcscan.app/tx/0xabc123');
    expect(screen.getByText(/Confirmed on Arc via Circle/i)).toBeTruthy();
  });

  it('shows an error phase', () => {
    render(<CircleTxStatus phase="error" isEmbedded={false} />);
    expect(screen.getByText('Transaction failed')).toBeTruthy();
  });

  it('error + embedded keeps the Circle badge + failure copy', () => {
    render(<CircleTxStatus phase="error" isEmbedded />);
    expect(screen.getByTestId('circle-tx-badge')).toBeTruthy();
    expect(screen.getByText('Transaction failed')).toBeTruthy();
  });

  it('success + plain + txHash shows ArcScan but NO Circle badge', () => {
    render(<CircleTxStatus phase="success" isEmbedded={false} txHash="0xdead" />);
    expect(screen.queryByTestId('circle-tx-badge')).toBeNull();
    expect(screen.getByTestId('circle-tx-arcscan').getAttribute('href')).toBe('https://testnet.arcscan.app/tx/0xdead');
  });
});
