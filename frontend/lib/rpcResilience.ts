// lib/rpcResilience.ts - rate-limit resilience for every Arc RPC call.
//
// Arc's public RPC throttles bursts with "request limit reached". Individual callers can't
// handle that well: viem's built-in retries are milliseconds apart (useless against a
// seconds-long throttle window), and the http→websocket fallback just hits the SAME limiter
// twice. So resilience lives here, at the one choke point every request flows through:
//
//   - `RateLimitGate`: a shared cooldown. The first limited request trips it; every other
//     request then WAITS instead of hammering (which only prolongs the throttle). Repeated
//     trips escalate the cooldown (2s → 4s → 8s → 15s cap); a quiet minute resets it.
//   - `withRateLimitResilience(transport)`: wraps a viem transport so each request waits for
//     the gate, retries through rate-limit errors on the gate's schedule, and passes every
//     other error through untouched. Retrying is safe for writes too: a 429 means the node
//     rejected the request before processing, and re-sending an identical signed raw tx is
//     idempotent by hash.
//
// One global gate (`rpcGate`) covers everything that talks to Arc - the wagmi transport, the
// session signer's wallet client, and the server-side clients - so a limit seen anywhere
// slows everyone down together. Endpoints with their OWN limiter (the CCTP source chains)
// get their own gate instances.

import type { Transport } from 'viem';

/** True when the error (or anything in its cause chain) is the RPC saying "slow down". */
export function isRateLimitError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 8; depth++) {
    const e = cur as {
      code?: unknown;
      status?: unknown;
      name?: unknown;
      message?: unknown;
      details?: unknown;
      shortMessage?: unknown;
      cause?: unknown;
    };
    if (e.code === -32005 || e.status === 429) return true;
    if (e.name === 'LimitExceededRpcError') return true;
    for (const text of [e.message, e.details, e.shortMessage]) {
      if (
        typeof text === 'string' &&
        /request limit|rate limit|limit exceeded|too many request|429/i.test(text)
      ) {
        return true;
      }
    }
    cur = e.cause;
  }
  return false;
}

const COOLDOWN_BASE_MS = 2_000;
const COOLDOWN_MAX_MS = 15_000;
const LEVEL_RESET_AFTER_MS = 60_000;
/** Per-request attempts inside the wrapper (initial try + retries through the gate). */
const MAX_ATTEMPTS = 4;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitGate {
  private cooldownUntil = 0;
  private level = 0;
  private lastTripAt = 0;
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: () => number;

  constructor(opts?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** Small random delay applied when a waiter is released, so the herd doesn't re-trip the limiter. */
    jitter?: () => number;
  }) {
    this.now = opts?.now ?? Date.now;
    this.sleep = opts?.sleep ?? defaultSleep;
    this.jitter = opts?.jitter ?? (() => Math.random() * 300);
  }

  isCoolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  /** {coolingDown, until} - for the UI indicator. */
  snapshot(): { coolingDown: boolean; until: number } {
    return { coolingDown: this.isCoolingDown(), until: this.cooldownUntil };
  }

  /** Notified on every effective trip (not on no-op reports during an active cooldown). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Report a rate-limit response. While a cooldown is already active this is a no-op - the
   * report is an in-flight request that predates the trip, not new evidence. A report AFTER
   * the cooldown expired means the limiter is still hot → escalate. A quiet minute resets
   * the escalation ladder.
   */
  reportRateLimit(): void {
    const t = this.now();
    if (t < this.cooldownUntil) return;
    if (t - this.lastTripAt > LEVEL_RESET_AFTER_MS) this.level = 0;
    const delay = Math.min(COOLDOWN_BASE_MS * 2 ** this.level, COOLDOWN_MAX_MS);
    this.level += 1;
    this.lastTripAt = t;
    this.cooldownUntil = t + delay;
    for (const fn of this.listeners) fn();
  }

  /** Resolves when no cooldown is active; staggers the release so waiters don't stampede. */
  async waitForClear(): Promise<void> {
    let waited = false;
    for (;;) {
      const remaining = this.cooldownUntil - this.now();
      if (remaining <= 0) break;
      waited = true;
      await this.sleep(remaining);
    }
    if (waited) {
      const j = this.jitter();
      if (j > 0) await this.sleep(j);
    }
  }
}

/** The global gate for everything that talks to the Arc RPC. */
export const rpcGate = new RateLimitGate();

// A viem transport is `(params) => { config, request, value? }`. The wrapper only replaces
// `request`; the loose local shape (instead of viem's deep generics) keeps the casts contained.
type TransportShape = (params: Record<string, unknown>) => {
  config: unknown;
  request: (args: unknown, options?: unknown) => Promise<unknown>;
  value?: unknown;
};

/**
 * Wraps a viem transport (http, webSocket, or a whole fallback) so every request rides
 * through `gate`: wait for any active cooldown, send, and on a rate-limit error trip the
 * gate and retry (up to MAX_ATTEMPTS). Non-rate-limit errors pass through immediately -
 * genuine failures must keep their shape for the callers that classify them.
 */
export function withRateLimitResilience<T extends Transport>(inner: T, gate: RateLimitGate = rpcGate): T {
  const wrapped = ((params: Record<string, unknown>) => {
    const t = (inner as unknown as TransportShape)(params);
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      for (let attempt = 1; ; attempt++) {
        await gate.waitForClear();
        try {
          return await t.request(args, options);
        } catch (err) {
          if (attempt >= MAX_ATTEMPTS || !isRateLimitError(err)) throw err;
          gate.reportRateLimit();
        }
      }
    };
    return { ...t, request };
  }) as unknown as T;
  return wrapped;
}
