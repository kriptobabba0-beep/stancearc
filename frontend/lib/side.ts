// lib/side.ts — Side enum encode/decode (single pinned scheme) + labels/colors.
// Stake encoding: encodeAbiParameters([{type:'uint8'}],[side]) <-> the contract's
// onERC721Received: `data.length == 32` + `abi.decode(data,(uint8))`, rejecting NONE
// (raw < UP || raw > RANGE => BadSide). Verified against src/FeeArena.sol L306-309.
import { encodeAbiParameters, decodeAbiParameters, type Hex } from 'viem';
import { Side } from '@/lib/types';

/** True only for UP(1)/DOWN(2)/RANGE(3). NONE(0) is the sentinel and never stakeable. */
export function isValidStakeSide(side: Side): boolean {
  return side === Side.UP || side === Side.DOWN || side === Side.RANGE;
}

/** Encode a stakeable side as the single pinned 32-byte uint8 calldata word. Rejects NONE. */
export function encodeSide(side: Side): Hex {
  if (!isValidStakeSide(side)) throw new Error('encodeSide: NONE/invalid side rejected');
  return encodeAbiParameters([{ type: 'uint8' }], [side]);
}

/** Decode the pinned side word back to a Side. */
export function decodeSide(data: Hex): Side {
  const [raw] = decodeAbiParameters([{ type: 'uint8' }], data);
  return Number(raw) as Side;
}

export function sideLabel(side: Side): string {
  switch (side) {
    case Side.UP: return 'UP';
    case Side.DOWN: return 'DOWN';
    case Side.RANGE: return 'RANGE';
    default: return 'NONE';
  }
}

/** Tailwind color tokens — UP=green, DOWN=red, RANGE=blue (matches tailwind.config side tokens). */
export const SIDE_COLOR: Record<Side, string> = {
  [Side.NONE]: 'text-ink-faint',
  [Side.UP]: 'text-side-up',
  [Side.DOWN]: 'text-side-down',
  [Side.RANGE]: 'text-side-range',
};

/** Human-readable labels indexed by Side enum value (array form for O(1) lookup). */
export const SIDE_LABELS: Record<Side, string> = {
  [Side.NONE]: 'NONE',
  [Side.UP]: 'UP',
  [Side.DOWN]: 'DOWN',
  [Side.RANGE]: 'RANGE',
};

/** CSS hex colors for bar fills / presentational use (not Tailwind classes). */
export const SIDE_COLORS: Record<Side, string> = {
  [Side.NONE]: '#94A3B8',
  [Side.UP]: '#059669',
  [Side.DOWN]: '#E11D48',
  [Side.RANGE]: '#0284C7',
};

/** isStakeableSide: alias for isValidStakeSide (used in plan imports). */
export const isStakeableSide = isValidStakeSide;
