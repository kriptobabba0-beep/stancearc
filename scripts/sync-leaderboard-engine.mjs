// Copies the files the keeper's leaderboard indexer shares with the site into keeper/src/. The
// keeper's Docker build context is keeper/, so it cannot import across packages, and both files
// are pure data/logic with zero imports - a byte-identical copy needs no build step.
//
// Run this after editing either canonical file; the drift tests in both suites fail until you do.
//
// Line endings are normalised to LF on both sides so the check means the same thing on Windows
// (where git hands back CRLF) as in the Linux container that actually runs the keeper.
import { readFileSync, writeFileSync } from 'node:fs';

/** canonical -> copy. The ABI is in here because hand-writing event fragments breaks decoding
 *  SILENTLY: a wrong parameter type changes topic0, and a log whose topic0 doesn't match is
 *  skipped without an error, so the standings lose every arena event while still looking
 *  plausible - volume keeps working because it comes from the pool. */
export const SYNCED = [
  ['frontend/lib/leaderboardIndex.ts', 'keeper/src/leaderboardIndex.ts'],
  ['frontend/abis/feeArenaV3.ts', 'keeper/src/feeArenaV3Abi.ts'],
];

export const BANNER =
  '// COPY - do NOT edit. The canonical file is {SRC}; the keeper cannot import across packages\n' +
  '// (its Docker build context is keeper/), so this is a byte-identical copy. Edit the canonical\n' +
  '// file and re-run `node scripts/sync-leaderboard-engine.mjs`. A test in BOTH suites fails the\n' +
  '// moment the two drift apart.\n';

export const lf = (s) => s.replace(/\r\n/g, '\n');
export const bannerFor = (src) => BANNER.replace('{SRC}', src);

for (const [src, dst] of SYNCED) {
  writeFileSync(dst, bannerFor(src) + lf(readFileSync(src, 'utf8')), 'utf8');
  console.log(`synced ${src} -> ${dst}`);
}
