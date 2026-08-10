import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { PhaseView, Side } from '@/lib/types';

const claim = vi.fn();
const unstake = vi.fn();
const refundConviction = vi.fn();
let phase = PhaseView.Running;
let swept = false;
let IS_V2 = false;
let IS_V3 = false;
let IS_WINNER = true;
let REFUNDABLE = true;
let HAS_CREDIT = false;
let V3_WON = true; // v3: did the position's call resolve correct?
let V3_HAS_REWARD = true; // v3: did it produce fees / is there a pot share to claim?

vi.mock('wagmi', () => ({ useAccount: () => ({ address: '0x1', isConnected: true }) }));
vi.mock('@/components/MarketProvider', () => ({ useActiveMarket: () => ({ id: 'm' }) }));
vi.mock('@/lib/markets', () => ({ isV2Market: () => IS_V2, isV3Market: () => IS_V3 }));
// ClaimUnstakePanel resolves the quote symbol via lib/tokens (eager ENV at module load); pin it to USDC.
vi.mock('@/lib/tokens', () => ({
  quoteToken: () => ({ symbol: 'USDC', address: '0x3600000000000000000000000000000000000000', decimals: 6 }),
}));
vi.mock('@/hooks/useUserStakes', () => ({
  // The stake carries the v3 extras on `.v3` (ignored by the v1/v2 rows); side RANGE matches the bug report.
  useUserStakes: () => ({ data: [{ tokenId: 42n, owner: '0x1', epochId: 9n, side: IS_V3 ? Side.RANGE : Side.UP, swept, claimed: false, unstaked: false, feeWETH: 0n, feeUSDC: 0n, contribution6: 8000_000000n, v3: { entryPrice18: 63_797_000000000000000000n, entryTime: 1n, processed: phase === PhaseView.Settled, won: V3_WON } }] }),
}));
vi.mock('@/hooks/useEpoch', () => ({ useEpoch: () => ({ data: { phase, rolledOver: false, settlePrice18: 63_803_000000000000000000n } }) }));
vi.mock('@/hooks/usePreviewClaim', () => ({ usePreviewClaim: () => ({ data: IS_V3
  ? { claimable: V3_WON && V3_HAS_REWARD && phase === PhaseView.Settled, isWinner: V3_WON, alreadyClaimed: false, payWETH: V3_HAS_REWARD ? 1n : 0n, payUSDC: V3_HAS_REWARD ? 2n : 0n, v3: { changeBps: 1n, ownFeeBase: 0n, ownFeeUSDC: V3_HAS_REWARD ? 2n : 0n, potShareBase: 0n, potShareUSDC: 0n } }
  : { claimable: IS_WINNER && phase === PhaseView.Settled && swept, isWinner: IS_WINNER, alreadyClaimed: false, payWETH: 1n, payUSDC: 2n, contribution6: 8000_000000n, winnerDenominator: 8000_000000n } }) }));
vi.mock('@/hooks/usePreviewRefund', () => ({ usePreviewRefund: () => ({ data: { refundable: IS_WINNER && REFUNDABLE && phase === PhaseView.Settled, amount: 5_000000n } }) }));
vi.mock('@/hooks/useSweepProgress', () => ({ useSweepProgress: () => ({ data: { done: swept ? 3 : 0, total: 3 } }) }));
vi.mock('@/hooks/useClaim', () => ({ useClaim: () => ({ claim, isPending: false }) }));
vi.mock('@/hooks/useRefundConviction', () => ({ useRefundConviction: () => ({ refundConviction, isPending: false }) }));
vi.mock('@/hooks/useUnstake', () => ({ useUnstake: () => ({ unstake, isPending: false }) }));
// useIsEmbeddedWallet imports lib/embedded/connector (eager ENV via @/lib/chain); stub it so this unit
// test needs no env. (Injected wallet => the Circle strip stays neutral.)
vi.mock('@/hooks/useIsEmbeddedWallet', () => ({ useIsEmbeddedWallet: () => false }));
vi.mock('@/hooks/useWithdrawCredited', () => ({ useWithdrawCredited: () => ({ owedUSDC: HAS_CREDIT ? 7_000000n : 0n, owedWETH: 0n, hasCredit: HAS_CREDIT, withdraw: vi.fn(), isPending: false }) }));
vi.mock('@/components/MoneyAmount', () => ({
  MoneyAmount: ({ value }: { value: bigint }) => <span>{value.toString()}</span>,
  BaseAmount: ({ value }: { value: bigint }) => <span>{value.toString()}</span>,
}));
vi.mock('@/components/TxButton', () => ({
  TxButton: ({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) => (
    <button data-testid={`tx-${label}`} disabled={disabled} onClick={onClick}>{label}</button>
  ),
}));

import { ClaimUnstakePanel } from '@/components/ClaimUnstakePanel';

beforeEach(() => {
  phase = PhaseView.Running; swept = false; IS_V2 = false; IS_V3 = false; IS_WINNER = true; REFUNDABLE = true; HAS_CREDIT = false;
  V3_WON = true; V3_HAS_REWARD = true;
  claim.mockReset(); unstake.mockReset(); refundConviction.mockReset();
});
afterEach(cleanup);

describe('ClaimUnstakePanel — v1', () => {
  it('shows wedged-epoch lock and disables both buttons when not Settled', () => {
    render(<ClaimUnstakePanel />);
    expect(screen.getByText(/Locked until the operator settles epoch #9/)).toBeTruthy();
    expect((screen.getByTestId('tx-Claim') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('tx-Unstake') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Claim once Settled + sweepDone + winner', () => {
    phase = PhaseView.Settled;
    swept = true;
    render(<ClaimUnstakePanel />);
    const btn = screen.getByTestId('tx-Claim') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(claim).toHaveBeenCalledWith({ epochId: 9n, tokenId: 42n });
    expect((screen.getByTestId('tx-Unstake') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ClaimUnstakePanel — v2 collect flow', () => {
  beforeEach(() => { IS_V2 = true; });

  it('a settled winner shows a Collect button that fires BOTH claim and refundConviction', async () => {
    phase = PhaseView.Settled; swept = true; IS_WINNER = true; REFUNDABLE = true;
    render(<ClaimUnstakePanel />);
    const btn = screen.getByTestId('tx-Collect') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    // v2 must NOT render a v1 'Claim' button.
    expect(screen.queryByTestId('tx-Claim')).toBeNull();
    fireEvent.click(btn);
    await Promise.resolve();
    expect(claim).toHaveBeenCalledWith({ epochId: 9n, tokenId: 42n });
    expect(refundConviction).toHaveBeenCalledWith({ epochId: 9n, tokenId: 42n });
  });

  it('a settled LOSER sees the forfeited/burned message, NO collect/refund affordance, but can unstake', () => {
    phase = PhaseView.Settled; swept = true; IS_WINNER = false; REFUNDABLE = false;
    render(<ClaimUnstakePanel />);
    expect(screen.getByText(/forfeited \(burned\)/i)).toBeTruthy();
    expect(screen.queryByTestId('tx-Collect')).toBeNull();
    expect(screen.queryByText(/refund/i)).toBeNull(); // never imply a refund for a loser
    expect((screen.getByTestId('tx-Unstake') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Collect is disabled before settlement', () => {
    phase = PhaseView.Running; swept = false;
    render(<ClaimUnstakePanel />);
    expect((screen.getByTestId('tx-Collect') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders the deferred-payout (withdrawCredited) banner only when there is credit', () => {
    phase = PhaseView.Settled; swept = true; HAS_CREDIT = true;
    render(<ClaimUnstakePanel />);
    expect(screen.getByTestId('deferred-payout-banner')).toBeTruthy();
    expect(screen.getByTestId('tx-Withdraw credited')).toBeTruthy();
  });

  it('hides the deferred-payout banner when nothing is credited', () => {
    phase = PhaseView.Settled; swept = true; HAS_CREDIT = false;
    render(<ClaimUnstakePanel />);
    expect(screen.queryByTestId('deferred-payout-banner')).toBeNull();
  });
});

describe('ClaimUnstakePanel — v3 (entry-anchored) claim honesty', () => {
  beforeEach(() => { IS_V3 = true; });

  it('a settled winner WITH fees shows an enabled Claim that pays the owner', () => {
    phase = PhaseView.Settled; V3_WON = true; V3_HAS_REWARD = true;
    render(<ClaimUnstakePanel />);
    const btn = screen.getByTestId('tx-Claim') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(claim).toHaveBeenCalledWith({ epochId: 9n, tokenId: 42n });
    expect(screen.getByText(/claim your fees plus your share/i)).toBeTruthy();
  });

  it('a settled winner with NO fees shows "Nothing to claim" + an honest message, NOT a dead Claim (the bug)', () => {
    phase = PhaseView.Settled; V3_WON = true; V3_HAS_REWARD = false;
    render(<ClaimUnstakePanel />);
    // No dead "Claim" button — a clear "Nothing to claim" affordance instead (exact-match the chip,
    // since the explanatory sentence below also contains the phrase "nothing to claim").
    expect(screen.queryByTestId('tx-Claim')).toBeNull();
    expect(screen.getByText('Nothing to claim')).toBeTruthy();
    // The message explains WHY (no fees generated this epoch), not a false promise of a reward.
    expect(screen.getByText(/no fees were generated during this epoch/i)).toBeTruthy();
    expect(screen.queryByText(/claim your fees plus your share/i)).toBeNull();
  });

  it('a settled non-qualifying position sees the did-not-qualify message and no claim affordance', () => {
    phase = PhaseView.Settled; V3_WON = false; V3_HAS_REWARD = false;
    render(<ClaimUnstakePanel />);
    expect(screen.queryByTestId('tx-Claim')).toBeNull();
    expect(screen.queryByText(/Nothing to claim/i)).toBeNull(); // non-qualifying positions get no claim affordance
    expect(screen.getByText(/did not qualify against your entry reference price/i)).toBeTruthy();
  });
});
