// lib/activity/merge.ts — pure merge of per-market activity results into the feed response. Lives in
// lib (not the route file) because Next.js route modules may only export GET/POST/etc., not helpers.
import type { ActivityEvent, ActivityResponse } from '@/lib/activity/types';

export const MAX_FEED_EVENTS = 50;

/**
 * Merge per-market results. A market that failed is `null`; if EVERY market failed (total Circle/scope
 * outage) the feed is `degraded`. Newest-first, capped at MAX_FEED_EVENTS. Pure + sync — unit-testable
 * without mocking the network.
 */
export function mergeActivity(perMarket: (ActivityEvent[] | null)[]): ActivityResponse {
  const ok = perMarket.filter((x): x is ActivityEvent[] => x !== null);
  if (perMarket.length > 0 && ok.length === 0) return { events: [], degraded: true };
  // Dedupe by id (overlapping page windows, or the same log surfaced by two markets) so React keys
  // stay unique and a row never doubles.
  const byId = new Map<string, ActivityEvent>();
  for (const e of ok.flat()) if (!byId.has(e.id)) byId.set(e.id, e);
  // Newest-first with a DETERMINISTIC same-block tiebreaker (blockHeight, then logIndex, then id) so the
  // feed doesn't flicker/reorder between polls and the MAX cap drops the same rows every time.
  const events = [...byId.values()]
    .sort((a, b) => b.blockHeight - a.blockHeight || b.logIndex - a.logIndex || b.id.localeCompare(a.id))
    .slice(0, MAX_FEED_EVENTS);
  return { events };
}
