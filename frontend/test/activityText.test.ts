import { describe, it, expect } from 'vitest';
import { describeEvent, relativeTime, type ActivityDescription } from '@/lib/activityText';
import { Side } from '@/lib/types';
import type { FeedLog } from '@/lib/events';

const log = (eventName: string, args: Record<string, unknown>, blockNumber = 100n): FeedLog => ({
  eventName,
  blockNumber,
  logIndex: 0,
  transactionHash: '0xabc',
  args,
});

// ── describeEvent — raw event → human sentence ─────────────────────────────────
describe('describeEvent', () => {
  it('Staked → "0xab… staked UP on epoch #42"', () => {
    const d = describeEvent(
      log('Staked', { epochId: 42n, owner: '0xabcdef0000000000000000000000000000001234', side: Side.UP }),
    );
    expect(d.text).toBe('0xabcd…1234 staked UP on epoch #42');
    expect(d.tone).toBe('up');
  });

  it('Staked DOWN/RANGE carry the matching tone', () => {
    expect(describeEvent(log('Staked', { epochId: 1n, owner: '0xabcdef0000000000000000000000000000001234', side: Side.DOWN })).tone).toBe('down');
    expect(describeEvent(log('Staked', { epochId: 1n, owner: '0xabcdef0000000000000000000000000000001234', side: Side.RANGE })).tone).toBe('range');
  });

  it('EpochStarted → "Epoch #7 started"', () => {
    expect(describeEvent(log('EpochStarted', { epochId: 7n, startPrice18: 0n })).text).toBe('Epoch #7 started');
  });

  it('EpochSettled → "Epoch #7 settled — DOWN won"', () => {
    const d = describeEvent(log('EpochSettled', { epochId: 7n, winningSide: Side.DOWN }));
    expect(d.text).toBe('Epoch #7 settled — DOWN won');
    expect(d.tone).toBe('down');
  });

  it('EpochResolved → "Epoch #7 resolved — UP won"', () => {
    expect(describeEvent(log('EpochResolved', { epochId: 7n, winningSide: Side.UP, deltaBps: 0n })).text).toBe(
      'Epoch #7 resolved — UP won',
    );
  });

  it('EmptyWinnerRollover → "Epoch #7 had no winner — pot rolled forward"', () => {
    expect(describeEvent(log('EmptyWinnerRollover', { epochId: 7n, winningSide: Side.UP })).text).toBe(
      'Epoch #7 had no winner — pot rolled forward',
    );
  });

  it('Claimed with a USDC payout reads the human amount + token', () => {
    const d = describeEvent(
      log('Claimed', {
        epochId: 7n,
        owner: '0xabcdef0000000000000000000000000000001234',
        tokenId: 5n,
        payWETH: 0n,
        payUSDC: 1_200_000n, // 1.2 USDC
      }),
    );
    // "0xab… claimed 1.2 USDC from epoch #7"
    expect(d.text).toBe('0xabcd…1234 claimed 1.2 USDC from epoch #7');
  });

  it('Claimed includes the base leg when present (per-market symbol/decimals)', () => {
    const d = describeEvent(
      log('Claimed', {
        epochId: 7n,
        owner: '0xabcdef0000000000000000000000000000001234',
        tokenId: 5n,
        payWETH: 100_000n, // 0.001 cirBTC at 8dp
        payUSDC: 0n,
      }),
      { baseSymbol: 'cirBTC', baseDecimals: 8 },
    );
    expect(d.text).toBe('0xabcd…1234 claimed 0.001 cirBTC from epoch #7');
  });

  it('Claimed with both legs joins them with "+"', () => {
    const d = describeEvent(
      log('Claimed', {
        epochId: 7n,
        owner: '0xabcdef0000000000000000000000000000001234',
        tokenId: 5n,
        payWETH: 100_000n,
        payUSDC: 1_200_000n,
      }),
      { baseSymbol: 'cirBTC', baseDecimals: 8 },
    );
    expect(d.text).toBe('0xabcd…1234 claimed 0.001 cirBTC + 1.2 USDC from epoch #7');
  });

  it('Unstaked → "0xab… withdrew their position from epoch #7"', () => {
    expect(
      describeEvent(
        log('Unstaked', { epochId: 7n, owner: '0xabcdef0000000000000000000000000000001234', tokenId: 5n }),
      ).text,
    ).toBe('0xabcd…1234 withdrew their position from epoch #7');
  });

  it('Swept → "Position #5 swept into epoch #7"', () => {
    expect(
      describeEvent(log('Swept', { epochId: 7n, tokenId: 5n, feeWETH: 0n, feeUSDC: 0n, contribution6: 0n })).text,
    ).toBe('Position #5 swept into epoch #7');
  });

  it('an unknown event degrades to its raw name (never throws)', () => {
    const d = describeEvent(log('SomethingNew', { epochId: 1n }));
    expect(d.text).toBe('SomethingNew');
    expect(d.tone).toBe('neutral');
  });

  it('a missing owner still produces a readable sentence', () => {
    const d = describeEvent(log('Staked', { epochId: 3n, side: Side.UP }));
    expect(d.text).toBe('Someone staked UP on epoch #3');
  });
});

// ── relativeTime — "Nm ago" from a chain-time delta ────────────────────────────
describe('relativeTime', () => {
  const now = 1_000_000n;
  it('just now (< 1 min)', () => {
    expect(relativeTime(now - 30n, now)).toBe('just now');
  });
  it('minutes', () => {
    expect(relativeTime(now - 120n, now)).toBe('2m ago');
  });
  it('hours', () => {
    expect(relativeTime(now - 7200n, now)).toBe('2h ago');
  });
  it('days', () => {
    expect(relativeTime(now - 172800n, now)).toBe('2d ago');
  });
  it('clamps a future timestamp to "just now"', () => {
    expect(relativeTime(now + 50n, now)).toBe('just now');
  });
  it('undefined → empty string (no timestamp known)', () => {
    expect(relativeTime(undefined, now)).toBe('');
  });
});

// type export sanity (compile-time): a description has text + tone.
const _typecheck: ActivityDescription = { text: 'x', tone: 'neutral' };
void _typecheck;
