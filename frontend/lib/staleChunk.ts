// lib/staleChunk.ts — recover from the one error a deploy reliably causes.
//
// Next.js fingerprints every JS chunk, so a new build renames all of them. A browser that already
// had the page open, or that cached the HTML, still asks for the previous build's filenames. Those
// are gone, and the app dies on "Loading chunk 3632 failed" before anything renders.
//
// The error boundary's "Try again" cannot fix it: reset() re-renders the same tree, which requests
// the same missing file. Only a full reload helps, because that fetches fresh HTML naming the chunks
// that actually exist. So this is not cosmetic error handling — it is the difference between a white
// screen after every deploy and a page that quietly heals itself.

const RELOAD_KEY = 'limen.stale-chunk-reload-at';
/** A second failure this soon after a reload is not a stale chunk; reloading again would just loop. */
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * Whether an error is a missing/stale JS chunk.
 *
 * Matched on the message because the error class differs by bundler and browser: webpack throws
 * ChunkLoadError, native ESM imports throw a TypeError about a failed module script, and Safari
 * words it differently again.
 */
export function isStaleChunkError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  return /ChunkLoadError|Loading chunk\s+\S+\s+failed|dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    text,
  );
}

/**
 * Reload once when the error is a stale chunk. Returns true when a reload was started, so the caller
 * can skip rendering a failure the user will never see.
 *
 * The cooldown is the important part: without it a genuinely broken build would reload forever.
 */
export function reloadIfStaleChunk(err: unknown, now: number = Date.now()): boolean {
  if (typeof window === 'undefined' || !isStaleChunkError(err)) return false;

  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
    if (Number.isFinite(last) && now - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    // Private mode or storage disabled. One reload is still the right move; the loop guard is what
    // is lost, and a hard-broken build would then be caught by the browser's own reload throttling.
  }

  window.location.reload();
  return true;
}
