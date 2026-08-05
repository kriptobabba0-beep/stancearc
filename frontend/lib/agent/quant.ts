// lib/agent/quant.ts - the PURE stance-probability math behind the Limen Agent.
//
// Given a recent price series and the epoch's qualification band, estimate the probability
// that each market view (UP / DOWN / RANGE) qualifies at settlement, and recommend the
// view with the highest estimated probability. The model is deliberately simple and
// stated honestly in the UI: log-returns are treated as approximately normal, volatility
// scales with the square root of the remaining horizon (random-walk assumption), and
// short-term momentum is only trusted for a bounded window (driftPersistSec) - a raw
// 60-minute drift extrapolated over a 12-hour epoch would swamp every other signal and
// is statistically indefensible, so persistence is capped instead.
//
// PURE: no I/O, no clock reads, no randomness - fully unit-testable. The caller supplies
// the bar series, the bar interval, the REMAINING seconds to settlement (entering later
// in the window shortens the horizon and makes RANGE likelier - the honest, time-aware
// behavior), and the epoch's bandBps.

export type StanceView = 'UP' | 'DOWN' | 'RANGE';

export interface StanceFeatures {
  /** Last observed price (quote per base, plain number - display only). */
  lastPrice: number;
  /** Expected log-return over the remaining horizon (momentum, persistence-capped). */
  driftH: number;
  /** Std-dev of the log-return over the remaining horizon (√-scaled realized vol). */
  volH: number;
  /** Band half-width as a fraction (bandBps / 10_000). */
  bandFrac: number;
  /** Remaining seconds to settlement the estimate was computed for. */
  horizonSec: number;
  /** Number of return samples the estimate is built from. */
  samples: number;
}

export interface StanceSignal {
  view: StanceView;
  pUp: number;
  pDown: number;
  pRange: number;
  /** The recommended view's probability (0..1) - the honest "confidence". */
  confidence: number;
  features: StanceFeatures;
}

/** Error function approximation (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). PURE. */
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF via erf. PURE. */
export function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Compute the stance signal from a close-price series.
 *
 * @param closes       Bar close prices, oldest first (≥ minSamples+1 points required).
 * @param barSec       Seconds per bar (e.g. 60 for 1-minute bars).
 * @param horizonSec   REMAINING seconds until settlement (entry now → settle then).
 * @param bandBps      Qualification band half-width in bps (e.g. 20 = ±0.20%).
 * @param opts.driftPersistSec  How long momentum is trusted to persist (default 1800s).
 * @param opts.minSamples       Minimum return samples required (default 10).
 * @returns the signal, or null when the series is too short / degenerate to estimate.
 */
export function computeStanceSignal(
  closes: number[],
  barSec: number,
  horizonSec: number,
  bandBps: number,
  opts?: { driftPersistSec?: number; minSamples?: number },
): StanceSignal | null {
  const minSamples = opts?.minSamples ?? 10;
  const driftPersistSec = opts?.driftPersistSec ?? 1_800;
  if (barSec <= 0 || horizonSec <= 0 || bandBps <= 0) return null;
  if (!Array.isArray(closes) || closes.length < minSamples + 1) return null;

  // Per-bar log returns; any non-positive price makes the series unusable.
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = closes[i - 1];
    const b = closes[i];
    if (a === undefined || b === undefined || !(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
    rets.push(Math.log(b / a));
  }

  const n = rets.length;
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const varSum = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0);
  const sd = Math.sqrt(varSum / n);

  // Horizon scaling: volatility diffuses with √time (random walk); momentum is only
  // extrapolated for min(horizon, driftPersistSec) - beyond that it is treated as spent.
  const hBars = horizonSec / barSec;
  const driftBars = Math.min(horizonSec, driftPersistSec) / barSec;
  const driftH = mean * driftBars;
  const volH = sd * Math.sqrt(hBars);

  const bandFrac = bandBps / 10_000;
  const upEdge = Math.log(1 + bandFrac); // final ≥ entry·(1+band) qualifies UP
  const downEdge = Math.log(1 - bandFrac); // final ≤ entry·(1−band) qualifies DOWN

  let pUp: number;
  let pDown: number;
  if (volH === 0) {
    // Degenerate flat series: the outcome is wherever the (capped) drift lands.
    pUp = driftH > upEdge ? 1 : 0;
    pDown = driftH < downEdge ? 1 : 0;
  } else {
    pUp = 1 - normCdf((upEdge - driftH) / volH);
    pDown = normCdf((downEdge - driftH) / volH);
  }
  const pRange = Math.min(1, Math.max(0, 1 - pUp - pDown));

  let view: StanceView = 'RANGE';
  let confidence = pRange;
  if (pUp >= pDown && pUp > pRange) {
    view = 'UP';
    confidence = pUp;
  } else if (pDown > pUp && pDown > pRange) {
    view = 'DOWN';
    confidence = pDown;
  }

  return {
    view,
    pUp,
    pDown,
    pRange,
    confidence,
    features: {
      lastPrice: closes[closes.length - 1]!,
      driftH,
      volH,
      bandFrac,
      horizonSec,
      samples: n,
    },
  };
}

/**
 * Deterministic plain-language rationale for a signal - the template renderer used when
 * no LLM is configured. States the volatility-vs-band comparison, the momentum read, and
 * the probability split, in the product's honest register. PURE.
 */
export function renderRationale(s: StanceSignal): string {
  const volPct = (s.features.volH * 100).toFixed(2);
  const bandPct = (s.features.bandFrac * 100).toFixed(2);
  const ratio = s.features.bandFrac > 0 ? s.features.volH / s.features.bandFrac : 0;
  const horizonMin = Math.round(s.features.horizonSec / 60);
  const drift = s.features.driftH;
  const momentum =
    Math.abs(drift) < s.features.volH * 0.1
      ? 'Momentum is roughly flat'
      : drift > 0
        ? 'Short-term momentum leans up'
        : 'Short-term momentum leans down';
  const width =
    ratio >= 1.5
      ? `well beyond the ±${bandPct}% band, so a breakout is more likely than staying in range`
      : ratio >= 0.75
        ? `comparable to the ±${bandPct}% band, so range and breakout outcomes are both live`
        : `inside the ±${bandPct}% band, so the price is likely to stay in range`;
  const pcts = `UP ${(s.pUp * 100).toFixed(0)}% · DOWN ${(s.pDown * 100).toFixed(0)}% · RANGE ${(s.pRange * 100).toFixed(0)}%`;
  return `Realized volatility implies a ±${volPct}% expected move over the ${horizonMin} min to settlement - ${width}. ${momentum} (treated as short-lived). Estimated qualification odds: ${pcts}.`;
}
