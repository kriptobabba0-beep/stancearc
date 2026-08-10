// rpcResilience.test.ts — the rate-limit resilience layer every Arc RPC call rides through:
// error classification, the shared cooldown gate (escalation / debounce / reset), the viem
// transport wrapper's retry loop, and the endpoint list helper.
import { describe, it, expect } from 'vitest';
import type { Transport } from 'viem';
import {
  isRateLimitError,
  RateLimitGate,
  EndpointCooldowns,
  withRateLimitResilience,
} from '@/lib/rpcResilience';
import { arcHttpEndpoints, ARC_EXTRA_HTTP_RPCS } from '@/lib/arcEndpoints';

// Virtual clock: sleeping ADVANCES time, so cooldown math is tested without real waiting.
function virtualClock() {
  const state = { t: 0 };
  return {
    state,
    now: () => state.t,
    sleep: async (ms: number) => {
      state.t += ms;
    },
    jitter: () => 0,
  };
}

describe('isRateLimitError', () => {
  it('recognises the viem-wrapped Arc throttle (details in the cause chain)', () => {
    const err = Object.assign(new Error('RPC Request failed.'), {
      shortMessage: 'RPC Request failed.',
      cause: { details: 'request limit reached' },
    });
    expect(isRateLimitError(err)).toBe(true);
  });

  it('recognises the JSON-RPC limit code, HTTP 429 and the viem error name', () => {
    expect(isRateLimitError({ code: -32005 })).toBe(true);
    expect(isRateLimitError({ cause: { status: 429 } })).toBe(true);
    expect(isRateLimitError({ name: 'LimitExceededRpcError' })).toBe(true);
  });

  it('does NOT flag ordinary failures', () => {
    expect(isRateLimitError(new Error('execution reverted: NotEntryWindow()'))).toBe(false);
    expect(isRateLimitError({ code: -32000, message: 'insufficient funds' })).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe('RateLimitGate', () => {
  it('escalates the cooldown on repeated trips and caps it', () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    gate.reportRateLimit(); // level 0 → 2s
    expect(gate.snapshot().until).toBe(2_000);
    c.state.t = 2_000; // cooldown lapsed, limiter still hot
    gate.reportRateLimit(); // level 1 → 4s
    expect(gate.snapshot().until).toBe(6_000);
    c.state.t = 6_000;
    gate.reportRateLimit(); // level 2 → 8s
    expect(gate.snapshot().until).toBe(14_000);
    c.state.t = 14_000;
    gate.reportRateLimit(); // level 3 → capped at 15s
    expect(gate.snapshot().until).toBe(29_000);
  });

  it('ignores reports while a cooldown is already active (in-flight stragglers)', () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    gate.reportRateLimit();
    const until = gate.snapshot().until;
    gate.reportRateLimit(); // straggler from a request that was already in flight
    gate.reportRateLimit();
    expect(gate.snapshot().until).toBe(until); // unchanged, no escalation
  });

  it('resets the escalation ladder after a quiet minute', () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    gate.reportRateLimit(); // 2s
    c.state.t = 2_000;
    gate.reportRateLimit(); // 4s (level up)
    c.state.t = 6_000 + 61_000; // quiet for >60s
    gate.reportRateLimit();
    expect(gate.snapshot().until - c.state.t).toBe(2_000); // back to the base cooldown
  });

  it('waitForClear waits out the cooldown (and is instant when clear)', async () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    await gate.waitForClear();
    expect(c.state.t).toBe(0); // no cooldown → no sleeping
    gate.reportRateLimit();
    await gate.waitForClear();
    expect(c.state.t).toBe(2_000); // slept exactly to the cooldown edge
  });

  it('notifies subscribers on effective trips only', () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    let fired = 0;
    gate.subscribe(() => fired++);
    gate.reportRateLimit();
    gate.reportRateLimit(); // no-op during cooldown
    expect(fired).toBe(1);
  });
});

describe('withRateLimitResilience', () => {
  // Minimal fake viem transport: scripts each request's outcome.
  function fakeTransport(outcomes: Array<'limit' | 'ok' | 'revert'>, log: string[]): Transport {
    let i = 0;
    return ((/* params */) => ({
      config: { name: 'fake' },
      request: async () => {
        const o = outcomes[Math.min(i, outcomes.length - 1)];
        i += 1;
        log.push(o);
        if (o === 'limit') {
          throw Object.assign(new Error('RPC Request failed.'), { cause: { details: 'request limit reached' } });
        }
        if (o === 'revert') throw new Error('execution reverted');
        return '0xresult';
      },
    })) as unknown as Transport;
  }

  it('retries through rate-limit errors on the gate schedule and succeeds', async () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    const log: string[] = [];
    const t = withRateLimitResilience(fakeTransport(['limit', 'limit', 'ok'], log), gate);
    const instance = (t as unknown as (p: Record<string, unknown>) => { request: (a: unknown) => Promise<unknown> })({});
    const result = await instance.request({ method: 'eth_call' });
    expect(result).toBe('0xresult');
    expect(log).toEqual(['limit', 'limit', 'ok']);
    expect(c.state.t).toBeGreaterThanOrEqual(2_000); // it actually waited out a cooldown
  });

  it('passes non-rate-limit errors through immediately (no retries)', async () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    const log: string[] = [];
    const t = withRateLimitResilience(fakeTransport(['revert'], log), gate);
    const instance = (t as unknown as (p: Record<string, unknown>) => { request: (a: unknown) => Promise<unknown> })({});
    await expect(instance.request({ method: 'eth_call' })).rejects.toThrow('execution reverted');
    expect(log).toEqual(['revert']);
  });

  it('gives up after the attempt budget and lets the limit error surface', async () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    const log: string[] = [];
    const t = withRateLimitResilience(fakeTransport(['limit'], log), gate);
    const instance = (t as unknown as (p: Record<string, unknown>) => { request: (a: unknown) => Promise<unknown> })({});
    await expect(instance.request({ method: 'eth_call' })).rejects.toThrow('RPC Request failed');
    expect(log.length).toBe(4); // MAX_ATTEMPTS
  });

  it('one transport tripping the gate makes a second transport wait too', async () => {
    const c = virtualClock();
    const gate = new RateLimitGate(c);
    const logA: string[] = [];
    const logB: string[] = [];
    const a = withRateLimitResilience(fakeTransport(['limit', 'ok'], logA), gate);
    const b = withRateLimitResilience(fakeTransport(['ok'], logB), gate);
    const ia = (a as unknown as (p: Record<string, unknown>) => { request: (x: unknown) => Promise<unknown> })({});
    const ib = (b as unknown as (p: Record<string, unknown>) => { request: (x: unknown) => Promise<unknown> })({});
    await ia.request({ method: 'eth_call' }); // trips at t=0, retries at t=2000
    const before = c.state.t;
    gate.reportRateLimit(); // limiter hot again
    await ib.request({ method: 'eth_getBalance' });
    expect(c.state.t).toBeGreaterThan(before); // B slept out the shared cooldown
    expect(logB).toEqual(['ok']);
  });
});

describe('arcHttpEndpoints', () => {
  it('appends the documented mirrors after the configured endpoints, de-duped', () => {
    const out = arcHttpEndpoints(['https://rpc.testnet.arc.network', ARC_EXTRA_HTTP_RPCS[0]]);
    expect(out[0]).toBe('https://rpc.testnet.arc.network');
    expect(out.filter((u) => u === ARC_EXTRA_HTTP_RPCS[0]).length).toBe(1);
    for (const m of ARC_EXTRA_HTTP_RPCS) expect(out).toContain(m);
  });

  it('treats trailing slashes as the same endpoint', () => {
    const out = arcHttpEndpoints([`${ARC_EXTRA_HTTP_RPCS[0]}/`]);
    expect(out.filter((u) => u.startsWith(ARC_EXTRA_HTTP_RPCS[0])).length).toBe(1);
  });
});

describe('EndpointCooldowns', () => {
  const A = 'https://a.example';
  const B = 'https://b.example';
  const make = () => {
    const state = { t: 1_000 };
    return { state, cd: new EndpointCooldowns({ now: () => state.t }) };
  };

  it('starts with every endpoint available', () => {
    const { cd } = make();
    expect(cd.available(A)).toBe(true);
  });

  it('cools only the endpoint that failed, never its neighbours', () => {
    // The whole reason for keeping mirrors: one being busy says nothing about the others.
    const { cd } = make();
    cd.report(A);
    expect(cd.available(A)).toBe(false);
    expect(cd.available(B)).toBe(true);
  });

  it('becomes available again after the cooldown passes', () => {
    const { cd, state } = make();
    cd.report(A);
    state.t += 2_000;
    expect(cd.available(A)).toBe(true);
  });

  it('escalates on repeat trips and caps the cooldown', () => {
    const { cd, state } = make();
    const coolFor = () => {
      let waited = 0;
      while (!cd.available(A) && waited < 60_000) {
        state.t += 100;
        waited += 100;
      }
      return waited;
    };
    cd.report(A);
    const first = coolFor();
    cd.report(A);
    const second = coolFor();
    expect(second).toBeGreaterThan(first);

    for (let i = 0; i < 10; i++) {
      cd.report(A);
      coolFor();
    }
    cd.report(A);
    expect(coolFor()).toBeLessThanOrEqual(15_100); // capped, never unbounded
  });

  it('ignores a report that lands during an active cooldown', () => {
    // Those are in-flight requests that predate the trip, not fresh evidence, so they must
    // not push an endpoint further up the ladder for what is really one bad moment.
    const { cd, state } = make();
    cd.report(A);
    cd.report(A);
    cd.report(A);
    state.t += 2_000;
    expect(cd.available(A)).toBe(true);
  });

  it('clears the penalty once an endpoint answers cleanly', () => {
    const { cd, state } = make();
    cd.report(A);
    cd.report(A); // no-op during cooldown, but the ladder is at level 1
    state.t += 2_000;
    cd.reportSuccess(A);

    cd.report(A);
    state.t += 2_000;
    expect(cd.available(A)).toBe(true); // back to the base rung, not the escalated one
  });
});
