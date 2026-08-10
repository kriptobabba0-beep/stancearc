// campaignMeta.test.ts — the campaign's human-facing bits: a readable name, and how far along it is.
//
// Progress drives a bar the reader takes literally, so the cases that matter are the ones where
// there is no honest answer to give: a campaign with no end block, and one whose range is nonsense.
import { describe, it, expect } from 'vitest';
import { campaignTitle, campaignProgress } from '@/lib/campaignMeta';

describe('campaignTitle', () => {
  it('uses the configured title when there is one', () => {
    expect(campaignTitle('aug', 'August Sprint')).toBe('August Sprint');
    expect(campaignTitle('aug', '  August Sprint  ')).toBe('August Sprint');
  });

  it('falls back to a readable form of the id', () => {
    expect(campaignTitle('aug')).toBe('Aug');
    expect(campaignTitle('test1h')).toBe('Test 1h');
    expect(campaignTitle('summer-sprint')).toBe('Summer Sprint');
    expect(campaignTitle('summer_sprint_2')).toBe('Summer Sprint 2');
  });

  it('treats a blank title as no title rather than printing nothing', () => {
    expect(campaignTitle('aug', '   ')).toBe('Aug');
    expect(campaignTitle('aug', null)).toBe('Aug');
  });

  it('never renders a campaign nameless', () => {
    expect(campaignTitle('')).toBe('Campaign');
  });
});

describe('campaignProgress', () => {
  it('measures how far the cursor has moved through the range', () => {
    expect(campaignProgress('100', '200', '150')).toBe(0.5);
    expect(campaignProgress('100', '200', '125')).toBe(0.25);
  });

  it('clamps rather than running past either end', () => {
    expect(campaignProgress('100', '200', '50')).toBe(0);
    expect(campaignProgress('100', '200', '500')).toBe(1);
  });

  it('says nothing for an open-ended campaign', () => {
    // endBlock 0 means "still running, no deadline set". A bar would have to invent a length.
    expect(campaignProgress('100', '0', '150')).toBeNull();
    expect(campaignProgress('100', '100', '100')).toBeNull();
  });

  it('says nothing rather than throwing on a malformed range', () => {
    expect(campaignProgress('abc', '200', '150')).toBeNull();
    expect(campaignProgress('100', '200', '')).toBeNull();
  });

  it('keeps its precision across a range far larger than a float can count', () => {
    // Arc runs about 169,000 blocks a day and block numbers are already in the tens of millions,
    // so the arithmetic has to stay in bigint until the very last step.
    const start = '55000000';
    const end = '55169000';
    const mid = '55084500';
    expect(campaignProgress(start, end, mid)).toBeCloseTo(0.5, 3);
  });
});
