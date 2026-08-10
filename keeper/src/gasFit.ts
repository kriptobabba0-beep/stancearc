// gasFit.ts — fit a position-iterating crank under the RPC's hard per-tx gas cap.
//
// WHY THIS EXISTS: every Arc public RPC caps BOTH eth_estimateGas AND the per-tx gas limit at
// exactly 16,777,216 (2^24). A single high-volume LP position can cost ~16.6M gas to process
// (heavy fee collection), so the keeper's default `processPositions(epoch, 50)` — which tries to
// process the whole backlog in one tx — estimates well above the cap. estimateGas then refuses
// ("gas required exceeds 16777216"), the keeper can't build the tx, and it backs off and retries
// the identical doomed call forever (the epoch-1658 wedge).
//
// THE FIX: probe the gas cost and SHRINK the batch (halving) until it fits under the cap, then
// submit with an EXPLICIT gas-limit (<= cap) so viem skips its own estimateGas+buffer (which would
// otherwise re-hit the cap for a batch whose true cost sits just under it). Self-tuning: large
// batches when positions are cheap, down to one-at-a-time when a single position approaches the cap.

/**
 * True when a thrown error is the node refusing a call/tx because its gas requirement exceeds the
 * per-tx / estimate cap — the signal to SHRINK the batch. Distinct from a contract revert (which
 * carries a reason string and must bubble up) and from a transport blip. Matches the phrasings Arc
 * RPCs use: "gas required exceeds 16777216", "gas limit too high" (code -32003), "intrinsic gas too
 * high", "exceeds block gas limit". Walks the viem error/cause chain via a full stringify.
 */
export function isGasCapError(err: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur != null; depth += 1) {
    if (typeof cur === 'string') {
      parts.push(cur);
    } else if (typeof cur === 'object') {
      const o = cur as Record<string, unknown>;
      for (const k of ['shortMessage', 'message', 'details', 'reason']) {
        if (typeof o[k] === 'string') parts.push(o[k] as string);
      }
      const code = o.code;
      if (typeof code === 'number') parts.push(`code:${code}`);
    }
    cur = (cur as { cause?: unknown })?.cause;
  }
  const blob = parts.join(' · ').toLowerCase();
  if (!blob) return false;
  return (
    /gas (required )?exceeds/.test(blob) ||
    /exceeds [^.]*gas (limit|allowance)/.test(blob) ||
    /gas limit too high/.test(blob) ||
    /intrinsic gas too high/.test(blob) ||
    /exceeds block gas limit/.test(blob)
  );
}

/** The chosen batch size + the explicit gas-limit to submit it with. */
export interface BatchFit {
  /** How many positions to process this tick (>= 1). */
  count: number;
  /** Explicit gas-limit for the tx, always <= cap. */
  gasLimit: bigint;
  /** True when gasLimit was clamped to the cap (the call sits right at the ceiling). */
  capped: boolean;
}

/**
 * Find the largest batch (<= `desired`) whose estimated gas fits under `cap`, halving on every
 * over-cap signal down to 1. `estimate(count)` runs the node's gas estimate for processing `count`
 * positions; it may THROW a gas-cap error (treated as "over cap, shrink") — any OTHER throw (a real
 * revert / transport error) propagates so the caller's normal failure+backoff path handles it.
 *
 * Submits with a headroom buffer above the estimate (default +12.5%) but never above `cap`. When
 * even a single position won't estimate under the cap, returns `{ count: 1, gasLimit: cap }` as a
 * last resort — the only shot at making progress (and the caller logs it loudly).
 */
export async function fitBatchUnderCap(opts: {
  desired: number;
  cap: bigint;
  estimate: (count: number) => Promise<bigint>;
  bufferBps?: number;
}): Promise<BatchFit> {
  const { desired, cap, estimate } = opts;
  const bufferBps = BigInt(opts.bufferBps ?? 1250);
  let n = Math.max(1, Math.floor(desired));

  for (;;) {
    let est: bigint | null;
    try {
      est = await estimate(n);
    } catch (err) {
      if (!isGasCapError(err)) throw err; // real revert / transport error — let the caller handle it
      est = null; // node refused: this batch needs more than the cap → shrink
    }

    if (est !== null && est <= cap) {
      const buffered = est + (est * bufferBps) / 10_000n;
      const gasLimit = buffered > cap ? cap : buffered;
      return { count: n, gasLimit, capped: gasLimit === cap };
    }

    if (n <= 1) {
      // A single position won't even estimate under the cap. It still might MINE under the cap
      // (estimateGas over-counts, and our manual probes proved a ~16.6M position fits at exactly
      // the cap), so take the one shot: submit 1 position at the cap.
      return { count: 1, gasLimit: cap, capped: true };
    }
    n = Math.max(1, Math.floor(n / 2));
  }
}
