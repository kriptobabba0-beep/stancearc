import { describe, it, expect } from 'vitest';
import { planTopUp, planTokenTopUp, buildTransferArgs, formatUnits } from '../src/agentFunding.js';

// The treasury rail's money math is pure and must fail closed: a bad balance read or a
// zero-cap mandate can never produce a transfer bigger than one stake plus gas margin.

const USDC6_TO_WEI = 1_000_000_000_000n;

describe('formatUnits', () => {
  it('renders native wei as decimal USDC and trims zeros', () => {
    expect(formatUnits(5_050_000_000_000_000_000n, 18)).toBe('5.05');
    expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe('1');
    expect(formatUnits(1n, 18)).toBe('0.000000000000000001');
  });

  it('renders 8dp token units (cirBTC)', () => {
    expect(formatUnits(40_000n, 8)).toBe('0.0004');
    expect(formatUnits(200_000n, 8)).toBe('0.002');
  });
});

describe('planTopUp', () => {
  const quoteLegUsdc6 = 5_000_000n; // 5 USDC stake budget
  const gasMarginWei = 50_000_000_000_000_000n; // 0.05

  it('declines when the signer already covers stake + margin', () => {
    const plan = planTopUp({ balanceWei: 6n * 10n ** 18n, quoteLegUsdc6, gasMarginWei });
    expect(plan).toEqual({ fund: false, reason: 'sufficient' });
  });

  it('funds exactly the shortfall, rounded up to 0.001', () => {
    const balanceWei = 1n * 10n ** 18n;
    const plan = planTopUp({ balanceWei, quoteLegUsdc6, gasMarginWei });
    if (!plan.fund) throw new Error('expected a funding plan');
    const needWei = quoteLegUsdc6 * USDC6_TO_WEI + gasMarginWei;
    expect(plan.amountWei).toBeGreaterThanOrEqual(needWei - balanceWei);
    expect(plan.amountWei % 1_000_000_000_000_000n).toBe(0n);
    expect(plan.amount).toBe('4.05');
  });

  it('never exceeds one stake + margin even from a zero balance', () => {
    const plan = planTopUp({ balanceWei: 0n, quoteLegUsdc6, gasMarginWei });
    if (!plan.fund) throw new Error('expected a funding plan');
    expect(plan.amountWei).toBeLessThanOrEqual(quoteLegUsdc6 * USDC6_TO_WEI + gasMarginWei);
  });

  it('fails closed on nonsense inputs', () => {
    expect(planTopUp({ balanceWei: -1n, quoteLegUsdc6, gasMarginWei }).fund).toBe(false);
    expect(planTopUp({ balanceWei: 0n, quoteLegUsdc6: 0n, gasMarginWei }).fund).toBe(false);
    expect(planTopUp({ balanceWei: 0n, quoteLegUsdc6, gasMarginWei: -1n }).fund).toBe(false);
  });
});

describe('planTokenTopUp', () => {
  it('funds only the shortfall for one mint', () => {
    const plan = planTokenTopUp({ balanceUnits: 10_000n, needUnits: 40_000n, decimals: 8 });
    if (!plan.fund) throw new Error('expected a funding plan');
    expect(plan.amountWei).toBe(30_000n);
    expect(plan.amount).toBe('0.0003');
  });

  it('declines when covered and fails closed on nonsense', () => {
    expect(planTokenTopUp({ balanceUnits: 40_000n, needUnits: 40_000n, decimals: 8 })).toEqual({ fund: false, reason: 'sufficient' });
    expect(planTokenTopUp({ balanceUnits: -1n, needUnits: 40_000n, decimals: 8 }).fund).toBe(false);
    expect(planTokenTopUp({ balanceUnits: 0n, needUnits: 0n, decimals: 8 }).fund).toBe(false);
  });
});

describe('buildTransferArgs', () => {
  it('pins the native-transfer argv the CLI receives', () => {
    expect(
      buildTransferArgs({ to: '0xEXEC', amount: '4.05', from: '0xTREASURY', chain: 'ARC-TESTNET' }),
    ).toEqual(['wallet', 'transfer', '0xEXEC', '--amount', '4.05', '--address', '0xTREASURY', '--chain', 'ARC-TESTNET', '--output', 'json']);
  });

  it('adds --token for the ERC20 leg', () => {
    const args = buildTransferArgs({ to: '0xEXEC', amount: '0.0003', from: '0xTREASURY', chain: 'ARC-TESTNET', token: '0xCIRBTC' });
    expect(args).toContain('--token');
    expect(args[args.indexOf('--token') + 1]).toBe('0xCIRBTC');
  });
});
