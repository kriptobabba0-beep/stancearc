// lib/epochProof.ts - PURE reconstruction of a settled epoch from on-chain FeeArena events, so a
// user can VERIFY the settlement was honest end-to-end (oracle move → winning side → pot split).
//
// The settlement rule is a fact, not a prediction: a signed Δbps (settle vs start price) that lands
// strictly BEYOND ±band wins UP (Δ>0) or DOWN (Δ<0); a move within ±band (inclusive) is a RANGE win.
// deriveWinningSide() re-applies that rule from the published Δ + band, and buildEpochProof compares
// it against the event's reported winningSide (winningSideVerified) - a mismatch is a tamper signal.
//
// All money math is BigInt + FLOOR (mirrors the contract's mulDiv floor); format only at render.
// Events used (decoded args), all keyed by epochId:
//   EpochStarted(startPrice18, startTimeActual)
//   EpochResolved(settlePrice18, winningSide, deltaBps, settleTimeActual)
//   EpochSettled(winningSide, winnerDenominator, potWETH, potUSDC)
//   EmptyWinnerRollover(winningSide, potWETH, potUSDC)
//   Staked(owner, tokenId, side)            - per-position owner + chosen side
//   Swept(tokenId, feeWETH, feeUSDC, contribution6) - per-position forfeited fees + contribution
import { Side } from '@/lib/types';
import { payoutFloor } from '@/lib/money';

// viem decodes named-arg events to a Record, but the static type is a union with the unnamed-tuple
// form; accept both and read by key only when it's the object form (all FeeArena events are named).
type LogArgs = Record<string, unknown> | readonly unknown[] | undefined;
export interface ProofLog {
  args?: LogArgs;
}
const argOf = (log: ProofLog, key: string): unknown =>
  log.args && !Array.isArray(log.args) ? (log.args as Record<string, unknown>)[key] : undefined;

/**
 * Re-apply the contract's settlement rule from the published Δbps + band. A move STRICTLY beyond the
 * band (|Δ| > band) is directional (UP if Δ>0, DOWN if Δ<0); within ±band (inclusive) is RANGE.
 * |band| is used so a malformed negative band still reads sanely. Pure - the heart of "provably fair".
 */
export function deriveWinningSide(deltaBps: bigint, bandBps: number): Side {
  const band = BigInt(Math.abs(bandBps));
  const abs = deltaBps < 0n ? -deltaBps : deltaBps;
  if (abs <= band) return Side.RANGE;
  return deltaBps > 0n ? Side.UP : Side.DOWN;
}

/** One reconstructed staked position in a settled epoch (owner, side, contribution, payout). */
export interface ProofPosition {
  tokenId: bigint;
  owner: `0x${string}`;
  side: Side;
  /** Range-normalized contribution (6dp) from the Swept event; 0 if not yet swept. */
  contribution6: bigint;
  /** Forfeited fees this position contributed to the pot (base leg + USDC leg), from Swept. */
  feeBase: bigint;
  feeUSDC: bigint;
  /** True iff this position's side equals the (settled) winning side and the epoch paid out. */
  isWinner: boolean;
  /** This position's floor share of the pot = pot × contribution6 / winnerDenominator (0 if loser). */
  payBase: bigint;
  payUSDC: bigint;
}

/** Full verifiable reconstruction of one epoch. `settled=false` for an in-progress epoch. */
export interface EpochProof {
  epochId: bigint;
  settled: boolean;
  rolledOver: boolean;
  startPrice18: bigint;
  settlePrice18?: bigint;
  deltaBps?: bigint;
  bandBps: number;
  /** The winning side AS REPORTED by the settlement event(s). */
  winningSide: Side;
  /** The winning side RECONSTRUCTED from Δ vs band (undefined when Δ is unknown). */
  derivedWinningSide?: Side;
  /** True iff derivedWinningSide === winningSide - the honesty check. undefined when Δ is unknown. */
  winningSideVerified?: boolean;
  winnerDenominator: bigint;
  potBase: bigint;
  potUSDC: bigint;
  startTimeActual?: bigint;
  settleTimeActual?: bigint;
  /** All staked positions in this epoch, winners first then by contribution desc. */
  positions: ProofPosition[];
  /** Count of winning positions (positions on the winning side that paid out). 0 on rollover. */
  winnerCount: number;
}

interface BuildArgs {
  epochId: bigint;
  bandBps: number;
  started: ProofLog[];
  resolved: ProofLog[];
  settled: ProofLog[];
  rollovers: ProofLog[];
  staked: ProofLog[];
  swept: ProofLog[];
}

/** True iff a log's epochId arg equals the target id. */
function isEpoch(log: ProofLog, epochId: bigint): boolean {
  const id = argOf(log, 'epochId');
  if (id === undefined) return false;
  try {
    return BigInt(id as bigint) === epochId;
  } catch {
    return false;
  }
}

/**
 * Reconstruct the requested epoch from its events. Returns null only when NO event references the
 * epoch at all (nothing to show). Pure + defensive - unknown fields degrade to sane defaults.
 */
export function buildEpochProof(args: BuildArgs): EpochProof | null {
  const { epochId, bandBps } = args;
  const started = args.started.filter((l) => isEpoch(l, epochId));
  const resolved = args.resolved.filter((l) => isEpoch(l, epochId));
  const settledLogs = args.settled.filter((l) => isEpoch(l, epochId));
  const rollovers = args.rollovers.filter((l) => isEpoch(l, epochId));
  const stakedLogs = args.staked.filter((l) => isEpoch(l, epochId));
  const sweptLogs = args.swept.filter((l) => isEpoch(l, epochId));

  // Nothing references this epoch → no proof.
  if (
    started.length === 0 &&
    resolved.length === 0 &&
    settledLogs.length === 0 &&
    rollovers.length === 0 &&
    stakedLogs.length === 0
  ) {
    return null;
  }

  const startLog = started[0];
  const resolvedLog = resolved[0];
  const settledLog = settledLogs[0];
  const rolloverLog = rollovers[0];

  const startPrice18 = (argOf(startLog ?? {}, 'startPrice18') as bigint) ?? 0n;
  const startTimeActual = startLog ? (argOf(startLog, 'startTimeActual') as bigint) : undefined;

  const settlePrice18 = resolvedLog ? (argOf(resolvedLog, 'settlePrice18') as bigint) : undefined;
  const deltaBps = resolvedLog ? (argOf(resolvedLog, 'deltaBps') as bigint) : undefined;
  const settleTimeActual = resolvedLog ? (argOf(resolvedLog, 'settleTimeActual') as bigint) : undefined;

  const rolledOver = rollovers.length > 0;
  const settled = settledLogs.length > 0 || rolledOver;

  // Winning side as reported: prefer EpochSettled, then rollover, then EpochResolved.
  let winningSide = Side.NONE;
  if (settledLog) winningSide = Number(argOf(settledLog, 'winningSide') ?? 0) as Side;
  else if (rolloverLog) winningSide = Number(argOf(rolloverLog, 'winningSide') ?? 0) as Side;
  else if (resolvedLog) winningSide = Number(argOf(resolvedLog, 'winningSide') ?? 0) as Side;

  // Reconstructed winner from Δ vs band - the honesty check.
  const derivedWinningSide = deltaBps !== undefined ? deriveWinningSide(deltaBps, bandBps) : undefined;
  const winningSideVerified =
    derivedWinningSide !== undefined && winningSide !== Side.NONE
      ? derivedWinningSide === winningSide
      : undefined;

  // Pot + winnerDenominator: from EpochSettled, falling back to the rollover (which mirrors the pot).
  const winnerDenominator = settledLog ? (argOf(settledLog, 'winnerDenominator') as bigint) ?? 0n : 0n;
  let potBase = settledLog ? (argOf(settledLog, 'potWETH') as bigint) ?? 0n : 0n;
  let potUSDC = settledLog ? (argOf(settledLog, 'potUSDC') as bigint) ?? 0n : 0n;
  if (rolloverLog) {
    if (potBase === 0n) potBase = (argOf(rolloverLog, 'potWETH') as bigint) ?? 0n;
    if (potUSDC === 0n) potUSDC = (argOf(rolloverLog, 'potUSDC') as bigint) ?? 0n;
  }

  // Join Staked (owner + side) with Swept (contribution + fees) by tokenId.
  const sweptByToken = new Map<string, ProofLog>();
  for (const l of sweptLogs) {
    const tid = argOf(l, 'tokenId');
    if (tid !== undefined) sweptByToken.set(String(tid), l);
  }

  const positions: ProofPosition[] = [];
  const seen = new Set<string>();
  const addPosition = (tokenId: bigint, owner: `0x${string}`, side: Side) => {
    const key = tokenId.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const sweep = sweptByToken.get(key);
    const contribution6 = sweep ? (argOf(sweep, 'contribution6') as bigint) ?? 0n : 0n;
    const feeBase = sweep ? (argOf(sweep, 'feeWETH') as bigint) ?? 0n : 0n;
    const feeUSDC = sweep ? (argOf(sweep, 'feeUSDC') as bigint) ?? 0n : 0n;
    // A winner only when the epoch actually paid out (not rolled over) and side matches.
    const isWinner = settled && !rolledOver && side === winningSide && winningSide !== Side.NONE;
    const { payWETH, payUSDC } = isWinner
      ? payoutFloor({ potWETH: potBase, potUSDC, contribution6, winnerDenominator })
      : { payWETH: 0n, payUSDC: 0n };
    positions.push({
      tokenId,
      owner,
      side,
      contribution6,
      feeBase,
      feeUSDC,
      isWinner,
      payBase: payWETH,
      payUSDC,
    });
  };

  for (const l of stakedLogs) {
    const tid = argOf(l, 'tokenId');
    const owner = argOf(l, 'owner') as `0x${string}` | undefined;
    const side = Number(argOf(l, 'side') ?? 0) as Side;
    if (tid === undefined || !owner) continue;
    addPosition(BigInt(tid as bigint), owner, side);
  }
  // A Swept with no matching Staked (missed log) still surfaces as a position with an unknown owner.
  for (const l of sweptLogs) {
    const tid = argOf(l, 'tokenId');
    if (tid === undefined || seen.has(String(tid))) continue;
    addPosition(BigInt(tid as bigint), '0x0000000000000000000000000000000000000000', Side.NONE);
  }

  // Sort winners-first, then by contribution descending, then by tokenId for stability.
  positions.sort((a, b) => {
    if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
    if (a.contribution6 !== b.contribution6) return b.contribution6 > a.contribution6 ? 1 : -1;
    return a.tokenId > b.tokenId ? 1 : a.tokenId < b.tokenId ? -1 : 0;
  });

  const winnerCount = positions.filter((p) => p.isWinner).length;

  return {
    epochId,
    settled,
    rolledOver,
    startPrice18,
    settlePrice18,
    deltaBps,
    bandBps,
    winningSide,
    derivedWinningSide,
    winningSideVerified,
    winnerDenominator,
    potBase,
    potUSDC,
    startTimeActual,
    settleTimeActual,
    positions,
    winnerCount,
  };
}
