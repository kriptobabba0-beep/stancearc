// lib/poolStats.ts — PURE, display-grade pool analytics for the Pool list page (no React, no chain
// reads, no hardcoded decimals). The hook (hooks/usePoolStats) feeds these the raw on-chain inputs —
// pool token reserves, the live slot0 price, and decoded 24h Swap events — and everything here is
// float arithmetic on already-derived quantities, used for DISPLAY ONLY. It NEVER sizes a transaction
// (those stay bigint-exact in lib/rangeMath / lib/swapQuote).
//
// HONEST framing: every number is a restatement of real on-chain data —
//   TVL    = pool reserves valued at the pool's OWN price,
//   Volume = summed real Swap notionals over the window,
//   Fees   = volume × the pool's fee tier,
//   APR    = annualised (24h fees / TVL).
// Nothing is fabricated or predicted.

/** A token symbol → USD price map for valuing reserves and swap notionals. USDC ≈ 1. */
export type UsdPriceMap = Record<string, number>;

/**
 * Raw token amount (bigint) at `decimals` → human float (display-grade). Splits whole/fraction so a
 * large reserve doesn't overflow Number on the integer part; the fractional part is float-approximated
 * (fine for a displayed reserve, never for money math). Handles negatives (signed swap amounts).
 */
export function toHuman(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = Number(abs / base);
  const frac = Number(abs % base) / Number(base);
  const val = whole + frac;
  return neg ? -val : val;
}

/** USD value (float) of a single token reserve at `decimals`, priced at `usd` per whole token. */
export function reserveUsd(raw: bigint, decimals: number, usd: number): number {
  return toHuman(raw, decimals) * usd;
}

/** Pool TVL in USD = base-leg reserve value + quote-leg reserve value. */
export function tvlUsd(args: {
  reserveBaseRaw: bigint;
  baseDecimals: number;
  baseUsd: number;
  reserveQuoteRaw: bigint;
  quoteDecimals: number;
  quoteUsd: number;
}): number {
  return (
    reserveUsd(args.reserveBaseRaw, args.baseDecimals, args.baseUsd) +
    reserveUsd(args.reserveQuoteRaw, args.quoteDecimals, args.quoteUsd)
  );
}

/**
 * USD notional of ONE swap, valued by its QUOTE leg: |quote amount| × quote USD price. A V3 Swap event
 * carries signed amount0/amount1; the caller passes whichever leg is the pool's quote token (USDC/EURC).
 * Both legs of a swap are ~equal value, so the quote leg is the stable, decimals-simple choice.
 */
export function swapNotionalUsd(quoteAmountRaw: bigint, quoteDecimals: number, quoteUsd: number): number {
  const abs = quoteAmountRaw < 0n ? -quoteAmountRaw : quoteAmountRaw;
  return toHuman(abs, quoteDecimals) * quoteUsd;
}

/** 24h fees from 24h volume and the fee tier (e.g. 3000 = 0.3% → volume × 0.003). */
export function feesFromVolume(volumeUsd: number, feeTier: number): number {
  return volumeUsd * (feeTier / 1_000_000);
}

/** Annualised fee APR (%) from 24h fees and TVL. Zero/negative TVL → 0 (no division by zero). */
export function feeAprPct(fees24Usd: number, tvlUsdValue: number): number {
  if (!(tvlUsdValue > 0)) return 0;
  return ((fees24Usd * 365) / tvlUsdValue) * 100;
}

/** A timestamped USD value (one swap), for bucketing into a sparkline series. */
export interface TimedValue {
  /** Unix seconds. */
  t: number;
  /** USD value at that time. */
  v: number;
}

/**
 * Sum `items` into `buckets` equal time-windows spanning [fromT, toT] (unix seconds). Returns a
 * length-`buckets` series (oldest → newest) for a sparkline. Items outside the window are ignored;
 * the closing edge folds into the last bucket. Empty/degenerate inputs return an all-zero series.
 */
export function bucketSeries(
  items: ReadonlyArray<TimedValue>,
  fromT: number,
  toT: number,
  buckets: number,
): number[] {
  const out = new Array<number>(Math.max(0, buckets)).fill(0);
  if (toT <= fromT || buckets <= 0) return out;
  const span = toT - fromT;
  for (const { t, v } of items) {
    if (t < fromT || t > toT) continue;
    let idx = Math.floor(((t - fromT) / span) * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    out[idx] += v;
  }
  return out;
}

/**
 * "$40,726,958" — whole-dollar grouped for ≥ $1; "$0.42" cents for sub-$1; "$0" for 0/negatives.
 * Display-grade grouping (Intl). Used for every USD figure on the Pool surfaces.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 1) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/**
 * "166.62%" / "0.58%" — 2dp percent. Non-finite → "—"; an absurd APR (thin pool, momentary spike) is
 * capped to ">9,999%" so a row never renders a 12-digit number.
 */
export function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 10_000) return '>9,999%';
  return `${n.toFixed(2)}%`;
}
