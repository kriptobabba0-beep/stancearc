// alert.ts - REAL alerting (dead-man's-switch). The keeper/arb already LOG
// `ALERT … WEDGED` / `WARN low balance`, but nothing reaches a human. This module
// dispatches those events to a configurable webhook so an operator is actually paged.
//
// Two independent channels, both OFF unless their URL is set:
//   - ALERT_WEBHOOK_URL    - receives compact JSON alerts (market WEDGED, low signer
//                            balance, repeated-failures past the wedged threshold). The
//                            body is webhook-agnostic ({ text, … }) so it works for a
//                            Slack/Discord incoming webhook, a Telegram-bot sendMessage
//                            proxy, or a Healthchecks.io-style log endpoint.
//   - ALERT_HEARTBEAT_URL  - receives a periodic liveness PING (the dead-man's-switch):
//                            the EXTERNAL monitor (e.g. Healthchecks.io / cron-monitor)
//                            alerts on the ABSENCE of this ping, so a dead/hung keeper that
//                            can't send its own WEDGED alert is still caught.
//
// Design (mirrors the rest of the keeper):
//   - The dedupe/rate-limit DECISION is a PURE function (`shouldDispatch`) with an injected
//     clock - unit-tested without a socket.
//   - `createAlerter` is a thin stateful shell over it with an INJECTED fetch + clock so the
//     POST path is testable with a mock and never touches the network in tests.
//   - NON-BLOCKING + crash-safe: a rejecting/non-ok fetch is swallowed and logged; an
//     alerting failure must NEVER throw out of the crank loop.
//   - DEDUPED/rate-limited: the same alert key isn't re-sent inside the dedupe window, so a
//     persistent WEDGE doesn't spam the webhook every tick. A FAILED delivery does NOT arm
//     the cooldown, so a transient webhook outage is retried next tick.
//   - OFF when the URL is unset - `notify`/`heartbeat` return false and never call fetch, so
//     the no-webhook path is exactly the unchanged log-only behavior.

/** Severity tag carried in the payload (purely informational for the receiver). */
export type AlertSeverity = 'info' | 'warn' | 'critical';

/** One alert to dispatch. `key` is the dedupe identity (e.g. "wedged:eth"). */
export interface AlertEvent {
  /** Dedupe key - same key inside the dedupe window is suppressed (e.g. "wedged:eth"). */
  key: string;
  severity: AlertSeverity;
  /** Short label (e.g. "WEDGED", "LOW BALANCE"). */
  title: string;
  /** Human-readable detail line. */
  message: string;
  /** Optional structured context merged into the payload (bigint-safe via the serializer). */
  context?: Record<string, unknown>;
}

/** Fully-resolved alerting configuration (built by config.ts; URLs absent => channel off). */
export interface AlertConfig {
  /** Webhook for alerts. Undefined/blank => alerting OFF (log-only, unchanged). */
  webhookUrl?: string;
  /** Separate dead-man's-switch ping URL. Undefined/blank => heartbeat ping OFF. */
  heartbeatUrl?: string;
  /** Suppress a repeat of the SAME alert key inside this window (ms). */
  dedupeWindowMs: number;
  /** Minimum spacing (ms) between heartbeat pings. */
  heartbeatIntervalMs: number;
  /** Abort a hung webhook POST after this many ms so alerting can't wedge the loop. */
  timeoutMs: number;
}

/** Injected dependencies so the dispatcher is fully unit-testable (no real network/clock). */
export interface AlerterDeps {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Defaults to Date.now. Injected so dedupe windows are deterministic in tests. */
  now?: () => number;
  /** Optional structured logger (defaults to a console.log JSON line). */
  log?: (o: Record<string, unknown>) => void;
}

/** The compact, webhook-agnostic POST body. `text` is the human line every endpoint reads. */
export interface AlertPayload {
  text: string;
  severity: AlertSeverity;
  key: string;
  title: string;
  ts: string;
  [k: string]: unknown;
}

/**
 * PURE dedupe/rate-limit decision: should an alert for a key be sent now?
 *   - never sent before (`lastSentMs === undefined`) -> true.
 *   - otherwise only once `now - lastSentMs >= windowMs` (boundary inclusive).
 * Holds no state + reads no clock (now is injected) -> trivially unit-testable.
 */
export function shouldDispatch(
  lastSentMs: number | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  if (lastSentMs === undefined) return true;
  return nowMs - lastSentMs >= windowMs;
}

/** bigint-safe JSON serializer (matches logTick/logArb so payloads can carry on-chain values). */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Build the compact POST body for an event. A single `text` line keeps it compatible with a
 * Slack/Discord incoming webhook (which render `text`) AND a Telegram-bot proxy / generic
 * log sink; the structured fields ride alongside for richer receivers. PURE.
 */
export function buildAlertPayload(ev: AlertEvent, nowIso: string = new Date().toISOString()): AlertPayload {
  const sev = ev.severity.toUpperCase();
  const text = `[fee-arena keeper] ${sev} - ${ev.title}: ${ev.message}`;
  return {
    text,
    severity: ev.severity,
    key: ev.key,
    title: ev.title,
    ts: nowIso,
    ...(ev.context ?? {}),
  };
}

/** The alerter handle wired into the loops. */
export interface Alerter {
  /** True if any channel is configured (used only for the startup log line). */
  readonly enabled: boolean;
  /**
   * Dispatch an alert (deduped). Resolves true iff a POST was actually delivered (ok), false
   * when suppressed by dedupe, disabled (no URL), or the delivery failed. NEVER throws.
   */
  notify(ev: AlertEvent): Promise<boolean>;
  /**
   * Send the dead-man's-switch heartbeat ping (rate-limited to heartbeatIntervalMs). Resolves
   * true iff a ping was actually delivered, false when throttled/disabled/failed. NEVER throws.
   */
  heartbeat(): Promise<boolean>;
}

/**
 * Create the stateful alert dispatcher. Holds only the per-key last-sent timestamps + the
 * last heartbeat time; all decisions defer to the pure `shouldDispatch`. fetch + clock are
 * injected (defaults wire the real globals) so production uses the real network while tests
 * pass a mock. Disabled channels (no URL) short-circuit before any fetch.
 */
export function createAlerter(cfg: AlertConfig, deps: AlerterDeps = {}): Alerter {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log =
    deps.log ??
    ((o: Record<string, unknown>) => console.log(serialize({ ts: new Date().toISOString(), ...o })));

  const webhookUrl = cfg.webhookUrl;
  const heartbeatUrl = cfg.heartbeatUrl;

  // Dedupe state: last DELIVERED time per key. A failed delivery is NOT recorded, so the
  // next tick can retry through the same key (a webhook outage doesn't swallow the alert).
  const lastSent = new Map<string, number>();
  let lastHeartbeat: number | undefined;

  /**
   * POST a body to a URL, bounded by an abort timeout. Resolves true on an ok response,
   * false on a non-ok status OR any thrown/rejected error (logged, never rethrown). This is
   * the single crash-safe boundary - every alert delivery funnels through here.
   */
  async function post(url: string, body: unknown, kind: string): Promise<boolean> {
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serialize(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      // Some endpoints (e.g. Healthchecks.io) return a plain 200 with no `ok` typing in
      // mocks - treat a missing `ok` with a 2xx status as success, else as a failure.
      const ok = 'ok' in res ? res.ok : (res as Response).status >= 200 && (res as Response).status < 300;
      if (!ok) {
        const status = 'status' in res ? (res as Response).status : 'unknown';
        log({ msg: 'alert.delivery.failed', kind, url, status });
        return false;
      }
      return true;
    } catch (err) {
      // Non-blocking + crash-safe: swallow EVERY error (network down, DNS, timeout/abort) so
      // alerting can never crash the crank. Log it so the operator can see alerting is broken.
      log({ msg: 'alert.delivery.error', kind, url, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  async function notify(ev: AlertEvent): Promise<boolean> {
    if (webhookUrl === undefined) return false; // channel OFF -> log-only (unchanged)
    const t = now();
    if (!shouldDispatch(lastSent.get(ev.key), t, cfg.dedupeWindowMs)) return false; // deduped
    const payload = buildAlertPayload(ev, new Date(t).toISOString());
    const delivered = await post(webhookUrl, payload, `alert:${ev.key}`);
    // Only arm the cooldown on a SUCCESSFUL delivery - a failed POST is retried next tick.
    if (delivered) lastSent.set(ev.key, t);
    return delivered;
  }

  async function heartbeat(): Promise<boolean> {
    if (heartbeatUrl === undefined) return false; // dead-man's-switch ping OFF
    const t = now();
    if (!shouldDispatch(lastHeartbeat, t, cfg.heartbeatIntervalMs)) return false; // throttled
    // A minimal liveness ping. Healthchecks.io ignores the body; richer sinks get a marker.
    const delivered = await post(heartbeatUrl, { text: '[fee-arena keeper] heartbeat', ts: new Date(t).toISOString() }, 'heartbeat');
    if (delivered) lastHeartbeat = t;
    return delivered;
  }

  return {
    enabled: webhookUrl !== undefined || heartbeatUrl !== undefined,
    notify,
    heartbeat,
  };
}
