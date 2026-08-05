// lib/arena.ts - small pure helpers for the Arena redesign's "real data" labels (durations + the
// live price-change %). No money math; format-only. Durations come straight from EpochView boundaries
// so the mockup's "1 day / 12h / 2h" rows reflect the ACTUAL on-chain schedule (e.g. 10 min / 5 min).

/**
 * Compact human duration from a second count: "45s", "5 min", "10 min", "2h", "2h 30m", "1 day",
 * "3 days". Non-positive/NaN inputs degrade to "-". Accepts bigint or number.
 */
export function formatDuration(seconds: bigint | number): string {
  const s = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  if (!Number.isFinite(s) || s <= 0) return '-';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day' : `${d} days`;
}

/**
 * Live price change in PERCENT relative to the epoch's start price (e.g. +2.1). 18dp inputs (1e18 ==
 * $1). Returns undefined when either price is missing/zero so the caller can hide the figure. Computed
 * in float for display only (never used for settlement, which is the contract's job).
 */
export function priceChangePct(startPrice18: bigint, livePrice18: bigint): number | undefined {
  if (startPrice18 <= 0n || livePrice18 <= 0n) return undefined;
  const start = Number(startPrice18);
  const live = Number(livePrice18);
  if (!Number.isFinite(start) || !Number.isFinite(live) || start === 0) return undefined;
  return ((live - start) / start) * 100;
}

/** Format a percent number with a sign and 1 decimal, e.g. 2.1 → "+2.1%", -0.4 → "-0.4%". */
export function formatSignedPct(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Compact USD price from an 18dp quote, e.g. 63750.42e18 → "$63,750". Sub-$1 keeps 2dp. */
export function formatUsdPrice18(price18: bigint, symbol = '$'): string {
  if (price18 <= 0n) return '-';
  const whole = price18 / 1_000_000_000_000_000_000n; // floor to whole units
  if (whole === 0n) {
    // sub-unit → 2dp
    const cents = (price18 % 1_000_000_000_000_000_000n) / 10_000_000_000_000_000n;
    return `${symbol}0.${cents.toString().padStart(2, '0')}`;
  }
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${grouped}`;
}
