import { describe, it, expect, vi, beforeEach } from 'vitest';

// fetchArbRef is the ONLY market-type branch in the arb engine: a CROSS-quoted market (quoteFeedId
// set, e.g. cirBTC/EURC = BTC/USD ÷ EUR/USD) reads the cross rate; a single-feed market (cirBTC/USDC)
// reads feedId directly. We mock the hermes module to assert the routing WITHOUT any network — and,
// crucially, that a single-feed market NEVER calls the cross path (the USDC arb is unaffected).
const fetchPythRef = vi.fn();
const fetchPythCrossRef = vi.fn();
vi.mock('../src/hermes.js', () => ({
  fetchPythRef: (...a: unknown[]) => fetchPythRef(...a),
  fetchPythCrossRef: (...a: unknown[]) => fetchPythCrossRef(...a),
}));

import { fetchArbRef } from '../src/arb.js';
import type { ArbConfig } from '../src/config.js';

type ArbMarket = ArbConfig['market'];
const FEED = `0x${'b'.repeat(64)}` as `0x${string}`;
const QUOTE_FEED = `0x${'c'.repeat(64)}` as `0x${string}`;

function market(quoteFeedId?: `0x${string}`): ArbMarket {
  return {
    id: 'm',
    label: 'm',
    arena: `0x${'1'.repeat(40)}`,
    pool: `0x${'2'.repeat(40)}`,
    base: `0x${'3'.repeat(40)}`,
    baseDecimals: 8,
    quote: `0x${'4'.repeat(40)}`,
    quoteDecimals: 6,
    feedId: FEED,
    ...(quoteFeedId ? { quoteFeedId } : {}),
    router: `0x${'5'.repeat(40)}`,
    feeTier: 3000,
  } as ArbMarket;
}

beforeEach(() => {
  fetchPythRef.mockReset().mockResolvedValue({ price18: 111n, publishTimeSec: 10 });
  fetchPythCrossRef.mockReset().mockResolvedValue({ price18: 222n, publishTimeSec: 20 });
});

describe('fetchArbRef — peg-reference routing', () => {
  it('single-feed market (no quoteFeedId) reads feedId directly and NEVER calls the cross path', async () => {
    const ref = await fetchArbRef('https://hermes', market(), 8000);
    expect(fetchPythRef).toHaveBeenCalledTimes(1);
    expect(fetchPythRef).toHaveBeenCalledWith('https://hermes', FEED, 8000);
    expect(fetchPythCrossRef).not.toHaveBeenCalled();
    expect(ref.price18).toBe(111n);
  });

  it('cross-quoted market reads feedId ÷ quoteFeedId (BTC/USD ÷ EUR/USD) and NEVER the single path', async () => {
    const ref = await fetchArbRef('https://hermes', market(QUOTE_FEED), 8000);
    expect(fetchPythCrossRef).toHaveBeenCalledTimes(1);
    expect(fetchPythCrossRef).toHaveBeenCalledWith('https://hermes', FEED, QUOTE_FEED, 8000);
    expect(fetchPythRef).not.toHaveBeenCalled();
    expect(ref.price18).toBe(222n);
  });
});
