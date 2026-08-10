import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
// Type-only (erased at runtime — does NOT execute lib/pools, which would read unmocked ENV).
import type { PoolInfo } from '@/lib/pools';

// The selected pair the positions list + cards are scoped to (token0 = USDC → baseIsToken0 = false,
// matching the live cirBTC/USDC orientation the fee-mapping + band assertions rely on).
const POOL: PoolInfo = {
  id: 'cirbtc-usdc',
  address: '0x00000000000000000000000000000000000000bb',
  feeTier: 3000,
  base: { symbol: 'cirBTC', address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', decimals: 8 },
  quote: { symbol: 'USDC', address: '0x0000000000000000000000000000000000000002', decimals: 6 },
  token0: { symbol: 'USDC', address: '0x0000000000000000000000000000000000000002', decimals: 6 },
  token1: { symbol: 'cirBTC', address: '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf', decimals: 8 },
  baseIsToken0: false,
};

// YourLiquidity (the off-ramp) lists the connected wallet's withdrawable LP positions for the active
// pool (via useOwnedPositions, which excludes already-staked positions) and offers a per-position
// "Withdraw" button that calls useRemoveLiquidity(tokenId).remove. We verify: (a) each owned position
// is listed by id with its liquidity, (b) clicking Withdraw invokes remove({ tokenId }) for that row,
// (c) the empty state renders when the wallet owns none, and (d) each card shows its REAL range badge
// ("Full range" or its min–max USDC band from the position's ticks) plus an In range / Out of range
// status chip vs the pool's live tick (live cirBTC/USDC vector: slot0 tick -64580, baseIsToken0=false).

const remove = vi.fn(async () => '0xhash');
vi.mock('@/hooks/useRemoveLiquidity', () => ({
  useRemoveLiquidity: () => ({ remove, isPending: false, error: undefined, hash: undefined }),
}));

// Collect-fees (the LP-only "claim"): the action hook + the polled accrued-fees read. positionFeesMock
// is reconfigurable per test so we can exercise the has-fees (enabled) vs no-fees (disabled) states.
// Default: 0/0 so the unclaimed-fees line reads "none yet" (keeps the no-"≈" fallback test valid).
const collect = vi.fn(async () => '0xcollecthash');
const positionFeesMock = vi.fn<() => { data: { amount0: bigint; amount1: bigint } | undefined }>(() => ({
  data: { amount0: 0n, amount1: 0n },
}));
vi.mock('@/hooks/useCollectFees', () => ({
  useCollectFees: () => ({ collect, isPending: false, error: undefined, hash: undefined }),
  usePositionFees: () => positionFeesMock(),
}));

// Live cirBTC/USDC pool slot0 (positional tuple): sqrtPriceX96 + tick -64580 (~63,753 USDC/cirBTC).
const POOL_TICK = -64580;
const slot0State = { current: [3137823051102157504608244265n, POOL_TICK, 0, 0, 0, 0, true] as unknown };

// The position cards read the pool handle + tick spacing through these (pure pass-throughs here).
vi.mock('@/lib/contracts', () => ({
  useMarketContracts: () => ({ pool: { address: '0x00000000000000000000000000000000000000bb', abi: [] } }),
}));
vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 5042002 }, GAS_FLOOR_WEI: 20_000_000_000n }));
vi.mock('@/hooks/useMintPosition', () => ({ tickSpacingForFee: () => 60 }));

// useRemoveQuote simulates the remove path per position and returns the estimated base + USDC that
// would land in the wallet. Reconfigured per test to exercise loaded / loading / error states.
const removeQuoteMock = vi.fn();
vi.mock('@/hooks/useRemoveQuote', () => ({ useRemoveQuote: () => removeQuoteMock() }));

// The position card labels each row with the active pair ("cirBTC / USDC") via useActiveBaseToken.
vi.mock('@/hooks/useActiveBaseToken', () => ({
  useActiveBaseToken: () => ({ address: '0xbase', decimals: 8, symbol: 'cirBTC', baseIsToken0: false, isLoading: false }),
}));

// Pool fee tier (drives the "0.3%" fee-tier badge on each position card).
vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app', FEE_TIER: 3000 } }));

// Owned-positions result is reconfigured per test via this holder so we can exercise the empty state.
// Position 42 is FULL RANGE (±887220, spacing 60); position 7 holds the verified custom band
// {-65280, -63960} = customTicks(60000, 68000, 6, 8, false, 60), straddling the live tick -64580.
const DEFAULT_POSITIONS = [
  { tokenId: 42n, liquidity: 1000n, tickLower: -887220, tickUpper: 887220 },
  { tokenId: 7n, liquidity: 5n, tickLower: -65280, tickUpper: -63960 },
];
const ownedPositionsMock = vi.fn(() => ({
  data: DEFAULT_POSITIONS,
  isLoading: false,
}));
vi.mock('@/hooks/useOwnedPositions', () => ({ useOwnedPositions: () => ownedPositionsMock() }));

// Reconfigurable connection state so we can exercise the connected list AND the disconnected empty state
// (the disconnected state renders the wallet <Connect/> control, which reads useConnect/useDisconnect/useBalance).
const accountState = { current: { isConnected: true, address: '0x1111111111111111111111111111111111111111' } as { isConnected: boolean; address?: string } };
vi.mock('wagmi', () => ({
  useAccount: () => accountState.current,
  useConnect: () => ({ connect: vi.fn(), connectors: [{ id: 'injected' }], isPending: false, error: undefined }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useBalance: () => ({ data: undefined }),
  useReadContract: (cfg: { functionName?: string }) =>
    cfg.functionName === 'slot0' ? { data: slot0State.current } : { data: undefined },
}));

import { YourLiquidity } from '@/components/YourLiquidity';
// PURE display helpers (unmocked) — the expected band string flows through the same lib the card uses.
import { bandLabel } from '@/lib/rangeDisplay';

// A loaded estimate: cirBTC base = 123 raw @ 8dp -> "0.00000123"; USDC = 9600 raw @ 6dp -> "0.0096".
const LOADED_QUOTE = {
  base: 123n,
  usdc: 9600n,
  baseDecimals: 8,
  baseSymbol: 'cirBTC',
  isLoading: false,
  isError: false,
};

beforeEach(() => {
  removeQuoteMock.mockReturnValue(LOADED_QUOTE);
});

afterEach(() => {
  cleanup();
  remove.mockClear();
  collect.mockClear();
  positionFeesMock.mockReset();
  positionFeesMock.mockReturnValue({ data: { amount0: 0n, amount1: 0n } });
  removeQuoteMock.mockReset();
  ownedPositionsMock.mockReset();
  ownedPositionsMock.mockReturnValue({ data: DEFAULT_POSITIONS, isLoading: false });
  accountState.current = { isConnected: true, address: '0x1111111111111111111111111111111111111111' };
});

describe('YourLiquidity', () => {
  it("lists the wallet's positions with a Withdraw button per row", () => {
    render(<YourLiquidity pool={POOL} />);
    // Both owned positions are listed by id.
    expect(screen.getByTestId('liquidity-row-42')).toBeTruthy();
    expect(screen.getByTestId('liquidity-row-7')).toBeTruthy();
    // Each row has its own Withdraw button.
    expect(screen.getByTestId('withdraw-42')).toBeTruthy();
    expect(screen.getByTestId('withdraw-7')).toBeTruthy();
    // The id is shown.
    expect(screen.getByTestId('liquidity-row-42').textContent).toContain('#42');
  });

  it('shows the estimated base + USDC return per position (formatted at full precision)', () => {
    render(<YourLiquidity pool={POOL} />);
    const row = screen.getByTestId('liquidity-row-42');
    // cirBTC base = 123 raw @ 8dp -> 0.00000123 ; USDC = 9600 raw @ 6dp -> 0.0096.
    expect(row.textContent).toContain('0.00000123 cirBTC');
    expect(row.textContent).toContain('0.0096 USDC');
    // The estimate replaces the meaningless raw liquidity magnitude.
    expect(row.textContent).not.toContain('liquidity: 1000');
  });

  it('falls back to the raw liquidity display when the estimate is unavailable', () => {
    removeQuoteMock.mockReturnValue({
      base: undefined,
      usdc: undefined,
      baseDecimals: 8,
      baseSymbol: 'cirBTC',
      isLoading: false,
      isError: true,
    });
    render(<YourLiquidity pool={POOL} />);
    const row = screen.getByTestId('liquidity-row-42');
    // No crash; degrades to the raw liquidity magnitude rather than showing a bogus estimate.
    expect(row.textContent).toContain('liquidity: 1000');
    // The estimate marker ("≈ … returned") is absent — only the pair label mentions the token now.
    expect(row.textContent).not.toContain('≈');
  });

  it('shows a loading hint while the estimate simulation is in flight', () => {
    removeQuoteMock.mockReturnValue({
      base: undefined,
      usdc: undefined,
      baseDecimals: 8,
      baseSymbol: 'cirBTC',
      isLoading: true,
      isError: false,
    });
    render(<YourLiquidity pool={POOL} />);
    const row = screen.getByTestId('liquidity-row-42');
    expect(row.textContent).toMatch(/estimating|…/i);
    // Does not yet assert a concrete amount while loading.
    expect(row.textContent).not.toContain('0.00000123');
  });

  it('clicking Withdraw invokes remove({ tokenId }) for that position', () => {
    render(<YourLiquidity pool={POOL} />);
    fireEvent.click(screen.getByTestId('withdraw-42'));
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith({ tokenId: 42n });
  });

  it('renders an empty state when the wallet owns no Arena positions', () => {
    ownedPositionsMock.mockReturnValue({ data: [], isLoading: false });
    render(<YourLiquidity pool={POOL} />);
    expect(screen.getByTestId('your-liquidity-empty')).toBeTruthy();
    expect(remove).not.toHaveBeenCalled();
  });

  // ── Collect fees (the "claim" for liquidity-only providers) ───────────────────────

  it('disables Collect fees + shows "none yet" when the position has no accrued fees', () => {
    positionFeesMock.mockReturnValue({ data: { amount0: 0n, amount1: 0n } });
    render(<YourLiquidity pool={POOL} />);
    expect((screen.getByTestId('collect-42') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('fees-42').textContent).toMatch(/none yet/i);
  });

  it('shows the accrued fees (mapped base/USDC by orientation) and enables Collect when fees exist', () => {
    // token0=USDC, token1=cirBTC (baseIsToken0=false): amount0->USDC, amount1->base.
    // amount1 = 1500 raw cirBTC @ 8dp -> 0.000015 ; amount0 = 42000 raw USDC @ 6dp -> 0.042.
    positionFeesMock.mockReturnValue({ data: { amount0: 42_000n, amount1: 1_500n } });
    render(<YourLiquidity pool={POOL} />);
    const fees = screen.getByTestId('fees-42').textContent ?? '';
    expect(fees).toContain('0.000015 cirBTC');
    expect(fees).toContain('0.042 USDC');
    expect((screen.getByTestId('collect-42') as HTMLButtonElement).disabled).toBe(false);
  });

  it('clicking Collect fees invokes collect({ tokenId }) for that position', () => {
    positionFeesMock.mockReturnValue({ data: { amount0: 42_000n, amount1: 1_500n } });
    render(<YourLiquidity pool={POOL} />);
    fireEvent.click(screen.getByTestId('collect-42'));
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect).toHaveBeenCalledWith({ tokenId: 42n });
  });

  // ── Uniswap-style position card: pair label + fee-tier badge ──────────────────────

  it('labels each position card with the active pair and the full-range fee tier', () => {
    render(<YourLiquidity pool={POOL} />);
    const row = screen.getByTestId('liquidity-row-42');
    // The Uniswap-style card shows the pair "cirBTC / USDC" and the 0.30% fee-tier badge
    // (formatBps pads sub-1% values to 2 decimals — 3000 pips / 100 = 30 bps -> "0.30%").
    expect(row.textContent).toContain('cirBTC / USDC');
    expect(row.textContent).toContain('0.30%');
  });

  // ── Empty-state "New position" reveals the create form via onNewPosition ──────────

  it('the empty-state "New position" button invokes onNewPosition', () => {
    ownedPositionsMock.mockReturnValue({ data: [], isLoading: false });
    const onNewPosition = vi.fn();
    render(<YourLiquidity pool={POOL} onNewPosition={onNewPosition} />);
    fireEvent.click(screen.getByTestId('your-liquidity-new-position'));
    expect(onNewPosition).toHaveBeenCalledTimes(1);
  });

  // ── Range badge + in/out-of-range status chip (per-position ticks vs the live tick) ─

  it('shows the position’s REAL band: "Full range" for full-range ticks, its min–max USDC band otherwise', () => {
    render(<YourLiquidity pool={POOL} />);
    // Position 42 covers ±887220 (the whole usable range for spacing 60).
    expect(screen.getByTestId('range-badge-42').textContent).toBe('Full range');
    // Position 7's band renders as human prices through the same lib (inversion-correct: with
    // baseIsToken0=false the LOWER tick is the HIGHER price; bandLabel orders them min – max).
    expect(screen.getByTestId('range-badge-7').textContent).toBe(
      `${bandLabel(-65280, -63960, 6, 8, false)} USDC`,
    );
    // The verified vector: that band is ≈ 60k – 68k USDC.
    expect(screen.getByTestId('range-badge-7').textContent).toMatch(/59,9\d\d|60,0\d\d/);
  });

  it('chips In range (green) when the live tick is inside the band, amber Out of range with a no-fees hint otherwise', () => {
    ownedPositionsMock.mockReturnValue({
      data: [
        // Straddles the live tick -64580 -> in range.
        { tokenId: 42n, liquidity: 1000n, tickLower: -65280, tickUpper: -63960 },
        // Entirely ABOVE the live tick in raw tick space (-64580 < -63960) -> out of range.
        { tokenId: 7n, liquidity: 5n, tickLower: -63960, tickUpper: -63000 },
      ],
      isLoading: false,
    });
    render(<YourLiquidity pool={POOL} />);
    expect(screen.getByTestId('range-status-42').textContent).toBe('In range');
    const oor = screen.getByTestId('range-status-7').textContent ?? '';
    expect(oor).toMatch(/Out of range/);
    expect(oor).toMatch(/earning no fees/i);
  });

  // ── Disconnected state: Uniswap's connect-your-wallet card ────────────────────────

  it('renders the disconnected connect-wallet state when no wallet is connected', () => {
    accountState.current = { isConnected: false };
    const onNewPosition = vi.fn();
    render(<YourLiquidity pool={POOL} onNewPosition={onNewPosition} />);
    expect(screen.getByTestId('your-liquidity-disconnected')).toBeTruthy();
    // The "New position" affordance is still offered from the disconnected state.
    fireEvent.click(screen.getByTestId('your-liquidity-new-position'));
    expect(onNewPosition).toHaveBeenCalledTimes(1);
    // No position rows / no withdraw possible while disconnected.
    expect(screen.queryByTestId('liquidity-row-42')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
});
