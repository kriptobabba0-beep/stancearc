import type { Page } from '@playwright/test';
import {
  encodeFunctionResult,
  decodeFunctionData,
  toFunctionSelector,
  type AbiFunction,
} from 'viem';
import { feeArenaAbi } from '../../abis/feeArena';
import { feeArenaV2Abi } from '../../abis/feeArenaV2';
import { feeArenaV2LensAbi } from '../../abis/feeArenaV2Lens';
import { nonfungiblePositionManagerAbi } from '../../abis/nonfungiblePositionManager';

const CHAIN_ID_HEX = '0x4cefb2'; // 5042002
const TEST_ACCOUNT = '0x1111111111111111111111111111111111111111';
// Minimal non-empty bytecode so the providers bytecode-exists guard passes.
const NONEMPTY_CODE = '0x60006000';
// Canned tx hash returned for every write (eth_sendTransaction) so the wallet-client write resolves
// and useWaitForTransactionReceipt has a hash to poll.
const TX_HASH = '0x' + '11'.repeat(32);

// Multicall3 address (canonical on every chain)
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

// ── Live cirBTC/USDC market decimals ──────────────────────────────────────────────
// The boot gate hard-fails unless USDC.decimals() === 6 (lib/decimals.ts). The base leg is
// decimals-agnostic on-chain, so the flagship cirBTC market boots with an 8-dp base; we still
// answer the base token's decimals() honestly (8) so any per-token decimals read on the dashboard
// reflects the live market rather than the stale mock WETH=18.
const USDC_DECIMALS = 6;
const BASE_DECIMALS = 8; // cirBTC (real Circle faucet token, 8dp)

// ── Function selectors the boot gate + first-paint reads issue ─────────────────────
// keccak256(signature)[0:4]. The boot gate batches decimals()/owner() through Multicall3, so the
// mock must answer per-inner-call (a fixed N-result blob breaks when viem batches a different count).
const SELECTOR = {
  decimals: '313ce567', // decimals() -> uint8
  owner: '8da5cb5b', // owner() -> address
  symbol: '95d89b41', // symbol() -> string
  name: '06fdde03', // name() -> string
} as const;

// ── Per-test scenario state (drives the FeeArena/NPM reads the write flows depend on) ──────────────
// 'entryOpen'  — current epoch is in the Entry window + the wallet owns ONE stakeable cirBTC/USDC
//                position (tokenId 1) and has NO existing stake — the stake-with-side flow.
// 'settled'    — current epoch is Settled & fully swept, the wallet has ONE staked+swept position
//                (tokenId 1) that is a claimable winner — the claim + withdraw(unstake) flows.
// 'idle'       — minimal state (no epoch progress, no positions) — the boot/dashboard smoke default.
export type MockScenario = 'entryOpen' | 'settled' | 'idle';

// Contract addresses come from the built env (passed at route-setup) so the mock stays correct if an
// address changes. Defaulted to the live cirBTC-market values in frontend/.env.example.
interface MockAddrs {
  usdc: string;
  base: string; // cirBTC pool base leg
  feeArena: string; // the v2 conviction arena (0xAEB3…) — the SECONDARY market the v2 specs select into
  feeArenaV1: string; // the live v1 arena (0xD0aE…) — MARKETS[0] / the DEFAULT market post-cutover
  lens?: string; // FeeArenaV2Lens (v2 only) — answers getStake(sByEpoch)/previewClaim/previewRefund
  npm: string;
  pool: string; // the {base, USDC} V3 pool — answers token0()/token1() for useActiveBaseToken
}
// CUTOVER-SAFETY ordering: frontend/.env.example (and .env.local) now list the LIVE v1 arena 0xD0aE…
// FIRST (= MARKETS[0] = DEFAULT_MARKET_ID), with the v2 conviction arena 0xAEB3… + its Lens 0xa0Db…
// as a SECONDARY entry (id "btc-v2"). So the mock routes BOTH: the v1 arena (collapsed EpochView +
// getUserStakes) as the default boot surface, AND the v2 arena (raw EpochV2 + currentEpochId) + Lens
// (getStakesByEpoch/getStake/previewClaim/previewRefund) for when a v2 spec selects the v2 market tab.
const DEFAULT_ADDRS: MockAddrs = {
  usdc: '0x3600000000000000000000000000000000000000',
  base: '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF',
  feeArena: '0xAEB33D3bfd63e4C330bb78A0a0b249e53DAA5C68',
  feeArenaV1: '0xD0aEDc19E1C27E7643255432006942ccFba5B8CE',
  lens: '0xa0Db836f8a24781b5a4F457924C9860Dfe2a80b9',
  npm: '0x646E3cCd584b315F235aD269C0893a125D9F38dc',
  pool: '0x969f2e3CB9929b5D50B6A59Cf49CF30870e1658b',
};

// Pool token0()/token1() selectors — the active base resolver (useActiveBaseToken) reads these to
// classify the base vs USDC leg, which gates useOwnedPositions' Arena-pair filter. We answer base as
// token0 and USDC as token1 (baseIsToken0 = true).
const POOL_TOKEN0 = '0dfe1681'; // token0()
const POOL_TOKEN1 = 'd21220a7'; // token1()

const FEE_TIER = 3000; // NEXT_PUBLIC_FEE_TIER in .env.example
const TOKEN_ID = 1n; // the single owned/staked position in the write-flow scenarios

// ── Low-level ABI hex helpers ──────────────────────────────────────────────────────
const strip0x = (s: string): string => (s.startsWith('0x') ? s.slice(2) : s);

/** Pad an unsigned value to a 32-byte (64-hex) word. */
const word = (n: number | bigint): string =>
  (typeof n === 'bigint' ? n : BigInt(n)).toString(16).padStart(64, '0');

/** Right-pad raw hex to a whole number of 32-byte words (for dynamic `bytes` data). */
const padBytes = (hex: string): string => {
  const h = strip0x(hex);
  const rem = h.length % 64;
  return rem === 0 ? h : h + '0'.repeat(64 - rem);
};

/** ABI-encode a single Multicall3 `Result = (bool success, bytes returnData)` tuple. */
function encodeResult(returnData: string): string {
  const data = strip0x(returnData);
  const byteLen = data.length / 2;
  return (
    word(1) + // bool success = true
    word(0x40) + // offset to `returnData` bytes within this tuple = 64
    word(byteLen) + // bytes length
    padBytes('0x' + data) // bytes data, right-padded to a word boundary
  );
}

/**
 * ABI-encode a Multicall3 `aggregate3` return: `Result[]` (a dynamic array of dynamic tuples).
 * `returnDatas[i]` is the raw return bytes for inner call i (already 0x-prefixed or bare hex).
 */
function encodeAggregate3Return(returnDatas: string[]): string {
  const tuples = returnDatas.map((rd) => encodeResult(rd));
  const n = tuples.length;
  // Header: outer offset to the array, then the array length, then one offset per element.
  // Element offsets are relative to the start of the array body (just after the length word).
  const offsetsHeaderWords = n; // one offset word per element
  let cursor = offsetsHeaderWords * 32; // first element starts after the offset table
  const elementOffsets: string[] = [];
  for (const t of tuples) {
    elementOffsets.push(word(cursor));
    cursor += t.length / 2; // each tuple's byte length
  }
  const arrayBody = word(n) + elementOffsets.join('') + tuples.join('');
  return '0x' + word(0x20) + arrayBody;
}

/** uint8 return value (e.g. decimals) as a 32-byte word. */
const encodeUint8 = (v: number): string => '0x' + word(v);
/** address return value, left-padded to a 32-byte word. */
const encodeAddress = (addr: string): string => '0x' + strip0x(addr).toLowerCase().padStart(64, '0');

// ── ABI-aware answers (FeeArena + NPM) ──────────────────────────────────────────────
// Map of "selector -> { abi function, name }" so we can encode a function RESULT by selector. We
// build this once from the typed ABIs so any signature drift is reflected automatically.
function buildSelectorIndex(abi: readonly unknown[]): Map<string, AbiFunction> {
  const idx = new Map<string, AbiFunction>();
  for (const e of abi as AbiFunction[]) {
    if (e.type !== 'function') continue;
    try {
      idx.set(strip0x(toFunctionSelector(e)).toLowerCase(), e);
    } catch {
      // overloaded entry with the same selector — first wins (fine for reads we encode).
    }
  }
  return idx;
}
const FEE_ARENA_SELECTORS = buildSelectorIndex(feeArenaAbi);
const FEE_ARENA_V2_SELECTORS = buildSelectorIndex(feeArenaV2Abi);
const LENS_SELECTORS = buildSelectorIndex(feeArenaV2LensAbi);
const NPM_SELECTORS = buildSelectorIndex(nonfungiblePositionManagerAbi);

/** A representative EpochView tuple in the given phase (1=EntryOpen, 3=Settled). */
function epochView(phase: number) {
  const settled = phase === 3;
  return {
    epochId: 1n,
    phase,
    entryOpenTime: 1_000n,
    entryCloseTime: 9_999_999_999n, // far future so the Entry window reads as open
    startTime: 1_100n,
    endTime: 9_999_999_999n,
    startTimeActual: settled ? 1_100n : 0n,
    settleTimeActual: settled ? 2_000n : 0n,
    bandBps: 100,
    startPrice18: 60_000n * 10n ** 18n,
    settlePrice18: settled ? 61_000n * 10n ** 18n : 0n,
    deltaBps: settled ? 166n : 0n,
    winningSide: settled ? 1 : 0, // UP wins in the settled scenario
    rolledOver: false,
    stakedCount: 1,
    sweepCursor: settled ? 1 : 0, // fully swept when settled
    potWETH: settled ? 10n ** 8n : 0n,
    potUSDC: settled ? 1_000_000n : 0n,
    sideContribution6: [0n, 1_000_000n, 0n, 0n] as readonly [bigint, bigint, bigint, bigint],
    winnerDenominator: settled ? 1_000_000n : 0n,
    rolloverPendingIn: false,
    rolloverInWETH: 0n,
    rolloverInUSDC: 0n,
  };
}

/**
 * A representative RAW EpochV2 tuple in the given RAW phase (1=EntryOpen, 5=Settled). The v2 arena's
 * currentEpoch()/getEpoch() return THIS shape (no epochId field, raw 6-phase Phase, reordered + extra
 * conviction fields) — NOT the collapsed EpochView. Field order/names mirror abis/feeArenaV2.ts exactly.
 */
function rawEpochV2(rawPhase: number) {
  const settled = rawPhase === 5;
  return {
    phase: rawPhase,
    entryOpenTime: 1_000n,
    entryCloseTime: 9_999_999_999n, // far future so the Entry window reads as open
    startTime: 1_100n,
    endTime: 9_999_999_999n,
    startTimeActual: settled ? 1_100n : 0n,
    settleTimeActual: settled ? 2_000n : 0n,
    winningSide: settled ? 1 : 0, // UP wins in the settled scenario
    rolledOver: false,
    rolloverConsumed: false,
    sweepCursor: settled ? 1 : 0, // fully swept when settled
    stakedCount: 1,
    bandBps: 100,
    startPrice18: 60_000n * 10n ** 18n,
    settlePrice18: settled ? 61_000n * 10n ** 18n : 0n,
    deltaBps: settled ? 166n : 0n,
    potWETH: settled ? 10n ** 8n : 0n,
    potUSDC: settled ? 1_000_000n : 0n,
    sideContribution6: [0n, 1_000_000n, 0n, 0n] as readonly [bigint, bigint, bigint, bigint],
    winnerDenominator: settled ? 1_000_000n : 0n,
    claimedWETH: 0n,
    claimedUSDC: 0n,
    claimedCount: 0,
    subsidyUSDC: 0n,
    sideConviction: [0n, 1_000_000n, 0n, 0n] as readonly [bigint, bigint, bigint, bigint],
    winnerSqrtConvSum: settled ? 1_000n : 0n,
    winningConvictionSum: settled ? 1_000_000n : 0n,
    refundedConviction: 0n,
    convRefundedCount: 0,
    burnedConviction: 0n,
  };
}

/** A StakeView for the wallet's single position in the given scenario. */
function stakeView(scenario: MockScenario) {
  const settled = scenario === 'settled';
  return {
    tokenId: TOKEN_ID,
    owner: TEST_ACCOUNT as `0x${string}`,
    epochId: 1n,
    side: 1, // UP
    swept: settled, // swept only after settlement — gates the unstake button
    claimed: false,
    unstaked: false,
    feeWETH: settled ? 10n ** 8n : 0n,
    feeUSDC: settled ? 1_000_000n : 0n,
    contribution6: 1_000_000n,
  };
}

/** ClaimPreview for the wallet's winning, claimable position (settled scenario). */
function claimPreview() {
  return {
    isWinner: true,
    alreadyClaimed: false,
    claimable: true,
    contribution6: 1_000_000n,
    winnerDenominator: 1_000_000n,
    payWETH: 10n ** 8n,
    payUSDC: 1_000_000n,
  };
}

/** Encode a FeeArena read by selector for the active scenario. Returns undefined if unhandled. */
function answerFeeArena(callData: string, scenario: MockScenario): string | undefined {
  const sel = strip0x(callData).slice(0, 8).toLowerCase();
  const fn = FEE_ARENA_SELECTORS.get(sel);
  if (!fn) return undefined;
  const enc = (v: unknown) =>
    encodeFunctionResult({ abi: feeArenaAbi, functionName: fn.name as never, result: v as never });
  switch (fn.name) {
    case 'currentEpoch':
    case 'getEpoch':
      return enc(epochView(scenario === 'entryOpen' ? 1 : scenario === 'settled' ? 3 : 0));
    case 'getUserStakes':
    case 'getStakesByEpoch': {
      // Only the 'settled' scenario has an existing (staked) position. In 'entryOpen' the wallet has
      // NO stake yet — so the owned position stays free + stakeable and the side is pickable (an
      // existing stake this epoch would lock the side and filter the position out of the picker).
      const arr = scenario === 'settled' ? [stakeView(scenario)] : [];
      // This function's single output is a tuple[] (an ARRAY). viem's encodeFunctionResult only wraps
      // a single-output `result` when it is NOT already an array, so an array result would be misread
      // as the outputs-list. Wrap it once more ([arr]) so viem encodes it as the lone tuple[] output.
      return enc([arr]);
    }
    case 'getStake':
      return enc(stakeView(scenario));
    case 'previewClaim':
      return enc(claimPreview());
    case 'sweepProgress':
      // (done, total) — fully swept in the settled scenario.
      return enc([scenario === 'settled' ? 1 : 0, 1]);
    case 'paused':
      return enc(false);
    default:
      return undefined;
  }
}

/**
 * Encode a v2 ARENA read by selector for the active scenario. The v2 arena returns the RAW EpochV2
 * struct for currentEpoch()/getEpoch() and exposes currentEpochId() separately (the raw struct has no
 * epochId). getStake(sByEpoch)/previewClaim live on the LENS, not here. Returns undefined if unhandled.
 */
function answerFeeArenaV2(callData: string, scenario: MockScenario): string | undefined {
  const sel = strip0x(callData).slice(0, 8).toLowerCase();
  const fn = FEE_ARENA_V2_SELECTORS.get(sel);
  if (!fn) return undefined;
  const enc = (v: unknown) =>
    encodeFunctionResult({ abi: feeArenaV2Abi, functionName: fn.name as never, result: v as never });
  switch (fn.name) {
    case 'currentEpoch':
    case 'getEpoch':
      return enc(rawEpochV2(scenario === 'entryOpen' ? 1 : scenario === 'settled' ? 5 : 0));
    case 'currentEpochId':
      return enc(1n); // epoch #1 — the id useCurrentEpoch injects + useUserStakes scans from
    case 'sweepProgress':
      return enc([scenario === 'settled' ? 1 : 0, 1]); // (done, total) — fully swept when settled
    case 'paused':
      return enc(false);
    default:
      return undefined;
  }
}

/**
 * Encode a v2 LENS read by selector for the active scenario. The frontend reads stake listings +
 * previews FROM THE LENS in v2: getStakesByEpoch (owner-filtered client-side by useUserStakes),
 * getStake, previewClaim, previewRefund. Returns undefined if unhandled.
 */
function answerLens(callData: string, scenario: MockScenario): string | undefined {
  const sel = strip0x(callData).slice(0, 8).toLowerCase();
  const fn = LENS_SELECTORS.get(sel);
  if (!fn) return undefined;
  const enc = (v: unknown) =>
    encodeFunctionResult({ abi: feeArenaV2LensAbi, functionName: fn.name as never, result: v as never });
  switch (fn.name) {
    case 'getStakesByEpoch': {
      // Only 'settled' has an existing (staked) position. Single tuple[] output -> wrap once ([arr]).
      const arr = scenario === 'settled' ? [stakeView(scenario)] : [];
      return enc([arr]);
    }
    case 'getStake':
      return enc(stakeView(scenario));
    case 'previewClaim':
      return enc(claimPreview());
    case 'previewRefund':
      // (refundable, amount) — not refundable in these scenarios (UP is the winner, not refundable).
      return enc([false, 0n]);
    default:
      return undefined;
  }
}

/** Encode an NPM read/simulate by selector for the active scenario. Returns undefined if unhandled. */
function answerNpm(callData: string, scenario: MockScenario, addrs: MockAddrs): string | undefined {
  const sel = strip0x(callData).slice(0, 8).toLowerCase();
  const fn = NPM_SELECTORS.get(sel);
  if (!fn) return undefined;
  const enc = (name: string, v: unknown) =>
    encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: name as never, result: v as never });
  const ownsPosition = scenario === 'entryOpen'; // a free, stakeable position only in the entry flow
  switch (fn.name) {
    case 'balanceOf':
      return enc('balanceOf', ownsPosition ? 1n : 0n);
    case 'tokenOfOwnerByIndex':
      return enc('tokenOfOwnerByIndex', TOKEN_ID);
    case 'positions':
      // (nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, fg0, fg1, owed0, owed1)
      // token0/token1 must match the active pool's {base, usdc} pair so filterArenaPositions keeps it.
      return enc('positions', [
        0n,
        '0x0000000000000000000000000000000000000000',
        addrs.base as `0x${string}`,
        addrs.usdc as `0x${string}`,
        FEE_TIER,
        -887220,
        887220,
        10n ** 18n, // liquidity > 0
        0n,
        0n,
        0n,
        0n,
      ]);
    case 'collect':
      // simulateContract(collect) result = (amount0, amount1) — pending fees shown in the picker.
      return enc('collect', [0n, 0n]);
    case 'safeTransferFrom':
      // stake simulate preflight — no outputs; an empty success return is correct.
      return '0x';
    case 'factory':
      return enc('factory', '0x184b90622535b024AD178730f39b75D26EF04826');
    default:
      return undefined;
  }
}

/**
 * Answer ONE inner contract call by its 4-byte selector + target. Decimals are keyed off the target
 * so USDC -> 6 and the base token -> 8; owner() returns the test account. FeeArena + NPM reads are
 * encoded from their ABIs for the active scenario. Anything unmapped returns a single zero word so
 * dependent reads degrade to "loading"/empty rather than crash.
 */
function answerCall(target: string, callData: string, scenario: MockScenario, addrs: MockAddrs): string {
  const sel = strip0x(callData).slice(0, 8).toLowerCase();
  const to = target.toLowerCase();
  if (sel === SELECTOR.decimals) {
    // USDC decimals MUST be 6 (boot gate). Any other token (the base cirBTC leg) -> 8.
    return encodeUint8(to === addrs.usdc.toLowerCase() ? USDC_DECIMALS : BASE_DECIMALS);
  }
  if (sel === SELECTOR.owner) {
    return encodeAddress(TEST_ACCOUNT);
  }
  // Active pool token legs (useActiveBaseToken): base sorts as token0, USDC as token1.
  if (to === addrs.pool.toLowerCase()) {
    if (sel === POOL_TOKEN0) return encodeAddress(addrs.base);
    if (sel === POOL_TOKEN1) return encodeAddress(addrs.usdc);
  }
  if (to === addrs.feeArena.toLowerCase()) {
    // The v2 conviction arena (0xAEB3…) — raw EpochV2 + currentEpochId answers; getStake(sByEpoch)/
    // previewClaim/previewRefund live on the Lens, not here.
    const a = answerFeeArenaV2(callData, scenario);
    if (a !== undefined) return a;
  }
  if (to === addrs.feeArenaV1.toLowerCase()) {
    // The live v1 arena (0xD0aE…) — the DEFAULT market post-cutover. Collapsed EpochView +
    // getUserStakes/getStakesByEpoch/previewClaim all live ON the arena in v1 (no Lens).
    const a = answerFeeArena(callData, scenario);
    if (a !== undefined) return a;
  }
  if (addrs.lens && to === addrs.lens.toLowerCase()) {
    const a = answerLens(callData, scenario);
    if (a !== undefined) return a;
  }
  if (to === addrs.npm.toLowerCase()) {
    const a = answerNpm(callData, scenario, addrs);
    if (a !== undefined) return a;
  }
  // Unmapped read: a zero word keeps hooks in their loading/empty state without crashing.
  return '0x' + word(0);
}

/**
 * Decode a Multicall3 `aggregate3(Call3[])` calldata into its inner calls. Returns one
 * `{ target, callData }` per element. Best-effort: on any parse hiccup returns [] so the caller can
 * fall back to a single zero-word answer.
 */
function decodeAggregate3Calls(data: string): Array<{ target: string; callData: string }> {
  try {
    const h = strip0x(data);
    // 4-byte selector + ABI head. Head[0] = offset to the Call3[] array.
    const body = h.slice(8);
    const at = (wordIndex: number): string => body.slice(wordIndex * 64, wordIndex * 64 + 64);
    const arrayOffsetBytes = Number(BigInt('0x' + at(0)));
    const arrayStart = arrayOffsetBytes * 2; // in hex chars
    const aw = (i: number): string => body.slice(arrayStart + i * 64, arrayStart + i * 64 + 64);
    const len = Number(BigInt('0x' + aw(0)));
    const calls: Array<{ target: string; callData: string }> = [];
    for (let i = 0; i < len; i++) {
      const elemOffsetBytes = Number(BigInt('0x' + aw(1 + i)));
      // Element offset is relative to the start of the array body (after the length word).
      const elemStart = arrayStart + 64 /* length word */ + elemOffsetBytes * 2;
      const ew = (j: number): string => body.slice(elemStart + j * 64, elemStart + j * 64 + 64);
      const target = '0x' + ew(0).slice(24); // address = low 20 bytes of the word
      // ew(1) = allowFailure (bool), ew(2) = offset to callData bytes within the tuple.
      const callDataOffsetBytes = Number(BigInt('0x' + ew(2)));
      const cdStart = elemStart + callDataOffsetBytes * 2;
      const cdLenBytes = Number(BigInt('0x' + body.slice(cdStart, cdStart + 64)));
      const cdHex = body.slice(cdStart + 64, cdStart + 64 + cdLenBytes * 2);
      calls.push({ target, callData: '0x' + cdHex });
    }
    return calls;
  } catch {
    return [];
  }
}

/**
 * Inject a minimal injected provider BEFORE app scripts run, so wagmi's injected() connector finds
 * window.ethereum on the Arc chain with one account. The provider also answers WRITE methods:
 * eth_sendTransaction returns a canned tx hash so the wallet-client write resolves (the matching
 * receipt is served by the RPC route below).
 */
export async function injectMockWallet(page: Page): Promise<void> {
  await page.addInitScript(
    ({ chainIdHex, account, txHash }) => {
      const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
      const provider = {
        isMetaMask: true,
        async request({ method }: { method: string; params?: unknown[] }) {
          switch (method) {
            case 'eth_chainId':
            case 'net_version':
              return chainIdHex;
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [account];
            case 'wallet_switchEthereumChain':
              return null;
            // ── Writes: return a canned hash so writeContractAsync resolves; the receipt + nonce +
            //    fee reads are served by the HTTP RPC route (viem's public client polls them). ──
            case 'eth_sendTransaction':
            case 'eth_sendRawTransaction':
              return txHash;
            default:
              return null;
          }
        },
        on(event: string, cb: (...args: unknown[]) => void) {
          (listeners[event] ||= []).push(cb);
          return this;
        },
        removeListener(event: string, cb: (...args: unknown[]) => void) {
          listeners[event] = (listeners[event] || []).filter((f) => f !== cb);
          return this;
        },
      };
      (window as unknown as Record<string, unknown>).ethereum = provider;
    },
    { chainIdHex: CHAIN_ID_HEX, account: TEST_ACCOUNT, txHash: TX_HASH },
  );
}

/** A successful, mined transaction receipt for the canned write hash. */
function txReceipt(): Record<string, unknown> {
  return {
    transactionHash: TX_HASH,
    transactionIndex: '0x0',
    blockHash: '0x' + '0'.repeat(64),
    blockNumber: '0x1',
    from: TEST_ACCOUNT,
    to: '0x' + '0'.repeat(40),
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    contractAddress: null,
    logs: [],
    logsBloom: '0x' + '0'.repeat(512),
    status: '0x1', // success
    effectiveGasPrice: '0x4a817c800',
    type: '0x2',
  };
}

/**
 * Intercept the HTTP JSON-RPC the viem transport makes and return canned results for the boot gate,
 * dashboard reads, the per-scenario FeeArena/NPM reads, and the write lifecycle (estimateGas, nonce,
 * fee history, and a successful receipt for the canned tx hash). Contract reads are answered per inner
 * call by selector/ABI so the response stays correct no matter how viem batches reads through
 * Multicall3. Anything unmapped degrades to a zero word so a polled read renders "loading"/empty.
 *
 * @param rpcUrlGlob the RPC URL glob to intercept.
 * @param opts.scenario which FeeArena/NPM state to serve ('entryOpen' | 'settled' | 'idle').
 * @param opts.usdcAddress / opts.baseAddress / opts.feeArenaAddress / opts.npmAddress live addresses
 *        (so routing matches the built env). All default to the live cirBTC-market values.
 */
export async function mockRpc(
  page: Page,
  rpcUrlGlob: string,
  opts: {
    scenario?: MockScenario;
    usdcAddress?: string;
    baseAddress?: string;
    feeArenaAddress?: string;
    feeArenaV1Address?: string;
    lensAddress?: string;
    npmAddress?: string;
    poolAddress?: string;
  } = {},
): Promise<void> {
  const scenario: MockScenario = opts.scenario ?? 'idle';
  // The Lens routes the v2 read surface. Default to the live v2 Lens; pass lensAddress:'' to force the
  // v1 (legacy) read path (collapsed EpochView + arena getUserStakes) for a v1-market e2e.
  const lens = opts.lensAddress !== undefined ? opts.lensAddress : DEFAULT_ADDRS.lens;
  const addrs: MockAddrs = {
    usdc: (opts.usdcAddress ?? DEFAULT_ADDRS.usdc).toLowerCase(),
    base: (opts.baseAddress ?? DEFAULT_ADDRS.base).toLowerCase(),
    feeArena: (opts.feeArenaAddress ?? DEFAULT_ADDRS.feeArena).toLowerCase(),
    feeArenaV1: (opts.feeArenaV1Address ?? DEFAULT_ADDRS.feeArenaV1).toLowerCase(),
    lens: lens ? lens.toLowerCase() : undefined,
    npm: (opts.npmAddress ?? DEFAULT_ADDRS.npm).toLowerCase(),
    pool: (opts.poolAddress ?? DEFAULT_ADDRS.pool).toLowerCase(),
  };

  await page.route(rpcUrlGlob, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    const body = JSON.parse(req.postData() || '{}');
    const calls = Array.isArray(body) ? body : [body];
    const results = calls.map((c: { id: number; method: string; params?: unknown[] }) => {
      let result: unknown = null;
      switch (c.method) {
        case 'eth_chainId':
          result = CHAIN_ID_HEX;
          break;
        case 'eth_blockNumber':
          result = '0x1';
          break;
        case 'eth_getLogs':
          // History/leaderboard backfill: no logs -> components render their empty state.
          result = [];
          break;
        case 'eth_getCode':
          result = NONEMPTY_CODE; // bytecode-exists guard passes
          break;
        case 'eth_getBlockByNumber':
          // minimal block with a timestamp for useChainTime
          result = { number: '0x1', timestamp: '0x6655c0c0', hash: '0x' + '0'.repeat(64) };
          break;
        case 'eth_gasPrice':
        case 'eth_maxPriorityFeePerGas':
          result = '0x4a817c800'; // 20 gwei
          break;
        case 'eth_feeHistory':
          result = { oldestBlock: '0x1', baseFeePerGas: ['0x1', '0x1'], gasUsedRatio: [0], reward: [['0x1']] };
          break;
        case 'eth_estimateGas':
          result = '0x5208';
          break;
        case 'eth_getTransactionCount':
          result = '0x0';
          break;
        case 'eth_getBalance':
          result = '0x0'; // wallet shows a zero gas balance (no funds) — dashboard still renders
          break;
        case 'eth_getTransactionReceipt':
          // Serve a success receipt only for the canned write hash; everything else is unmined.
          result = (c.params as string[])?.[0]?.toLowerCase() === TX_HASH ? txReceipt() : null;
          break;
        case 'eth_getTransactionByHash':
          result =
            (c.params as string[])?.[0]?.toLowerCase() === TX_HASH
              ? { hash: TX_HASH, blockNumber: '0x1', blockHash: '0x' + '0'.repeat(64), from: TEST_ACCOUNT, to: '0x' + '0'.repeat(40), input: '0x', value: '0x0', nonce: '0x0', gas: '0x5208', type: '0x2' }
              : null;
          break;
        case 'eth_call': {
          const callParams = (c.params as Array<{ to?: string; data?: string }>)?.[0];
          const toAddr = (callParams?.to ?? '').toLowerCase();
          const data = callParams?.data ?? '0x';
          const selector = strip0x(data).slice(0, 8).toLowerCase();
          if (toAddr === MULTICALL3 && selector === '82ad56cb') {
            // Boot gate / batched reads via Multicall3.aggregate3 — answer EACH inner call by selector.
            const inner = decodeAggregate3Calls(data);
            if (inner.length > 0) {
              result = encodeAggregate3Return(
                inner.map((ic) => answerCall(ic.target, ic.callData, scenario, addrs)),
              );
            } else {
              // Could not decode — fall back to a single USDC=6 result so the boot gate still passes.
              result = encodeAggregate3Return([encodeUint8(USDC_DECIMALS)]);
            }
          } else if (toAddr === MULTICALL3) {
            // Other multicall variant — return an empty-ish word.
            result = '0x' + word(0);
          } else {
            // Direct (non-batched) contract read / simulate: answer by selector against the target.
            result = answerCall(toAddr, data, scenario, addrs);
          }
          break;
        }
        default:
          result = null;
      }
      return { jsonrpc: '2.0', id: c.id, result };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Array.isArray(body) ? results : results[0]),
    });
  });
}

/**
 * Drive the real header connect flow: click "Connect Wallet" so wagmi's injected() connector runs
 * eth_requestAccounts against the mock provider and the app flips to the connected state. Reads gated
 * on isConnected (ClaimUnstakePanel, the owned-positions picker, gas balance) only run after this.
 * Idempotent-ish: if already connected (the short address chip is shown) it's a no-op.
 */
export async function connectWallet(page: import('@playwright/test').Page): Promise<void> {
  const disconnectBtn = page.getByRole('button', { name: /^Disconnect$/ });
  const connectBtn = page.getByRole('button', { name: /^Connect Wallet$/ });
  // Click "Connect Wallet" until the connected state appears (the Disconnect button replaces it). The
  // first click can land before React hydrates the onClick handler, so retry a few times. wagmi's
  // injected() connector runs eth_requestAccounts against the mock provider on click.
  for (let i = 0; i < 8; i++) {
    if ((await disconnectBtn.count()) > 0) return; // already connected
    if ((await connectBtn.count()) > 0) {
      await connectBtn.first().click().catch(() => {});
    }
    try {
      await disconnectBtn.waitFor({ state: 'visible', timeout: 2_000 });
      return;
    } catch {
      // not connected yet — loop and retry the click (hydration race).
    }
  }
  await disconnectBtn.waitFor({ state: 'visible', timeout: 5_000 });
}

/**
 * Switch the active market by clicking its tab in the MarketSelector. Post-cutover the LIVE v1 arena is
 * the DEFAULT (MARKETS[0]); the v2 conviction arena is a SECONDARY entry (id "btc-v2"). The v2 e2e flows
 * (stake/claim/withdraw) therefore select the v2 market explicitly after boot so the v2 read/write
 * surface (raw EpochV2 + Lens previews + conviction stake) is active. The selector only renders when 2+
 * markets are configured (the e2e env lists both), so the tab is present.
 */
export async function selectMarket(page: Page, marketId: string): Promise<void> {
  // The MarketSelector can render in more than one place (e.g. the header AND a dashboard section), so
  // there may be multiple tabs with the same testid. They all drive the SAME market context — click the
  // first and assert ANY instance flips active (data-active="true").
  const tab = page.getByTestId(`market-tab-${marketId}`).first();
  await tab.waitFor({ state: 'visible', timeout: 15_000 });
  await tab.click();
  await page.locator(`[data-testid="market-tab-${marketId}"][data-active="true"]`).first().waitFor({
    state: 'visible',
    timeout: 10_000,
  });
}

export { TEST_ACCOUNT, CHAIN_ID_HEX, TX_HASH, FEE_TIER, TOKEN_ID, decodeFunctionData };
