// feeArenaAbiDrift.test.ts — ABI-DRIFT GUARD for the FRONTEND. abis/feeArena.ts is a VERBATIM mirror
// of the compiled FeeArena ABI (generated from out/FeeArena.sol/FeeArena.json via `forge build`). The
// frontend decodes the EpochView / StakeView / ClaimPreview tuples returned by currentEpoch/getEpoch,
// getStake/getStakesByEpoch/getUserStakes, and previewClaim — a field-order/type drift in any of those
// tuples would silently corrupt every decoded value (e.g. price/contribution fields shifting), so the
// dashboard would render WRONG numbers with no error.
//
// This is the frontend port of keeper/test/abi.test.ts: it loads the compiled Foundry artifact and
// asserts the frontend's hand-mirrored entries match it STRUCTURALLY (names + types + order, recursing
// through tuples), with a failure message naming the drifted field so a future contract change fails
// CI loudly. Run `forge build` first (the frontend-ci workflow does) so the artifact is present.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { encodeAbiParameters, decodeAbiParameters, type AbiFunction, type AbiParameter } from 'viem';
import { feeArenaAbi } from '@/abis/feeArena';

// Repo root is two levels up from frontend/test/.
const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = resolve(HERE, '..', '..', 'out', 'FeeArena.sol', 'FeeArena.json');

// Functions whose OUTPUTS carry the view tuples the frontend decodes. We assert each function's full
// input + output signature (recursively through tuples) matches the artifact 1:1.
//   • EpochView    → currentEpoch / getEpoch
//   • StakeView    → getStake (tuple) / getStakesByEpoch + getUserStakes (tuple[])
//   • ClaimPreview → previewClaim
const VIEW_FUNCTIONS = [
  'currentEpoch',
  'getEpoch',
  'getStake',
  'getStakesByEpoch',
  'getUserStakes',
  'previewClaim',
] as const;

type AbiEntry = AbiFunction;

function loadArtifactAbi(): AbiEntry[] {
  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(
      `Missing ${ARTIFACT_PATH}. Run \`forge build\` at the repo root before the frontend ABI-drift test.`,
    );
  }
  const raw = readFileSync(ARTIFACT_PATH, 'utf8');
  const json = JSON.parse(raw) as { abi: AbiEntry[] };
  return json.abi;
}

/** Find the frontend's mirrored entry for a function by name. */
function frontendFn(name: string): AbiFunction {
  const e = (feeArenaAbi as readonly AbiEntry[]).find(
    (x) => x.type === 'function' && x.name === name,
  ) as AbiFunction | undefined;
  if (!e) throw new Error(`frontend abis/feeArena.ts is MISSING function "${name}" (frontend uses it)`);
  return e;
}

/** Find the artifact's entry for a function by name. */
function artifactFn(abi: AbiEntry[], name: string): AbiFunction {
  const e = abi.find((x) => x.type === 'function' && x.name === name) as AbiFunction | undefined;
  if (!e) throw new Error(`compiled artifact has NO function "${name}" — contract drift?`);
  return e;
}

/**
 * Structural signature of an AbiParameter list: a flat list of "name:type" plus, for tuples, the
 * recursively-flattened components. Names included so a rename is caught too.
 */
function sigParams(params: readonly AbiParameter[], prefix = ''): string[] {
  const out: string[] = [];
  for (const p of params) {
    out.push(`${prefix}${p.name ?? ''}:${p.type}`);
    const comps = (p as { components?: readonly AbiParameter[] }).components;
    if (comps) out.push(...sigParams(comps, `${prefix}${p.name ?? ''}.`));
  }
  return out;
}

/** Pull the (possibly nested) tuple component list out of a function's first output. */
function firstOutputComponents(fn: AbiFunction): AbiParameter[] {
  const out0 = fn.outputs[0] as AbiParameter & { components?: AbiParameter[] };
  if (!out0?.components) throw new Error(`${fn.name}: first output is not a tuple`);
  return out0.components;
}

describe('ABI-drift guard: frontend abis/feeArena.ts mirrors the compiled FeeArena artifact', () => {
  it('the compiled artifact exists (run `forge build` first)', () => {
    expect(
      existsSync(ARTIFACT_PATH),
      `Missing ${ARTIFACT_PATH}. Run \`forge build\` at the repo root before the frontend ABI-drift test.`,
    ).toBe(true);
  });

  const abi = loadArtifactAbi();

  for (const name of VIEW_FUNCTIONS) {
    it(`function ${name}() signature matches the artifact (inputs + outputs, recursive)`, () => {
      const f = frontendFn(name);
      const a = artifactFn(abi, name);

      // stateMutability must match (e.g. a view flipping nonpayable).
      expect(f.stateMutability, `${name}: stateMutability drift`).toBe(a.stateMutability);

      // Inputs: names + types + order (recursively through any tuples).
      expect(sigParams(f.inputs), `${name}: INPUT drift (frontend vs artifact)`).toEqual(
        sigParams(a.inputs),
      );

      // Outputs: names + types + order. This is where the EpochView / StakeView / ClaimPreview
      // tuple drift surfaces — the tuple component list is flattened and compared 1:1.
      expect(sigParams(f.outputs), `${name}: OUTPUT drift (frontend vs artifact)`).toEqual(
        sigParams(a.outputs),
      );
    });
  }

  it.each([
    ['EpochView', 'currentEpoch'],
    ['StakeView', 'getStake'],
    ['ClaimPreview', 'previewClaim'],
  ])('%s tuple components match the artifact exactly (names + types + order)', (_label, fnName) => {
    const fComps = firstOutputComponents(frontendFn(fnName)).map((c) => `${c.name}:${c.type}`);
    const aComps = firstOutputComponents(artifactFn(abi, fnName)).map((c) => `${c.name}:${c.type}`);

    // Per-field diff so a failure names the exact drifted tuple field.
    const max = Math.max(fComps.length, aComps.length);
    for (let i = 0; i < max; i++) {
      expect(
        fComps[i],
        `${_label} component #${i} drift: frontend="${fComps[i] ?? '<missing>'}" artifact="${aComps[i] ?? '<missing>'}"`,
      ).toBe(aComps[i]);
    }
    expect(fComps.length, `${_label} component COUNT drift`).toBe(aComps.length);
  });
});

describe('decode round-trip: frontend ABI decodes an EpochView tuple correctly', () => {
  it('encode (artifact tuple) -> decode (frontend tuple) yields the expected shape', () => {
    const abi = loadArtifactAbi();
    // Use the ARTIFACT's tuple param to ENCODE a representative EpochView, then DECODE it with the
    // FRONTEND's tuple param. If the frontend's component order/types drifted, the decoded values
    // would be wrong (or decoding would throw) — this catches both.
    const artifactTuple = artifactFn(abi, 'currentEpoch').outputs as readonly AbiParameter[];
    const frontendTuple = frontendFn('currentEpoch').outputs as readonly AbiParameter[];

    const sample = {
      epochId: 7n,
      phase: 2, // Running
      entryOpenTime: 1000n,
      entryCloseTime: 2000n,
      startTime: 2100n,
      endTime: 3000n,
      startTimeActual: 2101n,
      settleTimeActual: 3001n,
      bandBps: -150,
      startPrice18: 3_000_000000000000000000n,
      settlePrice18: 3_100_000000000000000000n,
      deltaBps: 333n,
      winningSide: 1,
      rolledOver: true,
      stakedCount: 42,
      sweepCursor: 17,
      potWETH: 5n,
      potUSDC: 6n,
      sideContribution6: [1n, 2n, 3n, 4n] as readonly [bigint, bigint, bigint, bigint],
      winnerDenominator: 99n,
      rolloverPendingIn: false,
      rolloverInWETH: 8n,
      rolloverInUSDC: 9n,
    };

    const encoded = encodeAbiParameters(artifactTuple, [sample]);
    const [decoded] = decodeAbiParameters(frontendTuple, encoded) as unknown as [typeof sample];

    expect(decoded.epochId).toBe(7n);
    expect(decoded.phase).toBe(2);
    expect(decoded.bandBps).toBe(-150); // signed int32 round-trips
    expect(decoded.deltaBps).toBe(333n); // signed int256
    expect(decoded.settlePrice18).toBe(3_100_000000000000000000n);
    expect(decoded.winningSide).toBe(1);
    expect(decoded.sideContribution6).toEqual([1n, 2n, 3n, 4n]); // fixed array
    expect(decoded.rolloverInUSDC).toBe(9n); // last field — order is intact end-to-end
    // Full structural equality: every field decodes to the encoded value.
    expect(decoded).toEqual(sample);
  });
});
