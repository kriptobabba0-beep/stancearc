import { describe, it, expect } from 'vitest';
import {
  escalatedGas,
  escalationEnabled,
  totalAttempts,
  type GasEscalationConfig,
} from '../src/gasEscalation.js';

const GWEI = 1_000_000_000n;

// A representative policy: floor 20 gwei, 1.25x/step, cap 100 gwei, up to 3 escalations.
const CFG: GasEscalationConfig = {
  floorWei: 20n * GWEI,
  capWei: 100n * GWEI,
  multiplierBps: 12_500, // 1.25x
  maxAttempts: 3,
};

describe('escalatedGas — attempt 0 is the floor verbatim', () => {
  it('returns exactly the floor on both fields for attempt 0 (unchanged behavior)', () => {
    const g = escalatedGas(0, CFG);
    expect(g.maxFeePerGas).toBe(20n * GWEI);
    expect(g.maxPriorityFeePerGas).toBe(20n * GWEI);
  });

  it('treats a negative attempt as attempt 0', () => {
    expect(escalatedGas(-5, CFG).maxFeePerGas).toBe(20n * GWEI);
  });

  it('clamps the floor to the cap if cap < floor (misconfig safety)', () => {
    const g = escalatedGas(0, { ...CFG, capWei: 10n * GWEI });
    expect(g.maxFeePerGas).toBe(10n * GWEI);
  });
});

describe('escalatedGas — bounded geometric growth', () => {
  it('multiplies by 1.25x each attempt (exact bigint bps math)', () => {
    // 20 -> 25 -> 31.25 (floored by integer bps to 31_250_000_000 -> /1e4 keeps exact) ...
    expect(escalatedGas(1, CFG).maxFeePerGas).toBe((20n * GWEI * 12_500n) / 10_000n); // 25 gwei
    const step1 = (20n * GWEI * 12_500n) / 10_000n;
    const step2 = (step1 * 12_500n) / 10_000n;
    expect(escalatedGas(2, CFG).maxFeePerGas).toBe(step2); // ~31.25 gwei
  });

  it('bumps maxFeePerGas AND maxPriorityFeePerGas together (Arc prices both)', () => {
    const g = escalatedGas(1, CFG);
    expect(g.maxFeePerGas).toBe(g.maxPriorityFeePerGas);
  });

  it('NEVER exceeds the cap, no matter how many attempts', () => {
    for (let a = 0; a < 50; a += 1) {
      expect(escalatedGas(a, CFG).maxFeePerGas).toBeLessThanOrEqual(CFG.capWei);
    }
    // A high attempt is pinned exactly at the cap.
    expect(escalatedGas(20, CFG).maxFeePerGas).toBe(CFG.capWei);
  });

  it('monotonically non-decreasing across attempts', () => {
    let prev = 0n;
    for (let a = 0; a < 10; a += 1) {
      const p = escalatedGas(a, CFG).maxFeePerGas;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('a 1.0x multiplier (10_000 bps) keeps a flat floor (still capped)', () => {
    const flat = { ...CFG, multiplierBps: 10_000 };
    expect(escalatedGas(1, flat).maxFeePerGas).toBe(20n * GWEI);
    expect(escalatedGas(5, flat).maxFeePerGas).toBe(20n * GWEI);
  });
});

describe('escalationEnabled / totalAttempts', () => {
  it('OFF when maxAttempts is 0 -> exactly one (floor) send', () => {
    const off: GasEscalationConfig = { ...CFG, maxAttempts: 0 };
    expect(escalationEnabled(off)).toBe(false);
    expect(totalAttempts(off)).toBe(1);
  });

  it('ON when maxAttempts > 0 -> 1 + maxAttempts total sends', () => {
    expect(escalationEnabled(CFG)).toBe(true);
    expect(totalAttempts(CFG)).toBe(4); // floor + 3 escalations
  });
});
