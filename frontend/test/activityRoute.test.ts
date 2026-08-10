import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActivityEvent } from '@/lib/activity/types';

const listMock = vi.hoisted(() => vi.fn());

// One live v3 market; the real decoder runs against the mocked raw logs.
vi.mock('@/lib/markets', () => ({
  MARKETS: [
    { id: 'cirbtc', label: 'cirBTC / USDC', feeArena: '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f', version: 'v3', quoteSymbol: 'USDC' },
  ],
  isV3Market: (m: { version?: string }) => m.version === 'v3',
}));

// The route only imports listContractEvents — mock just that.
vi.mock('@/lib/server/circleServer', () => ({ listContractEvents: listMock }));

import { GET } from '@/app/api/circle/activity/route';
import { mergeActivity } from '@/lib/activity/merge';

/** The real captured SettlementPriceSubmitted log (epoch 1281), overridable per-case. */
const priceLog = (over: Record<string, unknown> = {}) => ({
  id: 'price',
  txHash: '0x8ffe2163169dd9a2636c305df1165abf059f8f87d17a59ba9094e8096aaa7e84',
  blockHeight: 47902235,
  topics: [
    '0x33273b88ead2412a7e0ab4f7866da95abfb10d6386df5a066a79cc45b828eef8',
    '0x0000000000000000000000000000000000000000000000000000000000000501',
  ],
  data: '0x000000000000000000000000000000000000000000000d85caa8934ee6390cb0000000000000000000000000000000000000000000000d866a7686c55ef97800000000000000000000000000000000000000000000000000000000006a36ff70000000000000000000000000000000000000000000000000000000006a36ffac93f1c192d4b48ca9e201f372d3bdf6de6d605b04e4e63065ebb9fd32b780fa64',
  ...over,
});

const evt = (over: Partial<ActivityEvent>): ActivityEvent =>
  ({ id: 'e', kind: 'settled', marketId: 'm', marketLabel: 'M', quoteSymbol: 'USDC', epochId: 1, txHash: '0x0', blockHeight: 1, logIndex: 0, ...over }) as ActivityEvent;

/** A route Request (Next passes one); `qs` adds the optional ?market=… scope. */
const req = (qs = '') => new Request(`https://limen.finance/api/circle/activity${qs}`);

beforeEach(() => listMock.mockReset());
afterEach(() => {
  delete process.env.CIRCLE_SCP_API_KEY;
  delete process.env.CIRCLE_API_KEY;
});

describe('GET /api/circle/activity', () => {
  it('returns decoded events sorted by blockHeight desc', async () => {
    listMock.mockResolvedValue([priceLog({ id: 'a', blockHeight: 47902235 }), priceLog({ id: 'b', blockHeight: 47902300 })]);
    const res = await GET(req());
    const json = await res.json();
    expect(json.events).toHaveLength(2);
    expect(json.events[0].id).toBe('b'); // higher block first
    expect(json.events[0].kind).toBe('priceSubmitted');
    expect(json.events[0].marketId).toBe('cirbtc');
    expect(json.events[0].quoteSymbol).toBe('USDC');
    expect(json.events[0].finalPrice18).toBe('63858784322867586206896');
    expect(json.degraded).toBeFalsy();
  });

  it('drops undecodable logs', async () => {
    listMock.mockResolvedValue([{ id: 'x', txHash: '0xcc', blockHeight: 1, topics: [`0x${'12'.repeat(32)}`], data: '0x' }]);
    const res = await GET(req());
    const json = await res.json();
    expect(json.events).toEqual([]);
  });

  it('prefers CIRCLE_SCP_API_KEY, falls back to CIRCLE_API_KEY, undefined when neither set', async () => {
    listMock.mockResolvedValue([]);
    process.env.CIRCLE_SCP_API_KEY = 'scp-key';
    process.env.CIRCLE_API_KEY = 'main-key';
    await GET(req());
    expect(listMock.mock.calls[0][1].apiKey).toBe('scp-key');

    listMock.mockClear();
    delete process.env.CIRCLE_SCP_API_KEY;
    await GET(req());
    expect(listMock.mock.calls[0][1].apiKey).toBe('main-key');

    listMock.mockClear();
    delete process.env.CIRCLE_API_KEY;
    await GET(req());
    expect(listMock.mock.calls[0][1].apiKey).toBeUndefined();
  });

  it('?market=<id> scopes the feed to that market', async () => {
    listMock.mockResolvedValue([priceLog({ id: 'a', blockHeight: 1 })]);
    const json = await (await GET(req('?market=cirbtc'))).json();
    expect(json.events).toHaveLength(1);
    expect(listMock).toHaveBeenCalledTimes(1); // only the one matching arena queried
  });

  it('?market=<unknown> returns an empty feed (never the wrong market) and queries no arena', async () => {
    listMock.mockResolvedValue([priceLog({ id: 'a', blockHeight: 1 })]);
    const json = await (await GET(req('?market=does-not-exist'))).json();
    expect(json.events).toEqual([]);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('mergeActivity', () => {
  it('flags degraded when EVERY market failed (all null)', () => {
    expect(mergeActivity([null])).toEqual({ events: [], degraded: true });
    expect(mergeActivity([null, null])).toEqual({ events: [], degraded: true });
  });

  it('does NOT flag degraded on a partial failure', () => {
    const out = mergeActivity([[evt({ id: 'x', blockHeight: 5 })], null]);
    expect(out.degraded).toBeUndefined();
    expect(out.events).toHaveLength(1);
  });

  it('returns empty (not degraded) when there are no markets at all', () => {
    expect(mergeActivity([])).toEqual({ events: [] });
  });

  it('dedupes by id (same log from overlapping pages / two markets)', () => {
    const out = mergeActivity([[evt({ id: 'dup', blockHeight: 5 })], [evt({ id: 'dup', blockHeight: 5 })]]);
    expect(out.events).toHaveLength(1);
  });

  it('breaks same-block ties deterministically by logIndex (desc)', () => {
    const out = mergeActivity([[evt({ id: 'a', blockHeight: 5, logIndex: 1 }), evt({ id: 'b', blockHeight: 5, logIndex: 3 })]]);
    expect(out.events.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('merges, sorts newest-first and caps at 50', () => {
    const a = Array.from({ length: 40 }, (_, i) => evt({ id: `a${i}`, blockHeight: i }));
    const b = Array.from({ length: 40 }, (_, i) => evt({ id: `b${i}`, blockHeight: 100 + i }));
    const out = mergeActivity([a, b]);
    expect(out.events).toHaveLength(50);
    expect(out.events[0].blockHeight).toBe(139); // highest first (b: 100..139, a: 0..39)
    expect(out.events[49].blockHeight).toBe(30); // top 50 = 139..100 then 39..30
  });
});
