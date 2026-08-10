import { describe, it, expect } from 'vitest';
import { feeArenaAbi } from '@/abis/feeArena';

type AbiEntry = {
  type: string;
  name?: string;
  stateMutability?: string;
  inputs?: { type: string }[];
};

const entries = feeArenaAbi as readonly AbiEntry[];

describe('feeArenaAbi shape guard (V1 Pyth oracle)', () => {
  it('startEpoch is payable and takes a single bytes[] (priceData)', () => {
    const fn = entries.find((e) => e.type === 'function' && e.name === 'startEpoch');
    expect(fn).toBeDefined();
    expect(fn?.stateMutability).toBe('payable');
    expect(fn?.inputs).toHaveLength(1);
    expect(fn?.inputs?.[0].type).toBe('bytes[]');
  });

  it('endEpoch is payable and takes a single bytes[] (priceData)', () => {
    const fn = entries.find((e) => e.type === 'function' && e.name === 'endEpoch');
    expect(fn).toBeDefined();
    expect(fn?.stateMutability).toBe('payable');
    expect(fn?.inputs).toHaveLength(1);
    expect(fn?.inputs?.[0].type).toBe('bytes[]');
  });

  it('includes the V1 Pyth custom errors', () => {
    const errorNames = entries.filter((e) => e.type === 'error').map((e) => e.name);
    expect(errorNames).toContain('StartPriceTooOld');
    expect(errorNames).toContain('SettlePriceTooOld');
    expect(errorNames).toContain('RefundFailed');
  });

  it('no longer exposes the removed setOracle setter', () => {
    const hasSetOracle = entries.some((e) => e.type === 'function' && e.name === 'setOracle');
    expect(hasSetOracle).toBe(false);
  });
});
