import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useArenaActivity } from '@/hooks/useArenaActivity';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client: qc }, children);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useArenaActivity', () => {
  it('returns events + degraded=false from the activity endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ events: [{ id: 'a', kind: 'settled', epochId: 1, blockHeight: 9 }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useArenaActivity(), { wrapper });
    await waitFor(() => expect(result.current.events).toHaveLength(1));
    expect(result.current.events[0].id).toBe('a');
    expect(result.current.degraded).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/circle/activity');
  });

  it('surfaces degraded=true from the endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ events: [], degraded: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useArenaActivity(), { wrapper });
    await waitFor(() => expect(result.current.degraded).toBe(true));
    expect(result.current.events).toEqual([]);
  });
});
