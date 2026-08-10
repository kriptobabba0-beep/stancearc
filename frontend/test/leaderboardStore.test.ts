// The KV store is the site's half of the leaderboard: one payload per market, written only by the
// keeper's indexer. These cover the two things that keep it trustworthy — nobody else can write
// (auth + shape validation) and a missing/broken store degrades to an honest empty state instead
// of a 500.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/markets', () => ({
  MARKETS: [
    { id: 'btc', label: 'cirBTC / USDC', feeArena: '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2', version: 'v3', baseSymbol: 'cirBTC', quoteSymbol: 'USDC' },
    { id: 'legacy', label: 'old', feeArena: '0xdead', version: 'v1', baseSymbol: 'cirBTC' },
  ],
  isV3Market: (m: { version?: string }) => m.version === 'v3',
}));

// The KV binding comes from the Workers request context, which doesn't exist under vitest.
const kvStore = new Map<string, string>();
vi.mock('@opennextjs/cloudflare', () => ({
  getCloudflareContext: () => ({
    env: {
      LEADERBOARD_KV: {
        get: async (k: string) => kvStore.get(k) ?? null,
        put: async (k: string, v: string) => void kvStore.set(k, v),
      },
    },
  }),
}));

import { secretsMatch, validatePayload, kvKey, kvSelfKey, kvCampaignKey, readPayload, writePayload, warmingUpPayload } from '@/lib/leaderboardStore';
import { GET } from '@/app/api/leaderboard/route';
import { POST } from '@/app/api/leaderboard/ingest/route';
import { GET as GET_CAMPAIGN } from '@/app/api/campaign/route';
import { POST as POST_CAMPAIGN } from '@/app/api/campaign/ingest/route';
import { GET as GET_CAMPAIGNS } from '@/app/api/campaigns/route';

const SECRET = 'correct-horse-battery-staple';

const goodPayload = (over: Record<string, unknown> = {}) => ({
  market: 'btc',
  arena: '0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2',
  baseSymbol: 'cirBTC',
  quoteSymbol: 'USDC',
  head: '55329089',
  cursor: '55329089',
  syncing: false,
  progress: 100,
  updatedAt: 1785876761293,
  generatedAt: 1785876761293,
  lastError: null,
  totals: { epochsSettled: 8627, volumeUsd6: '611284802534', swapUsd6: '1', liqUsd6: '1', feeUsd6: '1', redistributedUsd6: '1', participants: 3 },
  rows: [],
  d30: [],
  d7: [],
  ...over,
});

const post = (body: unknown, secret?: string) =>
  POST(
    new Request('https://limen.finance/api/leaderboard/ingest', {
      method: 'POST',
      headers: secret === undefined ? {} : { 'X-Leaderboard-Secret': secret },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const get = (market?: string, self?: string) =>
  GET(
    new Request(
      `https://limen.finance/api/leaderboard?market=${market ?? 'btc'}${self ? `&self=${self}` : ''}`,
    ),
  );

beforeEach(() => {
  kvStore.clear();
  process.env.LEADERBOARD_INGEST_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.LEADERBOARD_INGEST_SECRET;
});

describe('secretsMatch', () => {
  it('accepts an exact match and nothing else', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch(SECRET, `${SECRET}x`)).toBe(false);
    expect(secretsMatch(SECRET.toUpperCase(), SECRET)).toBe(false);
  });

  it('treats missing values as a mismatch rather than a match', () => {
    // The dangerous bug here is two empty strings comparing equal, which would let an
    // unconfigured deploy accept anonymous writes.
    expect(secretsMatch('', '')).toBe(false);
    expect(secretsMatch(null, null)).toBe(false);
    expect(secretsMatch(undefined, SECRET)).toBe(false);
  });
});

describe('validatePayload', () => {
  it('accepts a well-formed payload', () => {
    expect(validatePayload(goodPayload(), 'btc')).toBeNull();
  });

  it('rejects anything that could poison the served response', () => {
    expect(validatePayload(goodPayload({ market: 'eth' }), 'btc')).toMatch(/mismatch/);
    expect(validatePayload(goodPayload({ rows: 'nope' }), 'btc')).toMatch(/rows/);
    expect(validatePayload(goodPayload({ head: 55 }), 'btc')).toMatch(/head/);
    expect(validatePayload(goodPayload({ generatedAt: 'now' }), 'btc')).toMatch(/generatedAt/);
    expect(validatePayload(null, 'btc')).toMatch(/object/);
  });
});

describe('ingest route', () => {
  it('stores a valid payload under the market key', async () => {
    const res = await post(goodPayload(), SECRET);
    expect(res.status).toBe(200);
    expect(kvStore.get(kvKey('btc'))).toContain('611284802534');
  });

  it('refuses writes without the right secret', async () => {
    expect((await post(goodPayload(), 'wrong')).status).toBe(401);
    expect((await post(goodPayload())).status).toBe(401);
    expect(kvStore.size).toBe(0);
  });

  it('fails CLOSED when no secret is configured', async () => {
    delete process.env.LEADERBOARD_INGEST_SECRET;
    // An unconfigured deploy must reject every write, not accept anonymous ones.
    expect((await post(goodPayload(), SECRET)).status).toBe(503);
    expect(kvStore.size).toBe(0);
  });

  it('rejects malformed bodies', async () => {
    expect((await post('{ not json', SECRET)).status).toBe(400);
    expect((await post(goodPayload({ rows: 'nope' }), SECRET)).status).toBe(400);
    expect(kvStore.size).toBe(0);
  });

  it('stores the exact bytes it validated, so the read path never re-parses', async () => {
    const body = JSON.stringify(goodPayload());
    await post(body, SECRET);
    expect(kvStore.get(kvKey('btc'))).toBe(body);
  });
});

describe('GET route', () => {
  it('serves the stored payload verbatim', async () => {
    await post(goodPayload(), SECRET);
    const res = await get('btc');
    expect(res.status).toBe(200);
    expect((await res.json()).totals.volumeUsd6).toBe('611284802534');
  });

  it('returns an honest empty state before the indexer has published', async () => {
    const body = await (await get('btc')).json();
    expect(body.rows).toEqual([]);
    expect(body.syncing).toBe(true);
    expect(body.lastError).toMatch(/not published/);
  });

  it('rejects unknown and non-v3 markets', async () => {
    expect((await get('nope')).status).toBe(404);
    expect((await get('legacy')).status).toBe(400);
  });
});

describe('store fallbacks', () => {
  it('reports no data instead of throwing when KV is unavailable', async () => {
    expect(await readPayload('btc', null)).toBeNull();
    expect(await writePayload('btc', '{}', null)).toBe(false);
  });

  it('warmingUpPayload is shaped like a real response so the page can render it', () => {
    const p = warmingUpPayload(
      { id: 'btc', feeArena: '0xabc', baseSymbol: 'cirBTC' },
      'cold start',
    );
    expect(p.quoteSymbol).toBe('USDC');
    expect(validatePayload(p, 'btc')).toBeNull();
  });
});

// Capping the board created a second question — "where do I stand?" for someone outside the top
// rows — and the answer must not undo the cap. The per-address index lives in KV and is read
// server-side; only the asker's own row ever reaches a browser.
describe('self lookup', () => {
  const OUTSIDER = '0x1111111111111111111111111111111111111111';
  const ONBOARD = '0x2222222222222222222222222222222222222222';

  const row = (addr: string) => ({
    address: addr, volumeUsd6: '900', swapUsd6: '900', liqUsd6: '0', feeUsd6: '0',
    pnlUsd6: '-5', claimedUsd6: '0', claimedBase: '0', claimedQuote: '0', entered: 3, won: 1,
  });

  const publish = () =>
    post(
      {
        payload: goodPayload({ rows: [row(ONBOARD)], d30: [row(ONBOARD)], d7: [], truncated: true, maxRows: 1 }),
        index: {
          all: { [OUTSIDER]: row(OUTSIDER), [ONBOARD]: row(ONBOARD) },
          d30: { [OUTSIDER]: row(OUTSIDER) },
          d7: {},
        },
      },
      SECRET,
    );

  it('publishes the board and the index to separate keys', async () => {
    const res = await publish();
    expect(res.status).toBe(200);
    expect(kvStore.get(kvKey('btc'))).toBeTruthy();
    expect(kvStore.get(kvSelfKey('btc'))).toContain(OUTSIDER);
    // The board a browser downloads must NOT contain the index.
    expect(kvStore.get(kvKey('btc'))).not.toContain(OUTSIDER);
  });

  it('attaches only the asking wallet, not the whole index', async () => {
    await publish();
    const body = await (await get('btc', OUTSIDER)).json();
    expect(body.self.address).toBe(OUTSIDER);
    expect(body.self.all.entered).toBe(3);
    expect(body.self.d7).toBeNull(); // absent from that window, honestly reported
    expect(body.rows).toHaveLength(1); // board still capped
  });

  it('skips the lookup when the wallet is already on the board', async () => {
    await publish();
    const body = await (await get('btc', ONBOARD)).json();
    expect(body.self).toBeUndefined(); // the badge finds them in place
  });

  it('reports an unknown wallet as having no standing rather than failing', async () => {
    await publish();
    const body = await (await get('btc', '0x9999999999999999999999999999999999999999')).json();
    expect(body.self).toEqual({
      address: '0x9999999999999999999999999999999999999999',
      all: null, d30: null, d7: null,
    });
  });

  it('ignores a malformed self parameter instead of trusting it', async () => {
    await publish();
    const body = await (await get('btc', 'not-an-address')).json();
    expect(body.self).toBeUndefined();
  });

  it('still accepts a bare payload from an older indexer', async () => {
    const res = await post(goodPayload(), SECRET);
    expect(res.status).toBe(200);
    expect(kvStore.get(kvKey('btc'))).toBeTruthy();
  });
});

describe('edge caching', () => {
  it('lets Cloudflare hold the shared board briefly', async () => {
    await post(goodPayload(), SECRET);
    const cc = (await get('btc')).headers.get('Cache-Control') ?? '';
    // Thousands of simultaneous readers should collapse into one KV read per location.
    expect(cc).toMatch(/s-maxage=\d+/);
  });

  it('never caches a response carrying someone`s own standing', async () => {
    await post(
      { payload: goodPayload({ rows: [], truncated: true }), index: { all: {}, d30: {}, d7: {} } },
      SECRET,
    );
    const cc = (await get('btc', '0x1111111111111111111111111111111111111111')).headers.get('Cache-Control') ?? '';
    expect(cc).toContain('no-store');
  });
});

// Campaign standings decide who gets paid, so the write path is held to the same rule as the
// leaderboard's: one authenticated writer, shape-checked, failing closed when unconfigured.
describe('campaign ingest and read', () => {
  const campaign = (over: Record<string, unknown> = {}) => ({
    id: 'aug',
    startBlock: '55000000',
    endBlock: '56000000',
    cursor: '55500000',
    live: true,
    generatedAt: 1785876761293,
    totals: { volumeUsd6: '123456', participants: 4 },
    prize: { prizeUsd: 300, nextTierAtUsd6: '250000000000' },
    volume: [{ address: '0xaaa', rank: 1 }],
    pnl: [{ address: '0xbbb', rank: 1 }],
    ...over,
  });

  const postC = (body: unknown, secret?: string) =>
    POST_CAMPAIGN(
      new Request('https://limen.finance/api/campaign/ingest', {
        method: 'POST',
        headers: secret === undefined ? {} : { 'X-Leaderboard-Secret': secret },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  const getC = (id?: string) =>
    GET_CAMPAIGN(new Request(`https://limen.finance/api/campaign${id ? `?id=${id}` : ''}`));

  it('stores under the campaign id and serves it back verbatim', async () => {
    expect((await postC(campaign(), SECRET)).status).toBe(200);
    expect(kvStore.get(kvCampaignKey('aug'))).toBeTruthy();
    expect((await (await getC('aug')).json()).totals.volumeUsd6).toBe('123456');
  });

  it('keeps each campaign on its own key, so a finished one is never overwritten', async () => {
    await postC(campaign(), SECRET);
    await postC(campaign({ id: 'sep', totals: { volumeUsd6: '999', participants: 1 } }), SECRET);
    expect((await (await getC('aug')).json()).totals.volumeUsd6).toBe('123456');
    expect((await (await getC('sep')).json()).totals.volumeUsd6).toBe('999');
  });

  it('refuses unauthenticated writes and fails closed with no secret set', async () => {
    expect((await postC(campaign(), 'wrong')).status).toBe(401);
    delete process.env.LEADERBOARD_INGEST_SECRET;
    expect((await postC(campaign(), SECRET)).status).toBe(503);
    expect(kvStore.size).toBe(0);
  });

  it('rejects a payload missing what the standings are read from', async () => {
    for (const bad of [{ volume: 'no' }, { prize: null }, { generatedAt: 'now' }, { id: '' }]) {
      expect((await postC(campaign(bad), SECRET)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('an announced campaign with no publish yet is pending, not an error', async () => {
    const res = await getC('aug');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(body.volume).toEqual([]);
  });

  // The bug this replaced: the page carried the campaign id in its bundle, so a campaign the
  // keeper was publishing perfectly showed an empty board because the page was still asking
  // for the previous one. Starting a campaign must not depend on a frontend deploy.
  it('answers with the running campaign when the caller names none', async () => {
    await postC(campaign({ id: 'test1h', totals: { volumeUsd6: '607728717', participants: 1 } }), SECRET);
    const body = await (await getC()).json();
    expect(body.id).toBe('test1h');
    expect(body.totals.volumeUsd6).toBe('607728717');
  });

  it('follows the pointer to the newest campaign when one succeeds another', async () => {
    await postC(campaign({ id: 'test1h' }), SECRET);
    await postC(campaign({ id: 'aug', totals: { volumeUsd6: '42', participants: 3 } }), SECRET);
    expect((await (await getC()).json()).id).toBe('aug');
    // and the finished one is still reachable by name
    expect((await (await getC('test1h')).json()).id).toBe('test1h');
  });

  it('is pending rather than an error when no campaign has ever run', async () => {
    const res = await getC();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(body.id).toBeNull();
    expect(body.volume).toEqual([]);
  });
});

// The campaign index page lists what exists without opening any of them, which needs a registry.
// Listing the KV namespace would return keys rather than figures and cost a call per page, so the
// registry is built from the publishes we already receive.
describe('campaign index', () => {
  const campaign = (over: Record<string, unknown> = {}) => ({
    id: 'aug',
    title: 'August sprint',
    startBlock: '55000000',
    endBlock: '56000000',
    cursor: '55500000',
    live: true,
    generatedAt: 1785876761293,
    totals: { volumeUsd6: '123456', participants: 4 },
    prize: { prizeUsd: 300, nextTierAtUsd6: null },
    volume: [],
    pnl: [],
    ...over,
  });
  const post = (body: unknown) =>
    POST_CAMPAIGN(
      new Request('https://limen.finance/api/campaign/ingest', {
        method: 'POST',
        headers: { 'X-Leaderboard-Secret': SECRET },
        body: JSON.stringify(body),
      }),
    );
  const list = async () =>
    (await (await GET_CAMPAIGNS()).json()).campaigns as Array<Record<string, unknown>>;

  it('records a campaign the first time it publishes', async () => {
    await post(campaign());
    const [c] = await list();
    expect(c.id).toBe('aug');
    expect(c.title).toBe('August sprint');
    expect(c.prizeUsd).toBe(300);
    expect(c.participants).toBe(4);
    expect(c.cursor).toBe('55500000');
  });

  it('updates in place instead of appending on every publish', async () => {
    // A running campaign republishes every loop. Appending would grow the list without bound and
    // show the same campaign a hundred times.
    await post(campaign());
    await post(campaign({ totals: { volumeUsd6: '999', participants: 9 }, prize: { prizeUsd: 500, nextTierAtUsd6: null } }));
    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0].prizeUsd).toBe(500);
    expect(all[0].participants).toBe(9);
  });

  it('carries the live flag through, so the page can split running from settled', async () => {
    await post(campaign());
    expect((await list())[0].live).toBe(true);
    await post(campaign({ live: false }));
    expect((await list())[0].live).toBe(false);
  });

  it('orders by when a campaign started, newest first', async () => {
    // Ordering on last-publish instead would reshuffle finished campaigns every thirty seconds
    // while a running one republishes.
    await post(campaign({ id: 'jul', startBlock: '54000000', live: false }));
    await post(campaign({ id: 'aug', startBlock: '55000000' }));
    await post(campaign({ id: 'jun', startBlock: '53000000', live: false }));
    expect((await list()).map((c) => c.id)).toEqual(['aug', 'jul', 'jun']);
  });

  it('names a campaign that was published without a title', async () => {
    await post(campaign({ id: 'test1h', title: undefined }));
    expect((await list())[0].title).toBe('Test 1h');
  });

  it('answers with an empty list rather than failing when nothing has published', async () => {
    const res = await GET_CAMPAIGNS();
    expect(res.status).toBe(200);
    expect(await list()).toEqual([]);
  });
});
