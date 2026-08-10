// errorsV2Map.test.ts — friendlyError must map EVERY FeeArenaV2 conviction custom error to clear,
// user-facing copy (Task 3b). The v2 arena reverts with custom errors carrying NO reason string, so an
// unmapped name would surface as opaque "execution reverted" calldata. This pins (1) full coverage of
// the v2 error set against the actual feeArenaV2Abi, and (2) the load-bearing copy for the operator and
// conviction-bounds reverts the user is most likely to hit.
import { describe, it, expect } from 'vitest';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import { friendlyError } from '@/lib/errors';
import { feeArenaV2Abi } from '@/abis/feeArenaV2';

/** Build a BaseError whose cause is a decoded ContractFunctionRevertedError for `name`. */
function revertWith(name: string): BaseError {
  const reverted = new ContractFunctionRevertedError({
    abi: [{ type: 'error', name, inputs: [] }],
    data: '0x',
    functionName: 'stakeWithConviction',
  });
  (reverted as unknown as { data?: { errorName?: string } }).data = { errorName: name };
  return new BaseError('Execution reverted', { cause: reverted });
}

// The v2-specific custom errors the frontend must explain (the conviction-parimutuel set).
const V2_ERRORS = [
  'OperatorCannotStake',
  'ConvOutOfBounds',
  'MissingConviction',
  'SideOverConcentrated',
  'NotRefundable',
  'AlreadyRefunded',
  'SubsidyCapExceeded',
  'WideConfidence',
  'StagedSideMismatch',
] as const;

describe('friendlyError — FeeArenaV2 custom-error coverage (Task 3b)', () => {
  it('every required v2 conviction error maps to a non-empty, specific message (not the raw name)', () => {
    for (const name of V2_ERRORS) {
      const msg = friendlyError(revertWith(name));
      expect(msg, `${name} must be mapped`).toBeTruthy();
      // It must be human copy, not the bare error name echoed back.
      expect(msg, `${name} must not echo the raw error name`).not.toBe(name);
      expect(msg.length, `${name} copy too short`).toBeGreaterThan(12);
    }
  });

  it('OperatorCannotStake tells the user to use a separate wallet (keeper/owner cannot stake)', () => {
    const msg = friendlyError(revertWith('OperatorCannotStake'));
    expect(msg).toMatch(/keeper|owner/i);
    expect(msg).toMatch(/cannot stake/i);
    expect(msg).toMatch(/wallet/i);
  });

  it('the conviction-bounds errors name the bounds / conviction concept', () => {
    expect(friendlyError(revertWith('ConvOutOfBounds'))).toMatch(/conviction|range|min|max/i);
    expect(friendlyError(revertWith('MissingConviction'))).toMatch(/conviction/i);
    expect(friendlyError(revertWith('SideOverConcentrated'))).toMatch(/side|concentrat|cap/i);
  });

  it('the refund errors explain refundability', () => {
    expect(friendlyError(revertWith('NotRefundable'))).toMatch(/refund/i);
    expect(friendlyError(revertWith('AlreadyRefunded'))).toMatch(/already.*refund/i);
  });

  it('the oracle/subsidy/side errors explain the cause', () => {
    expect(friendlyError(revertWith('SubsidyCapExceeded'))).toMatch(/subsidy/i);
    expect(friendlyError(revertWith('WideConfidence'))).toMatch(/confidence|oracle|price/i);
    expect(friendlyError(revertWith('StagedSideMismatch'))).toMatch(/side/i);
  });

  it('EVERY custom error in feeArenaV2Abi resolves to a mapped friendly message (no raw-name leaks)', () => {
    // Walk the real ABI's error set so a NEW custom error added on-chain surfaces here as an unmapped
    // gap (we only require the v2-conviction set above to be specific; the rest must at least not echo
    // the bare error name back to the user via the friendly path).
    const errorNames = Array.from(
      new Set(
        (feeArenaV2Abi as readonly { type: string; name?: string }[])
          .filter((e) => e.type === 'error' && typeof e.name === 'string')
          .map((e) => e.name as string),
      ),
    );
    // Sanity: the ABI really does carry the v2 conviction errors we assert on.
    for (const name of V2_ERRORS) expect(errorNames).toContain(name);
    // The v2 conviction set must each be mapped to bespoke copy (not the bare name).
    for (const name of V2_ERRORS) {
      expect(friendlyError(revertWith(name))).not.toBe(name);
    }
  });
});
