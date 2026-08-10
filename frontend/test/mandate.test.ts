import { describe, it, expect } from 'vitest';
import { parseMandate, buildUnattendedConfig, DEFAULT_MANDATE } from '@/lib/agent/mandate';

// The mandate is the human contract every autonomous layer obeys — parsing is defensive,
// and the unattended config compiles it into the keeper agent's EXACT env surface.

describe('parseMandate', () => {
  it('round-trips a valid mandate', () => {
    const m = { views: ['UP', 'RANGE'], minConfidence: 0.6, maxStakeUsdc: 10, autoEnter: true, lpRangePct: 2 };
    expect(parseMandate(JSON.stringify(m))).toEqual(m);
  });

  it('LP range accepts ±0.5–50% and treats anything else as full range (null)', () => {
    expect(parseMandate(JSON.stringify({ lpRangePct: 10 })).lpRangePct).toBe(10);
    expect(parseMandate(JSON.stringify({})).lpRangePct).toBeNull();
    expect(parseMandate(JSON.stringify({ lpRangePct: 0 })).lpRangePct).toBeNull();
    expect(parseMandate(JSON.stringify({ lpRangePct: 99 })).lpRangePct).toBeNull();
    expect(parseMandate(JSON.stringify({ lpRangePct: 'wide' })).lpRangePct).toBeNull();
  });

  it('auto-enter is opt-in — anything but true parses as false', () => {
    expect(parseMandate(JSON.stringify({ autoEnter: 'yes' })).autoEnter).toBe(false);
    expect(parseMandate(JSON.stringify({})).autoEnter).toBe(false);
  });

  it('falls back to defaults on garbage, empty views, and out-of-range numbers', () => {
    expect(parseMandate(null)).toEqual(DEFAULT_MANDATE);
    expect(parseMandate('not json')).toEqual(DEFAULT_MANDATE);
    expect(parseMandate(JSON.stringify({ views: ['SIDEWAYS'], minConfidence: 0.05, maxStakeUsdc: 99999 }))).toEqual(DEFAULT_MANDATE);
  });

  it('accepts the low-confidence floor down to 10% (the slider minimum)', () => {
    const m = parseMandate(JSON.stringify({ views: ['RANGE'], minConfidence: 0.1, maxStakeUsdc: 5 }));
    expect(m.minConfidence).toBe(0.1);
  });
});

describe('buildUnattendedConfig', () => {
  it('compiles the mandate into the keeper agent env block (policy, market, funding rail)', () => {
    const text = buildUnattendedConfig({
      mandate: { views: ['UP', 'RANGE'], minConfidence: 0.6, maxStakeUsdc: 7.5, autoEnter: false, lpRangePct: null },
      expiresDays: 7,
      market: {
        id: 'cirbtc',
        label: 'cirBTC / USDC',
        feeArena: `0x${'f'.repeat(40)}`,
        pool: `0x${'9'.repeat(40)}`,
        feedId: `0x${'e'.repeat(64)}`,
        baseDecimals: 8,
      },
      tokens: { base: `0x${'3'.repeat(40)}`, quote: `0x${'2'.repeat(40)}`, quoteDecimals: 6 },
      addresses: { npm: `0x${'6'.repeat(40)}`, router: `0x${'7'.repeat(40)}`, pyth: `0x${'8'.repeat(40)}` },
      agentWalletAddress: '0xAGENTWALLET',
      nowSec: 1_752_000_000,
    });
    expect(text).toContain(`STAKERBOT_ARENA=0x${'f'.repeat(40)}`);
    expect(text).toContain('LIMEN_AGENT_FUNDING=agent-wallet');
    expect(text).toContain('LIMEN_AGENT_WALLET_ADDRESS=0xAGENTWALLET');
    const policy = JSON.parse(/LIMEN_AGENT_POLICY='(.+)'/.exec(text)![1]!) as {
      allowedViews: string[];
      minConfidence: number;
      expiresAtSec: number;
      maxStakeUsdc6: string;
    };
    expect(policy.allowedViews).toEqual(['UP', 'RANGE']);
    expect(policy.minConfidence).toBe(0.6);
    expect(policy.expiresAtSec).toBe(1_752_000_000 + 7 * 24 * 3600);
    expect(policy.maxStakeUsdc6).toBe('7500000');
    const market = JSON.parse(/KEEPER_ARB_MARKET='(.+)'/.exec(text)![1]!) as { arena: string; quoteFeedId?: string };
    expect(market.arena).toBe(`0x${'f'.repeat(40)}`);
    expect(market.quoteFeedId).toBeUndefined(); // single-feed market omits the cross feed
  });
});
