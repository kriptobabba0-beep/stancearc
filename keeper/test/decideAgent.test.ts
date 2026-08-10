import { describe, it, expect } from 'vitest';
import { decideAgentEntry, type AgentPolicy } from '../src/decideAgent.js';
import { computeStanceSignal } from '../src/agentQuant.js';

// The Limen Agent's mandate engine: every clause of the human-approved policy must hold
// before the agent may enter an epoch, and every refusal carries its reason. Fails CLOSED.

const POLICY: AgentPolicy = {
  allowedViews: ['UP', 'RANGE'],
  minConfidence: 0.5,
  expiresAtSec: 2_000,
  minEntryLeftSec: 20,
  maxStakeUsdc6: 10_000_000n,
};

const BASE = {
  policy: POLICY,
  nowSec: 1_000,
  phase: 1, // EntryOpen
  entryCloseTime: 1_100n,
  alreadyActedThisEpoch: false,
  signal: { view: 'UP' as const, confidence: 0.61 },
};

describe('decideAgentEntry — the mandate engine', () => {
  it('a fully-satisfied mandate acts on the recommended side', () => {
    const v = decideAgentEntry(BASE);
    expect(v).toEqual({ act: true, view: 'UP', side: 1 });
  });

  it('maps every view to its arena side number', () => {
    const all: AgentPolicy = { ...POLICY, allowedViews: ['UP', 'DOWN', 'RANGE'] };
    expect(decideAgentEntry({ ...BASE, policy: all, signal: { view: 'DOWN', confidence: 0.9 } })).toEqual({ act: true, view: 'DOWN', side: 2 });
    expect(decideAgentEntry({ ...BASE, policy: all, signal: { view: 'RANGE', confidence: 0.9 } })).toEqual({ act: true, view: 'RANGE', side: 3 });
  });

  it('an expired mandate stands down — hard stop, whatever the signal says', () => {
    const v = decideAgentEntry({ ...BASE, nowSec: 2_000 });
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('mandate expired');
  });

  it('never acts outside the entry window', () => {
    const v = decideAgentEntry({ ...BASE, phase: 2 });
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('entry is not open');
  });

  it('refuses last-second entries (entry-window floor)', () => {
    const v = decideAgentEntry({ ...BASE, nowSec: 1_090 }); // 10s left < 20s floor
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('left in the entry window');
  });

  it('acts at most once per epoch', () => {
    const v = decideAgentEntry({ ...BASE, alreadyActedThisEpoch: true });
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('once per epoch');
  });

  it('no signal means no action — the agent never guesses', () => {
    const v = decideAgentEntry({ ...BASE, signal: null });
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('no signal');
  });

  it('a view the mandate forbids is refused even at high confidence', () => {
    const v = decideAgentEntry({ ...BASE, signal: { view: 'DOWN', confidence: 0.99 } });
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('does not allow');
  });

  it('confidence below the mandate floor is refused', () => {
    const v = decideAgentEntry({ ...BASE, signal: { view: 'UP', confidence: 0.49 } });
    expect(v.act).toBe(false);
    if (!v.act) expect(v.reason).toContain('below the');
  });
});

describe('agentQuant (keeper copy) — behavior pinned identical to the frontend core', () => {
  it('a decisive uptrend recommends UP; probabilities are a distribution', () => {
    const closes = [100];
    for (let i = 1; i < 61; i += 1) closes.push(closes[i - 1]! * 1.001);
    const s = computeStanceSignal(closes, 60, 240, 20)!;
    expect(s.view).toBe('UP');
    expect(s.pUp + s.pDown + s.pRange).toBeCloseTo(1, 6);
  });

  it('returns null instead of fabricating a signal on short input', () => {
    expect(computeStanceSignal([100, 101], 60, 240, 20)).toBeNull();
  });
});
