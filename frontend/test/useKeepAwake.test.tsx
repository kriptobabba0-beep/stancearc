import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeepAwake } from '@/hooks/useKeepAwake';

// The agent tab's throttling exemption: while the autopilot/session runs, the page must hold
// a SHARED Web Lock (Chromium exempts lock holders from intensive background throttling).
// jsdom has no navigator.locks — the hook must both no-op gracefully and use it when present.

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (navigator as any).locks;
  vi.restoreAllMocks();
});

describe('useKeepAwake', () => {
  it('holds a shared lock while active and releases it on cleanup', async () => {
    let released = false;
    const request = vi.fn(async (_name: string, _opts: unknown, cb: () => Promise<void>) => {
      await cb().then(() => {
        released = true;
      });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).locks = { request };

    const { unmount } = renderHook(() => useKeepAwake(true));
    expect(request).toHaveBeenCalledWith('limen-agent-keepawake', { mode: 'shared' }, expect.any(Function));
    expect(released).toBe(false); // held — the promise must stay pending while active

    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(released).toBe(true); // cleanup resolves the promise → the lock is released
  });

  it('does nothing when inactive or when the API is missing', () => {
    const request = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (navigator as any).locks = { request };
    renderHook(() => useKeepAwake(false));
    expect(request).not.toHaveBeenCalled();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (navigator as any).locks;
    expect(() => renderHook(() => useKeepAwake(true))).not.toThrow();
  });
});
