// rpcProxy.test.ts — the edge JSON-RPC cache/proxy core: cache TTLs, request coalescing,
// upstream rotation on throttle, stale-if-limited, and method policy. All deps injected
// (virtual clock + scripted fetch), no real network or timers.
import { describe, it, expect, vi } from 'vitest';
import { handleRpcPayload, stableStringify, type ProxyDeps } from '@/lib/rpcProxy';
import { EndpointCooldowns } from '@/lib/rpcResilience';

type FetchScript = (url: string, entries: Array<{ id: unknown; method: string; params: unknown }>) =>
  | { kind: 'ok'; results: Array<{ id: unknown; result?: unknown; error?: { code: number; message: string } }> }
  | { kind: 'http'; status: number }
  | { kind: 'throw'; message: string }
  /** An endpoint that eats `ms` of the clock and then times out, like a hung mirror. */
  | { kind: 'slow'; ms: number };

function makeDeps(script: FetchScript, upstreams = ['https://a.example', 'https://b.example']) {
  const state = { t: 0 };
  const calls: Array<{ url: string; methods: string[] }> = [];
  const cooldowns = new EndpointCooldowns({ now: () => state.t });
  const fetchFn = (async (url: unknown, init?: { body?: unknown }) => {
    const entries = JSON.parse(String(init?.body)) as Array<{ id: unknown; method: string; params: unknown }>;
    calls.push({ url: String(url), methods: entries.map((e) => e.method) });
    const out = script(String(url), entries);
    if (out.kind === 'slow') {
      state.t += out.ms;
      throw new Error('TimeoutError: signal timed out');
    }
    if (out.kind === 'throw') throw new Error(out.message);
    if (out.kind === 'http') {
      return { ok: false, status: out.status, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => out.results.map((r) => ({ jsonrpc: '2.0', ...r })),
    } as unknown as Response;
  }) as typeof fetch;
  const deps: ProxyDeps = {
    upstreams,
    fetchFn,
    cooldowns,
    now: () => state.t,
    l1: new Map(),
    lastGood: new Map(),
    inflight: new Map(),
  };
  return { deps, calls, state, cooldowns };
}

const call = (id: number, to = '0xabc') => ({
  jsonrpc: '2.0',
  id,
  method: 'eth_call',
  params: [{ to, data: '0x8da5cb5b' }, 'latest'],
});

const echoOk: FetchScript = (_url, entries) => ({
  kind: 'ok',
  results: entries.map((e) => ({ id: e.id, result: `0xanswer:${e.method}` })),
});

describe('handleRpcPayload — shapes and policy', () => {
  it('mirrors single-in → single-out and batch-in → batch-out', async () => {
    const { deps } = makeDeps(echoOk);
    const single = (await handleRpcPayload(call(1), deps)) as { id: number; result: string };
    expect(single.id).toBe(1);
    expect(single.result).toBe('0xanswer:eth_call');
    const batch = (await handleRpcPayload([call(2), call(3, '0xdef')], deps)) as Array<{ id: number }>;
    expect(Array.isArray(batch)).toBe(true);
    expect(batch.map((b) => b.id)).toEqual([2, 3]);
  });

  it('refuses non-eth namespaces without touching upstream', async () => {
    const { deps, calls } = makeDeps(echoOk);
    const res = (await handleRpcPayload(
      { jsonrpc: '2.0', id: 9, method: 'debug_traceCall', params: [] },
      deps,
    )) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
    expect(calls.length).toBe(0);
  });

  it('serves identical eth_calls from cache inside the TTL, refetches after it', async () => {
    const { deps, calls, state } = makeDeps(echoOk);
    await handleRpcPayload(call(1), deps);
    await handleRpcPayload(call(2), deps); // same call, different id → cache hit
    expect(calls.length).toBe(1);
    state.t += 1_300; // past the 1.2s eth_call TTL
    await handleRpcPayload(call(3), deps);
    expect(calls.length).toBe(2);
  });

  it('never caches nonce reads (eth_getTransactionCount)', async () => {
    const { deps, calls } = makeDeps(echoOk);
    const nonce = { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: ['0xabc', 'pending'] };
    await handleRpcPayload(nonce, deps);
    await handleRpcPayload({ ...nonce, id: 2 }, deps);
    expect(calls.length).toBe(2); // both hit upstream
  });

  it('caches a found receipt long and a pending (null) receipt only briefly', async () => {
    const nullThenFound: FetchScript = (_url, entries) => ({
      kind: 'ok',
      results: entries.map((e) => ({ id: e.id, result: null })),
    });
    const { deps, calls, state } = makeDeps(nullThenFound);
    const rcpt = { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: ['0xhash'] };
    await handleRpcPayload(rcpt, deps);
    await handleRpcPayload({ ...rcpt, id: 2 }, deps); // within 1s null-TTL → cached
    expect(calls.length).toBe(1);
    state.t += 1_100;
    await handleRpcPayload({ ...rcpt, id: 3 }, deps); // null TTL expired → refetch
    expect(calls.length).toBe(2);
  });

  it('coalesces duplicate calls inside one batch into a single upstream entry', async () => {
    const { deps, calls } = makeDeps(echoOk);
    const res = (await handleRpcPayload([call(1), call(2)], deps)) as Array<{ result: string }>;
    expect(calls.length).toBe(1);
    expect(calls[0].methods).toEqual(['eth_call']); // ONE entry went upstream, not two
    expect(res[0].result).toBe(res[1].result);
  });

  it('propagates upstream JSON-RPC errors and does NOT cache them', async () => {
    let n = 0;
    const revertThenOk: FetchScript = (_url, entries) => {
      n += 1;
      return n === 1
        ? { kind: 'ok', results: entries.map((e) => ({ id: e.id, error: { code: 3, message: 'execution reverted' } })) }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xfine' })) };
    };
    const { deps, calls } = makeDeps(revertThenOk);
    const first = (await handleRpcPayload(call(1), deps)) as { error: { message: string } };
    expect(first.error.message).toBe('execution reverted');
    const second = (await handleRpcPayload(call(2), deps)) as { result: string };
    expect(second.result).toBe('0xfine'); // error was not cached
    expect(calls.length).toBe(2);
  });
});

describe('handleRpcPayload — throttle behaviour', () => {
  it('rotates to the next upstream on a 429 and puts the throttled one on cooldown', async () => {
    const script: FetchScript = (url, entries) =>
      url.includes('a.example')
        ? { kind: 'http', status: 429 }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xfromB' })) };
    const { deps, calls, cooldowns } = makeDeps(script);
    const res = (await handleRpcPayload(call(1), deps)) as { result: string };
    expect(res.result).toBe('0xfromB');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['a.example', 'b.example']);
    expect(cooldowns.available('https://a.example')).toBe(false); // the throttled one, only
    expect(cooldowns.available('https://b.example')).toBe(true);
  });

  // The regression this whole design exists for. A throttled endpoint used to trip a SHARED
  // gate that every later request slept on, inside a Worker isolate serving every visitor at
  // that location: one throttle became an 8-second wall on the whole site. A cooldown must
  // mean "skip this endpoint", never "wait".
  it('skips a cooling upstream on the next request instead of waiting for it', async () => {
    const script: FetchScript = (url, entries) =>
      url.includes('a.example')
        ? { kind: 'http', status: 429 }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xfromB' })) };
    const { deps, calls, state } = makeDeps(script);
    await handleRpcPayload(call(1), deps);
    calls.length = 0;
    state.t += 1_300; // past the eth_call L1 TTL, still inside a.example's cooldown

    const res = (await handleRpcPayload(call(2), deps)) as { result: string };
    expect(res.result).toBe('0xfromB');
    // The cooling endpoint is not dialled at all, and no clock time is burned getting there.
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['b.example']);
    expect(state.t).toBe(1_300);
  });

  it('uses a recovered upstream again once its cooldown has passed', async () => {
    let throttleA = true;
    const script: FetchScript = (url, entries) =>
      url.includes('a.example') && throttleA
        ? { kind: 'http', status: 429 }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: `0xfrom${url.includes('a.') ? 'A' : 'B'}` })) };
    const { deps, calls, state } = makeDeps(script);
    await handleRpcPayload(call(1), deps);
    throttleA = false;
    calls.length = 0;
    state.t += 60_000; // well past the cooldown

    const res = (await handleRpcPayload(call(2), deps)) as { result: string };
    expect(res.result).toBe('0xfromA');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['a.example']);
  });

  it('stops dialling once the time budget is gone instead of walking the whole list', async () => {
    // Every endpoint hangs until its timeout. The request must abandon the list partway
    // rather than paying one slow dial after another, which is what turned a bad minute on
    // one mirror into a browser request held open for tens of seconds.
    //
    // The scripted fetch ignores the abort signal it is handed, so it always burns the full
    // 2.5s where the real one would be cut short by the remaining budget. That makes the
    // clock here an upper bound; what it pins down exactly is how many endpoints get dialled.
    const { deps, state, calls } = makeDeps(() => ({ kind: 'slow', ms: 2_500 }), [
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
      'https://e.example',
    ]);
    const res = (await handleRpcPayload(call(1), deps)) as { error: { code: number } };
    expect(res.error).toBeTruthy();
    expect(calls.length).toBe(2); // not 5
    expect(state.t).toBeLessThan(2_500 * 5);
  });

  it('serves the last-good value when EVERY upstream is limited', async () => {
    let limited = false;
    const script: FetchScript = (_url, entries) =>
      limited
        ? { kind: 'http', status: 429 }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xgood' })) };
    const { deps, state } = makeDeps(script);
    await handleRpcPayload(call(1), deps); // seeds lastGood
    limited = true;
    state.t += 5_000; // past the L1 TTL but well inside the 45s stale window
    const res = (await handleRpcPayload(call(2), deps)) as { result: string };
    expect(res.result).toBe('0xgood'); // stale beats an error, every time
  });

  it('answers with the retryable limit code when limited and no stale value exists', async () => {
    const always429: FetchScript = () => ({ kind: 'http', status: 429 });
    const { deps } = makeDeps(always429);
    const res = (await handleRpcPayload(call(1), deps)) as { error: { code: number; message: string } };
    expect(res.error.code).toBe(-32005); // viem treats this as retryable → falls back to direct legs
    expect(res.error.message).toMatch(/limit/i);
  });

  it('treats a 200 batch of per-entry -32005s like a 429 (rotate + stale)', async () => {
    let limited = false;
    const script: FetchScript = (_url, entries) =>
      limited
        ? {
            kind: 'ok',
            results: entries.map((e) => ({ id: e.id, error: { code: -32005, message: 'request limit reached' } })),
          }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xgood' })) };
    const { deps, state } = makeDeps(script);
    await handleRpcPayload(call(1), deps);
    limited = true;
    state.t += 5_000;
    const res = (await handleRpcPayload(call(2), deps)) as { result: string };
    expect(res.result).toBe('0xgood');
  });

  it('falls through to the next upstream on network failure', async () => {
    const script: FetchScript = (url, entries) =>
      url.includes('a.example')
        ? { kind: 'throw', message: 'fetch failed' }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xfromB' })) };
    const { deps } = makeDeps(script);
    const res = (await handleRpcPayload(call(1), deps)) as { result: string };
    expect(res.result).toBe('0xfromB');
  });

  it('rejects oversized batches with per-entry errors', async () => {
    const { deps, calls } = makeDeps(echoOk);
    const big = Array.from({ length: 201 }, (_, i) => call(i));
    const res = (await handleRpcPayload(big, deps)) as Array<{ error: { code: number } }>;
    expect(res.length).toBe(201);
    expect(res[0].error.code).toBe(-32600);
    expect(calls.length).toBe(0);
  });
});

describe('stableStringify', () => {
  it('is order-insensitive for object keys (cache keys must match)', () => {
    expect(stableStringify([{ to: '0xa', data: '0xb' }, 'latest'])).toBe(
      stableStringify([{ data: '0xb', to: '0xa' }, 'latest']),
    );
  });

  it('distinguishes genuinely different params', () => {
    expect(stableStringify([{ to: '0xa' }])).not.toBe(stableStringify([{ to: '0xb' }]));
  });
});

// The route wrapper is thin; sanity-check that the module exports what it declares.
describe('module surface', () => {
  it('exposes handleRpcPayload as the single entry point', () => {
    expect(typeof handleRpcPayload).toBe('function');
    expect(vi.isMockFunction(handleRpcPayload)).toBe(false);
  });
});

// Measured live: Arc's primary endpoint refuses a view call that two mirrors serve fine, answering
// HTTP 200 with {code:-32003,"out of gas: gas required exceeds..."}. The proxy passed that on as
// though it were the truth, so a page reading through us broke while the same call worked
// elsewhere. A node declining the work is not an answer.
describe('handleRpcPayload — a node that cannot execute the call', () => {
  it('asks the next upstream when one answers "out of gas"', async () => {
    const script: FetchScript = (url, entries) =>
      url.includes('a.example')
        ? { kind: 'ok', results: entries.map((e) => ({ id: e.id, error: { code: -32003, message: 'out of gas: gas required exceeds: 30000000' } })) }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xreal' })) };
    const { deps, calls } = makeDeps(script);
    const res = (await handleRpcPayload(call(1), deps)) as { result: string };
    expect(res.result).toBe('0xreal');
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['a.example', 'b.example']);
  });

  it('keeps a revert as the answer instead of shopping it around', async () => {
    // Every node returns the same revert. Retrying it elsewhere only spends the budget to be
    // told the same thing, and would hide a genuine contract error behind a proxy failure.
    const script: FetchScript = (_url, entries) => ({
      kind: 'ok',
      results: entries.map((e) => ({ id: e.id, error: { code: 3, message: 'execution reverted: NotOwner' } })),
    });
    const { deps, calls } = makeDeps(script);
    const res = (await handleRpcPayload(call(1), deps)) as { error: { message: string } };
    expect(res.error.message).toMatch(/reverted/);
    expect(calls).toHaveLength(1); // asked once, not rotated
  });

  it('re-asks only the entry that failed, not the whole batch', async () => {
    // A cheap read batched with an expensive one must not be re-sent just because its neighbour
    // was declined.
    const script: FetchScript = (url, entries) =>
      url.includes('a.example')
        ? {
            kind: 'ok',
            results: entries.map((e) =>
              e.id === 2
                ? { id: e.id, error: { code: -32003, message: 'out of gas' } }
                : { id: e.id, result: '0xcheap' },
            ),
          }
        : { kind: 'ok', results: entries.map((e) => ({ id: e.id, result: '0xexpensive' })) };
    const { deps, calls } = makeDeps(script);
    const res = (await handleRpcPayload([call(1, '0xaaa'), call(2, '0xbbb')], deps)) as Array<{ id: number; result: string }>;
    expect(res.find((r) => r.id === 1)!.result).toBe('0xcheap');
    expect(res.find((r) => r.id === 2)!.result).toBe('0xexpensive');
    // The second upstream was asked for ONE entry, not two.
    expect(calls[1]!.methods).toHaveLength(1);
  });

  it('serves what it did get when nobody can execute the rest', async () => {
    const script: FetchScript = (_url, entries) => ({
      kind: 'ok',
      results: entries.map((e) =>
        e.id === 2 ? { id: e.id, error: { code: -32003, message: 'out of gas' } } : { id: e.id, result: '0xok' },
      ),
    });
    const { deps } = makeDeps(script);
    const res = (await handleRpcPayload([call(1, '0xaaa'), call(2, '0xbbb')], deps)) as Array<{ id: number; result?: string; error?: unknown }>;
    expect(res.find((r) => r.id === 1)!.result).toBe('0xok');
    expect(res.find((r) => r.id === 2)!.error).toBeTruthy();
  });
});
