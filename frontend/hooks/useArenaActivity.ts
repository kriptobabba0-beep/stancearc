'use client';

// hooks/useArenaActivity.ts - the live arena activity feed (Circle SCP event monitors), polled from
// our /api/circle/activity route. The Circle API key never reaches the client; this just fetches the
// decoded, public on-chain events. Polls every 12s (Circle indexes Arc events ~3s after confirmation).

import { useQuery } from '@tanstack/react-query';
import type { ActivityResponse } from '@/lib/activity/types';

async function fetchActivity(marketId?: string): Promise<ActivityResponse> {
  const qs = marketId ? `?market=${encodeURIComponent(marketId)}` : '';
  const res = await fetch(`/api/circle/activity${qs}`);
  if (!res.ok) throw new Error('Failed to load arena activity');
  return (await res.json()) as ActivityResponse;
}

/** Live activity for ONE market when `marketId` is given (the feed must match the selected market),
 *  else the all-markets feed. Re-keyed by market so switching tabs refetches that market's events. */
export function useArenaActivity(marketId?: string) {
  const q = useQuery<ActivityResponse>({
    queryKey: ['fa-arena-activity', marketId ?? 'all'],
    queryFn: () => fetchActivity(marketId),
    refetchInterval: 12_000,
    staleTime: 8_000,
  });
  return {
    events: q.data?.events ?? [],
    degraded: q.data?.degraded ?? false,
    isLoading: q.isLoading,
  };
}
