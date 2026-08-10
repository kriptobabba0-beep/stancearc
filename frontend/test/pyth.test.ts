import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchPythUpdate } from '@/lib/pyth';

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchPythUpdate', () => {
  it('returns 0x-prefixed update bytes from Hermes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ binary: { encoding: 'hex', data: ['504e4155'] } }),
    })) as unknown as typeof fetch);
    const { updateData } = await fetchPythUpdate('https://hermes.pyth.network', '0xfeed');
    expect(updateData).toHaveLength(1);
    expect(updateData[0]).toBe('0x504e4155');
  });

  it('strips a trailing slash and a 0x on the feed id when building the URL', async () => {
    const spy = vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: ['abcd'] } }) }));
    vi.stubGlobal('fetch', spy as unknown as typeof fetch);
    await fetchPythUpdate('https://hermes.pyth.network/', '0xFEED');
    const calledUrl = ((spy.mock.calls as unknown[][])[0]?.[0] ?? '') as string;
    expect(calledUrl).toContain('/v2/updates/price/latest?ids[]=FEED');
    expect(calledUrl).not.toContain('//v2');
    expect(calledUrl).not.toContain('ids[]=0x');
  });

  it('throws on a non-ok Hermes response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 })) as unknown as typeof fetch);
    await expect(fetchPythUpdate('https://hermes.pyth.network', '0xfeed')).rejects.toThrow();
  });

  it('throws when Hermes returns no update data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ binary: { data: [] } }) })) as unknown as typeof fetch);
    await expect(fetchPythUpdate('https://hermes.pyth.network', '0xfeed')).rejects.toThrow();
  });
});
