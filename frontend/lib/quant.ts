// lib/quant.ts — pure projection math that QUANTIFIES the game for the UI: pot USD value, the
// "implied move to win" derived from the band, and the share text/URL for a win card. All money math
// is BigInt and FLOORS (truncates toward zero) to match the contract; format only at render.
//
// HONEST framing rule: nothing here fabricates odds or probabilities. The implied move is a pure
// restatement of the band (a 20-bps band ⇒ "BTC must move >0.20% this epoch for UP/DOWN; else RANGE"),
// and pot USD values are pot tokens × the live oracle price — both are facts, not predictions.

/**
 * USD value (scaled to 6dp, i.e. micro-dollars — same scale as USDC) of a base-token amount priced by
 * the 18dp oracle quote. Floors. Pure ratio:
 *   usd6 = floor( baseRaw * price18 * 1e6 / (10^baseDecimals * 1e18) )
 * baseRaw is the base leg at its own decimals (cirBTC 8dp, WETH 18dp, …); price18 is 1e18 == $1.
 * Returns 0 for a zero price (oracle not yet read) or zero amount.
 */
export function baseUsd6(baseRaw: bigint, baseDecimals: number, price18: bigint): bigint {
  if (baseRaw === 0n || price18 === 0n) return 0n;
  const numer = baseRaw * price18 * 1_000_000n;
  const denom = 10n ** BigInt(baseDecimals) * 1_000_000_000_000_000_000n; // 10^baseDec * 1e18
  return numer / denom; // BigInt division floors (operands non-negative)
}

/**
 * Total pot USD value (scaled to 6dp). The USDC leg is already 6dp USD, so it is added verbatim; the
 * base leg is converted via baseUsd6. price18==0 (oracle unread) ⇒ only the USDC leg contributes.
 */
export function potUsd6(args: {
  potWETH: bigint; // base leg, raw at baseDecimals (named potWETH on EpochView for back-compat)
  potUSDC: bigint; // USDC leg, 6dp
  baseDecimals: number;
  price18: bigint;
}): bigint {
  return args.potUSDC + baseUsd6(args.potWETH, args.baseDecimals, args.price18);
}

/**
 * Total ~USD value (6dp) distributed to winners across a set of leaderboard rows — i.e. the market's
 * lifetime claimed payout. Each row's base leg is valued at the live price (baseUsd6) and added to its
 * USDC leg; price18==0 (oracle unread) ⇒ only the USDC legs contribute. Pure aggregate of on-chain
 * Claimed payouts — no fabricated figure. `rows` is the useLeaderboard projection (claimedBase/USDC).
 */
export function totalClaimedUsd6(
  rows: ReadonlyArray<{ claimedBase: bigint; claimedUSDC: bigint }>,
  baseDecimals: number,
  price18: bigint,
): bigint {
  let usd6 = 0n;
  for (const r of rows) usd6 += r.claimedUSDC + baseUsd6(r.claimedBase, baseDecimals, price18);
  return usd6;
}

/**
 * The "implied move to win" derived purely from the band. A band of N bps means the settle price must
 * be MORE than N bps away from the start price (in either direction) for a directional side (UP/DOWN)
 * to win; a move within ±N bps is a RANGE win. Returns the band as an absolute percent number (e.g.
 * 20 bps ⇒ 0.2) plus the bps echoed back. |band| is used so a malformed negative band still reads sanely.
 */
export function impliedMove(bandBps: number): { pct: number; bps: number } {
  const bps = Math.abs(bandBps);
  return { pct: bps / 100, bps };
}

/**
 * Human one-liner for the implied move, e.g. 20 ⇒ "BTC must move >0.20% this epoch for UP/DOWN; else
 * RANGE". `symbol` is the price pair's base label (e.g. "BTC"). A zero band degrades to a plain note.
 */
export function impliedMoveText(bandBps: number, symbol: string): string {
  const { pct, bps } = impliedMove(bandBps);
  if (bps === 0) return `Any move decides UP/DOWN; an exactly-flat epoch is a RANGE win`;
  // |pct| < 1 keeps 2 decimals (0.20%), ≥1 trims (1.5%) — mirrors lib/format.formatBps legibility.
  const pctStr = pct < 1 ? pct.toFixed(2) : String(pct);
  return `${symbol} must move >${pctStr}% this epoch for UP/DOWN; else RANGE`;
}

/** The price-pair base symbol for copy (strip a leading "W", e.g. WETH→ETH, WBTC→BTC; cirBTC→cirBTC). */
export function priceSymbol(baseSymbol: string): string {
  return baseSymbol.replace(/^W(?=[A-Z])/, '');
}

/**
 * Compact USD label for a 6dp USD value. Sub-$1 keeps 2 decimals ("$0.42"); ≥$1 rounds to whole
 * dollars with thousands separators ("$1,234"). Pure string math on the integer dollars/cents — no
 * float drift on the dollar part. Negative inputs are clamped to 0 (USD values here are non-negative).
 */
export function formatUsd6(usd6: bigint, symbol = '$'): string {
  const v = usd6 < 0n ? 0n : usd6;
  if (v < 1_000_000n) {
    // Sub-unit: show cents (2dp). cents = floor(v / 1e4) gives hundredths exactly.
    const cents = v / 10_000n;
    const whole = cents / 100n;
    const frac = (cents % 100n).toString().padStart(2, '0');
    return `${symbol}${whole.toString()}.${frac}`;
  }
  const dollars = v / 1_000_000n; // floor to whole units
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${symbol}${grouped}`;
}

/**
 * USD label that DOES NOT vanish for dust amounts. At or above $0.01 it defers to formatUsd6 (cents,
 * then whole dollars with separators). Below a cent — but non-zero — it shows the real micro-dollar
 * value with up to 6 fractional digits (trailing zeros trimmed), so a tiny-but-real pot reads as e.g.
 * "$0.000526" instead of rounding away to "$0.00". A genuine zero still shows "$0.00".
 */
export function formatUsd6Precise(usd6: bigint, symbol = '$'): string {
  const v = usd6 < 0n ? 0n : usd6;
  if (v === 0n) return `${symbol}0.00`;
  if (v >= 10_000n) return formatUsd6(v, symbol); // ≥ $0.01 — cents/dollars read fine
  // Sub-cent: v is micro-dollars (6dp). Pad to 6 fractional digits, trim trailing zeros.
  const frac = v.toString().padStart(6, '0').replace(/0+$/, '');
  return `${symbol}0.${frac}`;
}

/**
 * Cumulative USD value (6dp) of every settled epoch's fee pool — the total trading fees the arena has
 * redistributed to date. The entry-anchored (v3) arena only snapshots a pot AT settlement, so the live
 * epoch's pot is always 0; this aggregate over the settled history is the honest non-zero "fee pool"
 * figure to surface. Each row's base leg is valued at the live price and added to its USDC leg.
 * price18==0 (oracle unread) ⇒ only the USDC legs contribute.
 */
export function cumulativePot6(
  rows: ReadonlyArray<{ potBase: bigint; potUSDC: bigint }>,
  baseDecimals: number,
  price18: bigint,
): bigint {
  let usd6 = 0n;
  for (const r of rows) usd6 += r.potUSDC + baseUsd6(r.potBase, baseDecimals, price18);
  return usd6;
}

/**
 * Absolute URL of a per-epoch share page. `origin` is the site origin (no trailing slash required);
 * falls back to a relative path when origin is empty (e.g. SSR with no known host).
 */
export function epochShareUrl(origin: string, epochId: bigint): string {
  const base = origin.replace(/\/$/, '');
  const path = `/epoch/${epochId.toString()}`;
  return base ? `${base}${path}` : path;
}

/**
 * Share copy for a settled win, e.g. 'Epoch #7 — DOWN won. I earned $1,234 on Limen Finance.'
 * `winningLabel` is the SIDE label ("UP"/"DOWN"/"RANGE"); `usd6` is the user's earned payout in 6dp USD.
 */
export function winShareText(args: { epochId: bigint; winningLabel: string; usd6: bigint }): string {
  return `Epoch #${args.epochId.toString()} — ${args.winningLabel} won. I earned ${formatUsd6(
    args.usd6,
  )} on Limen Finance.`;
}
