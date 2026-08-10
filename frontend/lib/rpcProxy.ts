// lib/rpcProxy.ts — the edge JSON-RPC cache/proxy core behind /api/rpc.
//
// Why this exists: Arc testnet has ONE public RPC and it rate-limits per client. Every
// visitor's browser polling it directly means N visitors = N× the same global reads
// (current epoch, pots, pool state, prices) — and any burst trips "request limit reached".
// Routing reads through our own Cloudflare edge changes the economics:
//
//   browser → /api/rpc (this code) → rpc.testnet.arc.network
//
//   - Identical reads are served from cache (L1 in-isolate map + L2 Cache API where TTL
//     allows), so the origin sees roughly ONE request per unique read per TTL — not one
//     per visitor.
//   - Concurrent identical misses are coalesced into a single upstream call.
//   - When the upstream throttles us, fresh-enough last-good values (≤45s) are served in
//     place of an error — visitors browse on stale-by-seconds data instead of a broken page.
//   - When nothing can be served, the entry fails with the JSON-RPC limit code (-32005),
//     which viem's fallback treats as retryable → the browser transparently retries on the
//     DIRECT endpoints from the user's own IP (a separate limiter budget).
//
// The proxy never caches writes or state-changing/nonce-sensitive calls
// (eth_sendRawTransaction, eth_estimateGas, eth_getTransactionCount, …) — those pass
// straight through. eth_call TTL is deliberately short (1.2s) so time-critical agent
// rechecks stay honest; the win comes from many visitors sharing it, not from it being long.

import { ENV } from '@/lib/env';
import { arcHttpEndpoints } from '@/lib/arcEndpoints';
import { EndpointCooldowns, arcEndpointCooldowns } from '@/lib/rpcResilience';

// ── JSON-RPC shapes ───────────────────────────────────────────────────────────────────
export interface RpcEntry {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}
type RpcResult = { jsonrpc: '2.0'; id: unknown; result: unknown };
type RpcError = { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string } };
export type RpcResponse = RpcResult | RpcError;

const LIMIT_CODE = -32005; // viem: LimitExceededRpcError — retryable, so fallback moves on
const INTERNAL_CODE = -32603;

// ── Cache policy ──────────────────────────────────────────────────────────────────────
// l1Ms: in-isolate map TTL. l2S: Cache API TTL in whole seconds (cross-isolate, per colo);
// omitted for sub-3s TTLs where second-granularity would stretch staleness guarantees.
type Policy = { l1Ms: number; l2S?: number };

const STATIC_TTL: Record<string, Policy> = {
  eth_call: { l1Ms: 1_200 },
  eth_blockNumber: { l1Ms: 1_200 },
  eth_getBalance: { l1Ms: 1_500 },
  eth_getStorageAt: { l1Ms: 1_500 },
  eth_gasPrice: { l1Ms: 2_000 },
  eth_maxPriorityFeePerGas: { l1Ms: 2_000 },
  eth_feeHistory: { l1Ms: 2_000 },
  eth_getLogs: { l1Ms: 3_000, l2S: 3 },
  eth_getCode: { l1Ms: 600_000, l2S: 600 },
  eth_chainId: { l1Ms: 86_400_000, l2S: 86_400 },
  net_version: { l1Ms: 86_400_000, l2S: 86_400 },
};

/** Methods that must NEVER be cached or coalesced (writes, gas estimation, nonces). */
const NEVER_CACHE = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_estimateGas',
  'eth_getTransactionCount',
  'eth_createAccessList',
  'eth_sign',
  'eth_signTransaction',
]);

/** Only plain Ethereum namespaces ride through; debug_/admin_/… are refused outright. */
const ALLOWED_METHOD = /^(eth|net|web3)_[a-zA-Z0-9]+$/;

/** Policy at WRITE time (result in hand — receipts cache differently when still pending). */
function writePolicy(method: string, params: unknown, result: unknown): Policy | null {
  if (NEVER_CACHE.has(method)) return null;
  const fixed = STATIC_TTL[method];
  if (fixed) return fixed;
  if (method === 'eth_getTransactionReceipt' || method === 'eth_getTransactionByHash') {
    // A found tx/receipt is immutable → cache well. "Not found yet" only briefly, so
    // receipt polling stays snappy while still absorbing tight loops.
    return result === null ? { l1Ms: 1_000 } : { l1Ms: 30_000, l2S: 30 };
  }
  if (method === 'eth_getBlockByNumber') {
    const tag = Array.isArray(params) ? params[0] : undefined;
    const isMoving = tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized';
    return isMoving ? { l1Ms: 1_200 } : { l1Ms: 60_000, l2S: 60 };
  }
  if (method === 'eth_getBlockByHash') return { l1Ms: 60_000, l2S: 60 };
  return null; // unknown-but-allowed methods pass through uncached
}

/** Whether the method is ever cacheable (governs L1 lookup + coalescing before fetch). */
function isCacheable(method: string): boolean {
  if (NEVER_CACHE.has(method)) return false;
  return (
    method in STATIC_TTL ||
    method === 'eth_getTransactionReceipt' ||
    method === 'eth_getTransactionByHash' ||
    method === 'eth_getBlockByNumber' ||
    method === 'eth_getBlockByHash'
  );
}

// ── Cache keys ────────────────────────────────────────────────────────────────────────
/** Deterministic stringify (recursively sorted object keys) so {to,data} vs {data,to} match. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

function cacheKey(method: string, params: unknown): string {
  return `${method}:${stableStringify(params ?? [])}`;
}

// ── Stores (module singletons; injectable for tests) ─────────────────────────────────
type L1Entry = { value: unknown; expiresAt: number };
type LastGood = { value: unknown; at: number };

const L1_MAX_ENTRIES = 600;
const STALE_OK_MS = 45_000;
// A healthy Arc endpoint answers in about 200ms. Anything past a second is already broken,
// so these are failure detectors, not patience: 2.5s to give up on one endpoint, and 4s as
// the hard ceiling on the whole request. Past the ceiling the browser is better served by a
// retryable error — its own fallback reaches the same endpoints direct, from a different IP
// with a separate limiter budget, and gets an answer sooner than we could.
const UPSTREAM_TIMEOUT_MS = 2_500;
const TOTAL_BUDGET_MS = 4_000;
const MAX_BATCH = 200;

export interface ProxyDeps {
  upstreams: string[];
  fetchFn: typeof fetch;
  cooldowns: EndpointCooldowns;
  now: () => number;
  l1: Map<string, L1Entry>;
  lastGood: Map<string, LastGood>;
  inflight: Map<string, Promise<unknown>>;
  /** Cloudflare Cache API when available (workerd); undefined in node dev/tests. */
  cacheApi?: { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };
}

const moduleL1 = new Map<string, L1Entry>();
const moduleLastGood = new Map<string, LastGood>();
const moduleInflight = new Map<string, Promise<unknown>>();

export function defaultProxyDeps(): ProxyDeps {
  const cachesGlobal = (globalThis as { caches?: { default?: ProxyDeps['cacheApi'] } }).caches;
  return {
    // Configured endpoints first, then Circle-documented provider mirrors — four independent
    // infrastructures to rotate across before we ever have to serve stale or say "limited".
    upstreams: arcHttpEndpoints(ENV.RPC_HTTP_URLS),
    fetchFn: fetch.bind(globalThis),
    cooldowns: arcEndpointCooldowns,
    now: Date.now,
    l1: moduleL1,
    lastGood: moduleLastGood,
    inflight: moduleInflight,
    cacheApi: cachesGlobal?.default,
  };
}

function capped<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  if (!map.has(key) && map.size >= max) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

// L2 keys are synthetic GET requests — the Cache API can't key on POST bodies.
function l2Request(key: string): Request {
  return new Request(`https://arc-rpc-cache.internal/${encodeURIComponent(key)}`);
}

async function l2Get(deps: ProxyDeps, key: string): Promise<unknown | undefined> {
  if (!deps.cacheApi) return undefined;
  try {
    const hit = await deps.cacheApi.match(l2Request(key));
    if (!hit) return undefined;
    return (await hit.json()) as unknown;
  } catch {
    return undefined;
  }
}

async function l2Put(deps: ProxyDeps, key: string, value: unknown, seconds: number): Promise<void> {
  if (!deps.cacheApi) return;
  try {
    await deps.cacheApi.put(
      l2Request(key),
      new Response(JSON.stringify(value), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` },
      }),
    );
  } catch {
    // best-effort cache — never let a cache write failure break the response
  }
}

// ── Upstream ──────────────────────────────────────────────────────────────────────────
type UpstreamOutcome =
  | { ok: true; byId: Map<string, { result?: unknown; error?: { code: number; message: string } }> }
  | { ok: false; limited: boolean; message: string };

function idKey(id: unknown): string {
  return typeof id === 'string' ? `s:${id}` : `n:${String(id)}`;
}

/**
 * One pass through the upstream list, skipping the endpoints we already know are busy or
 * broken, until one answers or the time budget runs out.
 *
 * This function NEVER sleeps. It runs inside a Worker isolate that is serving a browser
 * request, and a sleep there stalls every visitor that isolate is handling, not just this
 * one. When an endpoint throttles us it goes on cooldown and we ask the next endpoint in the
 * same millisecond — that is the entire reason for keeping four mirrors on separate
 * infrastructures. When none of them can answer, returning promptly is itself the useful
 * answer: the caller serves last-good, or hands the browser a retryable error it can satisfy
 * from its own connection.
 */
async function callUpstreams(
  entries: Array<{ id: unknown; method: string; params: unknown }>,
  deps: ProxyDeps,
): Promise<UpstreamOutcome> {
  let sawLimit = false;
  let lastMessage = 'no upstream configured';
  const deadline = deps.now() + TOTAL_BUDGET_MS;
  // Answers accumulate across upstreams: an entry a node could not execute is asked again on the
  // next one, while entries already answered are not re-sent.
  const answers = new Map<string, { result?: unknown; error?: { code: number; message: string } }>();
  let pending = entries;
  const bodyFor = (list: typeof entries) =>
    JSON.stringify(list.map((e) => ({ jsonrpc: '2.0', id: e.id, method: e.method, params: e.params ?? [] })));

  for (const url of deps.upstreams) {
    if (pending.length === 0) break;
    const body = bodyFor(pending);
    if (!deps.cooldowns.available(url)) {
      // Cooling from a recent throttle or failure. Skipping is the point, so this costs nothing.
      sawLimit = true;
      lastMessage = 'all upstreams are cooling down';
      continue;
    }
    const left = deadline - deps.now();
    if (left <= 0) {
      lastMessage = 'proxy time budget exhausted';
      break;
    }
    try {
      const res = await deps.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(Math.min(UPSTREAM_TIMEOUT_MS, left)),
      });
      if (res.status === 429) {
        sawLimit = true;
        lastMessage = 'upstream returned 429';
        deps.cooldowns.report(url);
        continue;
      }
      if (!res.ok) {
        lastMessage = `upstream HTTP ${res.status}`;
        deps.cooldowns.report(url);
        continue;
      }
      const json = (await res.json()) as unknown;
      const list = Array.isArray(json) ? json : [json];
      const byId = new Map<string, { result?: unknown; error?: { code: number; message: string } }>();
      for (const item of list) {
        const r = item as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
        if (r.error) {
          byId.set(idKey(r.id), {
            error: {
              code: typeof r.error.code === 'number' ? r.error.code : INTERNAL_CODE,
              message: typeof r.error.message === 'string' ? r.error.message : 'upstream error',
            },
          });
        } else {
          byId.set(idKey(r.id), { result: r.result ?? null });
        }
      }
      // A limiter can also answer 200 with per-entry -32005s — treat a fully-limited batch
      // like a 429 (trip + next upstream) so stale-serving kicks in.
      const allLimited =
        byId.size > 0 && [...byId.values()].every((v) => v.error && v.error.code === LIMIT_CODE);
      if (allLimited) {
        sawLimit = true;
        lastMessage = 'upstream rate-limited the batch';
        deps.cooldowns.report(url);
        continue;
      }

      // Keep what this node answered; carry forward only what it could not EXECUTE. A revert is
      // an answer and every node gives the same one, so it is kept. "out of gas" for a view call
      // is not an answer, it is this node declining the work, and a mirror with a higher call
      // budget returns the real result — measured live, where Arc's primary refused a read that
      // two mirrors served fine, and this proxy passed the refusal on as though it were the truth.
      const stillPending: typeof entries = [];
      for (const e of pending) {
        const a = byId.get(idKey(e.id));
        if (a && !(a.error && isNodeCapabilityError(a.error))) {
          answers.set(idKey(e.id), a);
        } else if (a) {
          stillPending.push(e);
          lastMessage = a.error?.message ?? 'upstream could not execute the call';
        } else {
          stillPending.push(e);
          lastMessage = 'upstream returned no answer for this id';
        }
      }
      if (byId.size > 0) deps.cooldowns.reportSuccess(url);
      pending = stillPending;
      if (pending.length === 0) return { ok: true, byId: answers };
      continue;
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err);
      if (/request limit|rate limit|429/i.test(lastMessage)) sawLimit = true;
      // Timeouts and refused connections cool the endpoint as well: a mirror that cannot be
      // reached is not worth the budget on the next request either.
      deps.cooldowns.report(url);
    }
  }
  // Some entries may have been answered before the upstreams ran out. Returning those beats
  // failing the whole batch over the one call nobody could execute.
  if (answers.size > 0) return { ok: true, byId: answers };
  return { ok: false, limited: sawLimit, message: lastMessage };
}

/**
 * Whether an error means "this node declined the work" rather than "this is the answer".
 *
 * The distinction decides whether asking a different node is worth anything. A revert, a bad
 * parameter or an unknown method is a real answer: every node gives the same one, and retrying
 * elsewhere just burns the budget to be told the same thing. A node running out of call gas, or
 * timing out executing, is a property of THAT node's limits — a mirror with a larger budget
 * returns the real result.
 */
export function isNodeCapabilityError(err: { code: number; message: string }): boolean {
  if (err.code === LIMIT_CODE) return true; // rate limited
  const m = err.message.toLowerCase();
  // Deliberately narrow. "execution reverted" and "out of gas" both contain "gas" in some
  // clients, so the revert case is excluded outright before anything else is considered.
  if (m.includes('revert')) return false;
  return (
    err.code === -32003 ||
    m.includes('out of gas') ||
    m.includes('gas required exceeds') ||
    m.includes('gas exhausted') ||
    m.includes('execution timeout') ||
    m.includes('request timed out') ||
    m.includes('exceeds the limit')
  );
}

// ── The handler core ──────────────────────────────────────────────────────────────────
function errEntry(id: unknown, code: number, message: string): RpcError {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function okEntry(id: unknown, result: unknown): RpcResult {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

/**
 * Serve a JSON-RPC payload (single object or batch array): cache-first for read methods,
 * one coalesced upstream batch for the misses, stale-if-limited as the safety net.
 * Always returns JSON-RPC-shaped entries (mirroring the input shape); never throws.
 */
export async function handleRpcPayload(
  payload: unknown,
  deps: ProxyDeps = defaultProxyDeps(),
): Promise<unknown> {
  const isBatch = Array.isArray(payload);
  const list: unknown[] = isBatch ? (payload as unknown[]) : [payload];
  if (list.length === 0) return isBatch ? [] : errEntry(null, -32600, 'empty batch');
  if (list.length > MAX_BATCH) {
    const errs = list.map((e) =>
      errEntry((e as RpcEntry)?.id, -32600, `batch too large (max ${MAX_BATCH})`),
    );
    return isBatch ? errs : errs[0];
  }

  const t = deps.now();
  const out: (RpcResponse | null)[] = new Array(list.length).fill(null);
  const toFetch: Array<{ index: number; id: unknown; method: string; params: unknown; key: string | null }> = [];
  const joined: Array<{ index: number; id: unknown; promise: Promise<unknown> }> = [];
  // Per-request resolvers for keys THIS call will fetch (coalescing point for others).
  const localResolvers = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  for (let i = 0; i < list.length; i++) {
    const entry = list[i] as RpcEntry;
    const method = typeof entry?.method === 'string' ? entry.method : '';
    if (!method || !ALLOWED_METHOD.test(method)) {
      out[i] = errEntry(entry?.id, -32601, 'method not allowed by this proxy');
      continue;
    }
    const params = entry.params ?? [];
    if (!isCacheable(method)) {
      toFetch.push({ index: i, id: entry.id, method, params, key: null });
      continue;
    }
    const key = cacheKey(method, params);
    const l1 = deps.l1.get(key);
    if (l1 && l1.expiresAt > t) {
      out[i] = okEntry(entry.id, l1.value);
      continue;
    }
    const running = deps.inflight.get(key);
    if (running) {
      joined.push({ index: i, id: entry.id, promise: running });
      continue;
    }
    // First asker for this key: register the in-flight promise others will join.
    const p = new Promise<unknown>((resolve, reject) => {
      localResolvers.set(key, { resolve, reject });
    });
    // Swallow rejections on the shared handle — every consumer awaits it with try/catch,
    // but nothing else should turn it into an unhandled rejection.
    p.catch(() => {});
    deps.inflight.set(key, p);
    toFetch.push({ index: i, id: entry.id, method, params, key });
  }

  // L2 lookups for the fetch list (only keys with an L2-eligible policy ever got stored).
  if (deps.cacheApi && toFetch.length > 0) {
    await Promise.all(
      toFetch.map(async (f) => {
        if (!f.key) return;
        const hit = await l2Get(deps, f.key);
        if (hit === undefined) return;
        out[f.index] = okEntry(f.id, hit);
        capped(deps.l1, f.key, { value: hit, expiresAt: deps.now() + 1_000 }, L1_MAX_ENTRIES);
        const r = localResolvers.get(f.key);
        if (r) {
          r.resolve(hit);
          localResolvers.delete(f.key);
          deps.inflight.delete(f.key);
        }
      }),
    );
  }
  const misses = toFetch.filter((f) => out[f.index] === null);

  if (misses.length > 0) {
    const outcome = await callUpstreams(
      misses.map((m) => ({ id: m.id, method: m.method, params: m.params })),
      deps,
    );

    for (const m of misses) {
      const resolver = m.key ? localResolvers.get(m.key) : undefined;
      if (outcome.ok) {
        const answer = outcome.byId.get(idKey(m.id));
        if (answer && !answer.error) {
          out[m.index] = okEntry(m.id, answer.result);
          if (m.key) {
            const pol = writePolicy(m.method, m.params, answer.result);
            if (pol) {
              capped(deps.l1, m.key, { value: answer.result, expiresAt: deps.now() + pol.l1Ms }, L1_MAX_ENTRIES);
              capped(deps.lastGood, m.key, { value: answer.result, at: deps.now() }, L1_MAX_ENTRIES);
              if (pol.l2S) await l2Put(deps, m.key, answer.result, pol.l2S);
            }
            resolver?.resolve(answer.result);
          }
        } else {
          const e = answer?.error ?? { code: INTERNAL_CODE, message: 'upstream returned no answer for this id' };
          out[m.index] = errEntry(m.id, e.code, e.message);
          resolver?.reject(e);
        }
      } else {
        // No upstream answered. A last-good value from the past few seconds beats an error
        // whatever the reason was, so freshness is the only test here, not the cause.
        const stale = m.key ? deps.lastGood.get(m.key) : undefined;
        if (stale && deps.now() - stale.at <= STALE_OK_MS) {
          out[m.index] = okEntry(m.id, stale.value);
          resolver?.resolve(stale.value);
        } else {
          const code = outcome.limited ? LIMIT_CODE : INTERNAL_CODE;
          const message = outcome.limited
            ? 'request limit reached (upstream throttled the proxy)'
            : `upstream unavailable: ${outcome.message}`;
          out[m.index] = errEntry(m.id, code, message);
          resolver?.reject({ code, message });
        }
      }
      if (m.key) {
        localResolvers.delete(m.key);
        deps.inflight.delete(m.key);
      }
    }
  }

  // Entries that joined someone else's in-flight fetch.
  for (const j of joined) {
    try {
      out[j.index] = okEntry(j.id, await j.promise);
    } catch (e) {
      const err = e as { code?: number; message?: string };
      out[j.index] = errEntry(
        j.id,
        typeof err?.code === 'number' ? err.code : INTERNAL_CODE,
        typeof err?.message === 'string' ? err.message : 'coalesced request failed',
      );
    }
  }

  // Any local resolvers left (e.g. L2 answered everything) are already cleaned up above;
  // defensively clear stragglers so a future request never awaits a dead promise.
  for (const [key, r] of localResolvers) {
    r.reject({ code: INTERNAL_CODE, message: 'proxy internal: unresolved entry' });
    deps.inflight.delete(key);
  }

  const filled = out.map((o, i) => o ?? errEntry((list[i] as RpcEntry)?.id, INTERNAL_CODE, 'proxy internal: no answer'));
  return isBatch ? filled : filled[0];
}
