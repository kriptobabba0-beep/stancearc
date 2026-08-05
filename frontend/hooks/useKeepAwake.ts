'use client';

// hooks/useKeepAwake.ts - exempt the agent tab from Chrome's Intensive Wake Up Throttling.
//
// Background tabs get their timers clamped to ONE fire per minute, batched to minute-aligned
// wake-ups. viem's multicall batching flushes reads with setTimeout(16), so in a throttled tab
// EVERY chain read stretched to ~60s - an unattended session's entry setup (several read
// rounds) could never finish inside a 2-minute window, and both overnight profiles died with
// "entry window closed during setup" stamped exactly on the minute grid.
//
// Chromium explicitly EXEMPTS pages holding a Web Lock from intensive throttling, so while
// the autopilot or a session is on we hold one (SHARED mode - an exclusive lock would
// serialize across the user's other Limen tabs). Best-effort by design: a closed laptop or a
// locked OS still suspends the page - true 24/7 is the self-hosted agent's job.
import { useEffect } from 'react';

export function useKeepAwake(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('locks' in navigator)) return;
    let release: (() => void) | undefined;
    let cancelled = false;
    void navigator.locks
      .request(
        'limen-agent-keepawake',
        { mode: 'shared' },
        () =>
          new Promise<void>((resolve) => {
            if (cancelled) resolve();
            else release = resolve;
          }),
      )
      .catch(() => {
        // Locks unavailable - throttling stays; the autopilot's visibility kick still recovers
        // the moment the tab is foregrounded.
      });
    return () => {
      cancelled = true;
      release?.();
    };
  }, [active]);
}
