'use client';

// hooks/useMediaQuery.ts — subscribe to a CSS media query in JS so a component can MOUNT only at the
// matching breakpoint (not merely be hidden via CSS `display:none`, which keeps it mounted + running
// its effects). Used by the dashboard to render <ActivityFeed/> exactly ONCE — in the xl right-rail or
// the below-xl full-width slot — so its getLogs backfill + live watcher don't run twice (which would
// double the activity-feed RPC load and work against the multi-RPC resilience goal).
import { useEffect, useState } from 'react';

/**
 * Returns whether `query` currently matches. SSR-safe: starts false on the server / first client render
 * (so markup is deterministic and hydration-stable) and syncs to the real value in an effect on mount.
 * Re-renders on viewport changes via the MediaQueryList change event.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    // Sync immediately (the SSR/first-render default is false; correct it on mount).
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
