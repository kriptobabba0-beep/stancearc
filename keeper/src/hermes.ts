// hermes.ts - fetch the latest signed Pyth price update for a feed id from Hermes
// (Pyth's off-chain aggregator). Mirrors frontend/lib/pyth.ts. The returned hex
// blobs are passed as the `bytes[] priceData` arg to startEpoch/endEpoch, and are
// also priced via Pyth.getUpdateFee to compute the `value` to pay.
//
// IMPORTANT (capture-pinning): fetch a FRESH update immediately before each of
// startEpoch and endEpoch so the update's publishTime is at/after the epoch
// boundary timestamp (see script/keeper/post-and-crank.md). The keeper calls this
// once per START and once per END - never reuses a stale blob.

/** Shape of the Hermes v2 latest-update JSON response (only the fields we read). */
interface HermesLatestResponse {
  binary?: { data?: string[] };
  parsed?: Array<{
    id?: string;
    price?: { price?: string; conf?: string; expo?: number; publish_time?: number };
  }>;
}

/** A parsed Pyth reference price for the arb bot: human price in 18dp + publish time. */
export interface PythRef {
  /** The price scaled to 18 decimals (1e18 == $1), e.g. for divergence math. */
  price18: bigint;
  /** Unix seconds the price was published (used to compute staleness/refAgeSec). */
  publishTimeSec: number;
}

/**
 * Convert a Pyth integer price + base-10 exponent into an 18-decimal fixed-point bigint.
 * Pyth prices are `price * 10^expo` with expo typically negative (e.g. -8). PURE.
 *   price18 = price * 10^(18 + expo)   (expo>-18 => multiply; expo<-18 => divide)
 */
export function pythToPrice18(price: bigint, expo: number): bigint {
  const shift = 18 + expo;
  if (shift >= 0) return price * 10n ** BigInt(shift);
  return price / 10n ** BigInt(-shift);
}

/** Default abort window if a caller doesn't pass one (mirrors config HERMES_TIMEOUT_MS). */
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Fetch the latest signed Pyth update(s) for a single feed id.
 * @param timeoutMs abort the request after this many ms so a hung Hermes can't wedge
 *   the whole sequential market loop - the rejection is caught and retried next tick.
 * @returns array of 0x-prefixed hex blobs (the `bytes[]` priceData).
 * @throws on a non-ok HTTP response, an empty update set, or a timeout/abort.
 */
export async function fetchPythUpdate(
  hermesUrl: string,
  feedId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<`0x${string}`[]> {
  const base = hermesUrl.replace(/\/$/, '');
  const id = feedId.replace(/^0x/, '');
  const url = `${base}/v2/updates/price/latest?ids[]=${id}&encoding=hex`;

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }

  const body = (await res.json()) as HermesLatestResponse;
  const data = body.binary?.data ?? [];
  const updateData = data.map((h) => `0x${h.replace(/^0x/, '')}` as `0x${string}`);
  if (updateData.length === 0) throw new Error('Hermes returned no update data');
  return updateData;
}

/**
 * Fetch the latest PARSED Pyth reference price for a single feed id (READ-ONLY - the arb
 * bot does NOT post these updates on-chain; it only reads the live reference to decide a
 * trade). Returns the price scaled to 18dp + its publish time so the caller can compute
 * the reference age (staleness) against the wall clock.
 * @throws on a non-ok HTTP response, a missing parsed entry, or a timeout/abort.
 */
export async function fetchPythRef(
  hermesUrl: string,
  feedId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PythRef> {
  const base = hermesUrl.replace(/\/$/, '');
  const id = feedId.replace(/^0x/, '');
  const url = `${base}/v2/updates/price/latest?ids[]=${id}&encoding=hex&parsed=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }

  const body = (await res.json()) as HermesLatestResponse;
  const entry = (body.parsed ?? [])[0];
  const p = entry?.price;
  if (p?.price === undefined || p.expo === undefined || p.publish_time === undefined) {
    throw new Error('Hermes returned no parsed price');
  }
  return {
    price18: pythToPrice18(BigInt(p.price), p.expo),
    publishTimeSec: p.publish_time,
  };
}

/**
 * Fetch BOTH the signed update blob(s) AND the parsed price18 in ONE request. Used to place an
 * entry-anchored stake: the `bytes[] priceData` blob is posted on-chain AND the `expectedEntryPrice18`
 * the contract slippage-guards must agree with it - fetching both from the same response keeps them
 * consistent (vs two separate calls that could straddle a price tick).
 * @throws on a non-ok HTTP response, an empty update set, a missing parsed price, or a timeout/abort.
 */
export async function fetchPythUpdateWithPrice(
  hermesUrl: string,
  feedId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ updateData: `0x${string}`[]; price18: bigint; publishTimeSec: number }> {
  const base = hermesUrl.replace(/\/$/, '');
  const id = feedId.replace(/^0x/, '');
  const url = `${base}/v2/updates/price/latest?ids[]=${id}&encoding=hex&parsed=true`;

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }

  const body = (await res.json()) as HermesLatestResponse;
  const updateData = (body.binary?.data ?? []).map((h) => `0x${h.replace(/^0x/, '')}` as `0x${string}`);
  if (updateData.length === 0) throw new Error('Hermes returned no update data');
  const p = (body.parsed ?? [])[0]?.price;
  if (p?.price === undefined || p.expo === undefined || p.publish_time === undefined) {
    throw new Error('Hermes returned no parsed price');
  }
  return {
    updateData,
    price18: pythToPrice18(BigInt(p.price), p.expo),
    publishTimeSec: p.publish_time,
  };
}

/** Normalize a 0x-or-bare feed id to the bare lowercase hex Hermes returns in `parsed[].id`. */
function bareId(feedId: string): string {
  return feedId.replace(/^0x/, '').toLowerCase();
}

/**
 * Fetch ONE signed Pyth blob covering MULTIPLE feed ids in a single request (Hermes supports repeated
 * `ids[]`). Used for CROSS markets (e.g. cirBTC/EURC settles on BTC/EUR = BTC/USD ÷ EUR/USD): the
 * CompositePythOracle's update() posts this one blob and getPriceUnsafe() then reads BOTH legs fresh.
 * @throws on a non-ok response, empty update set, or timeout.
 */
export async function fetchPythUpdateMulti(
  hermesUrl: string,
  feedIds: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<`0x${string}`[]> {
  const base = hermesUrl.replace(/\/$/, '');
  const qs = feedIds.map((f) => `ids[]=${bareId(f)}`).join('&');
  const url = `${base}/v2/updates/price/latest?${qs}&encoding=hex`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }
  const body = (await res.json()) as HermesLatestResponse;
  const data = (body.binary?.data ?? []).map((h) => `0x${h.replace(/^0x/, '')}` as `0x${string}`);
  if (data.length === 0) throw new Error('Hermes returned no update data');
  return data;
}

/**
 * Fetch the CROSS reference price (numerator/denominator) in 18-dp for a two-feed market, e.g.
 * BTC/EUR = (BTC/USD) ÷ (EUR/USD). Matches the on-chain CompositePythOracle.getPrice() math exactly
 * (price18 = num18 * 1e18 / den18) so the keeper's submitted settlement average agrees with the
 * arena's on-chain anchor within settleSanityBps. publishTimeSec = the OLDER of the two legs.
 * @throws on a non-ok response, a missing/zero leg, or timeout.
 */
export async function fetchPythCrossRef(
  hermesUrl: string,
  numeratorFeedId: string,
  denominatorFeedId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<PythRef> {
  const base = hermesUrl.replace(/\/$/, '');
  const num = bareId(numeratorFeedId);
  const den = bareId(denominatorFeedId);
  const url = `${base}/v2/updates/price/latest?ids[]=${num}&ids[]=${den}&encoding=hex&parsed=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }
  const body = (await res.json()) as HermesLatestResponse;
  const entries = body.parsed ?? [];
  const find = (id: string) => entries.find((e) => bareId(String(e.id ?? '')) === id)?.price;
  const np = find(num);
  const dp = find(den);
  if (np?.price === undefined || np.expo === undefined || np.publish_time === undefined) {
    throw new Error('Hermes returned no parsed numerator price');
  }
  if (dp?.price === undefined || dp.expo === undefined || dp.publish_time === undefined) {
    throw new Error('Hermes returned no parsed denominator price');
  }
  const num18 = pythToPrice18(BigInt(np.price), np.expo);
  const den18 = pythToPrice18(BigInt(dp.price), dp.expo);
  if (num18 <= 0n || den18 <= 0n) throw new Error('Hermes cross leg is non-positive');
  return {
    price18: (num18 * 10n ** 18n) / den18,
    publishTimeSec: Math.min(np.publish_time, dp.publish_time),
  };
}
