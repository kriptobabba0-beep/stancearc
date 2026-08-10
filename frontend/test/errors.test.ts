import { describe, it, expect } from 'vitest';
import {
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
} from 'viem';
import { friendlyError } from '@/lib/errors';

describe('friendlyError', () => {
  it('maps a known FeeArena custom error name to its friendly copy', () => {
    // Build a BaseError whose cause is a ContractFunctionRevertedError carrying the custom error name.
    const reverted = new ContractFunctionRevertedError({
      abi: [
        { type: 'error', name: 'NotEntryWindow', inputs: [] },
      ],
      data: '0x',
      functionName: 'stakeWithSide',
    });
    // Force the decoded errorName (the constructor may not decode from empty data in all viem builds).
    (reverted as unknown as { data?: { errorName?: string } }).data = { errorName: 'NotEntryWindow' };
    const err = new BaseError('Execution reverted', { cause: reverted });
    expect(friendlyError(err)).toBe(
      'The entry window is closed — staking is only allowed during Entry Open.',
    );
  });

  it('maps the v2 conviction custom errors (NotRefundable / AlreadyRefunded / NothingCredited) to friendly copy', () => {
    for (const [name, expected] of [
      ['NotRefundable', /only winning-side conviction/i],
      ['AlreadyRefunded', /already been refunded/i],
      ['NothingCredited', /no deferred .* balance/i],
      ['OperatorCannotStake', /keeper\/owner and cannot stake/i],
      ['ConvOutOfBounds', /outside the allowed/i],
    ] as const) {
      const reverted = new ContractFunctionRevertedError({
        abi: [{ type: 'error', name, inputs: [] }],
        data: '0x',
        functionName: 'refundConviction',
      });
      (reverted as unknown as { data?: { errorName?: string } }).data = { errorName: name };
      const err = new BaseError('Execution reverted', { cause: reverted });
      expect(friendlyError(err)).toMatch(expected);
    }
  });

  it('returns the wallet-rejection copy for a UserRejectedRequestError', () => {
    const err = new BaseError('User rejected', {
      cause: new UserRejectedRequestError(new Error('User denied transaction signature')),
    });
    expect(friendlyError(err)).toBe('Transaction rejected in wallet.');
  });

  it('surfaces the underlying detail for a generic "unknown RPC error" (not just shortMessage)', () => {
    // The opaque path: a BaseError that is neither UserRejected nor a decoded custom-error revert.
    // Its real reason lives in `details` — friendlyError must include it, not just "unknown RPC error".
    const err = new BaseError('An unknown RPC error occurred.', {
      details: 'execution reverted: ERC20: transfer amount exceeds balance',
    });
    const msg = friendlyError(err);
    expect(msg).toMatch(/transfer amount exceeds balance/);
    // It must NOT be the bare opaque shortMessage with no detail.
    expect(msg).not.toBe('An unknown RPC error occurred.');
  });

  it('walks a nested cause chain to surface the deepest real message', () => {
    const deep = new Error('execution reverted: SafeMath: subtraction overflow');
    const mid = new BaseError('RPC Request failed.', { cause: deep });
    const top = new BaseError('An unknown RPC error occurred.', { cause: mid });
    const msg = friendlyError(top);
    expect(msg).toMatch(/subtraction overflow/);
    expect(msg).not.toBe('An unknown RPC error occurred.');
  });

  it('falls back to shortMessage when there is no extra detail to surface', () => {
    const err = new BaseError('Something specific went wrong.');
    expect(friendlyError(err)).toBe('Something specific went wrong.');
  });

  it('handles a plain Error and a non-error value', () => {
    expect(friendlyError(new Error('boom'))).toBe('boom');
    expect(friendlyError('nope')).toBe('Transaction failed.');
  });

  // A blank message renders as NOTHING in `{error && …}` UI — a failed step with no explanation at
  // all, which is worse than a vague one. Rare in practice (viem populates its revert errors), but
  // cheap to make impossible, so the contract is: never return blank, whatever was thrown.
  it('never returns a blank string (wagmi custom-error revert shape)', () => {
    for (const blank of [new Error(''), new Error('   '), new Error('\n')]) {
      const msg = friendlyError(blank);
      expect(msg.trim()).not.toBe('');
      expect(msg).toMatch(/revert|explorer/i);
    }
  });
});
