// abi.test.ts — ABI-DRIFT GUARD. keeper/src/abi.ts is a HAND-MAINTAINED mirror of the
// compiled FeeArena ABI. Nothing else asserts it stays in sync, so a field-order/type
// drift in EpochView (or a changed function signature the keeper calls) would silently
// break viem decoding and WEDGE the keeper. This test loads the compiled Foundry
// artifact (out/FeeArena.sol/FeeArena.json) and asserts the keeper's hand-written entries
// for everything the keeper actually uses match it — structurally (names+types+order),
// with a failure message naming the drifted field so a future contract change fails CI
// loudly. Run `forge build` first (CI does) so the artifact is present & current.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { encodeAbiParameters, decodeAbiParameters, type AbiFunction, type AbiParameter } from 'viem';
import { feeArenaAbi, feeArenaV2Abi } from '../src/abi.js';

// Repo root is two levels up from keeper/test/.
const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = resolve(HERE, '..', '..', 'out', 'FeeArena.sol', 'FeeArena.json');
const ARTIFACT_PATH_V2 = resolve(HERE, '..', '..', 'out', 'FeeArenaV2.sol', 'FeeArenaV2.json');

// The functions the keeper actually calls (reads + writes), per keeper.ts / readState().
// NOTE: `keeper()` and `getEpoch()` are deliberately NOT here — the keeper code calls
// neither (it reads currentEpoch/currentEpochId, never getEpoch, and never the keeper()
// getter), so abi.ts does not mirror them. We only assert the surface the keeper truly
// depends on; asserting unused entries would be misleading.
const USED_FUNCTIONS = [
  'currentEpochId',
  'currentEpoch',
  'createEpoch',
  'openEntry',
  'startEpoch',
  'endEpoch',
  'sweep',
  'finalizeSettle',
  'maxStartDelay',
  'paused',
] as const;

type AbiEntry = AbiFunction;

function loadArtifactAbi(): AbiEntry[] {
  if (!existsSync(ARTIFACT_PATH)) {
    throw new Error(
      `Missing ${ARTIFACT_PATH}. Run \`forge build\` at the repo root before the keeper tests.`,
    );
  }
  const raw = readFileSync(ARTIFACT_PATH, 'utf8');
  const json = JSON.parse(raw) as { abi: AbiEntry[] };
  return json.abi;
}

/** Find the keeper's hand-written entry for a function by name. */
function keeperFn(name: string): AbiFunction {
  const e = (feeArenaAbi as readonly AbiEntry[]).find(
    (x) => x.type === 'function' && x.name === name,
  ) as AbiFunction | undefined;
  if (!e) throw new Error(`keeper abi.ts is MISSING function "${name}" (keeper uses it)`);
  return e;
}

/** Find the artifact's entry for a function by name. */
function artifactFn(abi: AbiEntry[], name: string): AbiFunction {
  const e = abi.find((x) => x.type === 'function' && x.name === name) as AbiFunction | undefined;
  if (!e) throw new Error(`compiled artifact has NO function "${name}" — contract drift?`);
  return e;
}

/**
 * Structural signature of an AbiParameter list: a flat list of "name:type" plus, for
 * tuples, the recursively-flattened components. Names included so a rename is caught too.
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

describe('ABI-drift guard: keeper abi.ts mirrors the compiled FeeArena artifact', () => {
  it('the compiled artifact exists (run `forge build` first)', () => {
    expect(
      existsSync(ARTIFACT_PATH),
      `Missing ${ARTIFACT_PATH}. Run \`forge build\` at the repo root before the keeper tests.`,
    ).toBe(true);
  });

  const abi = loadArtifactAbi();

  for (const name of USED_FUNCTIONS) {
    it(`function ${name}() signature matches the artifact`, () => {
      const k = keeperFn(name);
      const a = artifactFn(abi, name);

      // stateMutability must match (e.g. a read flipping payable, or a write becoming view).
      expect(k.stateMutability, `${name}: stateMutability drift`).toBe(a.stateMutability);

      // Inputs: names + types + order (recursively through any tuples).
      expect(sigParams(k.inputs), `${name}: INPUT drift (keeper vs artifact)`).toEqual(
        sigParams(a.inputs),
      );

      // Outputs: names + types + order. This is where EpochView drift (currentEpoch)
      // surfaces — the tuple component list is flattened and compared 1:1.
      expect(sigParams(k.outputs), `${name}: OUTPUT drift (keeper vs artifact)`).toEqual(
        sigParams(a.outputs),
      );
    });
  }

  it('EpochView tuple components match the artifact exactly (names + types + order)', () => {
    const kTuple = keeperFn('currentEpoch').outputs[0] as AbiParameter & {
      components: AbiParameter[];
    };
    const aTuple = artifactFn(abi, 'currentEpoch').outputs[0] as AbiParameter & {
      components: AbiParameter[];
    };

    const kComps = kTuple.components.map((c) => `${c.name}:${c.type}`);
    const aComps = aTuple.components.map((c) => `${c.name}:${c.type}`);

    // Per-field diff so a failure names the exact drifted EpochView field.
    const max = Math.max(kComps.length, aComps.length);
    for (let i = 0; i < max; i++) {
      expect(
        kComps[i],
        `EpochView component #${i} drift: keeper="${kComps[i] ?? '<missing>'}" artifact="${aComps[i] ?? '<missing>'}"`,
      ).toBe(aComps[i]);
    }
    expect(kComps.length, 'EpochView component COUNT drift').toBe(aComps.length);
  });
});

describe('decode round-trip: keeper ABI decodes an EpochView tuple correctly', () => {
  it('encode (artifact tuple) -> decode (keeper tuple) yields the expected shape', () => {
    const abi = loadArtifactAbi();
    // Use the ARTIFACT's tuple param to ENCODE a representative EpochView, then DECODE it
    // with the KEEPER's tuple param. If the keeper's component order/types drifted, the
    // decoded field values would be wrong (or decoding would throw) — this catches both.
    const artifactTuple = artifactFn(abi, 'currentEpoch').outputs as readonly AbiParameter[];
    const keeperTuple = keeperFn('currentEpoch').outputs as readonly AbiParameter[];

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
    const [decoded] = decodeAbiParameters(keeperTuple, encoded) as unknown as [typeof sample];

    expect(decoded.epochId).toBe(7n);
    expect(decoded.phase).toBe(2);
    expect(decoded.bandBps).toBe(-150); // signed int32 round-trips
    expect(decoded.deltaBps).toBe(333n); // signed int256
    expect(decoded.settlePrice18).toBe(3_100_000000000000000000n);
    expect(decoded.winningSide).toBe(1);
    expect(decoded.rolledOver).toBe(true);
    expect(decoded.stakedCount).toBe(42);
    expect(decoded.sweepCursor).toBe(17);
    expect(decoded.sideContribution6).toEqual([1n, 2n, 3n, 4n]); // fixed array
    expect(decoded.rolloverInUSDC).toBe(9n); // last field — order is intact end-to-end
    // Full structural equality: every field decodes to the encoded value.
    expect(decoded).toEqual(sample);
  });
});

// ===========================================================================
// FeeArenaV2 ABI-DRIFT GUARD. abi.ts's hand-written feeArenaV2Abi is the keeper's
// mirror of the compiled FeeArenaV2 artifact for the v2 (pinned) crank path. The
// EpochV2 tuple is a DIFFERENT shape from v1's EpochView (more fields, different order,
// NO leading epochId), so a drift here would silently break v2 decoding. This asserts
// every v2 function the keeper uses matches out/FeeArenaV2.sol/FeeArenaV2.json 1:1.
// ===========================================================================

// The FeeArenaV2 functions the keeper actually calls (reads + writes), per keeper.ts:
// startEpoch/endEpoch keep the (bytes[]) signature (the contract pins the window itself);
// settleWindow / maxSubsidyPerEpoch / USDC / getEpoch + the subsidy fundSubsidy are v2-new.
const USED_V2_FUNCTIONS = [
  'currentEpochId',
  'currentEpoch',
  'getEpoch',
  'createEpoch',
  'openEntry',
  'startEpoch',
  'endEpoch',
  'sweep',
  'finalizeSettle',
  'maxStartDelay',
  'paused',
  'settleWindow',
  'maxSubsidyPerEpoch',
  'USDC',
  'fundSubsidy',
  'emergencySettle',
] as const;

function loadArtifactAbiV2(): AbiEntry[] {
  if (!existsSync(ARTIFACT_PATH_V2)) {
    throw new Error(`Missing ${ARTIFACT_PATH_V2}. Run \`forge build\` at the repo root before the keeper tests.`);
  }
  const json = JSON.parse(readFileSync(ARTIFACT_PATH_V2, 'utf8')) as { abi: AbiEntry[] };
  return json.abi;
}

function keeperV2Fn(name: string): AbiFunction {
  const e = (feeArenaV2Abi as readonly AbiEntry[]).find(
    (x) => x.type === 'function' && x.name === name,
  ) as AbiFunction | undefined;
  if (!e) throw new Error(`keeper abi.ts feeArenaV2Abi is MISSING function "${name}" (keeper uses it)`);
  return e;
}

describe('ABI-drift guard: keeper feeArenaV2Abi mirrors the compiled FeeArenaV2 artifact', () => {
  it('the compiled FeeArenaV2 artifact exists (run `forge build` first)', () => {
    expect(
      existsSync(ARTIFACT_PATH_V2),
      `Missing ${ARTIFACT_PATH_V2}. Run \`forge build\` at the repo root before the keeper tests.`,
    ).toBe(true);
  });

  const abi = loadArtifactAbiV2();

  for (const name of USED_V2_FUNCTIONS) {
    it(`v2 function ${name}() signature matches the FeeArenaV2 artifact`, () => {
      const k = keeperV2Fn(name);
      const a = artifactFn(abi, name);
      expect(k.stateMutability, `v2 ${name}: stateMutability drift`).toBe(a.stateMutability);
      expect(sigParams(k.inputs), `v2 ${name}: INPUT drift (keeper vs artifact)`).toEqual(sigParams(a.inputs));
      expect(sigParams(k.outputs), `v2 ${name}: OUTPUT drift (keeper vs artifact)`).toEqual(sigParams(a.outputs));
    });
  }

  it('EpochV2 tuple components (currentEpoch) match the artifact exactly (names + types + order)', () => {
    const kTuple = keeperV2Fn('currentEpoch').outputs[0] as AbiParameter & { components: AbiParameter[] };
    const aTuple = artifactFn(abi, 'currentEpoch').outputs[0] as AbiParameter & { components: AbiParameter[] };
    const kComps = kTuple.components.map((c) => `${c.name}:${c.type}`);
    const aComps = aTuple.components.map((c) => `${c.name}:${c.type}`);
    const max = Math.max(kComps.length, aComps.length);
    for (let i = 0; i < max; i++) {
      expect(
        kComps[i],
        `EpochV2 component #${i} drift: keeper="${kComps[i] ?? '<missing>'}" artifact="${aComps[i] ?? '<missing>'}"`,
      ).toBe(aComps[i]);
    }
    expect(kComps.length, 'EpochV2 component COUNT drift').toBe(aComps.length);
  });

  it('the keeper reads the named EpochV2 fields it depends on (decode round-trip)', () => {
    // Encode an EpochV2 with the ARTIFACT tuple, decode with the KEEPER tuple, and assert the
    // fields the keeper actually consumes (phase/startTime/endTime/settlePrice18/sweepCursor/
    // stakedCount/subsidyUSDC) decode to the right values — catching any order/type drift.
    const artifactTuple = artifactFn(abi, 'currentEpoch').outputs as readonly AbiParameter[];
    const keeperTuple = keeperV2Fn('currentEpoch').outputs as readonly AbiParameter[];

    const sample = {
      phase: 2,
      entryOpenTime: 100n,
      entryCloseTime: 200n,
      startTime: 300n,
      endTime: 400n,
      startTimeActual: 301n,
      settleTimeActual: 401n,
      winningSide: 1,
      rolledOver: true,
      rolloverConsumed: false,
      sweepCursor: 17,
      stakedCount: 42,
      bandBps: -150,
      startPrice18: 3_000_000000000000000000n,
      settlePrice18: 3_100_000000000000000000n,
      deltaBps: 333n,
      potWETH: 5n,
      potUSDC: 6n,
      sideContribution6: [1n, 2n, 3n, 4n] as readonly [bigint, bigint, bigint, bigint],
      winnerDenominator: 99n,
      claimedWETH: 7n,
      claimedUSDC: 8n,
      claimedCount: 3,
      subsidyUSDC: 150_000000n,
      sideConviction: [10n, 20n, 30n, 40n] as readonly [bigint, bigint, bigint, bigint],
      winnerSqrtConvSum: 11n,
      winningConvictionSum: 12n,
      refundedConviction: 13n,
      convRefundedCount: 2,
      burnedConviction: 14n,
    };

    const encoded = encodeAbiParameters(artifactTuple, [sample]);
    const [decoded] = decodeAbiParameters(keeperTuple, encoded) as unknown as [typeof sample];

    expect(decoded.phase).toBe(2);
    expect(decoded.startTime).toBe(300n);
    expect(decoded.endTime).toBe(400n);
    expect(decoded.settlePrice18).toBe(3_100_000000000000000000n);
    expect(decoded.sweepCursor).toBe(17);
    expect(decoded.stakedCount).toBe(42);
    expect(decoded.subsidyUSDC).toBe(150_000000n);
    expect(decoded.bandBps).toBe(-150); // signed round-trips
    expect(decoded).toEqual(sample); // full structural equality end-to-end
  });
});
