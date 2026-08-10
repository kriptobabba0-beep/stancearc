import { describe, it, expect } from 'vitest';
import {
  decideActionV3,
  decideRecoveryV3,
  hasUnstakeBacklogV3,
  GRACE_SECONDS_V3,
  PhaseViewV3,
  type ActionV3,
  type KeeperStateV3,
} from '../src/decideV3.js';

// Baseline: epoch 5, entry closes at t=1000, settlement at t=1600, now mid-entry.
const base: KeeperStateV3 = {
  currentEpochId: 5n,
  phase: PhaseViewV3.EntryOpen,
  entryCloseTime: 1000n,
  settlementTime: 1600n,
  processedCursor: 0,
  stakedCount: 0,
  nowSec: 500n,
  paused: false,
};

const s = (over: Partial<KeeperStateV3>): KeeperStateV3 => ({ ...base, ...over });

/** A settled epoch #4 with 1 of 3 NFTs returned (live auto-return backlog). */
const backlog: Partial<KeeperStateV3> = { lastSettledEpochId: 4n, unstakeDone: 1, unstakeTotal: 3 };
const drained: Partial<KeeperStateV3> = { lastSettledEpochId: 4n, unstakeDone: 3, unstakeTotal: 3 };

describe('decideActionV3 — entry-anchored lifecycle table', () => {
  const cases: Array<{ name: string; state: KeeperStateV3; expected: ActionV3 }> = [
    // bootstrap + open
    { name: 'never created -> CREATE', state: s({ currentEpochId: 0n }), expected: 'CREATE' },
    { name: 'Idle -> OPEN', state: s({ phase: PhaseViewV3.Idle }), expected: 'OPEN' },

    // entry + locked watch: nothing to crank until the settlement moment
    { name: 'EntryOpen mid-window -> NONE', state: s({ nowSec: 500n }), expected: 'NONE' },
    { name: 'Locked (watching) before settlement -> NONE', state: s({ phase: PhaseViewV3.Locked, nowSec: 1200n }), expected: 'NONE' },
    { name: 'Locked AT the settlement moment -> SETTLE', state: s({ phase: PhaseViewV3.Locked, nowSec: 1600n }), expected: 'SETTLE' },
    { name: 'Locked past the settlement moment -> SETTLE (no expiry)', state: s({ phase: PhaseViewV3.Locked, nowSec: 99_999n }), expected: 'SETTLE' },
    {
      name: 'EntryOpen view but settlement reached (degenerate timing) -> SETTLE',
      state: s({ phase: PhaseViewV3.EntryOpen, nowSec: 1600n }),
      expected: 'SETTLE',
    },

    // processing + finalize
    { name: 'Settling with cursor<total -> PROCESS', state: s({ phase: PhaseViewV3.Settling, processedCursor: 1, stakedCount: 4 }), expected: 'PROCESS' },
    { name: 'Settling fully processed -> FINALIZE', state: s({ phase: PhaseViewV3.Settling, processedCursor: 4, stakedCount: 4 }), expected: 'FINALIZE' },
    { name: 'Settling empty epoch (0 staked) -> FINALIZE directly', state: s({ phase: PhaseViewV3.Settling, processedCursor: 0, stakedCount: 0 }), expected: 'FINALIZE' },

    // settled: auto-return backlog first, then next epoch
    { name: 'Settled with backlog -> UNSTAKE', state: s({ phase: PhaseViewV3.Settled, ...backlog }), expected: 'UNSTAKE' },
    { name: 'Settled drained -> CREATE', state: s({ phase: PhaseViewV3.Settled, ...drained }), expected: 'CREATE' },
    { name: 'Settled, backlog fields absent -> CREATE', state: s({ phase: PhaseViewV3.Settled }), expected: 'CREATE' },

    // idle waits double as catch-up windows
    { name: 'EntryOpen waiting with backlog -> UNSTAKE', state: s({ nowSec: 500n, ...backlog }), expected: 'UNSTAKE' },
    { name: 'Locked waiting with backlog -> UNSTAKE', state: s({ phase: PhaseViewV3.Locked, nowSec: 1200n, ...backlog }), expected: 'UNSTAKE' },
    {
      name: 'backlog never delays SETTLE',
      state: s({ phase: PhaseViewV3.Locked, nowSec: 1700n, ...backlog }),
      expected: 'SETTLE',
    },

    // guards
    { name: 'paused -> NONE', state: s({ paused: true, phase: PhaseViewV3.Settled, ...backlog }), expected: 'NONE' },
    {
      name: 'lastSettledEpochId 0 -> no UNSTAKE',
      state: s({ nowSec: 500n, lastSettledEpochId: 0n, unstakeDone: 0, unstakeTotal: 0 }),
      expected: 'NONE',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(decideActionV3(c.state)).toBe(c.expected);
    });
  }
});

describe('hasUnstakeBacklogV3', () => {
  it('true only when done < total on a real settled epoch', () => {
    expect(hasUnstakeBacklogV3(s(backlog))).toBe(true);
    expect(hasUnstakeBacklogV3(s(drained))).toBe(false);
    expect(hasUnstakeBacklogV3(s({}))).toBe(false);
    expect(hasUnstakeBacklogV3(s({ lastSettledEpochId: 0n, unstakeDone: 0, unstakeTotal: 5 }))).toBe(false);
  });
});

describe('decideRecoveryV3 — owner-key emergencySettle self-heal', () => {
  // A stuck-unsettled epoch: current==lastSettled+1, EntryOpen, well past settlement.
  const stuck = (over: Partial<KeeperStateV3> = {}): KeeperStateV3 =>
    s({
      currentEpochId: 5n,
      lastSettledEpochId: 4n,
      phase: PhaseViewV3.EntryOpen,
      settlementTime: 1600n,
      nowSec: 1600n + GRACE_SECONDS_V3 + 1n, // grace elapsed
      ...over,
    });

  it('RECOVER when stuck unsettled past the on-chain grace and an owner key is present', () => {
    expect(decideRecoveryV3(stuck(), true)).toBe('RECOVER');
    expect(decideRecoveryV3(stuck({ phase: PhaseViewV3.Locked }), true)).toBe('RECOVER');
  });

  it('NONE when no owner key (behavior unchanged from before)', () => {
    expect(decideRecoveryV3(stuck(), false)).toBe('NONE');
  });

  it('WAIT_GRACE before the on-chain grace elapses (do not spam a reverting tx)', () => {
    expect(decideRecoveryV3(stuck({ nowSec: 1600n + GRACE_SECONDS_V3 }), true)).toBe('WAIT_GRACE'); // exactly at grace boundary -> still wait
    expect(decideRecoveryV3(stuck({ nowSec: 1700n }), true)).toBe('WAIT_GRACE');
  });

  it('NONE before the settlement moment (a healthy in-window epoch is never touched)', () => {
    expect(decideRecoveryV3(stuck({ nowSec: 500n }), true)).toBe('NONE');
  });

  it('NONE for a Settling (Priced) or Settled epoch — only the unsettled shape recovers', () => {
    expect(decideRecoveryV3(stuck({ phase: PhaseViewV3.Settling }), true)).toBe('NONE');
    expect(decideRecoveryV3(stuck({ phase: PhaseViewV3.Settled }), true)).toBe('NONE');
    expect(decideRecoveryV3(stuck({ phase: PhaseViewV3.Idle }), true)).toBe('NONE');
  });

  it('NONE when ordering cannot be confirmed (no lastSettledEpochId) or epoch is out of order', () => {
    expect(decideRecoveryV3(stuck({ lastSettledEpochId: undefined }), true)).toBe('NONE');
    expect(decideRecoveryV3(stuck({ lastSettledEpochId: 2n }), true)).toBe('NONE'); // current != lastSettled+1
  });

  it('NONE when paused', () => {
    expect(decideRecoveryV3(stuck({ paused: true }), true)).toBe('NONE');
  });
});
