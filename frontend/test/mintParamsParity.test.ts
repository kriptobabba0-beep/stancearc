// test/mintParamsParity.test.ts
//
// TS↔Solidity PARITY CHECK for buildMintParams / fullRangeTicks / tickSpacingForFee.
//
// PURPOSE: assert that the TypeScript on-ramp builder (frontend/hooks/useMintPosition.ts) matches
// the Solidity reference in DeployMarket._seed and V3Deployer._buildMintParams for:
//   - tick computation (aligned full-range ticks for each fee tier)
//   - token ordering (address-sorted, driven by baseIsToken0)
//   - amount mapping (base/USDC amounts land in the correct token0/token1 slots)
//   - decimal handling (WETH 18dp, WBTC 8dp, USDC 6dp)
//
// WHAT THIS COVERS:
//   - Pure TypeScript logic of buildMintParams + helpers — no RPC, no wallet, no wagmi.
//   - Parity between the TS builder and the Solidity reference constants (hard-coded below with
//     citations so a future divergence is caught by a test failure, not a live mint).
//
// WHAT THIS DOES NOT COVER:
//   - Live contract execution or on-chain validation.
//   - sqrtPriceX96 / pool initialisation.
//   - Gas floor, simulate/writeContract flow (covered by useMintPosition.test.tsx).
//   - Slippage mins (intentionally 0 on testnet — a separate mainnet task).

import { describe, it, expect, vi } from 'vitest';
import { parseUnits } from 'viem';

// useMintPosition.ts imports from @/lib/env and @/lib/contracts at module load time,
// which tries to read NEXT_PUBLIC_* env vars. Stub both to avoid the env-guard throw.
vi.mock('@/lib/env', () => ({ ENV: { FEE_TIER: 3000 } }));
vi.mock('@/lib/contracts', () => ({
  npm: { address: '0x00000000000000000000000000000000000000aa' as const, abi: [] },
  usdc: { address: '0x0000000000000000000000000000000000000002' as const, abi: [] },
}));
// Stub wagmi hooks that useMintPosition imports (not called by the pure helpers, but the module
// imports them at the top level, so they must resolve).
vi.mock('wagmi', () => ({
  useAccount: vi.fn(),
  usePublicClient: vi.fn(),
  useWriteContract: vi.fn(),
  useWaitForTransactionReceipt: vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: vi.fn() }));
vi.mock('@/hooks/useActiveBaseToken', () => ({ useActiveBaseToken: vi.fn() }));
vi.mock('@/hooks/usePollInterval', () => ({ bumpPollAfterWrite: vi.fn() }));
vi.mock('@/lib/chain', () => ({ withGasFloor: (r: unknown) => r }));
vi.mock('@/lib/errors', () => ({ friendlyError: (e: unknown) => String(e) }));
import { buildMintParams, fullRangeTicks, tickSpacingForFee } from '@/hooks/useMintPosition';

// ---------------------------------------------------------------------------
// Solidity reference constants
// ---------------------------------------------------------------------------
// Source: test/utils/V3Deployer.sol lines 23–25 (int24 constants)
//   int24 internal constant TICK_SPACING_3000 = 60;
//   int24 internal constant MIN_TICK = -887272;
//   int24 internal constant MAX_TICK = 887272;
//
// And _buildMintParams (V3Deployer.sol lines 103–110):
//   int24 spacing = TICK_SPACING_3000; // 60 for fee 3000
//   tickLower: (MIN_TICK / spacing) * spacing  = (-887272 / 60) * 60 = -14787 * 60 = -887220
//   tickUpper: (MAX_TICK / spacing) * spacing  = ( 887272 / 60) * 60 =  14787 * 60 =  887220
//
// DeployMarket._seed (script/DeployMarket.s.sol lines 153–155) uses the identical formula:
//   int24 tickLower = (int24(-887272) / spacing) * spacing;
//   int24 tickUpper = (int24(887272) / spacing) * spacing;
// which yields the same ±887220 for the 0.3% (3000) fee tier.

const SOL_TICK_LOWER_3000 = -887220; // derived above
const SOL_TICK_UPPER_3000 = 887220;

// Spacing per fee tier — must match tickSpacingForFee() in useMintPosition.ts.
// Reference: Uniswap V3 whitepaper / factory constants (not in local Solidity, standard protocol).
const SOL_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

// Full-range ticks for non-3000 tiers, derived with the same Solidity integer-division formula:
//   tickLower = (-887272 / spacing) * spacing
//   tickUpper = ( 887272 / spacing) * spacing
function solidityFullRangeTicks(feeTier: number): { tickLower: number; tickUpper: number } {
  const spacing = SOL_SPACING[feeTier];
  const upper = Math.trunc(887272 / spacing) * spacing; // integer division matches Solidity
  return { tickLower: -upper, tickUpper: upper };
}

// Test addresses — deliberately chosen so address order can be tested deterministically.
// WETH sorts AFTER USDC (0xee > 0x00), so in a WETH/USDC pool: token0=USDC, token1=WETH —
// unless the pool was created the other way (we test both via baseIsToken0).
const BASE_WETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const; // high address
const BASE_WBTC = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const; // high address
const USDC_ADDR = '0x0000000000000000000000000000000000000002' as const; // low address
const RECIPIENT = '0x1111111111111111111111111111111111111111' as const;
const NOW_SEC = 2_000_000n;

// ---------------------------------------------------------------------------
// Tick helpers
// ---------------------------------------------------------------------------
describe('tickSpacingForFee — matches Uniswap V3 protocol constants', () => {
  it.each([
    [100, 1],
    [500, 10],
    [3000, 60],
    [10000, 200],
  ])('fee %i -> spacing %i', (fee, spacing) => {
    expect(tickSpacingForFee(fee)).toBe(spacing);
  });

  it('unknown fee tier falls back to 60 (0.3% default)', () => {
    expect(tickSpacingForFee(9999)).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Full-range ticks — parity with Solidity reference
// ---------------------------------------------------------------------------
describe('fullRangeTicks — parity with DeployMarket._seed / V3Deployer._buildMintParams', () => {
  it('0.3% tier (3000): tickLower=-887220, tickUpper=887220 — matches Solidity ±887272 aligned to spacing 60', () => {
    // Hard-coded Solidity reference: (-887272 / 60) * 60 = -887220, (887272 / 60) * 60 = 887220
    // (V3Deployer.sol lines 108–109; DeployMarket.s.sol lines 154–155)
    const { tickLower, tickUpper } = fullRangeTicks(3000);
    expect(tickLower).toBe(SOL_TICK_LOWER_3000);
    expect(tickUpper).toBe(SOL_TICK_UPPER_3000);
  });

  it.each([100, 500, 10000])('fee %i: TS ticks match Solidity integer-division formula', (fee) => {
    const ts = fullRangeTicks(fee);
    const sol = solidityFullRangeTicks(fee);
    expect(ts.tickLower).toBe(sol.tickLower);
    expect(ts.tickUpper).toBe(sol.tickUpper);
  });
});

// ---------------------------------------------------------------------------
// Token ordering — parity with DeployMarket._seed address-sort
// ---------------------------------------------------------------------------
// DeployMarket._seed (line 157-160): token0 = pool.token0() = address-sorted lower.
// buildMintParams uses `baseIsToken0` (supplied by useActiveBaseToken from the live pool),
// which already reflects the on-chain sort. We verify both orderings.

describe('buildMintParams — token ordering matches address-sort (DeployMarket._seed parity)', () => {
  it('baseIsToken0=true: base is token0, USDC is token1 (base address < USDC address on-chain)', () => {
    // Simulate a market where base sorts before USDC (base address < USDC address).
    const p = buildMintParams({
      baseToken: BASE_WETH,
      usdcToken: USDC_ADDR,
      baseIsToken0: true, // pool.token0() == base
      feeTier: 3000,
      baseAmount: parseUnits('1', 18),
      usdcAmount: parseUnits('2000', 6),
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    // Token ordering (mirrors DeployMarket._seed token0 = baseToken when base < usdc)
    expect(p.token0).toBe(BASE_WETH);
    expect(p.token1).toBe(USDC_ADDR);
    // Amount mapping: amount0=base, amount1=USDC
    expect(p.amount0Desired).toBe(parseUnits('1', 18));
    expect(p.amount1Desired).toBe(parseUnits('2000', 6));
  });

  it('baseIsToken0=false: USDC is token0, base is token1 (USDC address < base address on-chain)', () => {
    // Simulate a market where USDC sorts before base (USDC address < base address).
    const p = buildMintParams({
      baseToken: BASE_WBTC,
      usdcToken: USDC_ADDR,
      baseIsToken0: false, // pool.token0() == USDC
      feeTier: 3000,
      baseAmount: parseUnits('0.01', 8),
      usdcAmount: parseUnits('600', 6),
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    // Token ordering (mirrors DeployMarket._seed: token1 = baseToken when usdc < base)
    expect(p.token0).toBe(USDC_ADDR);
    expect(p.token1).toBe(BASE_WBTC);
    // Amount mapping: amount0=USDC (token0), amount1=base (token1)
    expect(p.amount0Desired).toBe(parseUnits('600', 6));
    expect(p.amount1Desired).toBe(parseUnits('0.01', 8));
  });
});

// ---------------------------------------------------------------------------
// Decimal handling — WETH (18dp), WBTC (8dp), USDC (6dp)
// ---------------------------------------------------------------------------
describe('buildMintParams — correct decimal handling per token', () => {
  it('WETH (18dp) base: parseUnits amounts survive round-trip with no precision loss', () => {
    const baseAmt = parseUnits('2.5', 18); // 2.5 WETH
    const usdcAmt = parseUnits('5000', 6); // 5000 USDC
    const p = buildMintParams({
      baseToken: BASE_WETH,
      usdcToken: USDC_ADDR,
      baseIsToken0: true,
      feeTier: 3000,
      baseAmount: baseAmt,
      usdcAmount: usdcAmt,
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    expect(p.amount0Desired).toBe(baseAmt);
    expect(p.amount1Desired).toBe(usdcAmt);
  });

  it('WBTC (8dp) base: 8-dp amounts are not confused with 18-dp amounts', () => {
    const baseAmt = parseUnits('0.5', 8); // 0.5 WBTC = 50_000_000n (NOT 18dp)
    const usdcAmt = parseUnits('15000', 6);
    const p = buildMintParams({
      baseToken: BASE_WBTC,
      usdcToken: USDC_ADDR,
      baseIsToken0: false, // USDC sorts first for these test addresses
      feeTier: 3000,
      baseAmount: baseAmt,
      usdcAmount: usdcAmt,
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    // USDC is token0 when baseIsToken0=false
    expect(p.amount0Desired).toBe(usdcAmt);
    expect(p.amount1Desired).toBe(baseAmt);
    // Sanity: WBTC amount is 8-dp, not accidentally inflated
    expect(p.amount1Desired).toBe(50_000_000n);
  });
});

// ---------------------------------------------------------------------------
// Invariants — fields that must be fixed regardless of inputs
// ---------------------------------------------------------------------------
describe('buildMintParams — fixed invariants (zero slippage mins, deadline, fee)', () => {
  it('amount0Min and amount1Min are always 0n (testnet: no MEV risk)', () => {
    const p = buildMintParams({
      baseToken: BASE_WETH,
      usdcToken: USDC_ADDR,
      baseIsToken0: true,
      feeTier: 3000,
      baseAmount: parseUnits('1', 18),
      usdcAmount: parseUnits('2000', 6),
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    // Zero slippage mins — mirrors DeployMarket._seed: amount0Min: 0, amount1Min: 0 (line 168-169)
    expect(p.amount0Min).toBe(0n);
    expect(p.amount1Min).toBe(0n);
  });

  it('deadline is nowSec + 3600 (far-future for testnet UX, matches _seed deadline formula)', () => {
    // DeployMarket._seed line 172: deadline: block.timestamp + 3600
    const p = buildMintParams({
      baseToken: BASE_WETH,
      usdcToken: USDC_ADDR,
      baseIsToken0: true,
      feeTier: 3000,
      baseAmount: 1n,
      usdcAmount: 1n,
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    expect(p.deadline).toBe(NOW_SEC + 3600n);
  });

  it('fee field equals the provided feeTier', () => {
    const p = buildMintParams({
      baseToken: BASE_WETH,
      usdcToken: USDC_ADDR,
      baseIsToken0: true,
      feeTier: 500,
      baseAmount: 1n,
      usdcAmount: 1n,
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    expect(p.fee).toBe(500);
  });

  it('recipient is passed through unchanged', () => {
    const p = buildMintParams({
      baseToken: BASE_WETH,
      usdcToken: USDC_ADDR,
      baseIsToken0: true,
      feeTier: 3000,
      baseAmount: 1n,
      usdcAmount: 1n,
      recipient: RECIPIENT,
      nowSec: NOW_SEC,
    });
    expect(p.recipient).toBe(RECIPIENT);
  });
});
