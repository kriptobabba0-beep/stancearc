import { describe, it, expect } from 'vitest';
import {
  decideAction,
  decideRecovery,
  EMERGENCY_RESOLUTION_RANGE,
  GRACE_SECONDS,
  PhaseView,
  type Action,
  type KeeperState,
} from '../src/decide.js';

// A sane baseline that each case overrides only the fields it cares about.
const base: KeeperState = {
  currentEpochId: 1n,
  phase: PhaseView.Idle,
  entryCloseTime: 1000n,
  startTime: 1100n,
  endTime: 2000n,
  settlePrice18: 0n,
  sweepCursor: 0,
  stakedCount: 0,
  nowSec: 500n,
  maxStartDelay: 600n,
  paused: false,
  lastSweptEpochId: null,
};

const s = (over: Partial<KeeperState>): KeeperState => ({ ...base, ...over });

describe('decideAction — exhaustive lifecycle table', () => {
  const cases: Array<{ name: string; state: KeeperState; expected: Action }> = [
    // --- bootstrap ---
    {
      name: 'never created (epochId 0) -> CREATE',
      state: s({ currentEpochId: 0n, phase: PhaseView.Idle }),
      expected: 'CREATE',
    },
    {
      name: 'never created wins even if phase looks like Settled',
      state: s({ currentEpochId: 0n, phase: PhaseView.Settled }),
      expected: 'CREATE',
    },

    // --- Idle (created, entry not yet opened) ---
    {
      name: 'Idle -> OPEN',
      state: s({ phase: PhaseView.Idle }),
      expected: 'OPEN',
    },
    {
      name: 'Idle -> OPEN regardless of nowSec vs entryClose',
      state: s({ phase: PhaseView.Idle, nowSec: 9999n }),
      expected: 'OPEN',
    },

    // --- EntryOpen (gate on entryCloseTime) ---
    {
      name: 'EntryOpen before entryClose -> NONE',
      state: s({ phase: PhaseView.EntryOpen, nowSec: 999n, entryCloseTime: 1000n }),
      expected: 'NONE',
    },
    {
      name: 'EntryOpen exactly at entryClose -> START',
      state: s({ phase: PhaseView.EntryOpen, nowSec: 1000n, entryCloseTime: 1000n }),
      expected: 'START',
    },
    {
      name: 'EntryOpen after entryClose -> START',
      state: s({ phase: PhaseView.EntryOpen, nowSec: 1500n, entryCloseTime: 1000n }),
      expected: 'START',
    },
    {
      name: 'EntryOpen at the LAST second of the start window -> START',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 600n, nowSec: 1600n }),
      expected: 'START',
    },
    {
      name: 'EntryOpen one second PAST the window -> STUCK (would revert StartDelayExceeded)',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 600n, nowSec: 1601n }),
      expected: 'STUCK',
    },
    {
      name: 'EntryOpen long past the window -> STUCK',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 600n, nowSec: 99_999n }),
      expected: 'STUCK',
    },
    {
      name: 'EntryOpen with zero maxStartDelay: at entryClose -> START',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 0n, nowSec: 1000n }),
      expected: 'START',
    },
    {
      name: 'EntryOpen with zero maxStartDelay: one second after -> STUCK',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 0n, nowSec: 1001n }),
      expected: 'STUCK',
    },

    // --- Running, not yet ended (settlePrice18 === 0) gate on endTime ---
    {
      name: 'Running not-ended before endTime -> NONE',
      state: s({ phase: PhaseView.Running, settlePrice18: 0n, nowSec: 1999n, endTime: 2000n }),
      expected: 'NONE',
    },
    {
      name: 'Running not-ended exactly at endTime -> END',
      state: s({ phase: PhaseView.Running, settlePrice18: 0n, nowSec: 2000n, endTime: 2000n }),
      expected: 'END',
    },
    {
      name: 'Running not-ended after endTime -> END',
      state: s({ phase: PhaseView.Running, settlePrice18: 0n, nowSec: 5000n, endTime: 2000n }),
      expected: 'END',
    },

    // --- Running, ended/resolved (settlePrice18 !== 0): sweep then finalize ---
    {
      name: 'Resolved cursor<total -> SWEEP',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 0, stakedCount: 10 }),
      expected: 'SWEEP',
    },
    {
      name: 'Resolved cursor partway (< total) -> SWEEP',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 9, stakedCount: 10 }),
      expected: 'SWEEP',
    },
    {
      name: 'Resolved cursor==total (non-empty) -> FINALIZE',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 10, stakedCount: 10, lastSweptEpochId: null }),
      expected: 'FINALIZE',
    },
    {
      name: 'Resolved EMPTY epoch, no sweep yet -> SWEEP (mandatory one-time sweep for Resolved->Swept)',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 0, stakedCount: 0, currentEpochId: 1n, lastSweptEpochId: null }),
      expected: 'SWEEP',
    },
    {
      name: 'Resolved EMPTY epoch, swept a DIFFERENT epoch -> SWEEP (this epoch not yet swept)',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 0, stakedCount: 0, currentEpochId: 2n, lastSweptEpochId: 1n }),
      expected: 'SWEEP',
    },
    {
      name: 'Resolved EMPTY epoch, already swept THIS epoch -> FINALIZE',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 0, stakedCount: 0, currentEpochId: 1n, lastSweptEpochId: 1n }),
      expected: 'FINALIZE',
    },

    // --- Settled -> begin next epoch ---
    {
      name: 'Settled -> CREATE',
      state: s({ phase: PhaseView.Settled }),
      expected: 'CREATE',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(decideAction(c.state)).toBe(c.expected);
    });
  }
});

describe('decideAction — purity & boundary sanity', () => {
  it('does not mutate the input state', () => {
    const state = s({ phase: PhaseView.EntryOpen, nowSec: 1500n });
    const snapshot = { ...state };
    decideAction(state);
    expect(state).toEqual(snapshot);
  });

  it('END requires being at/after endTime even just one second early -> NONE', () => {
    expect(
      decideAction(s({ phase: PhaseView.Running, settlePrice18: 0n, endTime: 2000n, nowSec: 1999n })),
    ).toBe('NONE');
  });

  it('START requires being at/after entryClose even just one second early -> NONE', () => {
    expect(
      decideAction(s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, nowSec: 999n })),
    ).toBe('NONE');
  });
});

describe('decideAction — paused short-circuits every phase to NONE', () => {
  // While paused, the payable/settlement cranks revert under whenNotPaused, so the
  // keeper must take NO action in ANY phase (even ones that would otherwise act).
  const phases: Array<{ name: string; state: KeeperState }> = [
    { name: 'never-created (epochId 0)', state: s({ paused: true, currentEpochId: 0n }) },
    { name: 'Idle', state: s({ paused: true, phase: PhaseView.Idle }) },
    {
      name: 'EntryOpen past entryClose (would START)',
      state: s({ paused: true, phase: PhaseView.EntryOpen, entryCloseTime: 1000n, nowSec: 1500n }),
    },
    {
      name: 'EntryOpen past window (would STUCK)',
      state: s({ paused: true, phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 10n, nowSec: 99_999n }),
    },
    {
      name: 'Running past endTime (would END)',
      state: s({ paused: true, phase: PhaseView.Running, settlePrice18: 0n, endTime: 2000n, nowSec: 5000n }),
    },
    {
      name: 'Resolved with sweep pending (would SWEEP)',
      state: s({ paused: true, phase: PhaseView.Running, settlePrice18: 1n, sweepCursor: 0, stakedCount: 5 }),
    },
    {
      name: 'Resolved fully swept (would FINALIZE)',
      state: s({ paused: true, phase: PhaseView.Running, settlePrice18: 1n, sweepCursor: 5, stakedCount: 5 }),
    },
    { name: 'Settled (would CREATE)', state: s({ paused: true, phase: PhaseView.Settled }) },
  ];

  for (const c of phases) {
    it(`paused + ${c.name} -> NONE`, () => {
      expect(decideAction(c.state)).toBe('NONE');
    });
  }
});

describe('decideRecovery — OPTIONAL owner-key wedge auto-recovery', () => {
  // The canonical WEDGED state: EntryOpen, the start window has lapsed
  // (now > entryCloseTime + maxStartDelay), genuinely unresolved (settlePrice18==0).
  // decideAction returns STUCK for exactly this shape — recovery is gated on it.
  // endTime is in the past so grace can be controlled via nowSec relative to
  // endTime + GRACE_SECONDS.
  const wedged = (over: Partial<KeeperState> = {}): KeeperState =>
    s({
      phase: PhaseView.EntryOpen,
      entryCloseTime: 1000n,
      maxStartDelay: 600n, // start window closes at 1600
      settlePrice18: 0n,
      endTime: 2000n, // grace boundary at endTime + 600 = 2600
      nowSec: 5000n, // past the start window (STUCK) AND past endTime+GRACE
      ...over,
    });

  it('sanity: the wedged base state is exactly the STUCK case', () => {
    expect(decideAction(wedged())).toBe('STUCK');
  });

  it('GRACE_SECONDS mirrors the contract (600) and RANGE resolution is 3', () => {
    expect(GRACE_SECONDS).toBe(600n);
    expect(EMERGENCY_RESOLUTION_RANGE).toBe(3);
  });

  // (a) wedged + owner key + grace elapsed -> RECOVER
  it('wedged + owner key + grace elapsed -> RECOVER', () => {
    expect(decideRecovery(wedged(), true)).toBe('RECOVER');
  });

  it('wedged + owner key, exactly one second past endTime+GRACE -> RECOVER', () => {
    // endTime 2000 + GRACE 600 = 2600; nowSec 2601 is the first eligible second.
    expect(decideRecovery(wedged({ nowSec: 2601n }), true)).toBe('RECOVER');
  });

  // (b) wedged + NO owner key -> NONE (unchanged STUCK behavior upstream)
  it('wedged + NO owner key -> NONE (behavior unchanged)', () => {
    expect(decideRecovery(wedged(), false)).toBe('NONE');
  });

  // (c) wedged + owner key + grace NOT elapsed -> WAIT_GRACE (no spam)
  it('wedged + owner key + grace NOT elapsed -> WAIT_GRACE', () => {
    // nowSec is past the start window (still STUCK) but at/under endTime+GRACE.
    expect(decideRecovery(wedged({ nowSec: 2500n }), true)).toBe('WAIT_GRACE');
  });

  it('wedged + owner key, EXACTLY at endTime+GRACE -> WAIT_GRACE (contract reverts on <=)', () => {
    // Contract reverts GraceNotElapsed while now <= endTime + GRACE, so the boundary
    // second itself is NOT yet eligible.
    expect(decideRecovery(wedged({ nowSec: 2600n }), true)).toBe('WAIT_GRACE');
  });

  // (d) healthy / normal epochs + owner key present -> NONE, NEVER recovery.
  const healthy: Array<{ name: string; state: KeeperState }> = [
    { name: 'never-created (epochId 0) -> would CREATE', state: s({ currentEpochId: 0n }) },
    { name: 'Idle -> would OPEN', state: s({ phase: PhaseView.Idle }) },
    {
      name: 'EntryOpen before entryClose -> would NONE',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 600n, nowSec: 999n }),
    },
    {
      name: 'EntryOpen INSIDE start window -> would START',
      state: s({ phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 600n, nowSec: 1200n }),
    },
    {
      name: 'Running not-ended past endTime -> would END',
      state: s({ phase: PhaseView.Running, settlePrice18: 0n, endTime: 2000n, nowSec: 5000n }),
    },
    {
      name: 'Resolved with sweep pending -> would SWEEP',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 0, stakedCount: 5 }),
    },
    {
      name: 'Resolved fully swept -> would FINALIZE',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 5, stakedCount: 5 }),
    },
    { name: 'Settled -> would CREATE', state: s({ phase: PhaseView.Settled }) },
    { name: 'paused -> would NONE', state: s({ paused: true, phase: PhaseView.EntryOpen, entryCloseTime: 1000n, maxStartDelay: 600n, nowSec: 5000n }) },
  ];

  for (const c of healthy) {
    it(`healthy/normal + owner key -> NONE (${c.name})`, () => {
      expect(decideRecovery(c.state, true)).toBe('NONE');
    });
  }

  it('SAFETY: a resolved epoch is NEVER recovered even if owner key present (settlePrice18 != 0)', () => {
    // Construct a state that is past the start window AND past endTime+GRACE but already
    // RESOLVED (settlePrice18 != 0). decideAction would return SWEEP/FINALIZE (not STUCK),
    // so decideRecovery must return NONE — emergencySettle would also revert WrongPhase.
    const resolved = wedged({ phase: PhaseView.Running, settlePrice18: 9999n, sweepCursor: 0, stakedCount: 3 });
    expect(decideAction(resolved)).not.toBe('STUCK');
    expect(decideRecovery(resolved, true)).toBe('NONE');
  });

  it('does not mutate the input state', () => {
    const state = wedged();
    const snapshot = { ...state };
    decideRecovery(state, true);
    expect(state).toEqual(snapshot);
  });
});

describe('decideAction — v1 auto-return (UNSTAKE) backlog', () => {
  /** A settled epoch with 2 of 5 NFTs already returned (live backlog). */
  const backlog: Partial<KeeperState> = { lastSettledEpochId: 7n, unstakeDone: 2, unstakeTotal: 5 };
  const drained: Partial<KeeperState> = { lastSettledEpochId: 7n, unstakeDone: 5, unstakeTotal: 5 };

  const cases: Array<{ name: string; state: KeeperState; expected: Action }> = [
    // --- Settled: drain the backlog BEFORE creating the next epoch ---
    {
      name: 'Settled with backlog -> UNSTAKE (return stakes before next epoch)',
      state: s({ phase: PhaseView.Settled, ...backlog }),
      expected: 'UNSTAKE',
    },
    {
      name: 'Settled fully drained -> CREATE',
      state: s({ phase: PhaseView.Settled, ...drained }),
      expected: 'CREATE',
    },
    {
      name: 'Settled with fields ABSENT (v2 market / legacy state) -> CREATE (unchanged)',
      state: s({ phase: PhaseView.Settled }),
      expected: 'CREATE',
    },

    // --- idle waits double as catch-up windows (e.g. after keeper downtime) ---
    {
      name: 'EntryOpen waiting (before entryClose) with backlog -> UNSTAKE',
      state: s({ phase: PhaseView.EntryOpen, nowSec: 999n, entryCloseTime: 1000n, ...backlog }),
      expected: 'UNSTAKE',
    },
    {
      name: 'Running waiting (before endTime) with backlog -> UNSTAKE',
      state: s({ phase: PhaseView.Running, settlePrice18: 0n, nowSec: 1500n, endTime: 2000n, ...backlog }),
      expected: 'UNSTAKE',
    },

    // --- the backlog must NEVER delay a time-critical crank ---
    {
      name: 'EntryOpen at entryClose with backlog -> START (not UNSTAKE)',
      state: s({ phase: PhaseView.EntryOpen, nowSec: 1000n, entryCloseTime: 1000n, ...backlog }),
      expected: 'START',
    },
    {
      name: 'Running past endTime with backlog -> END (not UNSTAKE)',
      state: s({ phase: PhaseView.Running, settlePrice18: 0n, nowSec: 2000n, endTime: 2000n, ...backlog }),
      expected: 'END',
    },
    {
      name: 'Resolved with sweep pending AND backlog -> SWEEP (settlement first)',
      state: s({ phase: PhaseView.Running, settlePrice18: 123n, sweepCursor: 0, stakedCount: 3, ...backlog }),
      expected: 'SWEEP',
    },

    // --- guards ---
    {
      name: 'paused with backlog -> NONE (unstakeBatch is whenNotPaused)',
      state: s({ paused: true, phase: PhaseView.Settled, ...backlog }),
      expected: 'NONE',
    },
    {
      name: 'lastSettledEpochId 0 (nothing ever settled) -> no UNSTAKE',
      state: s({ phase: PhaseView.EntryOpen, nowSec: 999n, entryCloseTime: 1000n, lastSettledEpochId: 0n, unstakeDone: 0, unstakeTotal: 0 }),
      expected: 'NONE',
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(decideAction(c.state)).toBe(c.expected);
    });
  }
});
