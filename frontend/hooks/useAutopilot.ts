'use client';

// hooks/useAutopilot.ts — the assisted autopilot loop for the Agent page.
//
// While enabled (and only while the page is open), it watches the active market's epoch:
// reads the live epoch from the arena, computes the SAME stance signal the copilot's odds
// tool uses — entirely client-side (pure quant over public Pyth benchmark bars), so a full
// day of watching costs zero model spend — and when the odds clear the confidence floor it
// proposes ONE entry per epoch through the normal confirmation card. The user signs, or
// ignores it. Decision logic is the pure decideAutopilot (unit-tested).
import { useEffect, useRef, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { computeStanceSignal, renderRationale } from '@/lib/agent/quant';
import { fetchMarketCloses } from '@/lib/agent/history';
import { bestAllowedView, decideAutopilot, type StanceView } from '@/lib/agent/autopilot';
import type { ActionProposal } from '@/lib/agent/copilot';
import type { Market } from '@/lib/markets';
import { ARC_CHAIN_ID } from '@/lib/chain';

const POLL_MS = 15_000;

/** What the autopilot is doing RIGHT NOW — the console renders this directly. */
export interface AutopilotStatus {
  state: 'off' | 'watching' | 'evaluating' | 'entering' | 'claiming' | 'waiting' | 'retrying';
  /** One human sentence for the state line. */
  detail: string;
  epochId: string | null;
  phaseName: string | null;
  entryLeftSec: number | null;
  settleInSec: number | null;
  /** Total seconds of the CURRENT phase (entry window or lock) — for the progress ring. */
  phaseTotalSec: number | null;
  /** The signal's live confidence for its best view, 0..1 (null while unknown). */
  confidence: number | null;
  lastCheckedAt: number | null;
}

const OFF_STATUS: AutopilotStatus = {
  state: 'off',
  detail: 'Not watching. Turn the agent on to monitor epochs under your mandate.',
  epochId: null,
  phaseName: null,
  entryLeftSec: null,
  settleInSec: null,
  phaseTotalSec: null,
  confidence: null,
  lastCheckedAt: null,
};

const PHASE_NAMES: Record<number, string> = { 0: 'starting', 1: 'entry open', 2: 'locked', 3: 'settling', 4: 'settled' };

export function useAutopilot({
  enabled,
  market,
  address,
  minConfidence,
  allowedViews,
  onPropose,
  onClaimable,
  executeEntry,
  onSettledOutcome,
  onDiagnostic,
}: {
  enabled: boolean;
  market: Market;
  address?: `0x${string}`;
  minConfidence: number;
  allowedViews: StanceView[];
  onPropose: (action: ActionProposal, confidence: number) => void;
  /** Fired ONCE per newly-detected settled win that is still unclaimed. */
  onClaimable?: (tokenIds: string[]) => void;
  /** Fired ONCE per entered epoch when it settles — the win/lose verdict for the feed. */
  onSettledOutcome?: (outcome: { epochId: string; side: 'UP' | 'DOWN' | 'RANGE'; won: boolean }) => void;
  /**
   * Zero-prompt executor (the session signer). When set, a green-lit decision goes here
   * instead of onPropose, and the epoch is only marked handled when the entry SUCCEEDS
   * (or fails permanently) — a transient RPC hiccup retries on the next tick instead of
   * burning the epoch. Return true when done with this epoch, false to retry.
   */
  executeEntry?: (side: StanceView, odds: { up: number; down: number; range: number }) => Promise<boolean>;
  /**
   * Diagnostic channel: fired at most once per epoch when a tick DIES during the entry
   * window (signal fetch / chain read threw). Without it a repeating failure is invisible —
   * the loop shows "retrying" for 15s slices and the feed stays silent while every window
   * quietly passes by.
   */
  onDiagnostic?: (message: string) => void;
}): AutopilotStatus {
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const [status, setStatus] = useState<AutopilotStatus>(OFF_STATUS);
  // Once-per-epoch discipline, per market (survives re-renders; resets on reload — fine,
  // proposing again after a reload is harmless because the user still confirms).
  const handled = useRef<Record<string, string>>({});
  // Wins already surfaced as claimable — each is announced once per page session.
  const claimSeen = useRef<Set<string>>(new Set());
  // Settled outcomes already announced (tokenId-epochId). Primed silently on the first
  // pass so a page reload doesn't replay history as fresh news.
  const outcomeSeen = useRef<Set<string>>(new Set());
  const outcomesPrimed = useRef(false);
  // The watched address FLIPS between the connected wallet and the session signer as
  // sessions start/stop. All per-address memory must reset on that flip, or the previous
  // address's history replays as fresh announcements (primed=true + unseen keys).
  const watchedAddr = useRef<string | undefined>(undefined);
  // One diagnostic per epoch — enough to name the blocker without flooding the feed.
  const diagSeenEpoch = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled || !publicClient) {
      setStatus(OFF_STATUS);
      return;
    }

    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      if (watchedAddr.current !== address) {
        watchedAddr.current = address;
        outcomeSeen.current.clear();
        claimSeen.current.clear();
        outcomesPrimed.current = false;
        // A fresh session should act on the CURRENT epoch even if watch-only already
        // proposed it — enterEpoch's own already-entered guard prevents double entry.
        delete handled.current[market.id];
      }
      try {
        const e = (await publicClient.readContract({
          address: market.feeArena,
          abi: feeArenaV3Abi,
          functionName: 'currentEpoch',
        })) as { epochId: bigint; phase: number | bigint; entryOpenTime: bigint; entryCloseTime: bigint; settlementTime: bigint; bandBps: number | bigint };
        const nowSec = Math.floor(Date.now() / 1000);
        const epochId = e.epochId.toString();
        const horizonSec = Number(e.settlementTime) - nowSec;

        let signal = null;
        if (Number(e.phase) === 1 && horizonSec > 0 && Number(e.bandBps) > 0) {
          const { closes, barSec } = await fetchMarketCloses(market.feedId, market.quoteFeedId);
          signal = computeStanceSignal(closes, barSec, horizonSec, Number(e.bandBps));
        }

        const phase = Number(e.phase);
        // FRESH clock: the signal fetch above can take seconds (and a throttled background
        // tab can stretch any await) — deciding with the tick-start clock would overstate
        // the remaining window and green-light entries that cannot finish in time.
        const entryLeftSec = Number(e.entryCloseTime) - Math.floor(Date.now() / 1000);
        const base = {
          epochId,
          phaseName: PHASE_NAMES[phase] ?? String(phase),
          entryLeftSec: phase === 1 ? Math.max(0, entryLeftSec) : null,
          settleInSec: horizonSec > 0 ? horizonSec : null,
          phaseTotalSec:
            phase === 1
              ? Math.max(1, Number(e.entryCloseTime) - Number(e.entryOpenTime))
              : phase === 2
                ? Math.max(1, Number(e.settlementTime) - Number(e.entryCloseTime))
                : null,
          // What actually gates entry: the strongest view the MANDATE allows (the global
          // favorite may be a view the user deliberately turned off).
          confidence: signal === null ? null : bestAllowedView(signal, allowedViews).p,
          lastCheckedAt: Date.now(),
        };

        const decision = decideAutopilot({
          phase,
          epochId,
          entryLeftSec,
          lastHandledEpochId: handled.current[market.id] ?? null,
          signal: signal === null ? null : { pUp: signal.pUp, pDown: signal.pDown, pRange: signal.pRange },
          minConfidence,
          allowedViews,
          // Executor floor: no human confirmation needed. With the LP pre-built at session
          // start, an entry is stake-only (refresh + previewClaim + pyth + stake ≈ 3-6s), so
          // 15s matches enterEpoch's own start-guard. This matters at tight bands: measured
          // on live data at 5bp, confident odds first cross the floor around T-25s on
          // average — a 25s floor discarded almost every legitimate crossing, which (with
          // the old lazy 60s LP setup) idled a funded session for two hours.
          minEntryLeftSec: executeEntry !== undefined ? 15 : undefined,
        });
        if (decision.act === 'propose' && signal !== null) {
          if (executeEntry !== undefined) {
            setStatus({ ...base, state: 'entering', detail: `Odds cleared your floor — entering ${decision.side} now (epoch ${epochId}).` });
            const done = await executeEntry(decision.side, {
              // one decimal so a real-but-small 0.4% never reads as a broken "0%"
              up: Math.round(signal.pUp * 1000) / 10,
              down: Math.round(signal.pDown * 1000) / 10,
              range: Math.round(signal.pRange * 1000) / 10,
            });
            if (done) handled.current[market.id] = epochId;
            setStatus({
              ...base,
              state: done ? 'watching' : 'retrying',
              detail: done
                ? `Entered epoch ${epochId} — waiting for the next one.`
                : 'Entry did not go through — retrying on the next check.',
              lastCheckedAt: Date.now(),
            });
          } else {
            handled.current[market.id] = epochId;
            onPropose(
              {
                type: 'stake',
                side: decision.side,
                marketId: market.id,
                note: `Autopilot — epoch ${epochId}: ${renderRationale(signal)}`,
              },
              decision.confidence,
            );
            setStatus({ ...base, state: 'watching', detail: `Proposed ${decision.side} for epoch ${epochId} — confirm it in the thread.` });
          }
        } else {
          if (decision.markHandled) handled.current[market.id] = epochId;
          if (handled.current[market.id] === epochId && phase === 1) {
            setStatus({ ...base, state: 'watching', detail: `Done with epoch ${epochId} — waiting for the next one.` });
          } else if (phase === 1 && signal === null) {
            setStatus({ ...base, state: 'evaluating', detail: 'Entry is open — reading market data to estimate the odds…' });
          } else if (phase === 1 && signal !== null) {
            // Reached only when the best ALLOWED view is under the floor — say so in those
            // terms. When the global favorite is a view the user turned off, name both, so
            // "why isn't it entering?" is answered without implying the mandate is a veto.
            const floor = Math.round(minConfidence * 100);
            const best = bestAllowedView(signal, allowedViews);
            const bestPct = Math.round(best.p * 100);
            setStatus({
              ...base,
              state: 'watching',
              detail: allowedViews.includes(signal.view)
                ? `Best view ${signal.view} at ${bestPct}% — below your ${floor}% floor. Re-checking every 15s.`
                : `${signal.view} leads at ${Math.round(signal.confidence * 100)}% (a view your mandate excludes) — best allowed is ${best.view} at ${bestPct}%, below your ${floor}% floor. Re-checking every 15s.`,
            });
          } else {
            setStatus({
              ...base,
              state: 'waiting',
              detail:
                phase === 2
                  ? `Epoch ${epochId} is locked — settles in ~${Math.max(0, horizonSec)}s, next entry window right after.`
                  : `Epoch ${epochId} is ${PHASE_NAMES[phase] ?? 'in transition'} — the next entry window opens shortly.`,
            });
          }
        }

        // Auto-claim watch: surface settled wins the wallet hasn't claimed, once each.
        if (address !== undefined && onClaimable !== undefined) {
          const stakes = (await publicClient.readContract({
            address: market.feeArena,
            abi: feeArenaV3Abi,
            functionName: 'getUserStakes',
            args: [address],
          })) as readonly { tokenId: bigint; epochId: bigint; side: number | bigint; processed: boolean; won: boolean; claimed: boolean }[];

          // Win/lose verdicts: every entered epoch reports its result exactly once.
          const SIDES = ['NONE', 'UP', 'DOWN', 'RANGE'] as const;
          for (const st of stakes) {
            if (!st.processed) continue;
            const k = `${st.tokenId.toString()}-${st.epochId.toString()}`;
            if (outcomeSeen.current.has(k)) continue;
            outcomeSeen.current.add(k);
            if (outcomesPrimed.current && onSettledOutcome !== undefined) {
              const sideName = SIDES[Number(st.side)];
              if (sideName === 'UP' || sideName === 'DOWN' || sideName === 'RANGE') {
                onSettledOutcome({ epochId: st.epochId.toString(), side: sideName, won: st.won });
              }
            }
          }
          outcomesPrimed.current = true;
          // getUserStakes keeps STALE won-records after a token re-stakes — previewClaim is
          // the authoritative check. Seen-keys carry the EPOCH: the same LP token wins
          // fresh epochs again and again, and each win deserves its own announcement
          // (keying by token alone silenced every win after the first).
          const candMap = new Map<string, string>(); // tokenId -> its latest won epochId
          for (const st of stakes) {
            if (st.processed && st.won && !st.claimed) candMap.set(st.tokenId.toString(), st.epochId.toString());
          }
          const fresh: string[] = [];
          for (const [id, ep] of candMap) {
            const key = `${id}-${ep}`;
            if (claimSeen.current.has(key)) continue;
            const pv = (await publicClient.readContract({
              address: market.feeArena,
              abi: feeArenaV3Abi,
              functionName: 'previewClaim',
              args: [BigInt(id)],
            })) as { claimable: boolean };
            claimSeen.current.add(key); // announced or stale — either way, once per win
            if (pv.claimable) fresh.push(id);
          }
          if (fresh.length > 0) {
            setStatus((prev) => ({ ...prev, state: 'claiming', detail: `Collecting ${fresh.length} settled fee share${fresh.length > 1 ? 's' : ''}…`, lastCheckedAt: Date.now() }));
            onClaimable(fresh);
          }
        }
      } catch (err) {
        // Transient RPC/benchmarks failure — the next tick retries; autopilot never throws at the page.
        setStatus((prev) => ({ ...prev, state: 'retrying', detail: 'Connection hiccup while reading the chain — retrying in 15s.', lastCheckedAt: Date.now() }));
        // A failure that repeats through a whole entry window would otherwise pass in
        // total silence — name it in the feed, once per epoch.
        if (onDiagnostic !== undefined) {
          try {
            const eNow = (await publicClient.readContract({
              address: market.feeArena,
              abi: feeArenaV3Abi,
              functionName: 'currentEpoch',
            })) as { epochId: bigint };
            const id = eNow.epochId.toString();
            if (diagSeenEpoch.current !== id) {
              diagSeenEpoch.current = id;
              onDiagnostic(err instanceof Error ? err.message.slice(0, 160) : 'check failed');
            }
          } catch {
            // even the diagnostic read failed — the status line already says "retrying"
          }
        }
      } finally {
        busy.current = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    // Foreground kick: after any background-throttled stretch, act the moment the user
    // returns instead of waiting out the next (possibly still-clamped) interval fire.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // allowedViews is spread into the deps as a stable string so a re-render with the same
    // mandate doesn't restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, publicClient, market.id, market.feeArena, market.feedId, market.quoteFeedId, address, minConfidence, allowedViews.join(','), onPropose, onClaimable, executeEntry, onSettledOutcome, onDiagnostic]);

  return status;
}
