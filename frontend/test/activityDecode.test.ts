import { describe, it, expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters } from 'viem';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { decodeArenaEvent } from '@/lib/activity/decode';
import type { CircleEventLog } from '@/lib/activity/types';

const market = { id: 'cirbtc', label: 'cirBTC / USDC' };

/**
 * Build a CircleEventLog from an event's indexed topics + non-indexed data so synthetic cases match the
 * exact on-chain shape Circle returns. (viem 2.19.4 has no encodeEventLog, so we compose it from
 * encodeEventTopics + encodeAbiParameters.)
 */
function logFromEvent(
  eventName: string,
  args: Record<string, unknown>,
  over: Partial<CircleEventLog> = {},
): CircleEventLog {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const topics = encodeEventTopics({ abi: feeArenaV3Abi as any, eventName: eventName as any, args: args as any });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry: any = (feeArenaV3Abi as any).find((e: any) => e.type === 'event' && e.name === eventName);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonIndexed = entry.inputs.filter((i: any) => !i.indexed);
  const data =
    nonIndexed.length > 0
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        encodeAbiParameters(nonIndexed, nonIndexed.map((i: any) => args[i.name]))
      : '0x';
  return {
    id: `evt-${eventName}`,
    txHash: '0xbbbb',
    blockHeight: 47902300,
    topics: topics as `0x${string}`[],
    data,
    ...over,
  };
}

describe('decodeArenaEvent', () => {
  it('decodes the REAL captured SettlementPriceSubmitted payload (epoch 1281) from Circle', () => {
    const ev = decodeArenaEvent(
      {
        id: '019ee6d6-d4db-70f4-8370-6dccdd97cbe0',
        txHash: '0x8ffe2163169dd9a2636c305df1165abf059f8f87d17a59ba9094e8096aaa7e84',
        blockHeight: 47902235,
        topics: [
          '0x33273b88ead2412a7e0ab4f7866da95abfb10d6386df5a066a79cc45b828eef8',
          '0x0000000000000000000000000000000000000000000000000000000000000501',
        ],
        data: '0x000000000000000000000000000000000000000000000d85caa8934ee6390cb0000000000000000000000000000000000000000000000d866a7686c55ef97800000000000000000000000000000000000000000000000000000000006a36ff70000000000000000000000000000000000000000000000000000000006a36ffac93f1c192d4b48ca9e201f372d3bdf6de6d605b04e4e63065ebb9fd32b780fa64',
        firstConfirmDate: '2026-06-20T21:01:36Z',
      },
      market,
    );
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('priceSubmitted');
    expect(ev!.epochId).toBe(1281);
    expect(ev!.finalPrice18).toBe('63858784322867586206896');
    expect(ev!.txHash).toBe('0x8ffe2163169dd9a2636c305df1165abf059f8f87d17a59ba9094e8096aaa7e84');
    expect(ev!.blockHeight).toBe(47902235);
    expect(ev!.marketId).toBe('cirbtc');
    expect(ev!.marketLabel).toBe('cirBTC / USDC');
    expect(ev!.ts).toBe('2026-06-20T21:01:36Z');
  });

  it('decodes a Staked event (side / owner / tokenId)', () => {
    const ev = decodeArenaEvent(
      logFromEvent('Staked', {
        epochId: 1281n,
        owner: '0x1111111111111111111111111111111111111111',
        tokenId: 42n,
        side: 1,
        entryPrice18: 63800000000000000000000n,
        stakedCount: 3,
      }),
      market,
    );
    expect(ev!.kind).toBe('staked');
    expect(ev!.epochId).toBe(1281);
    expect(ev!.side).toBe(1);
    expect(ev!.owner?.toLowerCase()).toBe('0x1111111111111111111111111111111111111111');
    expect(ev!.tokenId).toBe('42');
  });

  it('decodes an EpochSettled event (winnerCount / potUSDC / finalPrice18)', () => {
    const ev = decodeArenaEvent(
      logFromEvent('EpochSettled', {
        epochId: 1280n,
        finalPrice18: 63800000000000000000000n,
        winnerCount: 5,
        potBase: 0n,
        potUSDC: 1234560000n,
      }),
      market,
    );
    expect(ev!.kind).toBe('settled');
    expect(ev!.epochId).toBe(1280);
    expect(ev!.winnerCount).toBe(5);
    expect(ev!.potUSDC).toBe('1234560000');
    expect(ev!.finalPrice18).toBe('63800000000000000000000');
  });

  it('decodes a Claimed event (owner / tokenId / payUSDC)', () => {
    const ev = decodeArenaEvent(
      logFromEvent('Claimed', {
        epochId: 1279n,
        owner: '0x2222222222222222222222222222222222222222',
        tokenId: 7n,
        payBase: 0n,
        payUSDC: 5000000n,
      }),
      market,
    );
    expect(ev!.kind).toBe('claimed');
    expect(ev!.payUSDC).toBe('5000000');
    expect(ev!.owner?.toLowerCase()).toBe('0x2222222222222222222222222222222222222222');
    expect(ev!.tokenId).toBe('7');
  });

  it('returns null for an event in the ABI but not surfaced in the feed (Unstaked)', () => {
    const ev = decodeArenaEvent(
      logFromEvent('Unstaked', {
        epochId: 1n,
        owner: '0x3333333333333333333333333333333333333333',
        tokenId: 1n,
      }),
      market,
    );
    expect(ev).toBeNull();
  });

  it('returns null for an unknown / undecodable topic0', () => {
    const ev = decodeArenaEvent(
      { id: 'x', txHash: '0xcccc', blockHeight: 1, topics: [`0x${'12'.repeat(32)}`], data: '0x' },
      market,
    );
    expect(ev).toBeNull();
  });

  it('decodes EpochCreated and EmptyWinnerRollover to their feed kinds', () => {
    const created = decodeArenaEvent(
      logFromEvent('EpochCreated', { epochId: 100n, entryOpenTime: 1n, entryCloseTime: 2n, settlementTime: 3n, bandBps: 20 }),
      market,
    );
    expect(created!.kind).toBe('epochCreated');
    const empty = decodeArenaEvent(logFromEvent('EmptyWinnerRollover', { epochId: 100n, potBase: 0n, potUSDC: 0n }), market);
    expect(empty!.kind).toBe('emptyRollover');
  });

  it('omits ts when firstConfirmDate is absent and normalizes string blockHeight + logIndex', () => {
    const ev = decodeArenaEvent(
      logFromEvent(
        'Staked',
        { epochId: 1n, owner: '0x1111111111111111111111111111111111111111', tokenId: 1n, side: 1, entryPrice18: 1n, stakedCount: 1 },
        { blockHeight: '47902300', logIndex: '3' },
      ),
      market,
    );
    expect(ev!.ts).toBeUndefined();
    expect(ev!.blockHeight).toBe(47902300);
    expect(ev!.logIndex).toBe(3);
    expect(ev!.quoteSymbol).toBe('USDC'); // default when the market omits quoteSymbol
  });

  it('carries the market quoteSymbol when provided', () => {
    const ev = decodeArenaEvent(
      logFromEvent('EpochCreated', { epochId: 1n, entryOpenTime: 1n, entryCloseTime: 2n, settlementTime: 3n, bandBps: 20 }),
      { id: 'eur', label: 'cirBTC / EURC', quoteSymbol: 'EURC' },
    );
    expect(ev!.quoteSymbol).toBe('EURC');
  });
});
