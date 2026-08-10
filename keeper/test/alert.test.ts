import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAlertPayload,
  createAlerter,
  shouldDispatch,
  type AlertConfig,
  type AlertEvent,
} from '../src/alert.js';

// alert.ts must be:
//   - OFF when no webhook is configured (no fetch, returns false).
//   - deduplicated/rate-limited per alert key (a cooldown window).
//   - non-blocking + crash-safe (a rejecting/throwing fetch never throws to the caller).
//   - heartbeat = its own URL + its own interval (the dead-man's-switch ping).
// The decision/dedupe core is PURE (shouldDispatch, injected clock) so it's unit-tested
// without a socket; createAlerter is the thin stateful shell over it with an injected fetch.

const FULL_CFG: AlertConfig = {
  webhookUrl: 'https://hooks.example/keeper',
  heartbeatUrl: 'https://hc.example/ping/abc',
  dedupeWindowMs: 60_000,
  heartbeatIntervalMs: 300_000,
  timeoutMs: 5_000,
};

// ---------------------------------------------------------------------------
// PURE dedupe/rate-limit core
// ---------------------------------------------------------------------------
describe('shouldDispatch — pure dedupe/rate-limit', () => {
  it('first time a key is seen -> dispatch (no prior send)', () => {
    expect(shouldDispatch(undefined, 1_000, 60_000)).toBe(true);
  });

  it('inside the cooldown window for the same key -> suppress', () => {
    // last sent at t=1000; window 60_000 -> suppressed until t=61_000.
    expect(shouldDispatch(1_000, 1_000 + 59_999, 60_000)).toBe(false);
  });

  it('exactly at the window boundary -> dispatch again (>=)', () => {
    expect(shouldDispatch(1_000, 1_000 + 60_000, 60_000)).toBe(true);
  });

  it('after the cooldown window -> dispatch again', () => {
    expect(shouldDispatch(1_000, 1_000 + 60_001, 60_000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildAlertPayload — compact, webhook-agnostic body
// ---------------------------------------------------------------------------
describe('buildAlertPayload — compact JSON/text', () => {
  it('produces a { text } body (Slack/Telegram/Discord-compatible) with the severity + message', () => {
    const ev: AlertEvent = {
      key: 'wedged:eth',
      severity: 'critical',
      title: 'WEDGED',
      message: 'market=eth wedged after 5 consecutive failures',
    };
    const body = buildAlertPayload(ev);
    expect(typeof body.text).toBe('string');
    expect(body.text).toContain('eth');
    expect(body.text).toContain('WEDGED');
    // also carries the structured fields for richer endpoints.
    expect(body.severity).toBe('critical');
    expect(body.key).toBe('wedged:eth');
  });
});

// ---------------------------------------------------------------------------
// createAlerter — OFF when unset
// ---------------------------------------------------------------------------
describe('createAlerter — disabled when no webhook URL', () => {
  it('no webhookUrl -> notify() never calls fetch and returns false', async () => {
    const fetchMock = vi.fn();
    const alerter = createAlerter(
      { ...FULL_CFG, webhookUrl: undefined },
      { fetch: fetchMock as unknown as typeof fetch, now: () => 1_000 },
    );
    const sent = await alerter.notify({ key: 'wedged:eth', severity: 'critical', title: 'WEDGED', message: 'x' });
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no heartbeatUrl -> heartbeat() never calls fetch and returns false', async () => {
    const fetchMock = vi.fn();
    const alerter = createAlerter(
      { ...FULL_CFG, heartbeatUrl: undefined },
      { fetch: fetchMock as unknown as typeof fetch, now: () => 1_000 },
    );
    const sent = await alerter.heartbeat();
    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createAlerter — dispatch + dedupe
// ---------------------------------------------------------------------------
describe('createAlerter — dispatch + dedupe', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let clock: number;

  beforeEach(() => {
    clock = 1_000;
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  });

  function mk(over: Partial<AlertConfig> = {}) {
    return createAlerter(
      { ...FULL_CFG, ...over },
      { fetch: fetchMock as unknown as typeof fetch, now: () => clock },
    );
  }

  it('POSTs to the webhook URL with a JSON body on the first event', async () => {
    const alerter = mk();
    const sent = await alerter.notify({ key: 'lowbal', severity: 'warn', title: 'LOW BALANCE', message: 'low' });
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(FULL_CFG.webhookUrl);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toContain('application/json');
    const parsed = JSON.parse(init.body);
    expect(parsed.text).toContain('low');
  });

  it('suppresses a duplicate of the same key inside the dedupe window', async () => {
    const alerter = mk();
    await alerter.notify({ key: 'wedged:eth', severity: 'critical', title: 'WEDGED', message: 'a' });
    clock += 30_000; // still inside the 60s window
    const second = await alerter.notify({ key: 'wedged:eth', severity: 'critical', title: 'WEDGED', message: 'b' });
    expect(second).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-dispatches the same key once the dedupe window elapses', async () => {
    const alerter = mk();
    await alerter.notify({ key: 'wedged:eth', severity: 'critical', title: 'WEDGED', message: 'a' });
    clock += 60_000; // window elapsed
    const second = await alerter.notify({ key: 'wedged:eth', severity: 'critical', title: 'WEDGED', message: 'b' });
    expect(second).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('different keys are tracked independently (no cross-suppression)', async () => {
    const alerter = mk();
    await alerter.notify({ key: 'wedged:eth', severity: 'critical', title: 'WEDGED', message: 'a' });
    const other = await alerter.notify({ key: 'wedged:btc', severity: 'critical', title: 'WEDGED', message: 'b' });
    expect(other).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// createAlerter — non-blocking / crash-safe
// ---------------------------------------------------------------------------
describe('createAlerter — crash-safe (alerting failure never throws)', () => {
  it('a rejecting fetch is swallowed: notify resolves false, does not throw', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const logs: Record<string, unknown>[] = [];
    const alerter = createAlerter(FULL_CFG, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000,
      log: (o) => logs.push(o),
    });
    const sent = await alerter.notify({ key: 'k', severity: 'warn', title: 'T', message: 'm' });
    expect(sent).toBe(false); // dispatch attempted but the POST failed -> reported as not-sent
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // a delivery failure is logged, never thrown.
    expect(logs.some((l) => String(l.msg).includes('alert'))).toBe(true);
  });

  it('a non-ok HTTP response is treated as a failed delivery (no throw)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }) as Response);
    const alerter = createAlerter(FULL_CFG, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => 1_000,
    });
    const sent = await alerter.notify({ key: 'k', severity: 'warn', title: 'T', message: 'm' });
    expect(sent).toBe(false);
  });

  it('a failed delivery does NOT consume the dedupe slot (retry allowed next tick)', async () => {
    let ok = false;
    const fetchMock = vi.fn(async () => ({ ok, status: ok ? 200 : 500 }) as Response);
    let clock = 1_000;
    const alerter = createAlerter(FULL_CFG, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock,
    });
    const first = await alerter.notify({ key: 'k', severity: 'warn', title: 'T', message: 'm' });
    expect(first).toBe(false); // failed delivery
    clock += 1_000; // still inside the dedupe window
    ok = true;
    const second = await alerter.notify({ key: 'k', severity: 'warn', title: 'T', message: 'm' });
    expect(second).toBe(true); // not suppressed — the failed send didn't arm the cooldown
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// heartbeat — dead-man's-switch ping
// ---------------------------------------------------------------------------
describe('createAlerter — heartbeat (dead-man\'s-switch)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let clock: number;

  beforeEach(() => {
    clock = 1_000;
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  });

  function mk(over: Partial<AlertConfig> = {}) {
    return createAlerter(
      { ...FULL_CFG, ...over },
      { fetch: fetchMock as unknown as typeof fetch, now: () => clock },
    );
  }

  it('first heartbeat() pings the heartbeat URL', async () => {
    const alerter = mk();
    const sent = await alerter.heartbeat();
    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(FULL_CFG.heartbeatUrl);
  });

  it('rate-limits heartbeats to the heartbeat interval', async () => {
    const alerter = mk();
    await alerter.heartbeat();
    clock += 100_000; // inside the 300s interval
    const second = await alerter.heartbeat();
    expect(second).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 200_000; // now 300s total -> interval elapsed
    const third = await alerter.heartbeat();
    expect(third).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('heartbeat delivery failure is swallowed (returns false, no throw)', async () => {
    fetchMock = vi.fn(async () => {
      throw new Error('down');
    });
    const alerter = mk();
    const sent = await alerter.heartbeat();
    expect(sent).toBe(false);
  });
});
