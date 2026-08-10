// feeArenaV2AbiDrift.test.ts — ABI-DRIFT GUARD for the FRONTEND v2 surface. abis/feeArenaV2.ts and
// abis/feeArenaV2Lens.ts are VERBATIM mirrors of the compiled FeeArenaV2 / FeeArenaV2Lens ABIs
// (out/FeeArenaV2.sol/FeeArenaV2.json + out/FeeArenaV2Lens.sol/FeeArenaV2Lens.json via `forge build`).
//
// The frontend (a) WRITES stakeWithConviction / claim(recipient) / refundConviction(recipient) /
// withdrawCredited against the arena and (b) READS previewClaim / previewRefund / getStake /
// getStakesByEpoch from the LENS, plus the conviction bounds (minConv/maxConv) + TREASURY + USDC from
// the arena. A field-order/type/signature drift in any of those would silently corrupt every decoded
// value or send malformed calldata, so this guard asserts the hand-mirrored entries match the
// artifacts STRUCTURALLY (names + types + order, recursing through tuples), naming the drifted field.
//
// This is the v2 sibling of feeArenaAbiDrift.test.ts. Run `forge build` first (frontend-ci does) so
// the artifacts are present.
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { encodeAbiParameters, decodeAbiParameters, encodeFunctionData, type AbiFunction, type AbiParameter } from 'viem';
import { feeArenaV2Abi } from '@/abis/feeArenaV2';
import { feeArenaV2LensAbi } from '@/abis/feeArenaV2Lens';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';
import { erc20Abi } from '@/abis/erc20';
import { Side } from '@/lib/types';

// Repo root is two levels up from frontend/test/.
const HERE = dirname(fileURLToPath(import.meta.url));
const ARENA_ARTIFACT = resolve(HERE, '..', '..', 'out', 'FeeArenaV2.sol', 'FeeArenaV2.json');
const LENS_ARTIFACT = resolve(HERE, '..', '..', 'out', 'FeeArenaV2Lens.sol', 'FeeArenaV2Lens.json');
const NPM_ARTIFACT = resolve(
  HERE, '..', '..', 'out', 'NonfungiblePositionManager.sol', 'NonfungiblePositionManager.json',
);

// Arena functions the frontend depends on (writes + the config reads the stake flow / config need).
const ARENA_FUNCTIONS = [
  'stakeWithConviction',
  'claim',
  'refundConviction',
  'withdrawCredited',
  'currentEpoch',
  'getEpoch',
  'getPosition',
  'getConviction',
  'minConv',
  'maxConv',
  'TREASURY',
  'USDC',
] as const;

// Lens functions the frontend READS (previews + stake listings).
const LENS_FUNCTIONS = ['previewClaim', 'previewRefund', 'getStake', 'getStakesByEpoch'] as const;

type AbiEntry = AbiFunction;

function loadArtifactAbi(path: string): AbiEntry[] {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}. Run \`forge build\` at the repo root before the v2 ABI-drift test.`);
  }
  const json = JSON.parse(readFileSync(path, 'utf8')) as { abi: AbiEntry[] };
  return json.abi;
}

function findFn(abi: readonly AbiEntry[], name: string, where: string): AbiFunction {
  const e = abi.find((x) => x.type === 'function' && x.name === name) as AbiFunction | undefined;
  if (!e) throw new Error(`${where} is MISSING function "${name}"`);
  return e;
}

/** Structural signature: a flat "name:type" list, recursing through tuple components (names too). */
function sigParams(params: readonly AbiParameter[], prefix = ''): string[] {
  const out: string[] = [];
  for (const p of params) {
    out.push(`${prefix}${p.name ?? ''}:${p.type}`);
    const comps = (p as { components?: readonly AbiParameter[] }).components;
    if (comps) out.push(...sigParams(comps, `${prefix}${p.name ?? ''}.`));
  }
  return out;
}

function firstOutputComponents(fn: AbiFunction): AbiParameter[] {
  const out0 = fn.outputs[0] as AbiParameter & { components?: AbiParameter[] };
  if (!out0?.components) throw new Error(`${fn.name}: first output is not a tuple`);
  return out0.components;
}

describe('ABI-drift guard: frontend abis/feeArenaV2.ts mirrors the compiled FeeArenaV2 artifact', () => {
  it('the compiled artifact exists (run `forge build` first)', () => {
    expect(existsSync(ARENA_ARTIFACT), `Missing ${ARENA_ARTIFACT}. Run \`forge build\` first.`).toBe(true);
  });

  const abi = loadArtifactAbi(ARENA_ARTIFACT);

  for (const name of ARENA_FUNCTIONS) {
    it(`arena function ${name}() signature matches the artifact (inputs + outputs, recursive)`, () => {
      const f = findFn(feeArenaV2Abi as readonly AbiEntry[], name, 'frontend abis/feeArenaV2.ts');
      const a = findFn(abi, name, 'compiled FeeArenaV2 artifact');
      expect(f.stateMutability, `${name}: stateMutability drift`).toBe(a.stateMutability);
      expect(sigParams(f.inputs), `${name}: INPUT drift (frontend vs artifact)`).toEqual(sigParams(a.inputs));
      expect(sigParams(f.outputs), `${name}: OUTPUT drift (frontend vs artifact)`).toEqual(sigParams(a.outputs));
    });
  }

  it('stakeWithConviction has the exact (uint256 tokenId, uint8 side, uint256 conviction) signature', () => {
    const f = findFn(feeArenaV2Abi as readonly AbiEntry[], 'stakeWithConviction', 'frontend');
    expect(f.inputs.map((i) => `${i.name}:${i.type}`)).toEqual([
      'tokenId:uint256',
      'side:uint8',
      'conviction:uint256',
    ]);
    expect(f.outputs).toHaveLength(0);
    expect(f.stateMutability).toBe('nonpayable');
  });

  it('claim + refundConviction both take (uint64 epochId, uint256 tokenId, address recipient)', () => {
    for (const name of ['claim', 'refundConviction'] as const) {
      const f = findFn(feeArenaV2Abi as readonly AbiEntry[], name, 'frontend');
      expect(f.inputs.map((i) => `${i.name}:${i.type}`), `${name} inputs`).toEqual([
        'epochId:uint64',
        'tokenId:uint256',
        'recipient:address',
      ]);
    }
  });

  it('Position tuple (getPosition) carries the v2 conviction + convictionRefunded fields', () => {
    const comps = firstOutputComponents(findFn(feeArenaV2Abi as readonly AbiEntry[], 'getPosition', 'frontend')).map(
      (c) => `${c.name}:${c.type}`,
    );
    expect(comps).toContain('conviction:uint256');
    expect(comps).toContain('convictionRefunded:bool');
  });
});

describe('ABI-drift guard: frontend abis/feeArenaV2Lens.ts mirrors the compiled FeeArenaV2Lens artifact', () => {
  it('the compiled lens artifact exists (run `forge build` first)', () => {
    expect(existsSync(LENS_ARTIFACT), `Missing ${LENS_ARTIFACT}. Run \`forge build\` first.`).toBe(true);
  });

  const abi = loadArtifactAbi(LENS_ARTIFACT);

  for (const name of LENS_FUNCTIONS) {
    it(`lens function ${name}() signature matches the artifact (inputs + outputs, recursive)`, () => {
      const f = findFn(feeArenaV2LensAbi as readonly AbiEntry[], name, 'frontend abis/feeArenaV2Lens.ts');
      const a = findFn(abi, name, 'compiled FeeArenaV2Lens artifact');
      expect(f.stateMutability, `${name}: stateMutability drift`).toBe(a.stateMutability);
      expect(sigParams(f.inputs), `${name}: INPUT drift (frontend vs artifact)`).toEqual(sigParams(a.inputs));
      expect(sigParams(f.outputs), `${name}: OUTPUT drift (frontend vs artifact)`).toEqual(sigParams(a.outputs));
    });
  }

  it('previewRefund returns (bool refundable, uint256 amount)', () => {
    const f = findFn(feeArenaV2LensAbi as readonly AbiEntry[], 'previewRefund', 'frontend');
    expect(f.outputs.map((o) => `${o.name}:${o.type}`)).toEqual(['refundable:bool', 'amount:uint256']);
  });
});

describe('decode round-trip: frontend v2 lens ABI decodes a ClaimPreview tuple correctly', () => {
  it('encode (artifact tuple) -> decode (frontend tuple) yields the expected shape', () => {
    const abi = loadArtifactAbi(LENS_ARTIFACT);
    const artifactTuple = findFn(abi, 'previewClaim', 'artifact').outputs as readonly AbiParameter[];
    const frontendTuple = findFn(feeArenaV2LensAbi as readonly AbiEntry[], 'previewClaim', 'frontend')
      .outputs as readonly AbiParameter[];

    const sample = {
      isWinner: true,
      alreadyClaimed: false,
      claimable: true,
      contribution6: 1234n,
      winnerDenominator: 5678n,
      payWETH: 11n,
      payUSDC: 22n,
    };
    const encoded = encodeAbiParameters(artifactTuple, [sample]);
    const [decoded] = decodeAbiParameters(frontendTuple, encoded) as unknown as [typeof sample];
    expect(decoded).toEqual(sample);
  });
});

// ── v2 STAKE-FLOW INTEGRATION GUARD ────────────────────────────────────────────
// The live "ERC721: transfer caller is not owner nor approved" bug was the v2 stake flow MISSING the
// NFT operator-approval step: FeeArenaV2.stakeWithConviction has the ARENA pull the LP NFT
// (NPM.safeTransferFrom(user -> arena)), so the arena must be an approved operator first. The hook now
// does USDC approve -> NPM.setApprovalForAll(arena,true) -> stakeWithConviction. This guard asserts the
// NPM ABI actually carries the two ERC-721 operator-approval fns (matching the compiled NPM artifact),
// and that EVERY call the stake flow makes encodes cleanly against the REAL frontend ABIs with the exact
// arg shapes the hook sends — so the flow can't silently drift away from what the contract needs.
describe('v2 stake-flow integration: the three calls encode against the real frontend ABIs', () => {
  it('the NPM ABI carries setApprovalForAll + isApprovedForAll matching the compiled NPM artifact', () => {
    expect(
      existsSync(NPM_ARTIFACT),
      `Missing ${NPM_ARTIFACT}. Run \`forge build\` first.`,
    ).toBe(true);
    const artifact = loadArtifactAbi(NPM_ARTIFACT);
    for (const name of ['setApprovalForAll', 'isApprovedForAll'] as const) {
      const f = findFn(nonfungiblePositionManagerAbi as readonly AbiEntry[], name, 'frontend NPM abi');
      const a = findFn(artifact, name, 'compiled NPM artifact');
      expect(f.stateMutability, `${name}: stateMutability drift`).toBe(a.stateMutability);
      expect(sigParams(f.inputs), `${name}: INPUT drift (frontend vs artifact)`).toEqual(sigParams(a.inputs));
      expect(sigParams(f.outputs), `${name}: OUTPUT drift (frontend vs artifact)`).toEqual(sigParams(a.outputs));
    }
  });

  it('encodes USDC approve -> NPM.setApprovalForAll -> stakeWithConviction with the hook arg shapes', () => {
    // A valid lowercase 20-byte (40-hex) address (lowercase skips viem's checksum validation).
    const ARENA = '0x000000000000000000000000000000000feea002' as const;
    const USER = '0x1111111111111111111111111111111111111111' as const;
    const tokenId = 42n;
    const conviction = 250_000000n;

    // STEP 1 — USDC approve(arena, conviction) (EXACT amount).
    expect(() =>
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ARENA, conviction] }),
    ).not.toThrow();

    // STEP 2 — NPM.setApprovalForAll(arena, true) (operator approval; the arena pulls the NFT).
    const nftApproveData = encodeFunctionData({
      abi: nonfungiblePositionManagerAbi,
      functionName: 'setApprovalForAll',
      args: [ARENA, true],
    });
    expect(nftApproveData.startsWith('0x')).toBe(true);

    // STEP 3 — arena.stakeWithConviction(tokenId, side, conviction) on the REAL v2 arena ABI.
    const stakeData = encodeFunctionData({
      abi: feeArenaV2Abi,
      functionName: 'stakeWithConviction',
      args: [tokenId, Side.UP, conviction],
    });
    expect(stakeData.startsWith('0x')).toBe(true);

    // isApprovedForAll(user, arena) — the read that gates STEP 2 — also encodes against the real ABI.
    expect(() =>
      encodeFunctionData({
        abi: nonfungiblePositionManagerAbi,
        functionName: 'isApprovedForAll',
        args: [USER, ARENA],
      }),
    ).not.toThrow();
  });
});
