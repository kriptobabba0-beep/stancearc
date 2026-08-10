// Auto slippage decides how far the execution floor sits below the quote. Its whole job is to
// absorb the gap between what the user was shown and what the pool pays, and that gap has a very
// different size depending on WHERE the quote came from.
import { describe, it, expect } from 'vitest';
import { autoSlippageBps, MIN_AUTO_BPS, MAX_AUTO_BPS } from '@/lib/autoSlippage';

describe('autoSlippageBps', () => {
  it('stays tight on an exact quote, because there is no quote error to absorb', () => {
    expect(autoSlippageBps({ priceImpactBps: 0, exact: true })).toBe(MIN_AUTO_BPS);
    expect(autoSlippageBps({ priceImpactBps: 100, exact: true })).toBe(75);
  });

  it('opens up on an estimate, which is the case that used to revert', () => {
    // The local estimate was 6.6% high on a trade it called 0.04% impact, so its error does not
    // track impact and the floor cannot be derived from impact alone.
    const estimated = autoSlippageBps({ priceImpactBps: 4, exact: false });
    const exact = autoSlippageBps({ priceImpactBps: 4, exact: true });
    expect(estimated).toBeGreaterThan(exact);
    expect(estimated).toBeGreaterThanOrEqual(300);
  });

  it('never goes below the floor or past the ceiling', () => {
    expect(autoSlippageBps({ priceImpactBps: -50, exact: true })).toBe(MIN_AUTO_BPS);
    expect(autoSlippageBps({ priceImpactBps: 1_000_000, exact: false })).toBe(MAX_AUTO_BPS);
    expect(autoSlippageBps({ priceImpactBps: Number.NaN, exact: true })).toBe(MIN_AUTO_BPS);
  });

  it('widens with impact, since a bigger trade drifts further before it lands', () => {
    expect(autoSlippageBps({ priceImpactBps: 800, exact: true }))
      .toBeGreaterThan(autoSlippageBps({ priceImpactBps: 200, exact: true }));
  });
});
