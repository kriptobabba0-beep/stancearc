import { describe, it, expect, vi } from 'vitest';
import { computeStanceSignal, renderRationale, normCdf, erf } from '@/lib/agent/quant';

// The Limen Agent's pure stance-probability math. Every property a user-facing
// recommendation depends on is pinned here: probabilities behave like probabilities,
// the view tracks the dominant probability, the horizon shapes the answer, and
// degenerate inputs return null instead of a fabricated signal.

/** A geometric series drifting `perBar` per bar for n bars, starting at 100. */
function trend(n: number, perBar: number): number[] {
  const out = [100];
  for (let i = 1; i < n; i += 1) out.push(out[i - 1] * (1 + perBar));
  return out;
}

/** A flat series with a deterministic ± wiggle so volatility is non-zero. */
function choppy(n: number, wigglePct: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(100 * (1 + (i % 2 === 0 ? wigglePct : -wigglePct)));
  return out;
}

describe('normCdf / erf — numeric plumbing', () => {
  it('matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
    expect(erf(0)).toBeCloseTo(0, 6); // A&S approximation carries a ~1e-9 residual at 0
  });
});

describe('computeStanceSignal', () => {
  it('probabilities are a distribution and confidence tracks the recommended view', () => {
    const s = computeStanceSignal(choppy(61, 0.001), 60, 240, 20)!;
    expect(s).not.toBeNull();
    expect(s.pUp + s.pDown + s.pRange).toBeCloseTo(1, 6);
    for (const p of [s.pUp, s.pDown, s.pRange]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
    const max = Math.max(s.pUp, s.pDown, s.pRange);
    expect(s.confidence).toBeCloseTo(max, 9);
  });

  it('a strong steady uptrend recommends UP', () => {
    // +0.1%/bar drift, 4-min horizon, ±0.20% band: the capped drift (≈+0.40%) clears the
    // upper edge decisively -> UP with high confidence. (A ±0.05%/bar trend would land
    // exactly ON the band edge — deliberately avoided here.)
    const s = computeStanceSignal(trend(61, 0.001), 60, 240, 20)!;
    expect(s.view).toBe('UP');
    expect(s.pUp).toBeGreaterThan(0.5);
  });

  it('a strong downtrend recommends DOWN', () => {
    const s = computeStanceSignal(trend(61, -0.001), 60, 240, 20)!;
    expect(s.view).toBe('DOWN');
    expect(s.pDown).toBeGreaterThan(0.5);
  });

  it('low volatility inside a wide band recommends RANGE', () => {
    // ±0.01% per-bar wiggle vs a ±0.50% band over a short horizon: staying in range dominates.
    const s = computeStanceSignal(choppy(61, 0.0001), 60, 240, 50)!;
    expect(s.view).toBe('RANGE');
    expect(s.pRange).toBeGreaterThan(0.9);
  });

  it('a SHORTER remaining horizon makes RANGE likelier (time-aware honesty)', () => {
    const long = computeStanceSignal(choppy(61, 0.001), 60, 43_200, 20)!;
    const short = computeStanceSignal(choppy(61, 0.001), 60, 60, 20)!;
    expect(short.pRange).toBeGreaterThan(long.pRange);
  });

  it('momentum persistence is CAPPED: a 12h horizon does not extrapolate an hour of drift 720×', () => {
    const s = computeStanceSignal(trend(61, 0.0005), 60, 43_200, 20)!;
    // Uncapped drift would be 0.0005·720 = 36% — absurd. Capped (30 min) it is ≤ 1.5%.
    expect(Math.abs(s.features.driftH)).toBeLessThanOrEqual(0.0005 * 30 + 1e-9);
  });

  it('a flat series with zero volatility resolves deterministically to RANGE', () => {
    const s = computeStanceSignal(Array(61).fill(100), 60, 240, 20)!;
    expect(s.view).toBe('RANGE');
    expect(s.pRange).toBe(1);
  });

  it('returns null on short series, bad prices, and degenerate params', () => {
    expect(computeStanceSignal([100, 101], 60, 240, 20)).toBeNull();
    expect(computeStanceSignal(trend(61, 0.0005).concat(NaN as unknown as number), 60, 240, 20)).toBeNull();
    expect(computeStanceSignal(trend(61, 0.0005), 60, 0, 20)).toBeNull();
    expect(computeStanceSignal(trend(61, 0.0005), 60, 240, 0)).toBeNull();
  });
});

describe('renderRationale', () => {
  it('names the band, the horizon, and the probability split', () => {
    const s = computeStanceSignal(choppy(61, 0.001), 60, 240, 20)!;
    const text = renderRationale(s);
    expect(text).toContain('±0.20% band');
    expect(text).toContain('4 min');
    expect(text).toMatch(/UP \d+% · DOWN \d+% · RANGE \d+%/);
  });
});

// ─── fetchMarketCloses stale-ok cache: a rate-limited benchmarks API must not starve the
// autopilot — the last good series (bars change once a minute) serves for up to 5 minutes.
describe('fetchMarketCloses — last-good fallback', () => {
  it('serves the cached series when the fetch fails, and rethrows once the cache is stale', async () => {
    const { fetchMarketCloses } = await import('@/lib/agent/history');
    const FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';
    const okBody = { s: 'ok', c: [100, 101, 102] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => okBody })       // 1st: fresh OK
      .mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }); // then: 403 forever
    vi.stubGlobal('fetch', fetchMock);
    try {
      const fresh = await fetchMarketCloses(FEED, undefined, 3600, 1_000_000);
      expect(fresh.closes).toEqual([100, 101, 102]);

      // fetch now fails → the <5-min-old cache steps in silently
      const fallback = await fetchMarketCloses(FEED, undefined, 3600, 1_000_060);
      expect(fallback.closes).toEqual([100, 101, 102]);

      // age the cache past 5 minutes → the failure surfaces honestly
      const realNow = Date.now;
      vi.stubGlobal('Date', Object.assign(Object.create(Date), Date, { now: () => realNow() + 6 * 60_000 }));
      await expect(fetchMarketCloses(FEED, undefined, 3600, 1_000_120)).rejects.toThrow(/403/);
      vi.stubGlobal('Date', Date);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
