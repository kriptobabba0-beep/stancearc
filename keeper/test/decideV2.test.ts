// decideV2.test.ts — the PURE v2 pinned-window decision logic. v2 differs from v1 ONLY
// in the SETTLE path: startEpoch/endEpoch must post a FRESH Hermes blob whose publishTime
// lands in the contract-pinned window [endpointTime, endpointTime+settleWindow] (settleWindow
// hard-capped 60s, default ~12s). decideV2Window is the testable core that gates WHEN the
// keeper attempts the pinned crank so it only fires inside that tight window. No I/O, no clock.
import { describe, it, expect } from 'vitest';
import {
  collapseV2Phase,
  decidePinnedWindow,
  effectiveSettleWindow,
  MAX_SETTLE_WINDOW,
  PhaseV2,
  type PinnedWindowDecision,
} from '../src/decideV2.js';
import { PhaseView } from '../src/decide.js';

describe('collapseV2Phase — collapse v2 RAW 6-phase Phase to the external 4-phase PhaseView', () => {
  // The v2 contract's currentEpoch() returns the RAW EpochV2 struct with the INTERNAL 6-phase
  // Phase enum (it does NOT run EpochViewLib.toView/collapse like v1). This MUST mirror
  // src/libraries/EpochViewLib.collapse EXACTLY, else the keeper misreads the settle path and
  // the v2 lifecycle wedges at first settle.
  it('None(0) -> Idle(0)', () => {
    expect(collapseV2Phase(0)).toBe(PhaseView.Idle);
    expect(collapseV2Phase(PhaseV2.None)).toBe(PhaseView.Idle);
  });
  it('EntryOpen(1) -> EntryOpen(1)', () => {
    expect(collapseV2Phase(1)).toBe(PhaseView.EntryOpen);
    expect(collapseV2Phase(PhaseV2.EntryOpen)).toBe(PhaseView.EntryOpen);
  });
  it('Running(2) -> Running(2)', () => {
    expect(collapseV2Phase(2)).toBe(PhaseView.Running);
    expect(collapseV2Phase(PhaseV2.Running)).toBe(PhaseView.Running);
  });
  it('Resolved(3) -> Running(2) (NOT Settled — the crux of the wedge bug)', () => {
    // The naive `Number(phase) as PhaseView` mapped raw 3 -> PhaseView.Settled(3), which made
    // decideAction return CREATE -> createEpoch reverts PrevNotSettled (winners never paid).
    expect(collapseV2Phase(3)).toBe(PhaseView.Running);
    expect(collapseV2Phase(PhaseV2.Resolved)).toBe(PhaseView.Running);
    expect(collapseV2Phase(3)).not.toBe(PhaseView.Settled);
  });
  it('Swept(4) -> Running(2)', () => {
    expect(collapseV2Phase(4)).toBe(PhaseView.Running);
    expect(collapseV2Phase(PhaseV2.Swept)).toBe(PhaseView.Running);
  });
  it('Settled(5) -> Settled(3)', () => {
    expect(collapseV2Phase(5)).toBe(PhaseView.Settled);
    expect(collapseV2Phase(PhaseV2.Settled)).toBe(PhaseView.Settled);
  });

  it('covers ALL 6 raw phases with the exact EpochViewLib.collapse mapping', () => {
    const expected: Record<number, PhaseView> = {
      0: PhaseView.Idle, // None
      1: PhaseView.EntryOpen, // EntryOpen
      2: PhaseView.Running, // Running
      3: PhaseView.Running, // Resolved
      4: PhaseView.Running, // Swept
      5: PhaseView.Settled, // Settled
    };
    for (let raw = 0; raw <= 5; raw += 1) {
      expect(collapseV2Phase(raw)).toBe(expected[raw]);
    }
  });

  it('an unknown/out-of-range raw value defaults to Running (safe settlement-in-progress bucket)', () => {
    // A misread (neither a valid Phase nor PhaseView) must never spuriously CREATE or stall —
    // Running keeps decideAction in the settle/wait path, the conservative choice.
    expect(collapseV2Phase(6)).toBe(PhaseView.Running);
    expect(collapseV2Phase(99)).toBe(PhaseView.Running);
    expect(collapseV2Phase(-1)).toBe(PhaseView.Running);
  });
});

describe('effectiveSettleWindow — read settleWindow from the arena, hard-cap 60', () => {
  it('passes through a normal window (12s)', () => {
    expect(effectiveSettleWindow(12n)).toBe(12n);
  });
  it('passes through the exact cap (60s)', () => {
    expect(effectiveSettleWindow(60n)).toBe(60n);
    expect(MAX_SETTLE_WINDOW).toBe(60n);
  });
  it('hard-caps an over-large window to 60 (defense vs a misread / bad config)', () => {
    expect(effectiveSettleWindow(600n)).toBe(60n);
    expect(effectiveSettleWindow(120n)).toBe(60n);
  });
  it('a zero/garbage window is clamped UP to 1 so the math is never degenerate', () => {
    // The contract enforces settleWindow >= 1; a 0 read (RPC hiccup) would make the window
    // empty — clamp to 1 so we still attempt rather than dividing the window to nothing.
    expect(effectiveSettleWindow(0n)).toBe(1n);
  });
});

describe('decidePinnedWindow — gate the pinned start/end on the tight window', () => {
  // window = [endpoint, endpoint+settleWindow]; safetyMarginSec shaves the TAIL so the blob
  // (publishTime ~= now) + the fetch->mine latency still lands <= endpoint+settleWindow.
  const d = (over: {
    nowSec: bigint;
    endpointTime?: bigint;
    settleWindow?: bigint;
    safetyMarginSec?: bigint;
  }): PinnedWindowDecision =>
    decidePinnedWindow({
      nowSec: over.nowSec,
      endpointTime: over.endpointTime ?? 1000n,
      settleWindow: over.settleWindow ?? 12n,
      safetyMarginSec: over.safetyMarginSec ?? 2n,
    });

  it('before the endpoint -> WAIT (do not attempt — parse would revert out-of-window)', () => {
    expect(d({ nowSec: 999n })).toBe('WAIT');
  });

  it('exactly at the endpoint -> ATTEMPT (first valid second)', () => {
    expect(d({ nowSec: 1000n })).toBe('ATTEMPT');
  });

  it('inside the window, before the safety tail -> ATTEMPT', () => {
    // window [1000,1012], tail starts at 1012-2 = 1010; nowSec 1009 is fine.
    expect(d({ nowSec: 1009n })).toBe('ATTEMPT');
  });

  it('at the last safe second (endpoint+settleWindow-margin) -> ATTEMPT', () => {
    // 1000 + 12 - 2 = 1010 is still attemptable.
    expect(d({ nowSec: 1010n })).toBe('ATTEMPT');
  });

  it('one second into the safety tail -> MISSED (too risky: blob may land past the window)', () => {
    // 1011 > 1010 (last safe second) but <= 1012 (hard window end) -> MISSED, fetch fresher next tick.
    expect(d({ nowSec: 1011n })).toBe('MISSED');
  });

  it('exactly at the hard window end -> MISSED', () => {
    expect(d({ nowSec: 1012n })).toBe('MISSED');
  });

  it('past the hard window end -> MISSED (wedged unless a faster tick / owner emergencySettle)', () => {
    expect(d({ nowSec: 5000n })).toBe('MISSED');
  });

  it('zero safety margin: attempt right up to the hard window end', () => {
    expect(d({ nowSec: 1012n, safetyMarginSec: 0n })).toBe('ATTEMPT');
    expect(d({ nowSec: 1013n, safetyMarginSec: 0n })).toBe('MISSED');
  });

  it('a margin >= the window collapses the attempt set to just the endpoint instant', () => {
    // window 12, margin 12 -> last safe = endpoint+0 = endpoint; only nowSec==endpoint attempts.
    expect(d({ nowSec: 1000n, settleWindow: 12n, safetyMarginSec: 12n })).toBe('ATTEMPT');
    expect(d({ nowSec: 1001n, settleWindow: 12n, safetyMarginSec: 12n })).toBe('MISSED');
  });

  it('a margin LARGER than the window never makes the last-safe second precede the endpoint', () => {
    // last-safe is clamped to >= endpoint, so the endpoint itself is always attemptable.
    expect(d({ nowSec: 1000n, settleWindow: 4n, safetyMarginSec: 100n })).toBe('ATTEMPT');
    expect(d({ nowSec: 1001n, settleWindow: 4n, safetyMarginSec: 100n })).toBe('MISSED');
  });

  it('does not mutate its input', () => {
    const inp = { nowSec: 1005n, endpointTime: 1000n, settleWindow: 12n, safetyMarginSec: 2n };
    const snap = { ...inp };
    decidePinnedWindow(inp);
    expect(inp).toEqual(snap);
  });
});
