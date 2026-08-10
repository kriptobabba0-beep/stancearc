import { describe, it, expect } from 'vitest';
import {
  freshReserveHistory,
  recordReserve,
  drawdownWeiPerHour,
  projectDryMs,
  evaluateReserve,
  type ReserveHistory,
  type ReserveParams,
} from '../src/reserveGovernor.js';

// Realistic wei magnitudes: the reserve holds whole-ether quantities of native gas token.
const ETH = 10n ** 18n;
const HOUR = 3_600_000; // ms

// A fixed injected clock so every test is deterministic (no Date.now anywhere).
const NOW = 1_700_000_000_000;

/** Hand-build a history from [msAgo, wei] pairs (oldest first). msAgo is relative to NOW. */
function historyOf(points: Array<[number, bigint]>): ReserveHistory {
  return { samples: points.map(([msAgo, wei]) => ({ ts: NOW - msAgo, wei: wei.toString() })) };
}

describe('recordReserve — appends and prunes (pure)', () => {
  it('appends the new sample as a decimal string', () => {
    const h0 = freshReserveHistory();
    const h1 = recordReserve(h0, NOW, 5n * ETH, HOUR);
    expect(h1.samples).toEqual([{ ts: NOW, wei: (5n * ETH).toString() }]);
    // input untouched
    expect(h0.samples).toEqual([]);
  });

  it('round-trips wei through BigInt(string) exactly (no precision loss)', () => {
    const big = 123_456_789_012_345_678_901n; // > Number.MAX_SAFE_INTEGER
    const h = recordReserve(freshReserveHistory(), NOW, big, HOUR);
    expect(BigInt(h.samples[0]!.wei)).toBe(big);
  });

  it('prunes samples older than now - retainMs, keeps in-window ones', () => {
    let h = freshReserveHistory();
    h = recordReserve(h, NOW - 3 * HOUR, 9n * ETH, 2 * HOUR); // will fall out of a 2h window
    h = recordReserve(h, NOW - 1 * HOUR, 8n * ETH, 2 * HOUR);
    h = recordReserve(h, NOW, 7n * ETH, 2 * HOUR);
    // the 3h-old sample is older than NOW-2h => pruned; the 1h-old and the fresh one survive.
    expect(h.samples.map((s) => s.ts)).toEqual([NOW - 1 * HOUR, NOW]);
  });

  it('keeps a sample exactly at the cutoff boundary (ts == now - retainMs)', () => {
    let h = freshReserveHistory();
    h = recordReserve(h, NOW - 2 * HOUR, 9n * ETH, 2 * HOUR); // exactly at cutoff -> kept
    h = recordReserve(h, NOW, 8n * ETH, 2 * HOUR);
    expect(h.samples.map((s) => s.ts)).toEqual([NOW - 2 * HOUR, NOW]);
  });

  it('does not mutate the input history', () => {
    const h0 = recordReserve(freshReserveHistory(), NOW - HOUR, 5n * ETH, 10 * HOUR);
    const snapshot = JSON.parse(JSON.stringify(h0));
    recordReserve(h0, NOW, 4n * ETH, 10 * HOUR);
    expect(h0).toEqual(snapshot);
  });
});

describe('drawdownWeiPerHour — measured slope oldest->newest (pure)', () => {
  it('null with fewer than 2 samples', () => {
    expect(drawdownWeiPerHour(freshReserveHistory(), NOW)).toBeNull();
    expect(drawdownWeiPerHour(historyOf([[0, 5n * ETH]]), NOW)).toBeNull();
  });

  it('correct positive rate for a linear decline (10 ETH drop over 1h)', () => {
    // 100 ETH -> 90 ETH across exactly one hour => 10 ETH/hour.
    const h = historyOf([
      [HOUR, 100n * ETH],
      [0, 90n * ETH],
    ]);
    expect(drawdownWeiPerHour(h, NOW)).toBe(10n * ETH);
  });

  it('halves the rate when the same drop spans two hours', () => {
    const h = historyOf([
      [2 * HOUR, 100n * ETH],
      [0, 90n * ETH],
    ]);
    expect(drawdownWeiPerHour(h, NOW)).toBe(5n * ETH);
  });

  it('measures oldest->newest across intermediate samples (endpoints only)', () => {
    // Endpoints 100 -> 70 over 2h => 15 ETH/h, regardless of the mid-point value.
    const h = historyOf([
      [2 * HOUR, 100n * ETH],
      [1 * HOUR, 50n * ETH],
      [0, 70n * ETH],
    ]);
    expect(drawdownWeiPerHour(h, NOW)).toBe(15n * ETH);
  });

  it('null when the reserve grew (not draining)', () => {
    const h = historyOf([
      [HOUR, 90n * ETH],
      [0, 100n * ETH],
    ]);
    expect(drawdownWeiPerHour(h, NOW)).toBeNull();
  });

  it('null when the reserve held flat (delta == 0)', () => {
    const h = historyOf([
      [HOUR, 90n * ETH],
      [0, 90n * ETH],
    ]);
    expect(drawdownWeiPerHour(h, NOW)).toBeNull();
  });

  it('null when two samples share a timestamp (no divide-by-zero)', () => {
    const h: ReserveHistory = {
      samples: [
        { ts: NOW, wei: (100n * ETH).toString() },
        { ts: NOW, wei: (90n * ETH).toString() },
      ],
    };
    expect(drawdownWeiPerHour(h, NOW)).toBeNull();
  });
});

describe('projectDryMs — time-to-floor at the measured rate (pure)', () => {
  it('projects the runway to the floor', () => {
    // Draining 10 ETH/h, currently 90 ETH, floor 30 ETH => 60 ETH headroom => 6 hours.
    const h = historyOf([
      [HOUR, 100n * ETH],
      [0, 90n * ETH],
    ]);
    const ms = projectDryMs(h, NOW, 90n * ETH, 30n * ETH);
    expect(ms).toBe(6 * HOUR);
  });

  it('null when not draining (no rate)', () => {
    const flat = historyOf([
      [HOUR, 90n * ETH],
      [0, 90n * ETH],
    ]);
    expect(projectDryMs(flat, NOW, 90n * ETH, 30n * ETH)).toBeNull();
  });

  it('null when already at or below the floor (no headroom)', () => {
    const h = historyOf([
      [HOUR, 100n * ETH],
      [0, 90n * ETH],
    ]);
    expect(projectDryMs(h, NOW, 30n * ETH, 30n * ETH)).toBeNull(); // exactly at floor
    expect(projectDryMs(h, NOW, 20n * ETH, 30n * ETH)).toBeNull(); // below floor
  });
});

describe('evaluateReserve — full decision (pure)', () => {
  // Draining 10 ETH/h over the last hour.
  const draining = historyOf([
    [HOUR, 100n * ETH],
    [0, 90n * ETH],
  ]);

  const baseParams = (over: Partial<ReserveParams> = {}): ReserveParams => ({
    currentWei: 90n * ETH,
    floorWei: 10n * ETH,
    throttleWei: 30n * ETH,
    warnDrawdownWeiPerHour: 50n * ETH, // higher than the 10 ETH/h measured -> no rate alert by default
    projectDryWarnMs: 2 * HOUR, // dry-soon if < 2h to floor
    ...over,
  });

  it("'none' + no throttle/stop when healthy", () => {
    // 90 ETH current, draining 10/h, floor 10 => 8h runway (> 2h warn), rate 10 < 50 warn.
    const d = evaluateReserve(draining, NOW, baseParams());
    expect(d.drawdownWeiPerHour).toBe(10n * ETH);
    expect(d.projectedDryMs).toBe(8 * HOUR);
    expect(d.alert).toBe('none');
    expect(d.throttle).toBe(false);
    expect(d.stop).toBe(false);
  });

  it("'rate' when the drawdown is fast but the floor is still hours out", () => {
    // Lower the rate-warn threshold below the measured 10 ETH/h; keep projection far out.
    const d = evaluateReserve(draining, NOW, baseParams({ warnDrawdownWeiPerHour: 5n * ETH }));
    expect(d.alert).toBe('rate');
    expect(d.throttle).toBe(false);
    expect(d.stop).toBe(false);
  });

  it("'projection' when dry-soon (overrides a rate alert)", () => {
    // Floor at 85 ETH => only 5 ETH headroom => 0.5h to floor (< 2h warn). Rate also fast,
    // but projection has higher precedence.
    const d = evaluateReserve(
      draining,
      NOW,
      baseParams({ floorWei: 85n * ETH, throttleWei: 87n * ETH, warnDrawdownWeiPerHour: 5n * ETH }),
    );
    expect(d.projectedDryMs).toBe(HOUR / 2);
    expect(d.alert).toBe('projection');
    expect(d.throttle).toBe(false); // 90 > 87 throttle
    expect(d.stop).toBe(false);
  });

  it("'floor' + stop when current <= floor (overrides everything)", () => {
    const d = evaluateReserve(
      draining,
      NOW,
      baseParams({ currentWei: 10n * ETH, floorWei: 10n * ETH }),
    );
    expect(d.alert).toBe('floor');
    expect(d.stop).toBe(true);
    expect(d.throttle).toBe(true); // at/below floor is also at/below throttle
    // at the floor there is no headroom left to project
    expect(d.projectedDryMs).toBeNull();
  });

  it('throttle flips exactly at throttleWei (boundary inclusive)', () => {
    expect(evaluateReserve(draining, NOW, baseParams({ currentWei: 31n * ETH })).throttle).toBe(false);
    expect(evaluateReserve(draining, NOW, baseParams({ currentWei: 30n * ETH })).throttle).toBe(true);
    expect(evaluateReserve(draining, NOW, baseParams({ currentWei: 29n * ETH })).throttle).toBe(true);
  });

  it('stop flips exactly at floorWei (boundary inclusive)', () => {
    expect(evaluateReserve(draining, NOW, baseParams({ currentWei: 11n * ETH })).stop).toBe(false);
    expect(evaluateReserve(draining, NOW, baseParams({ currentWei: 10n * ETH })).stop).toBe(true);
    expect(evaluateReserve(draining, NOW, baseParams({ currentWei: 9n * ETH })).stop).toBe(true);
  });

  it('null rate/projection are reported when the reserve is not draining', () => {
    const flat = historyOf([
      [HOUR, 90n * ETH],
      [0, 90n * ETH],
    ]);
    const d = evaluateReserve(flat, NOW, baseParams());
    expect(d.drawdownWeiPerHour).toBeNull();
    expect(d.projectedDryMs).toBeNull();
    expect(d.alert).toBe('none');
  });
});
