import { describe, it, expect } from 'vitest';
import {
  mulDivFloor, wethNotionalDiv, clampShareNum, payoutFloor,
} from '@/lib/money';

describe('mulDivFloor', () => {
  it('floors toward zero (no rounding up)', () => {
    expect(mulDivFloor(1_000_000n, 1n, 3n)).toBe(333_333n); // §4.5 dust example
    expect(mulDivFloor(7n, 3n, 2n)).toBe(10n);              // 21/2 -> 10
    expect(mulDivFloor(0n, 5n, 3n)).toBe(0n);
  });
  it('throws on zero denominator', () => {
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow();
  });
});

describe('wethNotionalDiv (derived, never magic 1e30)', () => {
  it('= 10 ** (wethDec + priceDec - usdcDec) = 1e30 for 18/18/6', () => {
    expect(wethNotionalDiv({ usdc: 6, weth: 18, price: 18 })).toBe(10n ** 30n);
  });
});


describe('payoutFloor — §4.5 conservation', () => {
  const potWETH = 4n * 10n ** 18n;
  const potUSDC = 6000n * 10n ** 6n;
  const denom = 8_000_000_000n; // winnerDenominator = sideContribution6[UP]
  it('LP-A (5/8): 2.5 WETH + 3750 USDC', () => {
    const a = payoutFloor({ potWETH, potUSDC, contribution6: 5_000_000_000n, winnerDenominator: denom });
    expect(a.payWETH).toBe(2_500_000_000_000_000_000n);
    expect(a.payUSDC).toBe(3750n * 10n ** 6n);
  });
  it('LP-B (3/8): 1.5 WETH + 2250 USDC; A+B conserve to pot', () => {
    const a = payoutFloor({ potWETH, potUSDC, contribution6: 5_000_000_000n, winnerDenominator: denom });
    const b = payoutFloor({ potWETH, potUSDC, contribution6: 3_000_000_000n, winnerDenominator: denom });
    expect(b.payWETH).toBe(1_500_000_000_000_000_000n);
    expect(b.payUSDC).toBe(2250n * 10n ** 6n);
    expect(a.payWETH + b.payWETH).toBe(potWETH);
    expect(a.payUSDC + b.payUSDC).toBe(potUSDC);
  });
  it('zero winnerDenominator yields zero payout (empty-winner guard)', () => {
    const z = payoutFloor({ potWETH, potUSDC, contribution6: 1n, winnerDenominator: 0n });
    expect(z.payWETH).toBe(0n);
    expect(z.payUSDC).toBe(0n);
  });
});

describe('clampShareNum — share never > 1', () => {
  it('clamps numerator to denominator', () => {
    expect(clampShareNum(9n, 8n)).toBe(8n);
    expect(clampShareNum(3n, 8n)).toBe(3n);
    expect(clampShareNum(5n, 0n)).toBe(0n);
  });
});
