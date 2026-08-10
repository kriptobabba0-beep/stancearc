import { describe, it, expect } from 'vitest';
import { describeActivity } from '@/lib/activity/describe';
import type { ActivityEvent } from '@/lib/activity/types';
import { Side } from '@/lib/types';

const base = (over: Partial<ActivityEvent>): ActivityEvent =>
  ({
    id: 'e',
    kind: 'settled',
    marketId: 'cirbtc',
    marketLabel: 'cirBTC / USDC',
    quoteSymbol: 'USDC',
    epochId: 1,
    txHash: '0x0',
    blockHeight: 1,
    logIndex: 0,
    ...over,
  }) as ActivityEvent;

const OWNER = '0x1111111111111111111111111111111111111111';

describe('describeActivity', () => {
  it('staked UP / DOWN carry the right label + tone', () => {
    const up = describeActivity(base({ kind: 'staked', side: Side.UP, owner: OWNER, epochId: 42 }));
    expect(up.text).toBe('0x1111…1111 staked UP on epoch #42');
    expect(up.tone).toBe('up');

    const down = describeActivity(base({ kind: 'staked', side: Side.DOWN, owner: OWNER, epochId: 42 }));
    expect(down.text).toContain('staked DOWN');
    expect(down.tone).toBe('down');
  });

  it('settlement price posted shows the USD price for a USDC-quoted market', () => {
    const d = describeActivity(base({ kind: 'priceSubmitted', finalPrice18: '63858784322867586206896', epochId: 1281 }));
    expect(d.text).toBe('Epoch #1281 settlement price posted — $63,859');
    expect(d.tone).toBe('brand');
  });

  it('settled shows the qualifying-position count + price, pluralized', () => {
    const many = describeActivity(base({ kind: 'settled', winnerCount: 3, finalPrice18: '63800000000000000000000', epochId: 1280 }));
    expect(many.text).toBe('Epoch #1280 settled — 3 qualifying positions · $63,800');
    const one = describeActivity(base({ kind: 'settled', winnerCount: 1, epochId: 9 }));
    expect(one.text).toBe('Epoch #9 settled — 1 qualifying position');
  });

  it('claimed shows the payout amount + tone up', () => {
    const d = describeActivity(base({ kind: 'claimed', payUSDC: '5000000', owner: OWNER, epochId: 7 }));
    expect(d.text).toBe('0x1111…1111 claimed 5 USDC from epoch #7');
    expect(d.tone).toBe('up');
  });

  it('uses € + EURC for a EURC-QUOTED market (cirBTC/EURC)', () => {
    const price = describeActivity(base({ kind: 'priceSubmitted', quoteSymbol: 'EURC', marketLabel: 'cirBTC / EURC', finalPrice18: '59120000000000000000000', epochId: 5 }));
    expect(price.text).toBe('Epoch #5 settlement price posted — €59,120');
    const claim = describeActivity(base({ kind: 'claimed', quoteSymbol: 'EURC', marketLabel: 'cirBTC / EURC', payUSDC: '2000000', owner: OWNER, epochId: 5 }));
    expect(claim.text).toContain('claimed 2 EURC');
  });

  it('keys currency off the QUOTE symbol, not the label (EURC-base, USDC-quote market shows $)', () => {
    // base=EURC, quote=USDC: label contains "EURC" but it settles in USD.
    const d = describeActivity(base({ kind: 'priceSubmitted', quoteSymbol: 'USDC', marketLabel: 'EURC / USDC', finalPrice18: '1100000000000000000', epochId: 3 }));
    expect(d.text).toBe('Epoch #3 settlement price posted — $1.1'); // $ glyph from quote=USDC, not the EURC label
    const claim = describeActivity(base({ kind: 'claimed', quoteSymbol: 'USDC', marketLabel: 'EURC / USDC', payUSDC: '4000000', owner: OWNER, epochId: 3 }));
    expect(claim.text).toContain('claimed 4 USDC');
  });

  it('never throws on a non-numeric price (drops the price suffix)', () => {
    const d = describeActivity(base({ kind: 'priceSubmitted', finalPrice18: 'not-a-number', epochId: 8 }));
    expect(d.text).toBe('Epoch #8 settlement price posted');
  });

  it('empty-winner rollover is neutral', () => {
    const d = describeActivity(base({ kind: 'emptyRollover', epochId: 11 }));
    expect(d.text).toBe('Epoch #11 had no winner — pot rolled forward');
    expect(d.tone).toBe('neutral');
  });
});
