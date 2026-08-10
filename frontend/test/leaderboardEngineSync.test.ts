// Two files exist twice: the leaderboard engine and the FeeArenaV3 ABI, canonical here and copied
// into keeper/src/ because the keeper is the process that actually advances the index and its
// Docker build context is keeper/ — it cannot import across packages. Both are pure, so copying is
// safe; drifting apart is not.
//
// The ABI matters most, and it is the one that already bit us. Event fragments were hand-written
// on the keeper side with `epochId` as uint256 where the contract emits uint64. Every topic0
// hashed to something the chain never emits, viem's strict:false skipped all of them without an
// error, and the leaderboard reported 0 epochs, 0 fees and empty 7D/30D windows while still
// rendering a plausible-looking page, because volume comes from the pool and kept working.
//
// Re-sync with: node scripts/sync-leaderboard-engine.mjs
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const read = (p: string) => lf(readFileSync(resolve(process.cwd(), p), 'utf8'));

/** canonical (relative to frontend/) -> copy (relative to frontend/) */
const SYNCED: Array<[string, string]> = [
  ['lib/leaderboardIndex.ts', '../keeper/src/leaderboardIndex.ts'],
  ['abis/feeArenaV3.ts', '../keeper/src/feeArenaV3Abi.ts'],
];

const BANNER_END = '// moment the two drift apart.\n';

describe('files shared with the keeper', () => {
  it.each(SYNCED)('%s is byte-identical to its keeper copy', (canonicalPath, copyPath) => {
    const canonical = read(canonicalPath);
    const copy = read(copyPath);

    const cut = copy.indexOf(BANNER_END);
    expect(cut, `${copyPath} is missing its "do not edit" banner`).toBeGreaterThan(-1);
    expect(copy.slice(cut + BANNER_END.length)).toBe(canonical);
  });

  it.each(SYNCED)('%s stays dependency-free, which is what makes copying it safe', (canonicalPath) => {
    // An import here would resolve under Next.js and break inside the keeper container.
    expect(read(canonicalPath)).not.toMatch(/^\s*import\s/m);
  });

  it('the ABI still declares the events the standings are built from', () => {
    const abi = read('abis/feeArenaV3.ts');
    for (const name of ['EpochCreated', 'Staked', 'PositionProcessed', 'EpochSettled', 'Claimed']) {
      expect(abi, `${name} is gone from the ABI — the indexer would stop seeing it`).toContain(
        `"name":"${name}"`,
      );
    }
  });
});
