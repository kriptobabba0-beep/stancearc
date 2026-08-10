// lib/oracleFormat.ts — PURE render-only formatters for Pyth oracle provenance on the epoch-detail
// page. A Pyth price is a signed int64 mantissa scaled by 10^expo (expo is usually negative, e.g. -8).
// We format exactly with BigInt string math (no float drift), then trim trailing zeros.

/** Trim trailing zeros after a decimal point (and a dangling dot). */
function trimFrac(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Format a Pyth (price, expo) pair as a decimal string. expo<0 inserts a decimal point |expo| places
 * from the right; expo>=0 appends |expo| zeros. Exact (BigInt) + trailing-zero trimmed. Sign preserved.
 */
export function formatPythPrice(price: bigint, expo: bigint): string {
  if (price === 0n) return '0';
  const neg = price < 0n;
  const abs = neg ? -price : price;
  let out: string;
  if (expo >= 0n) {
    out = abs.toString() + '0'.repeat(Number(expo));
  } else {
    const places = Number(-expo);
    const digits = abs.toString().padStart(places + 1, '0');
    const whole = digits.slice(0, digits.length - places);
    const frac = digits.slice(digits.length - places);
    out = trimFrac(`${whole}.${frac}`);
  }
  return neg ? `-${out}` : out;
}

/**
 * Format a unix-seconds timestamp as a stable "YYYY-MM-DD HH:MM:SS UTC" label (locale-independent,
 * so SSR and client agree). 0/undefined → em-dash.
 */
export function formatUnixTime(unixSec: bigint | undefined): string {
  if (unixSec === undefined || unixSec === 0n) return '—';
  const d = new Date(Number(unixSec) * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}
