import { describe, it, expect } from 'vitest';
import { evaluateWatchdog, type ArbTickLog } from '../src/arb.js';

// LOW fix coverage — the shrink-watchdog now judges the POST-SWAP divergence (the pool
// re-read AFTER the receipt vs the SAME ref used to size the trade) instead of the
// pre-trade divBps. This kills the false-positive where the live Pyth ref moving between
// ticks looked like a "non-shrinking" divergence and tripped a spurious WEDGE alert.

const rec = (over: Partial<ArbTickLog>): ArbTickLog => ({
  ts: '2026-06-07T00:00:00.000Z',
  market: 'cirbtc',
  kind: 'SWAP',
  reason: 'test',
  ...over,
});

describe('evaluateWatchdog', () => {
  it('FAILS when the tick carries an error (regardless of divergence)', () => {
    const v = evaluateWatchdog(rec({ error: 'swap reverted: SELL_BASE', postSwapDivBps: 10 }), 50);
    expect(v.fail).toBe(true);
    expect(v.reason).toBe('error');
    // An errored tick does NOT advance the baseline (no clean measurement).
    expect(v.nextBaseline).toBe(50);
  });

  it('SEEDS the baseline on the first attributable swap (cannot non-shrink with no prior)', () => {
    const v = evaluateWatchdog(rec({ postSwapDivBps: 120 }), null);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('shrinking');
    expect(v.nextBaseline).toBe(120);
  });

  it('passes when the post-swap divergence SHRANK vs the prior baseline', () => {
    const v = evaluateWatchdog(rec({ postSwapDivBps: 30 }), 100);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('shrinking');
    expect(v.nextBaseline).toBe(30);
  });

  it('FAILS when the post-swap divergence did NOT shrink (>= prior baseline)', () => {
    const v = evaluateWatchdog(rec({ postSwapDivBps: 110 }), 100);
    expect(v.fail).toBe(true);
    expect(v.reason).toBe('non-shrinking');
    expect(v.nextBaseline).toBe(110);
  });

  it('uses the ABSOLUTE post-swap divergence (a negative residual still counts)', () => {
    // Pool overshot to the other side of the ref: postSwapDivBps = -120, |.|=120 >= 100 -> fail.
    const v = evaluateWatchdog(rec({ postSwapDivBps: -120 }), 100);
    expect(v.fail).toBe(true);
    expect(v.reason).toBe('non-shrinking');
    expect(v.nextBaseline).toBe(120);
  });

  it('does NOT fire on a NONE tick and LEAVES the baseline unchanged (no false WEDGE)', () => {
    // The CORE false-positive case: a NONE tick (or any non-swap) must not be measured.
    const v = evaluateWatchdog(rec({ kind: 'NONE', divBps: 800 }), 100);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('unattributable');
    expect(v.nextBaseline).toBe(100); // baseline preserved swap-to-swap
  });

  it('does NOT fire on a SWAP whose POST-READ failed (postSwapDivBps undefined)', () => {
    // The post-receipt pool re-read failed, so we cannot attribute the divergence -> skip
    // the watchdog rather than guess (it would otherwise re-use a stale pre-trade value).
    const v = evaluateWatchdog(rec({ kind: 'SWAP', divBps: 300, postSwapDivBps: undefined }), 100);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('unattributable');
    expect(v.nextBaseline).toBe(100);
  });

  it('does NOT false-positive when the pre-trade divBps grew but the POST-swap shrank', () => {
    // Scenario the OLD watchdog botched: between ticks the Pyth ref moved so the PRE-trade
    // divBps is large (e.g. 900), yet our swap actually pulled the pool close to the ref
    // (postSwapDivBps 10). The new watchdog reads the post value -> shrink -> NO fail.
    const v = evaluateWatchdog(rec({ divBps: 900, postSwapDivBps: 10 }), 100);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('shrinking');
    expect(v.nextBaseline).toBe(10);
  });

  it('ignores SKIP/ALERT ticks entirely', () => {
    expect(evaluateWatchdog(rec({ kind: 'SKIP', postSwapDivBps: 999 }), 100).fail).toBe(false);
    expect(evaluateWatchdog(rec({ kind: 'ALERT', postSwapDivBps: 999 }), 100).fail).toBe(false);
    // postSwapDivBps is only ever set for a SWAP in practice; even if present it's ignored.
    expect(evaluateWatchdog(rec({ kind: 'SKIP', postSwapDivBps: 999 }), 100).nextBaseline).toBe(100);
  });

  // TASK 3 — the shrink-watchdog judges ONLY the price-convergence arb. A rebalance or
  // heartbeat swap isn't trying to close a price gap, so it must NOT be measured for shrink
  // (a heartbeat at ~0 divergence might even nudge it up — that's expected, not a wedge).
  it('treats an explicit purpose==="arb" SWAP as attributable (back-compat with undefined)', () => {
    const v = evaluateWatchdog(rec({ purpose: 'arb', postSwapDivBps: 110 }), 100);
    expect(v.fail).toBe(true);
    expect(v.reason).toBe('non-shrinking');
  });

  it('does NOT measure a REBALANCE swap (unattributable, baseline preserved)', () => {
    const v = evaluateWatchdog(rec({ purpose: 'rebalance', postSwapDivBps: 999 }), 100);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('unattributable');
    expect(v.nextBaseline).toBe(100);
  });

  it('does NOT measure a HEARTBEAT swap (unattributable, baseline preserved)', () => {
    const v = evaluateWatchdog(rec({ purpose: 'heartbeat', postSwapDivBps: 999 }), 100);
    expect(v.fail).toBe(false);
    expect(v.reason).toBe('unattributable');
    expect(v.nextBaseline).toBe(100);
  });

  it('STILL fails a reverted rebalance/heartbeat swap (the error path is purpose-agnostic)', () => {
    const reb = evaluateWatchdog(rec({ purpose: 'rebalance', error: 'swap reverted: rebalance BUY_BASE' }), 100);
    expect(reb.fail).toBe(true);
    expect(reb.reason).toBe('error');
    const hb = evaluateWatchdog(rec({ purpose: 'heartbeat', error: 'swap reverted: heartbeat SELL_BASE' }), 100);
    expect(hb.fail).toBe(true);
    expect(hb.reason).toBe('error');
  });
});
