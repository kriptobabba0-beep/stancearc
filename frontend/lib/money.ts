// lib/money.ts — BigInt money math mirroring the FeeArena contract (Math.mulDiv FLOOR).
// Scale derived from cached decimals (NEVER the magic literal 1e30). Format only at render.
// payWETH/payUSDC = mulDiv(pot, contribution6, winnerDenominator) floor — unit-agnostic ratio stays valid.
import type { BootDecimals } from '@/lib/types';

/** Floor multiply-divide: floor(a * b / denom). Mirrors OZ Math.mulDiv (floor). */
export function mulDivFloor(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error('mulDivFloor: zero denominator');
  return (a * b) / denom; // BigInt division truncates toward zero (operands non-negative here)
}

/** WETH_NOTIONAL_DIV = 10 ** (wethDec + priceDec - usdcDec). 1e30 for 18+18-6. Derived, not hardcoded. */
export function wethNotionalDiv(d: BootDecimals): bigint {
  return 10n ** BigInt(d.weth + d.price - d.usdc);
}

/** Floor mixed payout = floor(pot * contribution6 / winnerDenominator) per leg. Returns 0 when denom==0. */
export function payoutFloor(args: {
  potWETH: bigint; potUSDC: bigint; contribution6: bigint; winnerDenominator: bigint;
}): { payWETH: bigint; payUSDC: bigint } {
  if (args.winnerDenominator === 0n) return { payWETH: 0n, payUSDC: 0n };
  return {
    payWETH: mulDivFloor(args.potWETH, args.contribution6, args.winnerDenominator),
    payUSDC: mulDivFloor(args.potUSDC, args.contribution6, args.winnerDenominator),
  };
}

/** Clamp a share numerator so num/denom <= 1 (UI share never exceeds 1). denom==0 -> 0. */
export function clampShareNum(num: bigint, denom: bigint): bigint {
  if (denom === 0n) return 0n;
  return num > denom ? denom : num;
}
