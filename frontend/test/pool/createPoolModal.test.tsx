import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// CreatePoolModal: pick Token A + Token B → Continue routes to that pool's deposit page. Token B is
// constrained to tokens that actually pair with A, so Continue always resolves to a real registry pool.
// We mock ENV so the real lib/tokens + lib/pools registries build (distinct addresses), and capture the
// router push to assert the destination.

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));

vi.mock('@/lib/env', () => ({
  ENV: {
    FEE_TIER: 3000,
    POOL_ADDRESS: '0x00000000000000000000000000000000000000aa',
    WETH_ADDRESS: '0x00000000000000000000000000000000000000bb', // cirBTC
    USDC_ADDRESS: '0x0000000000000000000000000000000000000002',
    EURC_ADDRESS: '0x0000000000000000000000000000000000000003',
  },
}));

import { CreatePoolModal } from '@/components/pool/CreatePoolModal';

afterEach(() => {
  cleanup();
  pushMock.mockReset();
});
beforeEach(() => {
  pushMock.mockReset();
});

describe('CreatePoolModal', () => {
  it('defaults to cirBTC / USDC and Continue routes to its deposit page', () => {
    render(<CreatePoolModal open onClose={() => {}} />);
    const cta = screen.getByTestId('create-continue');
    expect(cta).toHaveTextContent('cirBTC / USDC');
    fireEvent.click(cta);
    expect(pushMock).toHaveBeenCalledWith('/pool/cirbtc-usdc');
  });

  it('routes to the EURC/USDC pool after choosing EURC as Token A', () => {
    render(<CreatePoolModal open onClose={() => {}} />);
    // Open Token A and choose EURC.
    fireEvent.click(screen.getByRole('button', { name: /select token a/i }));
    const listbox = screen.getByRole('listbox', { name: /select token a/i });
    fireEvent.click(within(listbox).getByText('EURC'));
    // Token B stayed USDC (still a valid pair) → Continue → /pool/eurc-usdc.
    fireEvent.click(screen.getByTestId('create-continue'));
    expect(pushMock).toHaveBeenCalledWith('/pool/eurc-usdc');
  });

  it('does not render when closed', () => {
    render(<CreatePoolModal open={false} onClose={() => {}} />);
    expect(screen.queryByTestId('create-continue')).toBeNull();
  });
});
