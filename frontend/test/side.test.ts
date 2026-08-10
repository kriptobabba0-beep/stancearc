import { describe, it, expect } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { Side } from '@/lib/types';
import { encodeSide, decodeSide, isValidStakeSide, sideLabel, SIDE_COLOR } from '@/lib/side';

describe('encodeSide / decodeSide round-trip', () => {
  it('encodes UP/DOWN/RANGE to a 32-byte uint8 word and decodes back', () => {
    for (const s of [Side.UP, Side.DOWN, Side.RANGE]) {
      const data = encodeSide(s);
      expect(data.length).toBe(66); // 0x + 64 hex chars (32 bytes)
      expect(decodeSide(data)).toBe(s);
      // matches the contract's abi.decode(data,(uint8)) scheme:
      const [raw] = decodeAbiParameters([{ type: 'uint8' }], data);
      expect(Number(raw)).toBe(s);
    }
  });
  it('rejects NONE on encode', () => {
    expect(() => encodeSide(Side.NONE)).toThrow();
  });
});

describe('isValidStakeSide', () => {
  it('UP/DOWN/RANGE valid; NONE invalid', () => {
    expect(isValidStakeSide(Side.UP)).toBe(true);
    expect(isValidStakeSide(Side.DOWN)).toBe(true);
    expect(isValidStakeSide(Side.RANGE)).toBe(true);
    expect(isValidStakeSide(Side.NONE)).toBe(false);
  });
});

describe('labels + colors', () => {
  it('labels each side', () => {
    expect(sideLabel(Side.UP)).toBe('UP');
    expect(sideLabel(Side.DOWN)).toBe('DOWN');
    expect(sideLabel(Side.RANGE)).toBe('RANGE');
    expect(sideLabel(Side.NONE)).toBe('NONE');
  });
  it('color tokens map UP/DOWN/RANGE to semantic side colors', () => {
    expect(SIDE_COLOR[Side.UP]).toContain('side-up');
    expect(SIDE_COLOR[Side.DOWN]).toContain('side-down');
    expect(SIDE_COLOR[Side.RANGE]).toContain('side-range');
  });
});
