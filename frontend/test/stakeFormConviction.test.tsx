import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Side, PhaseView } from '@/lib/types';
import type { Market } from '@/lib/markets';

// StakeWithSideForm against a FeeArena **v2** market: it must render a conviction USDC input bounded
// [minConv,maxConv], validate it inline, gate submit until a valid conviction is entered, and submit
// via useStakeWithConviction with { tokenId, side, conviction } in 6dp base units. A read-only legacy
// market must block staking entirely.

const v2Stake = vi.fn();
const v1Stake = vi.fn();

const V2_MARKET: Market = {
  id: 'btc', label: 'BTC / USDC', baseSymbol: 'cirBTC', baseDecimals: 8,
  feeArena: '0xaeb33d3bfd63e4c330bb78a0a0b249e53daa5c68',
  oracle: '0xf8ac3c46a062acc1d4c1ba23158bd0ef7242688e',
  pool: '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b',
  feedId: `0x${'e'.repeat(64)}`, fromBlock: 0n,
  version: 'v2',
  lens: '0xa0db836f8a24781b5a4f457924c9860dfe2a80b9',
  treasury: '0x891b0000000000000000000000000000000000ab',
  minConv: 100_000000n, maxConv: 1_000_000000n,
};
const LEGACY_MARKET: Market = { ...V2_MARKET, id: 'btc-v1', version: 'v1', readOnly: true, lens: undefined };

const activeMarket = vi.hoisted(() => ({ current: undefined as Market | undefined }));

vi.mock('wagmi', () => ({ useAccount: () => ({ isConnected: true }) }));
vi.mock('@/hooks/useStakeWithSide', () => ({ useStakeWithSide: () => ({ stake: v1Stake, isPending: false, error: undefined }) }));
vi.mock('@/hooks/useStakeWithConviction', () => ({ useStakeWithConviction: () => ({ stake: v2Stake, isPending: false, error: undefined }) }));
vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: () => ({ data: { phase: PhaseView.EntryOpen } }) }));
vi.mock('@/hooks/useUserStakes', () => ({ useUserStakes: () => ({ data: [] }) }));
vi.mock('@/components/MarketProvider', () => ({ useActiveMarket: () => activeMarket.current }));
vi.mock('@/components/PositionPicker', () => ({
  PositionPicker: ({ onSelect }: { onSelect: (id: bigint) => void }) => (
    <button data-testid="pick" onClick={() => onSelect(42n)}>pick</button>
  ),
}));

import { StakeWithSideForm } from '@/components/StakeWithSideForm';

afterEach(() => {
  cleanup();
  v2Stake.mockReset();
  v1Stake.mockReset();
  activeMarket.current = undefined;
});

describe('StakeWithSideForm — FeeArena v2 conviction', () => {
  it('renders the conviction input + at-risk explainer for a v2 market', () => {
    activeMarket.current = V2_MARKET;
    render(<StakeWithSideForm />);
    expect(screen.getByTestId('conviction-input')).toBeTruthy();
    expect(screen.getByTestId('conviction-explainer').textContent).toMatch(/at-risk conviction/i);
    expect(screen.getByTestId('conviction-explainer').textContent).toMatch(/burned to the treasury/i);
  });

  it('keeps submit disabled until position + side + valid conviction + ack, then stakes with conviction', () => {
    activeMarket.current = V2_MARKET;
    render(<StakeWithSideForm />);
    const submit = () => screen.getByTestId('stake-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);

    fireEvent.click(screen.getByTestId('pick'));
    fireEvent.click(screen.getByTestId(`side-${Side.UP}`));
    fireEvent.click(screen.getByTestId('risk-ack'));
    // Still disabled: no conviction yet.
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId('conviction-input'), { target: { value: '250' } });
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    expect(v2Stake).toHaveBeenCalledWith({ tokenId: 42n, side: Side.UP, conviction: 250_000000n });
    expect(v1Stake).not.toHaveBeenCalled();
  });

  it('shows an inline bounds error and keeps submit disabled for an out-of-bounds conviction', () => {
    activeMarket.current = V2_MARKET;
    render(<StakeWithSideForm />);
    fireEvent.click(screen.getByTestId('pick'));
    fireEvent.click(screen.getByTestId(`side-${Side.UP}`));
    fireEvent.click(screen.getByTestId('risk-ack'));

    fireEvent.change(screen.getByTestId('conviction-input'), { target: { value: '50' } }); // below min
    expect(screen.getByTestId('conviction-error').textContent).toMatch(/at least|min/i);
    expect((screen.getByTestId('stake-submit') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId('conviction-input'), { target: { value: '5000' } }); // above max
    expect(screen.getByTestId('conviction-error').textContent).toMatch(/at most|max/i);
    expect((screen.getByTestId('stake-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks staking entirely on a read-only legacy market', () => {
    activeMarket.current = LEGACY_MARKET;
    render(<StakeWithSideForm />);
    expect(screen.getByTestId('readonly-market')).toBeTruthy();
    expect(screen.queryByTestId('stake-submit')).toBeNull();
    expect(screen.queryByTestId('conviction-input')).toBeNull();
  });
});
