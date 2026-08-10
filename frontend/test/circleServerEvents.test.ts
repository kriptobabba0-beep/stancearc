import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { listContractEvents, CIRCLE_W3S_BASE } from '@/lib/server/circleServer';

const KEY = 'TEST_API_KEY:abc123:def456';

function okFetch(json: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => json });
}

beforeEach(() => {
  process.env.CIRCLE_API_KEY = KEY;
});
afterEach(() => {
  delete process.env.CIRCLE_API_KEY;
  vi.restoreAllMocks();
});

describe('listContractEvents', () => {
  it('GETs /contracts/events with contractAddress + ARC-TESTNET + pageSize and returns eventLogs', async () => {
    const raw = {
      id: 'e1',
      txHash: '0x8ffe2163',
      blockHeight: 47902235,
      topics: ['0x33273b88', '0x0501'],
      data: '0xdead',
      eventName: 'SettlementPriceSubmitted(uint64,uint256,uint256,uint64,uint64,bytes32)',
      firstConfirmDate: '2026-06-20T21:01:36Z',
    };
    const fetchImpl = okFetch({ data: { eventLogs: [raw] } });
    const out = await listContractEvents('0xC1abF142', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: KEY,
      pageSize: 20,
    });

    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('e1');
    expect(out[0].txHash).toBe('0x8ffe2163');
    expect(out[0].blockHeight).toBe(47902235);
    expect(out[0].topics).toEqual(['0x33273b88', '0x0501']);
    expect(out[0].eventName).toContain('SettlementPriceSubmitted');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain(`${CIRCLE_W3S_BASE}/contracts/events?`);
    expect(String(url)).toContain('contractAddress=0xC1abF142');
    expect(String(url)).toContain('blockchain=ARC-TESTNET');
    expect(String(url)).toContain('pageSize=20');
    expect((init as RequestInit).method).toBe('GET');
    const h = (init as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${KEY}`);
    expect(h['X-User-Token']).toBeUndefined(); // account-level SCP read — no user token
  });

  it('returns [] when the response has no eventLogs', async () => {
    const fetchImpl = okFetch({ data: {} });
    const out = await listContractEvents('0xabc', { fetchImpl: fetchImpl as unknown as typeof fetch, apiKey: KEY });
    expect(out).toEqual([]);
  });
});
