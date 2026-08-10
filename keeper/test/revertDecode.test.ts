// revertDecode.test.ts — unit coverage for classifyRevert(). We mimic the three viem error
// SHAPES with plain JS objects (real viem error classes aren't needed for the selector/message
// paths): a structured `{ data: '0x<selector>' }`, a nested `{ cause: { ... } }` chain, and a
// plain Error whose message carries the bare error name. Expected selectors are recomputed here
// with viem's toFunctionSelector so the test never hardcodes a hash that could drift.
import { describe, it, expect } from 'vitest';
import { toFunctionSelector, BaseError, ContractFunctionRevertedError } from 'viem';
import { classifyRevert, type RevertInfo } from '../src/revertDecode.js';

// The exact set the module recognizes, re-listed so the test owns its own source of truth.
const KNOWN_NAMES = [
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

const selectorFor = (name: string) => toFunctionSelector(`${name}()`).toLowerCase();

describe('classifyRevert — selector shape (raw .data hex)', () => {
  for (const name of KNOWN_NAMES) {
    it(`classifies ${name} from a raw .data selector`, () => {
      const selector = selectorFor(name);
      const info: RevertInfo = classifyRevert({ data: selector });
      expect(info.name).toBe(name);
      expect(info.selector).toBe(selector);
      expect(info.isStale).toBe(name === 'StalePrice');
    });
  }

  it('matches a selector that is the PREFIX of longer revert calldata', () => {
    // Real revert data for a zero-arg error is exactly the 4-byte selector, but the contract
    // could pad it — startsWith semantics must still classify it.
    const selector = selectorFor('WrongPhase');
    const padded = selector + '00'.repeat(28);
    const info = classifyRevert({ data: padded });
    expect(info.name).toBe('WrongPhase');
    expect(info.selector).toBe(selector);
    expect(info.isStale).toBe(false);
  });

  it('matches a selector carried on .signature (undecoded-ABI simulate shape)', () => {
    const info = classifyRevert({ signature: selectorFor('SettleTooEarly') });
    expect(info.name).toBe('SettleTooEarly');
  });
});

describe('classifyRevert — isStale is exclusive to StalePrice', () => {
  it('StalePrice → isStale: true', () => {
    expect(classifyRevert({ data: selectorFor('StalePrice') }).isStale).toBe(true);
  });

  it('every other known error → isStale: false', () => {
    for (const name of KNOWN_NAMES) {
      if (name === 'StalePrice') continue;
      expect(classifyRevert({ data: selectorFor(name) }).isStale).toBe(false);
    }
  });
});

describe('classifyRevert — nested .cause chain', () => {
  it('finds a raw selector nested two levels deep in .cause', () => {
    const selector = selectorFor('ProcessNotComplete');
    const err = {
      message: 'execution reverted',
      cause: {
        message: 'call exception',
        cause: { code: 3, message: 'reverted', data: selector },
      },
    };
    const info = classifyRevert(err);
    expect(info.name).toBe('ProcessNotComplete');
    expect(info.selector).toBe(selector);
  });

  it('does not loop forever on a cyclic .cause chain', () => {
    const a: Record<string, unknown> = { message: 'a' };
    const b: Record<string, unknown> = { message: 'b', cause: a };
    a.cause = b; // cycle
    expect(classifyRevert(a)).toEqual({ name: 'unknown', isStale: false });
  });
});

describe('classifyRevert — ContractFunctionRevertedError decoded path', () => {
  it('uses data.errorName from a CFRE in the BaseError walk chain', () => {
    // Construct a minimal CFRE and stuff the decoded errorName, then wrap it in a BaseError so
    // .walk() finds it — exercising priority (1).
    const cfre = Object.create(ContractFunctionRevertedError.prototype) as ContractFunctionRevertedError;
    (cfre as unknown as { data: unknown }).data = { errorName: 'NotSettled' };
    const wrapper = new BaseError('settle failed');
    (wrapper as unknown as { walk: (fn: (e: unknown) => boolean) => unknown }).walk = (fn) =>
      fn(cfre) ? cfre : null;
    const info = classifyRevert(wrapper);
    expect(info.name).toBe('NotSettled');
    expect(info.selector).toBe(selectorFor('NotSettled'));
    expect(info.isStale).toBe(false);
  });
});

describe('classifyRevert — message-substring fallback', () => {
  it('classifies a message-only Error("execution reverted: StalePrice()")', () => {
    const info = classifyRevert(new Error('execution reverted: StalePrice()'));
    expect(info.name).toBe('StalePrice');
    expect(info.isStale).toBe(true);
  });

  it('classifies a bare known name embedded in a longer message', () => {
    const info = classifyRevert(new Error('Error: VM Exception: custom error GraceNotElapsed'));
    expect(info.name).toBe('GraceNotElapsed');
  });
});

describe('classifyRevert — unrelated / unknown errors', () => {
  it('plain Error("connection refused") → unknown', () => {
    expect(classifyRevert(new Error('connection refused'))).toEqual({
      name: 'unknown',
      isStale: false,
    });
  });

  it('unrelated selector { data: "0xdeadbeef" } → unknown', () => {
    expect(classifyRevert({ data: '0xdeadbeef' })).toEqual({ name: 'unknown', isStale: false });
  });

  it('null / undefined / non-object → unknown', () => {
    expect(classifyRevert(null)).toEqual({ name: 'unknown', isStale: false });
    expect(classifyRevert(undefined)).toEqual({ name: 'unknown', isStale: false });
    expect(classifyRevert(42)).toEqual({ name: 'unknown', isStale: false });
  });

  it('a string that is not a known name → unknown', () => {
    expect(classifyRevert('totally unrelated')).toEqual({ name: 'unknown', isStale: false });
  });
});
