// Every deploy renames the JS chunks, so a browser holding the previous page asks for filenames
// that no longer exist and the app dies before it renders. The error boundary's reset() cannot fix
// that: it re-renders the same tree and requests the same missing file. Only a reload does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isStaleChunkError, reloadIfStaleChunk } from '@/lib/staleChunk';

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  window.sessionStorage.clear();
  Object.defineProperty(window, 'location', { value: { reload }, writable: true });
});

describe('isStaleChunkError', () => {
  it('recognises how each bundler and browser words it', () => {
    // The exact message from production, plus the native-ESM and Safari variants.
    for (const m of [
      'Loading chunk 3632 failed. (error: https://limen.finance/_next/static/chunks/3632-05c7e6ac8fd7be7a.js)',
      'Failed to fetch dynamically imported module: https://limen.finance/x.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
    ]) {
      expect(isStaleChunkError(new Error(m)), m).toBe(true);
    }
    const named = new Error('boom');
    named.name = 'ChunkLoadError';
    expect(isStaleChunkError(named)).toBe(true);
  });

  it('leaves real application errors alone', () => {
    for (const m of ['execution reverted: STF', 'User rejected the request.', 'Network request failed']) {
      expect(isStaleChunkError(new Error(m)), m).toBe(false);
    }
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

describe('reloadIfStaleChunk', () => {
  it('reloads on a stale chunk and reports that it handled it', () => {
    expect(reloadIfStaleChunk(new Error('Loading chunk 42 failed.'))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an ordinary error', () => {
    expect(reloadIfStaleChunk(new Error('execution reverted'))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  // Without this a genuinely broken build would reload forever instead of showing the failure.
  it('refuses to loop when the same failure comes straight back', () => {
    const t0 = 1_000_000;
    expect(reloadIfStaleChunk(new Error('Loading chunk 42 failed.'), t0)).toBe(true);
    expect(reloadIfStaleChunk(new Error('Loading chunk 42 failed.'), t0 + 5_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh attempt once the cooldown has passed', () => {
    const t0 = 1_000_000;
    reloadIfStaleChunk(new Error('Loading chunk 42 failed.'), t0);
    expect(reloadIfStaleChunk(new Error('Loading chunk 42 failed.'), t0 + 60_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
