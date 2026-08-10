import { describe, it, expect, vi } from 'vitest';
import { isGasCapError, fitBatchUnderCap } from '../src/gasFit.js';

// Arc's hard per-tx / estimate cap (2^24).
const CAP = 16_777_216n;

describe('isGasCapError', () => {
  it('matches the estimateGas "gas required exceeds" phrasing', () => {
    expect(isGasCapError(new Error('gas required exceeds allowance (16777216)'))).toBe(true);
    expect(isGasCapError({ shortMessage: 'gas required exceeds: 16777216' })).toBe(true);
  });

  it('matches "gas limit too high" with an RPC code', () => {
    expect(isGasCapError({ message: 'gas limit too high', code: -32003 })).toBe(true);
  });

  it('matches intrinsic / block-limit phrasings', () => {
    expect(isGasCapError(new Error('intrinsic gas too high'))).toBe(true);
    expect(isGasCapError(new Error('tx exceeds block gas limit'))).toBe(true);
  });

  it('walks the viem cause chain', () => {
    const inner = { shortMessage: 'gas required exceeds 16777216' };
    const outer = { message: 'Execution failed', cause: { details: 'wrapped', cause: inner } };
    expect(isGasCapError(outer)).toBe(true);
  });

  it('does NOT match a genuine contract revert', () => {
    expect(isGasCapError(new Error('execution reverted: WrongPhase'))).toBe(false);
    expect(isGasCapError({ shortMessage: 'reverted', reason: 'ProcessNotComplete' })).toBe(false);
  });

  it('does NOT match a transport blip or empty error', () => {
    expect(isGasCapError(new Error('fetch failed'))).toBe(false);
    expect(isGasCapError(null)).toBe(false);
    expect(isGasCapError({})).toBe(false);
  });
});

describe('fitBatchUnderCap', () => {
  it('keeps the full batch when it estimates under the cap (with +12.5% headroom)', async () => {
    const estimate = vi.fn(async () => 8_000_000n);
    const fit = await fitBatchUnderCap({ desired: 10, cap: CAP, estimate });
    expect(fit.count).toBe(10);
    expect(fit.gasLimit).toBe(9_000_000n); // 8M + 12.5%
    expect(fit.capped).toBe(false);
    expect(estimate).toHaveBeenCalledTimes(1);
    expect(estimate).toHaveBeenCalledWith(10);
  });

  it('clamps the buffered gas-limit to the cap (never submits above it)', async () => {
    // Estimate is just under the cap; +12.5% would exceed it → clamp to cap.
    const estimate = vi.fn(async () => 16_000_000n);
    const fit = await fitBatchUnderCap({ desired: 1, cap: CAP, estimate });
    expect(fit.count).toBe(1);
    expect(fit.gasLimit).toBe(CAP);
    expect(fit.capped).toBe(true);
  });

  it('halves the batch when a larger batch ESTIMATES above the cap', async () => {
    // 4 positions → 20M (over), 2 → 10M (fits).
    const estimate = vi.fn(async (n: number) => BigInt(n) * 5_000_000n);
    const fit = await fitBatchUnderCap({ desired: 4, cap: CAP, estimate });
    expect(fit.count).toBe(2);
    expect(fit.gasLimit).toBe(11_250_000n); // 10M + 12.5%
    expect(estimate.mock.calls.map((c) => c[0])).toEqual([4, 2]);
  });

  it('halves the batch when the estimate THROWS a gas-cap error', async () => {
    // The real Arc behavior: estimating an over-cap batch ERRORS rather than returning a number.
    const estimate = vi.fn(async (n: number) => {
      if (n > 1) throw new Error('gas required exceeds 16777216');
      return CAP; // a single position clamps to the cap
    });
    const fit = await fitBatchUnderCap({ desired: 3, cap: CAP, estimate });
    expect(fit.count).toBe(1);
    expect(fit.gasLimit).toBe(CAP);
    expect(fit.capped).toBe(true);
    expect(estimate.mock.calls.map((c) => c[0])).toEqual([3, 1]);
  });

  it('last resort: submits 1 at the cap when even a single position estimates over', async () => {
    const estimate = vi.fn(async (_n: number) => {
      throw new Error('gas required exceeds 16777216');
    });
    const fit = await fitBatchUnderCap({ desired: 5, cap: CAP, estimate });
    expect(fit.count).toBe(1);
    expect(fit.gasLimit).toBe(CAP);
    expect(fit.capped).toBe(true);
    // 5 → 2 → 1, then give up at 1.
    expect(estimate.mock.calls.map((c) => c[0])).toEqual([5, 2, 1]);
  });

  it('propagates a NON-gas error (real revert / transport) instead of shrinking', async () => {
    const estimate = vi.fn(async () => {
      throw new Error('execution reverted: WrongPhase');
    });
    await expect(fitBatchUnderCap({ desired: 4, cap: CAP, estimate })).rejects.toThrow('WrongPhase');
    expect(estimate).toHaveBeenCalledTimes(1); // no shrink loop on a real revert
  });

  it('treats desired < 1 as a single position', async () => {
    const estimate = vi.fn(async () => 1_000_000n);
    const fit = await fitBatchUnderCap({ desired: 0, cap: CAP, estimate });
    expect(fit.count).toBe(1);
    expect(estimate).toHaveBeenCalledWith(1);
  });

  it('respects a custom buffer', async () => {
    const estimate = vi.fn(async () => 10_000_000n);
    const fit = await fitBatchUnderCap({ desired: 1, cap: CAP, estimate, bufferBps: 2000 });
    expect(fit.gasLimit).toBe(12_000_000n); // 10M + 20%
  });
});
