import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// SwapForm is now a SINGLE token-pair card across cirBTC / USDC / EURC. It resolves the direct V3 pool
// for the selected pair (lib/pools), quotes client-side from the pool's slot0 + liquidity (lib/swapQuote,
// pure), shows price impact + a slippage floor, and calls useSwap (pool-agnostic). All three pairs are
// tradeable — including cirBTC⇄EURC directly.
//
// Pool fixture (mocked for every pool, by functionName): sqrtPriceX96 = 2·Q96, liquidity = 1e10, fee 0.3%.
// cirBTC address sorts ABOVE USDC (0x3600...) so USDC is token0 — selling cirBTC is !zeroForOne. cirBTC 8dp,
// USDC/EURC 6dp. Hand-worked: selling 1 cirBTC (1e8 raw, !zeroForOne) → 24_801_365 USDC raw = "24.801365",
// 99 bps; selling 5 cirBTC → 504 bps (> 300 → high-impact warning).
const Q96 = 2n ** 96n;
const SQRT_P = 2n * Q96;
const LIQ = 10n ** 10n;
const CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF' as const; // > 0x3600 so USDC is token0
const USDC = '0x3600000000000000000000000000000000000000' as const;
const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a' as const;

const swapFn = vi.fn();
const swapState = vi.hoisted(() => ({
  isPending: false,
  result: undefined as
    | { hash: string; tokenIn: string; tokenOut: string; amountIn: bigint; amountOut: bigint | null }
    | undefined,
}));
const resetFn = vi.fn();
const cirbtcBalance = vi.hoisted(() => ({ current: 10n * 10n ** 8n })); // 10 cirBTC
const usdcBalance = vi.hoisted(() => ({ current: 10_000_000000n })); // 10,000 USDC

vi.mock('@/lib/env', () => ({
  ENV: {
    FEE_TIER: 3000,
    USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
    EURC_ADDRESS: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    WETH_ADDRESS: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF', // cirBTC
    POOL_ADDRESS: '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b',
  },
}));
vi.mock('@/lib/chain', () => ({ ARC_CHAIN_ID: 5042002, arcTestnet: { id: 5042002 } }));
vi.mock('@/abis', () => ({
  quoterV2Abi: [{ type: 'function', name: 'quoteExactInputSingle' }],
  erc20Abi: [{ type: 'function', name: 'balanceOf' }],
  uniswapV3PoolAbi: [{ type: 'function', name: 'slot0' }, { type: 'function', name: 'liquidity' }],
}));
vi.mock('@/hooks/useSwap', () => ({
  useSwap: () => ({
    swap: swapFn,
    isPending: swapState.isPending,
    isApproving: false,
    isSwapping: false,
    isSuccess: !!swapState.result,
    result: swapState.result,
    reset: resetFn,
    error: undefined,
  }),
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true }),
  // The exact-quote hook reads through this. These cases deliberately exercise the FALLBACK path
  // (the mocked env has no quoter address), so the local estimate is what the assertions below see.
  usePublicClient: () => ({ simulateContract: async () => ({ result: [0n, 0n, 0, 0n] }) }),
  useReadContract: (cfg: { functionName?: string; address?: string }) => {
    switch (cfg?.functionName) {
      case 'slot0':
        return { data: [SQRT_P, 0, 0, 0, 0, 0, true] };
      case 'liquidity':
        return { data: LIQ };
      case 'balanceOf':
        return { data: cfg.address === USDC ? usdcBalance.current : cfg.address === CIRBTC ? cirbtcBalance.current : 0n };
      default:
        return { data: undefined };
    }
  },
}));

import { SwapForm } from '@/components/SwapForm';

const symbolOf = (el: HTMLElement) => (el.textContent ?? '').replace(/[₿$€]/g, '').trim();
function openSettings() {
  fireEvent.click(screen.getByTestId('swap-settings-toggle'));
  return screen.getByTestId('swap-settings-popover');
}

beforeEach(() => {
  swapFn.mockReset();
  resetFn.mockReset();
  swapState.isPending = false;
  swapState.result = undefined;
  cirbtcBalance.current = 10n * 10n ** 8n;
  usdcBalance.current = 10_000_000000n;
});
afterEach(cleanup);

describe('SwapForm (token-pair)', () => {
  it('renders the single swap card with cirBTC → USDC as the default pair', () => {
    render(<SwapForm />);
    expect(screen.getByTestId('swap-form')).toBeTruthy();
    expect(screen.getByTestId('swap-tab').textContent).toBe('Swap');
    expect(symbolOf(screen.getByTestId('swap-from'))).toBe('cirBTC');
    expect(symbolOf(screen.getByTestId('swap-to'))).toBe('USDC');
    expect((screen.getByTestId('swap-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('swap-submit').textContent).toBe('Enter an amount');
    expect(screen.getByTestId('swap-amount-out').textContent).toBe('0');
  });

  it('computes a live quote from the mocked pool state for a hand-worked input', () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '1' } });
    // Slippage now defaults to Auto; pick the 1% preset so the floor below stays hand-checkable.
    openSettings();
    fireEvent.click(screen.getByTestId('swap-slippage-100'));
    expect(screen.getByTestId('swap-amount-out').textContent).toBe('24.801365');
    expect(screen.getByTestId('swap-price-impact').textContent).toBe('0.99%');
    expect(screen.getByTestId('swap-min-received').textContent).toContain('24.553351');
    expect((screen.getByTestId('swap-submit') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('swap-submit').textContent).toBe('Swap');
  });

  it('flips the From/To tokens when the flip button is clicked', () => {
    render(<SwapForm />);
    fireEvent.click(screen.getByTestId('swap-flip'));
    expect(symbolOf(screen.getByTestId('swap-from'))).toBe('USDC');
    expect(symbolOf(screen.getByTestId('swap-to'))).toBe('cirBTC');
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '100' } });
    expect(parseFloat(screen.getByTestId('swap-amount-out').textContent ?? '')).toBeGreaterThan(0);
  });

  it('lets the user pick EURC to form the cirBTC ⇄ EURC pair (direct pool)', () => {
    render(<SwapForm />);
    // Open the "You receive" selector and choose EURC.
    fireEvent.click(screen.getByTestId('swap-to'));
    fireEvent.click(screen.getByTestId('swap-to-opt-EURC'));
    expect(symbolOf(screen.getByTestId('swap-from'))).toBe('cirBTC');
    expect(symbolOf(screen.getByTestId('swap-to'))).toBe('EURC');
    // The cirBTC/EURC pool resolves + quotes a positive output (no "no pool" CTA).
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '1' } });
    expect(parseFloat(screen.getByTestId('swap-amount-out').textContent ?? '')).toBeGreaterThan(0);
    expect(screen.getByTestId('swap-submit').textContent).toBe('Swap');
  });

  it('disables Swap + shows an insufficient-balance message when over balance', () => {
    cirbtcBalance.current = 1n * 10n ** 8n;
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5' } });
    expect((screen.getByTestId('swap-submit') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('swap-insufficient').textContent).toMatch(/Insufficient cirBTC/i);
    expect(screen.getByTestId('swap-submit').textContent).toBe('Insufficient cirBTC');
  });

  it('hides the insufficient-balance warning while a swap is in progress (no false flash)', () => {
    cirbtcBalance.current = 1n * 10n ** 8n; // 1 cirBTC
    swapState.isPending = true;
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5' } }); // over balance
    expect(screen.queryByTestId('swap-insufficient')).toBeNull();
    expect(screen.getByTestId('swap-submit').textContent).toBe('Swapping…');
  });

  // A huge trade used to be refused outright, which on a thin pool meant it simply could not be
  // done. It now states the number and asks for consent, because it is the user's trade to make.
  it('asks for consent on a pool-moving swap instead of refusing it', () => {
    cirbtcBalance.current = 100_000n * 10n ** 8n; // plenty of balance, so this is not an "insufficient" block
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5000' } });

    const submit = () => screen.getByTestId('swap-submit') as HTMLButtonElement;
    expect(submit().disabled).toBe(true);
    expect(submit().textContent).toBe('Confirm the price impact');
    // The consent names the expected output, not just the impact.
    expect(screen.getByTestId('swap-impact-consent').textContent).toMatch(/would receive about/);

    fireEvent.click(screen.getByTestId('swap-impact-consent-input'));
    expect(submit().disabled).toBe(false);
    expect(submit().textContent).toBe('Swap');
  });

  // Two amber boxes saying the same thing read like two separate problems.
  it('shows one warning, not two, once consent is being asked for', () => {
    cirbtcBalance.current = 100_000n * 10n ** 8n;
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5000' } });
    expect(screen.getByTestId('swap-impact-consent')).toBeTruthy();
    expect(screen.queryByTestId('swap-impact-warning')).toBeNull();
  });

  it('still warns on a merely high impact, where no consent is required', () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5' } });
    expect(screen.getByTestId('swap-impact-warning')).toBeTruthy();
    expect(screen.queryByTestId('swap-impact-consent')).toBeNull();
  });

  it('drops the consent when the trade changes, so it is never carried over', () => {
    cirbtcBalance.current = 100_000n * 10n ** 8n;
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5000' } });
    fireEvent.click(screen.getByTestId('swap-impact-consent-input'));
    expect((screen.getByTestId('swap-submit') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '6000' } });
    expect((screen.getByTestId('swap-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the high-impact warning for a large input', () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '5' } });
    expect(screen.getByTestId('swap-impact-warning')).toBeTruthy();
    expect(screen.getByTestId('swap-price-impact').textContent).toBe('5.04%');
  });

  it('Max fills the input from the from-token balance', () => {
    cirbtcBalance.current = 3n * 10n ** 8n;
    render(<SwapForm />);
    fireEvent.click(screen.getByTestId('swap-max'));
    expect((screen.getByTestId('swap-amount-input') as HTMLInputElement).value).toBe('3');
  });

  it('moves slippage into the gear popover (opens, toggles a preset, closes on Escape)', () => {
    render(<SwapForm />);
    expect(screen.queryByTestId('swap-settings-popover')).toBeNull();
    const popover = openSettings();
    // Auto is the default now: it reads the quote's quality and widens only when it must.
    expect(within(popover).getByTestId('swap-slippage-auto').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(popover).getByTestId('swap-slippage-50'));
    expect(screen.getByTestId('swap-slippage-auto').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('swap-slippage-50').getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('swap-settings-popover')).toBeNull();
  });

  it('calls useSwap with the right tokenIn/tokenOut + slippage-floored amountOutMinimum', () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '1' } });
    openSettings();
    fireEvent.click(screen.getByTestId('swap-slippage-50'));
    fireEvent.click(screen.getByTestId('swap-submit'));
    expect(swapFn).toHaveBeenCalledTimes(1);
    expect(swapFn).toHaveBeenCalledWith({
      tokenIn: CIRBTC,
      tokenOut: USDC,
      amountIn: 100_000000n,
      amountOutMinimum: 24_677_358n,
    });
  });
  // The presets cover normal days. A thin or drifting pool needs a number they don't have, and
  // without one the only outcome is a swap that reverts on `amountOutMinimum`.
  // Auto and a preset were both rendering as selected, so the popover showed two active choices.
  it('lets exactly one slippage choice look selected', () => {
    render(<SwapForm />);
    const popover = openSettings();
    const pressed = () =>
      ['auto', '50', '100', '300']
        .map((k) => within(popover).getByTestId(`swap-slippage-${k}`))
        .filter((el) => el.getAttribute('aria-pressed') === 'true' || el.className.includes('bg-brand-soft'));

    expect(pressed()).toHaveLength(1);
    fireEvent.click(within(popover).getByTestId('swap-slippage-50'));
    expect(pressed()).toHaveLength(1);
    fireEvent.click(within(popover).getByTestId('swap-slippage-auto'));
    expect(pressed()).toHaveLength(1);
    expect(within(popover).getByTestId('swap-slippage-auto').getAttribute('aria-pressed')).toBe('true');
  });

  // Before an amount is typed there is nothing to quote, so a concrete percentage is invented.
  it('shows a bare "Auto" until there is a trade to measure', () => {
    render(<SwapForm />);
    openSettings();
    expect(screen.getByTestId('swap-slippage-value').textContent).toBe('Auto');
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '1' } });
    expect(screen.getByTestId('swap-slippage-value').textContent).toMatch(/^Auto · /);
  });

  it('accepts a typed slippage and uses it for amountOutMinimum', () => {
    render(<SwapForm />);
    fireEvent.change(screen.getByTestId('swap-amount-input'), { target: { value: '1' } });
    openSettings();
    fireEvent.click(screen.getByTestId('swap-slippage-50'));
    fireEvent.click(screen.getByTestId('swap-submit'));
    const atHalfPercent = swapFn.mock.calls[0]![0].amountOutMinimum as bigint;

    // The popover is still open: jsdom's click does not fire the mousedown the outside-close listens for.
    fireEvent.change(screen.getByTestId('swap-slippage-custom'), { target: { value: '15' } });
    fireEvent.click(screen.getByTestId('swap-submit'));
    const atFifteen = swapFn.mock.calls[1]![0].amountOutMinimum as bigint;

    // Asserted as a ratio rather than a literal so the quote fixture can move without touching this.
    const quote = (atHalfPercent * 10_000n) / 9_950n;
    expect(atFifteen).toBeLessThan(atHalfPercent);
    expect(atFifteen).toBeGreaterThan((quote * 8_499n) / 10_000n);
    expect(atFifteen).toBeLessThan((quote * 8_501n) / 10_000n);
  });

  it('takes a comma as a decimal separator', () => {
    render(<SwapForm />);
    openSettings();
    fireEvent.change(screen.getByTestId('swap-slippage-custom'), { target: { value: '2,5' } });
    expect(screen.queryByTestId('swap-slippage-error')).toBeNull();
    expect((screen.getByTestId('swap-slippage-custom') as HTMLInputElement).value).toBe('2.5');
  });

  it('rejects nonsense and out-of-range values without changing the trade', () => {
    render(<SwapForm />);
    openSettings();
    for (const bad of ['abc', '-1', '0', '99']) {
      fireEvent.change(screen.getByTestId('swap-slippage-custom'), { target: { value: bad } });
      expect(screen.getByTestId('swap-slippage-error'), bad).toBeTruthy();
    }
  });

  it('warns when the typed slippage is high enough to cost real money', () => {
    render(<SwapForm />);
    openSettings();
    expect(screen.queryByTestId('swap-slippage-warning')).toBeNull();
    fireEvent.change(screen.getByTestId('swap-slippage-custom'), { target: { value: '10' } });
    expect(screen.getByTestId('swap-slippage-warning')).toBeTruthy();
  });

  it('a preset click takes the input back over', () => {
    render(<SwapForm />);
    openSettings();
    fireEvent.change(screen.getByTestId('swap-slippage-custom'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('swap-slippage-50'));
    expect((screen.getByTestId('swap-slippage-custom') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('swap-slippage-50').getAttribute('aria-pressed')).toBe('true');
  });
});

// A swap that has settled turns the card into a receipt. What is tested is that it reports the
// trade truthfully — the SETTLED amount, not the quote — that the explorer link points at the
// transaction it is describing, and that Done gives back a clean form.
describe('SwapForm — swap completed', () => {
  const done = (over: Partial<{ amountOut: bigint | null }> = {}) => {
    swapState.result = {
      hash: '0xabc0000000000000000000000000000000000000000000000000000000000001',
      tokenIn: USDC,
      tokenOut: CIRBTC,
      amountIn: 5_000000n,
      amountOut: 1_206n,
      ...over,
    };
  };

  it('replaces the form with the confirmation once the swap settles', () => {
    done();
    render(<SwapForm />);
    expect(screen.getByTestId('swap-completed')).toBeTruthy();
    // The form is gone, not merely covered: no amount box, no Swap button behind it.
    expect(screen.queryByTestId('swap-submit')).toBeNull();
    expect(screen.queryByTestId('swap-pay-panel')).toBeNull();
  });

  it('shows the amount the chain settled at, not the quote', () => {
    // 1_206 raw at 8dp. Quoting the pre-signature estimate here would contradict the explorer
    // button sitting right next to it.
    done();
    render(<SwapForm />);
    expect(screen.getByTestId('swap-completed-amount').textContent).toContain('0.00001206');
  });

  it('restates what was paid, so the receipt describes the whole trade', () => {
    done();
    render(<SwapForm />);
    expect(screen.getByTestId('swap-completed-paid').textContent).toMatch(/5\b/);
    expect(screen.getByTestId('swap-completed-paid').textContent).toContain('USDC');
  });

  it('links the explorer at this transaction, in a new tab', () => {
    done();
    render(<SwapForm />);
    const link = screen.getByTestId('swap-completed-explorer') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toContain('0xabc0000000000000000000000000000000000000000000000000000000000001');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('says nothing rather than a wrong number when the receipt did not carry the amount', () => {
    done({ amountOut: null });
    render(<SwapForm />);
    expect(screen.getByTestId('swap-completed-amount').textContent).toBe('—');
    expect(screen.getByText(/wasn.t in the receipt/i)).toBeTruthy();
  });

  it('Done clears the swap and hands back an empty form', () => {
    done();
    render(<SwapForm />);
    fireEvent.click(screen.getByTestId('swap-completed-done'));
    expect(resetFn).toHaveBeenCalled();
  });

  it('hides the slippage control, since there is nothing left to configure', () => {
    done();
    render(<SwapForm />);
    const gear = screen.getByTestId('swap-settings-toggle');
    expect(gear.closest('div.hidden')).toBeTruthy();
  });
});
