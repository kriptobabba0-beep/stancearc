// lib/priceInput.ts — PURE parse/format for the editable Min/Max price fields on the deposit page.
// parsePrice is FAIL-CLOSED: it returns NaN unless the WHOLE trimmed string is a plain decimal, so a
// pasted grouped price ("52,515"), an exponent ("1e5"), hex ("0x1f") or a unit suffix ("70k") can NEVER
// silently truncate the band — they're rejected outright, mirroring the amount fields' fail-closed parse.
// toPlainPrice renders a band price back into a plain, un-grouped, parse-safe string (round-trips through
// parsePrice within its rounding precision), so the field the user edits is always re-readable.

/** Plain-decimal price → number; NaN for anything that isn't a bare decimal (grouping/exponent/letters). */
export function parsePrice(s: string): number {
  const t = s.trim();
  return /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number.parseFloat(t) : Number.NaN;
}

/** A band price → a plain, un-grouped, parse-safe string at sensible precision (2/4/8 dp by magnitude).
 *  Returns '' for 0 / negative / non-finite so an unusable bound renders empty, not "0" or "NaN". */
export function toPlainPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return '';
  const dp = p >= 1000 ? 2 : p >= 1 ? 4 : 8;
  return p.toFixed(dp).replace(/\.?0+$/, '');
}

/** A valid editable band: both strings parse to plain numbers with 0 < min < max. */
export function validPriceBand(minStr: string, maxStr: string): boolean {
  const mn = parsePrice(minStr);
  const mx = parsePrice(maxStr);
  return Number.isFinite(mn) && Number.isFinite(mx) && mn > 0 && mn < mx;
}
