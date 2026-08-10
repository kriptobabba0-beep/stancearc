// revertDecode.ts — PURE classifier that turns a thrown viem error (from simulateContract
// OR a mined revert) into a STABLE FeeArena revert reason. WHY this exists:
//
// The keeper's own ABI only declares ONE custom error (SweepAlreadyDone), so viem can only
// cleanly decode that one to an errorName. Every OTHER FeeArena v3 custom error arrives on the
// live Arc RPC in a raw, undecoded shape — as a 4-byte selector buried in `err.data` /
// `err.signature` / the innermost `.cause` RPC object, or (worst case) only as a substring in
// `err.message`. This module recognizes the full set regardless of which shape shows up.
//
// The one reason the loop treats specially is StalePrice: it's the simulate -> mine FRESHNESS
// RACE. The keeper simulates a settle/process with a Pyth price that is fresh AT SIM TIME, but by
// the time the tx mines a block or two later the contract's staleness check can reject it. That's
// not a real failure — it just needs its OWN backoff class (retry soon with a fresher price)
// rather than the generic exponential breaker. `isStale` exposes exactly that signal.
//
// Robustness here intentionally MIRRORS isSweepAlreadyDone / rawRevertDataHasSelector in keeper.ts
// (walk the BaseError chain, then bounded recursion over `.cause` scanning structured data fields,
// then a conservative message fallback). It is conservative by construction: it only ever matches
// a KNOWN zero-arg selector or a KNOWN error name as a whole word — never a broad "reverted" match.
import { BaseError, ContractFunctionRevertedError, toFunctionSelector } from 'viem';

/**
 * Every FeeArena v3 custom error the keeper cares about. ALL are zero-argument (signature
 * `Name()`), so each maps to a single 4-byte selector via toFunctionSelector('Name()').
 *
 * - The arena lifecycle errors come from src/interfaces/IFeeArenaV3.sol.
 * - SweepAlreadyDone is declared + reverted by FeeArena.sol (the keeper already special-cases it;
 *   we include it so this classifier reports a consistent name for it too).
 * - EnforcedPause is OpenZeppelin's Pausable revert — any `whenNotPaused` arena fn can throw it.
 */
const KNOWN_ERROR_NAMES = [
  'WrongPhase',
  'ZeroPrice',
  'StalePrice',
  'SettlePriceTooOld',
  'SettlePriceOutOfBounds',
  'SettleTooEarly',
  'ProcessNotComplete',
  'NotSettled',
  'GraceNotElapsed',
  'SweepAlreadyDone',
  'EnforcedPause',
] as const;

type KnownErrorName = (typeof KNOWN_ERROR_NAMES)[number];

/** Fast membership test for a decoded errorName / message word. */
const KNOWN_NAME_SET: ReadonlySet<string> = new Set<string>(KNOWN_ERROR_NAMES);

/**
 * lowercase 4-byte selector ('0x________') -> error name, computed once at module load.
 * Built from toFunctionSelector so the mapping can never drift from the on-chain encoding.
 */
const SELECTOR_TO_NAME: ReadonlyMap<string, KnownErrorName> = new Map(
  KNOWN_ERROR_NAMES.map((name) => [toFunctionSelector(`${name}()`).toLowerCase(), name] as const),
);

/** Classification result for a thrown revert. */
export interface RevertInfo {
  /** Best-effort error name, e.g. 'StalePrice'; 'unknown' when nothing matched. */
  name: string;
  /** The matched 4-byte selector (lowercase 0x…) if recognized, else undefined. */
  selector?: string;
  /** True iff name === 'StalePrice' — the freshness-race revert the loop backs off specifically. */
  isStale: boolean;
}

/** Assemble the result for a matched name (looks the selector back up so it's always consistent). */
function infoForName(name: KnownErrorName): RevertInfo {
  // SELECTOR_TO_NAME is name->? keyed by selector; invert by scanning once (11 entries, trivial).
  for (const [selector, mapped] of SELECTOR_TO_NAME) {
    if (mapped === name) return { name, selector, isStale: name === 'StalePrice' };
  }
  // Unreachable for a KnownErrorName, but keep the shape total.
  return { name, isStale: name === 'StalePrice' };
}

/**
 * Scan an error and its entire `.cause` chain (including plain non-Error RPC objects that
 * BaseError.walk can't descend into) for a structured hex field — `.data` / `.signature` / `.raw` —
 * whose value startsWith a KNOWN selector. Returns the matched name, or undefined. Bounded depth so
 * a cyclic cause chain can't loop forever. Mirrors rawRevertDataHasSelector in keeper.ts. PURE.
 */
function scanCauseChainForSelector(err: unknown, depth = 0): KnownErrorName | undefined {
  if (err == null || typeof err !== 'object' || depth > 12) return undefined;
  const o = err as Record<string, unknown>;
  for (const key of ['data', 'signature', 'raw'] as const) {
    const v = o[key];
    if (typeof v === 'string') {
      const lower = v.toLowerCase();
      for (const [selector, name] of SELECTOR_TO_NAME) {
        if (lower.startsWith(selector)) return name;
      }
    }
  }
  // descend the cause chain (viem nests RpcRequestError.cause = raw {code,message,data} object)
  return scanCauseChainForSelector(o.cause, depth + 1);
}

/**
 * Last-resort message fallback: does the text contain a KNOWN error name as a WHOLE WORD? Conservative
 * on purpose — a bare `\bSettleTooEarly\b` can only match an exact known name, never a broad
 * "reverted". Returns the first known name found (in declared order), or undefined.
 */
function scanMessageForName(message: string): KnownErrorName | undefined {
  for (const name of KNOWN_ERROR_NAMES) {
    // Word-boundary match so 'NotSettled' in a longer identifier doesn't false-positive, and so the
    // bare name in "execution reverted: StalePrice()" matches cleanly.
    if (new RegExp(`\\b${name}\\b`).test(message)) return name;
  }
  return undefined;
}

/**
 * Classify a thrown error (simulate OR mined revert) into a RevertInfo. PURE — no IO.
 *
 * Detection priority (any one suffices), mirroring isSweepAlreadyDone's robustness:
 *   1. a ContractFunctionRevertedError in the BaseError .walk() chain whose data.errorName is known;
 *   2. a raw known selector in `.data` / `.signature` / `.raw` anywhere in the `.cause` chain;
 *   3. a known error name as a whole word in `err.message`.
 * Returns { name: 'unknown', isStale: false } when nothing matches.
 */
export function classifyRevert(err: unknown): RevertInfo {
  // (1) viem DECODED it — walk the cause chain for a ContractFunctionRevertedError with a known name.
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const errorName = reverted.data?.errorName;
      if (typeof errorName === 'string' && KNOWN_NAME_SET.has(errorName)) {
        return infoForName(errorName as KnownErrorName);
      }
    }
  }

  // (2) raw known selector in STRUCTURED revert data anywhere in the cause chain.
  const bySelector = scanCauseChainForSelector(err);
  if (bySelector) return infoForName(bySelector);

  // (3) LAST-RESORT message fallback: a known error name as a whole word.
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message) {
    const byMessage = scanMessageForName(message);
    if (byMessage) return infoForName(byMessage);
  }

  return { name: 'unknown', isStale: false };
}
