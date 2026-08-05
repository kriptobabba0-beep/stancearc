// lib/queryClient.ts - TanStack QueryClient defaults (staleTime, retry). BigInt values flow through
// query data untouched; do NOT JSON-serialize query data (keys must avoid raw bigint - callers stringify).
import { QueryClient } from '@tanstack/react-query';

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Polling is the source of truth; per-hook refetchInterval (usePollInterval) drives cadence.
        staleTime: 2_000,
        gcTime: 5 * 60_000,
        retry: 2,
        refetchOnWindowFocus: false,
      },
    },
  });
}
