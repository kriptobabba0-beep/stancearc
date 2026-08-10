/** Fetch the latest signed Pyth price update for a feed id from Hermes. */
export async function fetchPythUpdate(
  hermesUrl: string,
  feedId: string,
): Promise<{ updateData: `0x${string}`[] }> {
  const base = hermesUrl.replace(/\/$/, '');
  const id = feedId.replace(/^0x/, '');
  const url = `${base}/v2/updates/price/latest?ids[]=${id}&encoding=hex`;
  const res = await fetch(url);
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }
  const body = (await res.json()) as { binary?: { data?: string[] } };
  const data = body.binary?.data ?? [];
  const updateData = data.map((h) => `0x${h.replace(/^0x/, '')}` as `0x${string}`);
  if (updateData.length === 0) throw new Error('Hermes returned no update data');
  return { updateData };
}

/** Convert a Pyth integer price + base-10 exponent into an 18-dp bigint (1e18 == $1). */
export function pythToPrice18(price: bigint, expo: number): bigint {
  const shift = 18 + expo;
  if (shift >= 0) return price * 10n ** BigInt(shift);
  return price / 10n ** BigInt(-shift);
}

/**
 * Fetch the latest signed update blob AND its parsed price in ONE Hermes request — the
 * v3 entry-anchored stake needs both: the blob posts on-chain (the contract reads the
 * anchor from it) and the parsed price18 becomes `expectedEntryPrice18` for the slippage
 * guard, so what the user is promised and what the contract reads come from the SAME update.
 */
export async function fetchPythUpdateWithPrice(
  hermesUrl: string,
  feedId: string,
): Promise<{ updateData: `0x${string}`[]; price18: bigint; publishTimeSec: number }> {
  const base = hermesUrl.replace(/\/$/, '');
  const id = feedId.replace(/^0x/, '');
  const url = `${base}/v2/updates/price/latest?ids[]=${id}&encoding=hex&parsed=true`;
  const res = await fetch(url);
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }
  const body = (await res.json()) as {
    binary?: { data?: string[] };
    parsed?: Array<{ price?: { price?: string; expo?: number; publish_time?: number } }>;
  };
  const data = body.binary?.data ?? [];
  const updateData = data.map((h) => `0x${h.replace(/^0x/, '')}` as `0x${string}`);
  if (updateData.length === 0) throw new Error('Hermes returned no update data');
  const p = (body.parsed ?? [])[0]?.price;
  if (p?.price === undefined || p.expo === undefined || p.publish_time === undefined) {
    throw new Error('Hermes returned no parsed price');
  }
  return { updateData, price18: pythToPrice18(BigInt(p.price), p.expo), publishTimeSec: p.publish_time };
}

/**
 * CROSS variant of {@link fetchPythUpdateWithPrice} for a two-feed market (e.g. cirBTC/EURC settles on
 * BTC/EUR = BTC/USD ÷ EUR/USD). Fetches ONE Hermes blob covering BOTH feeds (so the on-chain
 * CompositePythOracle reads both legs fresh) and returns the CROSS price18 = num18 * 1e18 / den18 —
 * matching the oracle's getPrice() math exactly, so the entry-anchor slippage guard agrees on-chain.
 */
export async function fetchPythCrossUpdateWithPrice(
  hermesUrl: string,
  numeratorFeedId: string,
  denominatorFeedId: string,
): Promise<{ updateData: `0x${string}`[]; price18: bigint; publishTimeSec: number }> {
  const base = hermesUrl.replace(/\/$/, '');
  const num = numeratorFeedId.replace(/^0x/, '').toLowerCase();
  const den = denominatorFeedId.replace(/^0x/, '').toLowerCase();
  const url = `${base}/v2/updates/price/latest?ids[]=${num}&ids[]=${den}&encoding=hex&parsed=true`;
  const res = await fetch(url);
  if (!('ok' in res) || !res.ok) {
    const status = 'status' in res ? (res as Response).status : 'unknown';
    throw new Error(`Hermes request failed (${status})`);
  }
  const body = (await res.json()) as {
    binary?: { data?: string[] };
    parsed?: Array<{ id?: string; price?: { price?: string; expo?: number; publish_time?: number } }>;
  };
  const data = body.binary?.data ?? [];
  const updateData = data.map((h) => `0x${h.replace(/^0x/, '')}` as `0x${string}`);
  if (updateData.length === 0) throw new Error('Hermes returned no update data');
  const entries = body.parsed ?? [];
  const find = (id: string) => entries.find((e) => String(e.id ?? '').replace(/^0x/, '').toLowerCase() === id)?.price;
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
    updateData,
    price18: (num18 * 10n ** 18n) / den18,
    publishTimeSec: Math.min(np.publish_time, dp.publish_time),
  };
}
