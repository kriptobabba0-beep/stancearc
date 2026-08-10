import { describe, it, expect } from 'vitest';
import { decideAutopilot, bestAllowedView, type AutopilotInput } from '@/lib/agent/autopilot';

// The assisted autopilot's decision core: one evaluation cycle per epoch, entry-open only,
// confidence floor with re-evaluation (odds sharpen as settlement nears), and a time floor
// so a proposal never lands with no time left to confirm it. The mandate's allowed views
// are the CANDIDATE SET the decision chooses from — a filter, never a veto keyed to the
// global favorite (field case: RANGE at 80% + a mandate of UP/DOWN froze the autopilot on
// "waiting for it to flip", making a deliberate underdog strategy impossible).

const base: AutopilotInput = {
  phase: 1,
  epochId: '2900',
  entryLeftSec: 90,
  lastHandledEpochId: null,
  signal: { pUp: 0.14, pDown: 0.14, pRange: 0.72 },
  minConfidence: 0.55,
};

describe('decideAutopilot', () => {
  it('proposes the strongest view when entry is open and confidence clears the floor', () => {
    expect(decideAutopilot(base)).toEqual({ act: 'propose', side: 'RANGE', confidence: 0.72, markHandled: true });
  });

  it('never acts outside the entry window and does not burn the epoch', () => {
    const d = decideAutopilot({ ...base, phase: 2 });
    expect(d).toMatchObject({ act: 'skip', markHandled: false });
  });

  it('acts at most once per epoch', () => {
    const d = decideAutopilot({ ...base, lastHandledEpochId: '2900' });
    expect(d).toMatchObject({ act: 'skip', markHandled: false });
  });

  it('closes out the epoch when too little entry time remains to confirm', () => {
    const d = decideAutopilot({ ...base, entryLeftSec: 12 });
    expect(d).toMatchObject({ act: 'skip', markHandled: true });
  });

  it('keeps re-evaluating below the confidence floor instead of burning the epoch', () => {
    const d = decideAutopilot({ ...base, signal: { pUp: 0.41, pDown: 0.31, pRange: 0.28 } });
    expect(d).toMatchObject({ act: 'skip', markHandled: false });
    expect((d as { reason: string }).reason).toContain('41%');
  });

  it('waits patiently when there is no signal yet', () => {
    expect(decideAutopilot({ ...base, signal: null })).toMatchObject({ act: 'skip', markHandled: false });
  });
});

describe('decideAutopilot — mandate allowed views are a FILTER, not a veto', () => {
  it('enters the best ALLOWED view even while an excluded view leads globally (the underdog mandate)', () => {
    // The exact field case: RANGE 80%, mandate UP/DOWN only, floor 10% — the user is
    // deliberately betting the low-odds sides. The decision must pick the better of
    // UP/DOWN and compare THAT against the floor.
    const d = decideAutopilot({
      ...base,
      signal: { pUp: 0.12, pDown: 0.08, pRange: 0.8 },
      allowedViews: ['UP', 'DOWN'],
      minConfidence: 0.1,
    });
    expect(d).toEqual({ act: 'propose', side: 'UP', confidence: 0.12, markHandled: true });
  });

  it('still respects the floor within the allowed set (keeps watching, never burns the epoch)', () => {
    const d = decideAutopilot({
      ...base,
      signal: { pUp: 0.12, pDown: 0.08, pRange: 0.8 },
      allowedViews: ['UP', 'DOWN'],
      minConfidence: 0.55,
    });
    expect(d).toMatchObject({ act: 'skip', markHandled: false });
    expect((d as { reason: string }).reason).toContain('best allowed view UP at 12%');
  });

  it('proposes normally when the global favorite is inside the mandate', () => {
    expect(decideAutopilot({ ...base, allowedViews: ['RANGE'] })).toMatchObject({ act: 'propose', side: 'RANGE' });
  });
});

describe('bestAllowedView', () => {
  it('picks the strongest among the allowed set only', () => {
    expect(bestAllowedView({ pUp: 0.12, pDown: 0.08, pRange: 0.8 }, ['UP', 'DOWN'])).toEqual({ view: 'UP', p: 0.12 });
  });

  it('defaults to all three views when the mandate is absent', () => {
    expect(bestAllowedView({ pUp: 0.12, pDown: 0.08, pRange: 0.8 })).toEqual({ view: 'RANGE', p: 0.8 });
  });
});
