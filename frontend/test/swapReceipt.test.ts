// swapReceipt.test.ts — the figure the "Swap completed" screen puts in front of the user.
//
// It has to be what the chain settled at, because the user can click straight through to the
// explorer and check it. These cover the ways a receipt can mislead: the wrong token's transfer,
// somebody else's transfer, the leg the user PAID rather than received, and a receipt that simply
// doesn't say — where the only honest answer is to show nothing.
import { describe, it, expect } from 'vitest';
import { receivedAmount, TRANSFER_TOPIC, type ReceiptLog } from '@/lib/swapReceipt';

const ME = '0x6a286073bde0a93f656078ca89c9c86536950144';
const OTHER = '0x1111111111111111111111111111111111111111';
const POOL = '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b';
const CIRBTC = '0xf0c4a4ce82a5746abaad9425360ab04fbba432bf';
const USDC = '0x2222222222222222222222222222222222222222';

const pad = (addr: string) => `0x${'0'.repeat(24)}${addr.slice(2).toLowerCase()}`;
const hex = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}`;

const transfer = (token: string, from: string, to: string, value: bigint): ReceiptLog => ({
  address: token,
  topics: [TRANSFER_TOPIC, pad(from), pad(to)],
  data: hex(value),
});

describe('receivedAmount', () => {
  it('reads what the pool paid the user in the bought token', () => {
    const logs = [
      transfer(USDC, ME, POOL, 5_000_000n), // the leg the user paid
      transfer(CIRBTC, POOL, ME, 1_206n), // the leg they received
    ];
    expect(receivedAmount(logs, CIRBTC, ME)).toBe(1_206n);
  });

  it('ignores the token the user paid with, however the swap is ordered', () => {
    const logs = [transfer(USDC, ME, POOL, 5_000_000n)];
    expect(receivedAmount(logs, CIRBTC, ME)).toBeNull();
  });

  it('ignores a transfer of the right token to somebody else', () => {
    // A fee or a router hop crediting another address is not the user's payout.
    const logs = [transfer(CIRBTC, POOL, OTHER, 9_999n)];
    expect(receivedAmount(logs, CIRBTC, ME)).toBeNull();
  });

  it('ignores an outgoing transfer of the bought token', () => {
    const logs = [transfer(CIRBTC, ME, POOL, 500n)];
    expect(receivedAmount(logs, CIRBTC, ME)).toBeNull();
  });

  it('adds up a payout that arrives in more than one transfer', () => {
    const logs = [transfer(CIRBTC, POOL, ME, 700n), transfer(CIRBTC, POOL, ME, 506n)];
    expect(receivedAmount(logs, CIRBTC, ME)).toBe(1_206n);
  });

  it('matches addresses whatever their casing', () => {
    const logs = [transfer(CIRBTC.toUpperCase().replace('0X', '0x'), POOL, ME, 42n)];
    expect(receivedAmount(logs, CIRBTC, ME)).toBe(42n);
  });

  it('ignores a non-Transfer log on the same token', () => {
    const logs: ReceiptLog[] = [
      { address: CIRBTC, topics: ['0xdeadbeef', pad(POOL), pad(ME)], data: hex(1n) },
    ];
    expect(receivedAmount(logs, CIRBTC, ME)).toBeNull();
  });

  it('says nothing rather than zero when the receipt has no payout in it', () => {
    // Null and 0n must stay distinguishable: 0n is "you received nothing", null is "we don't
    // know". The screen shows a figure for one and stays quiet for the other.
    expect(receivedAmount([], CIRBTC, ME)).toBeNull();
    expect(receivedAmount(undefined, CIRBTC, ME)).toBeNull();
    expect(receivedAmount([transfer(CIRBTC, POOL, ME, 0n)], CIRBTC, ME)).toBe(0n);
  });

  it('needs both a token and a recipient to answer', () => {
    const logs = [transfer(CIRBTC, POOL, ME, 1n)];
    expect(receivedAmount(logs, undefined, ME)).toBeNull();
    expect(receivedAmount(logs, CIRBTC, undefined)).toBeNull();
  });

  it('skips a malformed value instead of throwing', () => {
    const bad: ReceiptLog = { address: CIRBTC, topics: [TRANSFER_TOPIC, pad(POOL), pad(ME)], data: '0xzz' };
    expect(receivedAmount([bad], CIRBTC, ME)).toBeNull();
    expect(receivedAmount([bad, transfer(CIRBTC, POOL, ME, 8n)], CIRBTC, ME)).toBe(8n);
  });

  it('is not fooled by a short or missing topic', () => {
    const logs: ReceiptLog[] = [{ address: CIRBTC, topics: [TRANSFER_TOPIC], data: hex(5n) }];
    expect(receivedAmount(logs, CIRBTC, ME)).toBeNull();
  });
});
