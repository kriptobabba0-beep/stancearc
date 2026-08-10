import { describe, it, expect, beforeEach } from 'vitest';
import {
  assertBootDecimals,
  setBootDecimals,
  getBootDecimals,
  __resetBootDecimalsForTest,
} from '@/lib/decimals';

describe('assertBootDecimals', () => {
  it('returns a frozen BootDecimals when USDC===6 (18-dp base, e.g. WETH)', () => {
    const d = assertBootDecimals(6, 18);
    expect(d).toEqual({ usdc: 6, weth: 18, price: 18 });
  });

  it('hard-fails when USDC !== 6', () => {
    expect(() => assertBootDecimals(8, 18)).toThrow(/USDC/);
  });

  // cirBTC migration: the base leg is now decimals-agnostic. The app MUST boot with an 8-dp base
  // (cirBTC) — assertBootDecimals no longer requires the base to be 18, only that USDC === 6.
  it('ACCEPTS an 8-dp base (cirBTC) without throwing', () => {
    expect(() => assertBootDecimals(6, 8)).not.toThrow();
    const d = assertBootDecimals(6, 8);
    expect(d.usdc).toBe(6);
    expect(d.price).toBe(18);
  });

  it('ACCEPTS any base decimals (does not gate on the base leg)', () => {
    expect(() => assertBootDecimals(6, 6)).not.toThrow();
    expect(() => assertBootDecimals(6, 0)).not.toThrow();
    expect(() => assertBootDecimals(6, 36)).not.toThrow();
  });

  it('still rejects USDC !== 6 even with an 8-dp base', () => {
    expect(() => assertBootDecimals(8, 8)).toThrow(/USDC/);
  });
});

describe('boot decimals cache', () => {
  beforeEach(() => __resetBootDecimalsForTest());

  it('getBootDecimals throws before the gate passed', () => {
    expect(() => getBootDecimals()).toThrow(/boot/i);
  });

  it('setBootDecimals caches and getBootDecimals returns it', () => {
    setBootDecimals(assertBootDecimals(6, 18));
    expect(getBootDecimals()).toEqual({ usdc: 6, weth: 18, price: 18 });
  });
});
