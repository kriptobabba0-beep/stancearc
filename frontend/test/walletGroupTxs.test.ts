import { describe, it, expect } from 'vitest';
import { classifyWalletTxs, isOutbound, type Role } from '@/lib/wallet/groupTxs';
import type { CircleTxDto } from '@/lib/circle/client';

const ME = '0xabc0000000000000000000000000000000000001';
const POOL = '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b';
const NPM = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x7fcef1330b4c21f884d6894f3d6a56036e587aa9';
const ARENA = '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f';
const RANDO = '0x2222222222222222222222222222222222222222';

const ROLES: Record<string, Role> = {
  [POOL]: 'pool',
  [NPM]: 'npm',
  [ROUTER]: 'router',
  [ARENA]: 'arena',
};
const role = (a?: string): Role | undefined => (a ? ROLES[a.toLowerCase()] : undefined);

let n = 0;
const tx = (o: Partial<CircleTxDto>): CircleTxDto => ({ id: `id${n++}`, state: 'COMPLETE', ...o });
const out = (o: Partial<CircleTxDto> = {}) => tx({ transactionType: 'OUTBOUND', ...o });
const inb = (o: Partial<CircleTxDto> = {}) => tx({ transactionType: 'INBOUND', ...o });

const classify = (txs: CircleTxDto[]) => classifyWalletTxs(txs, ME, role);

describe('isOutbound', () => {
  it('prefers transactionType, falls back to sourceAddress', () => {
    expect(isOutbound(out(), ME)).toBe(true);
    expect(isOutbound(inb(), ME)).toBe(false);
    expect(isOutbound(tx({ sourceAddress: ME }), ME)).toBe(true);
    expect(isOutbound(tx({}), ME)).toBe(false);
  });
});

describe('classifyWalletTxs — action classification', () => {
  it('SWAP: pool counterparty, one out + one in', () => {
    const rows = classify([
      out({ txHash: '0xs', amounts: ['0.0001'], destinationAddress: POOL }),
      inb({ txHash: '0xs', amounts: ['6.5'], sourceAddress: POOL }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'swap', txHash: '0xs' });
    expect(rows[0]!.outs).toHaveLength(1);
    expect(rows[0]!.ins).toHaveLength(1);
  });

  it('SWAP fallback: an out+in pair with NO recognized counterparty still collapses', () => {
    const rows = classify([
      out({ txHash: '0xs', amounts: ['1'] }),
      inb({ txHash: '0xs', amounts: ['2'] }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(['swap']);
  });

  it('ADD LIQUIDITY: pool/NPM counterparty, two outbound legs', () => {
    const rows = classify([
      out({ txHash: '0xa', amounts: ['0.001'], destinationAddress: NPM }),
      out({ txHash: '0xa', amounts: ['30'], destinationAddress: POOL }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(['addLiquidity']);
    expect(rows[0]!.outs).toHaveLength(2);
  });

  it('REMOVE LIQUIDITY: NPM counterparty, inbound legs only', () => {
    const rows = classify([
      inb({ txHash: '0xr', amounts: ['0.001'], sourceAddress: NPM }),
      inb({ txHash: '0xr', amounts: ['30'], sourceAddress: POOL }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(['removeLiquidity']);
  });

  it('ADD LIQUIDITY wins over swap when an out-heavy mint refunds dust (2 out + 1 in)', () => {
    const rows = classify([
      out({ txHash: '0xa', amounts: ['0.001'], destinationAddress: POOL }),
      out({ txHash: '0xa', amounts: ['30'], destinationAddress: POOL }),
      inb({ txHash: '0xa', amounts: ['0.0000001'], sourceAddress: POOL }), // dust refund
    ]);
    expect(rows.map((r) => r.action)).toEqual(['addLiquidity']);
  });

  it('JOIN ARENA: arena counterparty, outbound (no tokens returned)', () => {
    const rows = classify([out({ txHash: '0xj', amounts: ['0.01'], destinationAddress: ARENA })]);
    expect(rows.map((r) => r.action)).toEqual(['joinArena']);
  });

  it('CLAIM FEES: arena counterparty, inbound payout', () => {
    const rows = classify([inb({ txHash: '0xc', amounts: ['12.5'], sourceAddress: ARENA })]);
    expect(rows.map((r) => r.action)).toEqual(['claimFees']);
  });

  it('ROUTER counterparty alone → swap', () => {
    const rows = classify([out({ txHash: '0xrt', amounts: ['1'], destinationAddress: ROUTER })]);
    expect(rows.map((r) => r.action)).toEqual(['swap']);
  });

  it('plain SEND / RECEIVE to an unknown party stay separate', () => {
    const rows = classify([
      out({ txHash: '0xsend', amounts: ['1'], destinationAddress: RANDO }),
      inb({ txHash: '0xrecv', amounts: ['2'], sourceAddress: RANDO }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(['send', 'receive']);
  });

  it('hash-less legs are never grouped', () => {
    const rows = classify([out({ amounts: ['1'] }), inb({ amounts: ['2'] })]);
    expect(rows.map((r) => r.action)).toEqual(['send', 'receive']);
  });

  it('preserves newest-first order across mixed actions', () => {
    const rows = classify([
      out({ txHash: '0xS', amounts: ['1'], destinationAddress: POOL }),
      inb({ txHash: '0xS', amounts: ['9'], sourceAddress: POOL }),
      inb({ txHash: '0xC', amounts: ['5'], sourceAddress: ARENA }),
      out({ txHash: '0xSEND', amounts: ['3'], destinationAddress: RANDO }),
    ]);
    expect(rows.map((r) => `${r.action}:${r.txHash}`)).toEqual(['swap:0xS', 'claimFees:0xC', 'send:0xSEND']);
  });
});
