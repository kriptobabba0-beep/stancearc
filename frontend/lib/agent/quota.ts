// lib/agent/quota.ts - the copilot's per-key daily message quota. A soft cost bound
// (in-memory per edge isolate) until x402 nanopayments become the real billing layer.
export interface QuotaEntry {
  day: string;
  used: number;
}

/** Count one message against `key` for the UTC day of `nowMs`; false = over the limit. PURE-ish (mutates map). */
export function checkQuota(map: Map<string, QuotaEntry>, key: string, nowMs: number, limit: number): boolean {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  if (limit <= 0) return false; // zero free tier means zero - even the day's first message
  const cur = map.get(key);
  if (!cur || cur.day !== day) {
    map.set(key, { day, used: 1 });
    return true;
  }
  if (cur.used >= limit) return false;
  cur.used += 1;
  return true;
}
