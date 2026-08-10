import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPythUpdate, fetchPythRef, pythToPrice18 } from '../src/hermes.js';

const FEED = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
const HERMES = 'https://hermes.pyth.network';

function mockFetch(impl: (url: string) => unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => impl(url)));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchPythUpdate', () => {
  it('returns 0x-prefixed update blobs from a successful response', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ binary: { data: ['504e41551234', 'abcdef'] } }),
    }));

    const out = await fetchPythUpdate(HERMES, FEED);
    expect(out).toEqual(['0x504e41551234', '0xabcdef']);
    expect(out.every((h) => h.startsWith('0x'))).toBe(true);
  });

  it('does not double-prefix data that already has 0x', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ binary: { data: ['0xdeadbeef'] } }),
    }));

    const out = await fetchPythUpdate(HERMES, FEED);
    expect(out).toEqual(['0xdeadbeef']);
  });

  it('builds the URL with the feed id stripped of 0x and trims a trailing slash', async () => {
    let seen = '';
    mockFetch((url) => {
      seen = url;
      return { ok: true, json: async () => ({ binary: { data: ['aa'] } }) };
    });

    await fetchPythUpdate('https://hermes.pyth.network/', FEED);
    expect(seen).toBe(
      'https://hermes.pyth.network/v2/updates/price/latest?ids[]=ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace&encoding=hex',
    );
  });

  it('throws on a non-ok response with the status', async () => {
    mockFetch(() => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(fetchPythUpdate(HERMES, FEED)).rejects.toThrow(/Hermes request failed \(503\)/);
  });

  it('throws when the update set is empty', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ binary: { data: [] } }) }));
    await expect(fetchPythUpdate(HERMES, FEED)).rejects.toThrow(/no update data/);
  });

  it('throws when binary is missing entirely', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({}) }));
    await expect(fetchPythUpdate(HERMES, FEED)).rejects.toThrow(/no update data/);
  });
});

describe('pythToPrice18', () => {
  it('scales a typical BTC price (expo -8) to 18dp', () => {
    // BTC ~ $100,000 with expo -8 -> price field = 100000 * 1e8 = 1e13.
    // price18 = 1e13 * 10^(18-8) = 1e13 * 1e10 = 1e23 = 100000 * 1e18.
    expect(pythToPrice18(10n ** 13n, -8)).toBe(100_000n * 10n ** 18n);
  });

  it('handles expo == -18 (no shift)', () => {
    expect(pythToPrice18(123n, -18)).toBe(123n);
  });

  it('divides when expo < -18 (more precise than 18dp)', () => {
    // price * 10^(18-20) = price / 100.
    expect(pythToPrice18(12_345n, -20)).toBe(123n); // floor
  });
});

describe('fetchPythRef', () => {
  it('parses price + publish time into price18', async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        parsed: [{ id: FEED.slice(2), price: { price: '10000000000000', expo: -8, publish_time: 1_700_000_000 } }],
      }),
    }));
    const ref = await fetchPythRef(HERMES, FEED);
    expect(ref.price18).toBe(100_000n * 10n ** 18n);
    expect(ref.publishTimeSec).toBe(1_700_000_000);
  });

  it('requests parsed=true in the URL', async () => {
    let seen = '';
    mockFetch((url) => {
      seen = url;
      return { ok: true, json: async () => ({ parsed: [{ price: { price: '1', expo: 0, publish_time: 1 } }] }) };
    });
    await fetchPythRef(HERMES, FEED);
    expect(seen).toContain('parsed=true');
  });

  it('throws on a non-ok response', async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(fetchPythRef(HERMES, FEED)).rejects.toThrow(/Hermes request failed \(500\)/);
  });

  it('throws when no parsed price is present', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ parsed: [] }) }));
    await expect(fetchPythRef(HERMES, FEED)).rejects.toThrow(/no parsed price/);
  });
});
