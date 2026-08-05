// lib/agent/history.ts - recent price history for the Limen Agent's quant features.
//
// Source: Pyth's public benchmarks API (TradingView shim) - 1-minute bars for the same
// feeds the arena settles on. A CROSS market (cirBTC/EURC = BTC/USD ÷ EUR/USD) divides
// the two close series element-wise on their shared tail, mirroring the on-chain
// CompositePythOracle's math, so the agent reasons in the exact price the epoch settles in.

const BENCHMARKS = 'https://benchmarks.pyth.network/v1/shims/tradingview/history';

/** Pyth feedId -> benchmarks symbol, for the feeds Limen markets actually use. */
const FEED_SYMBOLS: Record<string, string> = {
  // BTC/USD
  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'Crypto.BTC/USD',
  // EUR/USD
  '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b': 'FX.EUR/USD',
};

interface TvHistory {
  s: string;
  c?: number[];
}

async function fetchCloses(symbol: string, fromSec: number, toSec: number, timeoutMs: number): Promise<number[]> {
  const url = `${BENCHMARKS}?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${fromSec}&to=${toSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`benchmarks ${res.status} for ${symbol}`);
  const body = (await res.json()) as TvHistory;
  if (body.s !== 'ok' || !Array.isArray(body.c) || body.c.length === 0) {
    throw new Error(`benchmarks returned no bars for ${symbol}`);
  }
  return body.c;
}

// Last-good bars per market: the benchmarks API rate-limits chatty clients (a 15s poll
// running for days WILL eventually see 403/429s), and a signal that dies with the fetch
// silently starves the autopilot through whole entry windows. Bars only change once a
// minute, so serving a few-minutes-old series is statistically identical - the quant
// re-scales by the remaining horizon anyway.
const STALE_OK_MS = 5 * 60_000;
const lastGood = new Map<string, { at: number; closes: number[]; barSec: number }>();

/**
 * Close-price series (1-min bars, oldest first) for a market's settlement price over the
 * trailing `windowSec`. Single-feed markets return the feed's closes; cross markets return
 * base ÷ quote aligned on the shared tail (the two grids can differ by a bar at the edges).
 * A failed fetch falls back to the last GOOD series if it is under five minutes old.
 */
export async function fetchMarketCloses(
  feedId: string,
  quoteFeedId: string | undefined,
  windowSec = 3_600,
  nowSec = Math.floor(Date.now() / 1000),
  timeoutMs = 8_000,
): Promise<{ closes: number[]; barSec: number }> {
  const cacheKey = `${feedId.toLowerCase()}|${quoteFeedId?.toLowerCase() ?? ''}`;
  try {
    const result = await fetchMarketClosesFresh(feedId, quoteFeedId, windowSec, nowSec, timeoutMs);
    lastGood.set(cacheKey, { at: Date.now(), ...result });
    return result;
  } catch (err) {
    const cached = lastGood.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < STALE_OK_MS) {
      return { closes: cached.closes, barSec: cached.barSec };
    }
    throw err;
  }
}

async function fetchMarketClosesFresh(
  feedId: string,
  quoteFeedId: string | undefined,
  windowSec: number,
  nowSec: number,
  timeoutMs: number,
): Promise<{ closes: number[]; barSec: number }> {
  const baseSym = FEED_SYMBOLS[feedId.toLowerCase()];
  if (!baseSym) throw new Error(`no benchmarks symbol mapped for feed ${feedId}`);
  const from = nowSec - windowSec;

  if (!quoteFeedId) {
    return { closes: await fetchCloses(baseSym, from, nowSec, timeoutMs), barSec: 60 };
  }

  const quoteSym = FEED_SYMBOLS[quoteFeedId.toLowerCase()];
  if (!quoteSym) throw new Error(`no benchmarks symbol mapped for quote feed ${quoteFeedId}`);
  const [b, q] = await Promise.all([
    fetchCloses(baseSym, from, nowSec, timeoutMs),
    fetchCloses(quoteSym, from, nowSec, timeoutMs),
  ]);
  const n = Math.min(b.length, q.length);
  const closes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const bb = b[b.length - n + i];
    const qq = q[q.length - n + i];
    if (!(qq > 0)) throw new Error('quote leg has a non-positive close');
    closes.push(bb / qq);
  }
  return { closes, barSec: 60 };
}
