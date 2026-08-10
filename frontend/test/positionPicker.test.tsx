import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// Live-ish pool slot0 (positional tuple) — the picker reads the CURRENT tick for the in/out-of-range
// hint. Reconfigured per test (ETH-market tests use tick 0; the BTC range tests use the live -64580).
const slot0State = { current: [2n ** 96n, 0, 0, 0, 0, 0, true] as unknown };

// collect(max,max) returns ADDRESS-SORTED [amount0, amount1]. We use distinguishable values:
//   amount0 = 2e18 (looks like an 18dp WETH amount), amount1 = 6_000000 (looks like 6dp USDC).
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  useSimulateContract: () => ({ data: { result: [2_000000000000000000n, 6_000000n] }, isLoading: false }),
  useReadContract: (cfg: { functionName?: string }) =>
    cfg.functionName === 'slot0' ? { data: slot0State.current } : { data: undefined },
}));
// Owned-positions result is reconfigured per test via this holder so we can exercise the empty state.
// Default: one FULL-RANGE position (±887220 for spacing 60).
const ownedPositionsMock = vi.fn(() => ({
  data: [{ tokenId: 42n, liquidity: 1000n, tickLower: -887220, tickUpper: 887220 }],
  isLoading: false,
}));
vi.mock('@/hooks/useOwnedPositions', () => ({
  useOwnedPositions: () => ownedPositionsMock(),
}));
// Prevent ENV access in tests
vi.mock('@/lib/contracts', () => ({
  npmContract: { address: '0x0000000000000000000000000000000000000001', abi: [] },
  useMarketContracts: () => ({ pool: { address: '0x00000000000000000000000000000000000000bb', abi: [] } }),
}));
vi.mock('@/lib/env', () => ({ ENV: { FEE_TIER: 3000 } }));
vi.mock('@/hooks/useMintPosition', () => ({ tickSpacingForFee: () => 60 }));
vi.mock('@/lib/chain', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
}));

// useActiveBaseToken classifies base vs USDC; the mock is reconfigured per test via this holder.
const baseTokenMock = vi.fn();
vi.mock('@/hooks/useActiveBaseToken', () => ({
  useActiveBaseToken: () => baseTokenMock(),
}));

// BaseAmount reads the active market's baseDecimals/baseSymbol via useActiveMarket — stub it so the
// rendered base leg is formatted with a deterministic decimals/symbol per test.
const activeMarketMock = vi.fn();
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => activeMarketMock(),
}));

import { PositionPicker } from '@/components/PositionPicker';
// PURE display helper (unmocked) — expected band strings flow through the same lib the row uses.
import { bandLabel } from '@/lib/rangeDisplay';

afterEach(() => {
  cleanup();
  slot0State.current = [2n ** 96n, 0, 0, 0, 0, 0, true];
});

describe('PositionPicker', () => {
  it('selects a row and shows simulated pending fees (default ETH market: base IS token0)', () => {
    baseTokenMock.mockReturnValue({
      address: '0xeeee000000000000000000000000000000000000',
      decimals: 18,
      symbol: 'WETH',
      baseIsToken0: true,
      isLoading: false,
    });
    activeMarketMock.mockReturnValue({ baseDecimals: 18, baseSymbol: 'WETH' });

    const onSelect = vi.fn();
    render(<PositionPicker onSelect={onSelect} />);
    const row = screen.getByTestId('position-42');
    expect(row.textContent).toContain('pending');
    // base leg (amount0 = 2e18) renders as WETH; USDC leg (amount1 = 6e6) renders as USDC.
    expect(row.textContent).toContain('WETH');
    expect(row.textContent).toContain('2'); // 2 WETH
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(42n);
  });

  it('maps the base leg by baseIsToken0 when USDC sorts as token0 (BTC market)', () => {
    // BTC market where USDC sorts FIRST: base is token1. The collect tuple is [amount0, amount1] =
    // [2e18, 6_000000] (from the wagmi mock). With baseIsToken0=false the BASE leg must read amount1
    // (6_000000 -> 0.06 WBTC at 8dp) and the USDC leg amount0 — i.e. the legs swap vs the ETH case.
    baseTokenMock.mockReturnValue({
      address: '0xbbbb000000000000000000000000000000000000',
      decimals: 8,
      symbol: 'WBTC',
      baseIsToken0: false,
      isLoading: false,
    });
    activeMarketMock.mockReturnValue({ baseDecimals: 8, baseSymbol: 'WBTC' });

    const onSelect = vi.fn();
    render(<PositionPicker onSelect={onSelect} />);
    const row = screen.getByTestId('position-42');
    // Base leg = amount1 (6_000000) formatted at 8dp -> "0.06 WBTC".
    expect(row.textContent).toContain('0.06 WBTC');
    // The wrong (un-remapped) behavior would have shown amount0 (2e18) as the base leg — a huge
    // 2000000000000 number at 8dp. Assert the base leg is NOT that.
    expect(row.textContent).not.toMatch(/2000000000000\s*WBTC/);
  });

  it('labels a full-range row "Full range · in range" (range info per row, no warning)', () => {
    baseTokenMock.mockReturnValue({
      address: '0xeeee000000000000000000000000000000000000',
      decimals: 18,
      symbol: 'WETH',
      baseIsToken0: true,
      isLoading: false,
    });
    activeMarketMock.mockReturnValue({ baseDecimals: 18, baseSymbol: 'WETH' });

    render(<PositionPicker onSelect={vi.fn()} />);
    const range = screen.getByTestId('position-range-42');
    expect(range.textContent).toContain('Full range');
    expect(range.textContent).toContain('in range');
    expect(screen.queryByTestId('position-range-oor-42')).toBeNull();
  });

  it('flags an out-of-range row with an amber no-arena-contribution note but does NOT block selecting it', () => {
    // Live BTC market: slot0 tick -64580 (≈63,753 USDC/cirBTC), USDC sorts as token0 (baseIsToken0=false).
    slot0State.current = [3137823051102157504608244265n, -64580, 0, 0, 0, 0, true];
    baseTokenMock.mockReturnValue({
      address: '0xbbbb000000000000000000000000000000000000',
      decimals: 8,
      symbol: 'WBTC',
      baseIsToken0: false,
      isLoading: false,
    });
    activeMarketMock.mockReturnValue({ baseDecimals: 8, baseSymbol: 'WBTC' });
    // Band entirely ABOVE the live tick in raw tick space (-64580 < -63960) -> out of range.
    ownedPositionsMock.mockReturnValueOnce({
      data: [{ tokenId: 42n, liquidity: 1000n, tickLower: -63960, tickUpper: -63000 }],
      isLoading: false,
    });

    const onSelect = vi.fn();
    render(<PositionPicker onSelect={onSelect} />);
    // The row shows the band as human prices (through the same inversion-correct lib).
    expect(screen.getByTestId('position-range-42').textContent).toContain(
      bandLabel(-63960, -63000, 6, 8, false),
    );
    const note = screen.getByTestId('position-range-oor-42');
    expect(note.textContent).toMatch(/out of range/i);
    expect(note.textContent).toMatch(/no Stance contribution/i);
    // Informational only — the contract accepts any range, so selection still works.
    fireEvent.click(screen.getByTestId('position-42'));
    expect(onSelect).toHaveBeenCalledWith(42n);
  });

  it('falls back to an explicit range-status hint when slot0 is unavailable (no silent omission)', () => {
    // slot0 never resolved (RPC failure) — the row must SAY the status is unknown rather than
    // silently dropping both the "in range" suffix and the out-of-range warning.
    slot0State.current = undefined;
    baseTokenMock.mockReturnValue({
      address: '0xeeee000000000000000000000000000000000000',
      decimals: 18,
      symbol: 'WETH',
      baseIsToken0: true,
      isLoading: false,
    });
    activeMarketMock.mockReturnValue({ baseDecimals: 18, baseSymbol: 'WETH' });

    render(<PositionPicker onSelect={vi.fn()} />);
    const range = screen.getByTestId('position-range-42');
    expect(range.textContent).toContain('range status unavailable');
    expect(range.textContent).not.toContain('in range');
    expect(screen.queryByTestId('position-range-oor-42')).toBeNull();
  });

  it('empty state guides the user to Provide liquidity (no dead "minted out-of-band" copy)', () => {
    baseTokenMock.mockReturnValue({ address: '0xeeee000000000000000000000000000000000000', decimals: 18, symbol: 'WETH', baseIsToken0: true, isLoading: false });
    activeMarketMock.mockReturnValue({ baseDecimals: 18, baseSymbol: 'WETH' });
    ownedPositionsMock.mockReturnValueOnce({ data: [], isLoading: false });

    render(<PositionPicker onSelect={vi.fn()} />);
    const empty = screen.getByTestId('position-picker-empty');
    // Points at the on-ramp panel instead of the old dead-end.
    expect(empty.textContent).toMatch(/Provide liquidity/i);
    expect(empty.textContent).not.toMatch(/minted out-of-band/i);
    const link = empty.querySelector('a');
    expect(link?.getAttribute('href')).toBe('#provide-liquidity');
  });
});
