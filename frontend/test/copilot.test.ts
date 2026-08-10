import { describe, it, expect, vi } from 'vitest';

// The copilot modules read chain/env config lazily, but their import graph still touches
// lib/env eagerly via lib/chain and lib/markets — stub those with a minimal single market.
vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 5042002 } }));
vi.mock('@/lib/env', () => ({ ENV: { HERMES_URL: 'https://hermes.test' } }));
vi.mock('@/lib/markets', () => ({
  MARKETS: [{ id: 'cirbtc', label: 'cirBTC / USDC' }],
  marketById: (id: string) => {
    if (id !== 'cirbtc') throw new Error(`unknown market: ${id}`);
    return {
      id: 'cirbtc',
      label: 'cirBTC / USDC',
      feeArena: `0x${'1'.repeat(40)}`,
      feedId: `0x${'e'.repeat(64)}`,
      baseDecimals: 8,
    };
  },
}));

import { parseSseChunk } from '@/hooks/useCopilotChat';
import { systemPrompt, validateActionProposal, summarizeEpochHistory, summarizeUserRecord } from '@/lib/agent/copilot';
import type { EpochRecord, StakeRecord, ClaimPreview } from '@/lib/agent/copilot';
import { POST } from '@/app/api/agent/chat/route';

// The Limen Copilot's protocol plumbing: the SSE frame parser the client folds streams
// with, the action-proposal validator that gates what the model may put in front of the
// user, and the route's honest offline behavior when no model key is configured.

describe('parseSseChunk — SSE frame folding', () => {
  it('parses complete frames and returns the unconsumed remainder', () => {
    const { events, rest } = parseSseChunk('data: {"type":"text","delta":"Hel"}\n\ndata: {"type":"done"}\n\ndata: {"type":"te');
    expect(events).toEqual([{ type: 'text', delta: 'Hel' }, { type: 'done' }]);
    expect(rest).toBe('data: {"type":"te');
  });

  it('skips malformed frames instead of killing the stream', () => {
    const { events } = parseSseChunk('data: not-json\n\ndata: {"type":"tool","name":"get_market_overview","status":"start"}\n\n');
    expect(events).toEqual([{ type: 'tool', name: 'get_market_overview', status: 'start' }]);
  });

  it('an empty buffer yields nothing', () => {
    expect(parseSseChunk('')).toEqual({ events: [], rest: '' });
  });
});

describe('systemPrompt — the copilot must know the autopilot exists and whose addresses are whose', () => {
  const addr = `0x${'a'.repeat(40)}`;
  const sess = `0x${'b'.repeat(40)}`;

  it('a live session puts the signer address in context and forbids denying autopilot activity', () => {
    const p = systemPrompt({ address: addr, sessionAddress: sess, marketId: 'cirbtc' });
    expect(p).toContain(sess);
    expect(p).toMatch(/never deny that the autopilot acted/i);
    expect(p).toMatch(/REAL event notifications/);
  });

  it('past session signers are attributed to the user too', () => {
    const past = `0x${'c'.repeat(40)}`;
    const p = systemPrompt({ address: addr, pastSessionAddresses: [past], marketId: 'cirbtc' });
    expect(p).toContain(past);
  });

  it('the stale "auto-entry is an upcoming feature" claim is gone for good', () => {
    const p = systemPrompt({ address: addr, marketId: 'cirbtc' });
    expect(p).not.toMatch(/upcoming mandate-agent/i);
    expect(p).toMatch(/Continuous auto-entry EXISTS today/);
    expect(p).toMatch(/Start unattended/);
  });
});

describe('validateActionProposal — the gate between the model and the user', () => {
  it('accepts a well-formed stake with a side, defaulting the market', () => {
    const v = validateActionProposal({ type: 'stake', side: 'up', note: 'Odds favor UP.' }, 'cirbtc');
    expect(v).toEqual({ type: 'stake', side: 'UP', marketId: 'cirbtc', note: 'Odds favor UP.' });
  });

  it('accepts a claim and fills a default note', () => {
    const v = validateActionProposal({ type: 'claim' }, 'cirbtc');
    expect(v).toMatchObject({ type: 'claim', marketId: 'cirbtc' });
    if (!('error' in v)) expect(v.note.length).toBeGreaterThan(0);
  });

  it('rejects unknown action types, missing sides, and unknown markets', () => {
    expect(validateActionProposal({ type: 'withdraw' }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'stake' }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'stake', side: 'SIDEWAYS' }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'stake', side: 'UP', marketId: 'dogecoin' }, 'cirbtc')).toHaveProperty('error');
  });
});

describe('chat route — honest offline behavior', () => {
  it('reports not_configured (503) when no model key is set, instead of breaking', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await POST(
        new Request('http://localhost/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], marketId: 'cirbtc' }),
        }),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'not_configured' });
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });

  it('goes offline when the AGENT_ENABLED switch is set to false, even with a model key', async () => {
    const prev = { key: process.env.ANTHROPIC_API_KEY, on: process.env.AGENT_ENABLED };
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.AGENT_ENABLED = 'false';
    try {
      const res = await POST(
        new Request('http://localhost/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], marketId: 'cirbtc' }),
        }),
      );
      expect(res.status).toBe(503);
    } finally {
      if (prev.key !== undefined) process.env.ANTHROPIC_API_KEY = prev.key; else delete process.env.ANTHROPIC_API_KEY;
      if (prev.on !== undefined) process.env.AGENT_ENABLED = prev.on; else delete process.env.AGENT_ENABLED;
    }
  });
});

describe('validateActionProposal — swap and add_liquidity', () => {
  it('accepts a swap with a positive USDC amount', () => {
    const v = validateActionProposal({ type: 'swap', amountUsdc: 100, note: 'Buy $100 of cirBTC.' }, 'cirbtc');
    expect(v).toMatchObject({ type: 'swap', amountUsdc: 100, marketId: 'cirbtc' });
  });

  it('rejects swaps without an amount, with a non-positive amount, or above the cap', () => {
    expect(validateActionProposal({ type: 'swap' }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'swap', amountUsdc: 0 }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'swap', amountUsdc: 999_999 }, 'cirbtc')).toHaveProperty('error');
  });

  it('add_liquidity carries the amount and an optional price band through', () => {
    expect(
      validateActionProposal({ type: 'add_liquidity', amountUsdc: 5, priceLower: 55_000, priceUpper: 75_000 }, 'cirbtc'),
    ).toMatchObject({ type: 'add_liquidity', amountUsdc: 5, priceLower: 55_000, priceUpper: 75_000, marketId: 'cirbtc' });
    // No band = full range: both bounds stay undefined.
    const full = validateActionProposal({ type: 'add_liquidity', amountUsdc: 10 }, 'cirbtc');
    expect(full).toMatchObject({ type: 'add_liquidity', amountUsdc: 10 });
    expect((full as { priceLower?: number }).priceLower).toBeUndefined();
  });

  it('add_liquidity rejects a missing amount and a malformed band', () => {
    expect(validateActionProposal({ type: 'add_liquidity' }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'add_liquidity', amountUsdc: 5, priceLower: 75_000, priceUpper: 55_000 }, 'cirbtc')).toHaveProperty('error');
    expect(validateActionProposal({ type: 'add_liquidity', amountUsdc: 5, priceLower: 55_000 }, 'cirbtc')).toHaveProperty('error');
  });
});

describe('checkQuota — the daily cost bound', () => {
  it('counts per key per day and blocks at the limit', async () => {
    const { checkQuota } = await import('@/lib/agent/quota');
    const map = new Map<string, { day: string; used: number }>();
    const day1 = Date.UTC(2026, 6, 10, 12);
    expect(checkQuota(map, '0xabc', day1, 2)).toBe(true);
    expect(checkQuota(map, '0xabc', day1, 2)).toBe(true);
    expect(checkQuota(map, '0xabc', day1, 2)).toBe(false); // limit hit
    expect(checkQuota(map, '0xdef', day1, 2)).toBe(true); // other keys unaffected
    const day2 = Date.UTC(2026, 6, 11, 12);
    expect(checkQuota(map, '0xabc', day2, 2)).toBe(true); // resets next day
  });
});

// ─── Copilot v3: history + record summarizers (pure) ────────────────────────────────────

const epochRec = (over: Partial<EpochRecord>): EpochRecord => ({
  epochId: 100n,
  phase: 4,
  entryCloseTime: 0n,
  settlementTime: 0n,
  bandBps: 20,
  rolledOver: false,
  stakedCount: 3,
  winnerCount: 1,
  finalPrice18: 63_500_000_000_000_000_000_000n, // $63,500
  potBase: 0n,
  potUSDC: 2_500_000n, // $2.50
  ...over,
});

const stakeRec = (over: Partial<StakeRecord>): StakeRecord => ({
  tokenId: 1n,
  epochId: 100n,
  side: 3,
  processed: true,
  won: false,
  claimed: false,
  unstaked: false,
  ...over,
});

describe('summarizeEpochHistory', () => {
  it('digests settled epochs: winners by side, pots, rollovers, win rate', () => {
    const epochs = [
      epochRec({ epochId: 101n, winnerCount: 2, stakedCount: 3 }),
      epochRec({ epochId: 100n, winnerCount: 0, stakedCount: 2, rolledOver: true, potUSDC: 0n }),
    ];
    const stakes = [
      [stakeRec({ side: 3, won: true }), stakeRec({ side: 1, won: true }), stakeRec({ side: 2, won: false })],
      [stakeRec({ side: 1 }), stakeRec({ side: 2 })],
    ];
    const out = summarizeEpochHistory(epochs, stakes, { baseSymbol: 'cirBTC', baseDecimals: 8, ccy: '$' }) as {
      epochsAnalyzed: number;
      aggregate: { totalWinners: number; overallWinRate: string; winsBySide: Record<string, number>; epochsWherePotRolledOver: number };
      epochs: Array<Record<string, unknown>>;
    };
    expect(out.epochsAnalyzed).toBe(2);
    expect(out.aggregate.totalWinners).toBe(2);
    expect(out.aggregate.overallWinRate).toBe('40%'); // 2 of 5
    expect(out.aggregate.winsBySide).toEqual({ UP: 1, DOWN: 0, RANGE: 1 });
    expect(out.aggregate.epochsWherePotRolledOver).toBe(1);
    expect(out.epochs[0]).toMatchObject({ epochId: '101', winners: 2, reallocatedPot: '$2.5 + 0 cirBTC' });
    expect(out.epochs[1]).toMatchObject({ epochId: '100', potRolledToNextEpoch: true, reallocatedPot: 'none' });
  });

  it('ignores unsettled epochs and says so when nothing settled', () => {
    const out = summarizeEpochHistory([epochRec({ phase: 2 })], [[]], { baseSymbol: 'cirBTC', baseDecimals: 8, ccy: '$' });
    expect(out).toEqual({ note: 'no settled epochs in the requested window yet' });
  });
});

describe('summarizeUserRecord', () => {
  const preview = (over: Partial<ClaimPreview>): ClaimPreview => ({
    claimable: true,
    ownFeeBase: 0n,
    ownFeeUSDC: 1_000_000n, // $1
    potShareBase: 10_000n, // 0.0001 cirBTC
    potShareUSDC: 500_000n, // $0.50
    ...over,
  });

  it('totals wins, losses, and exact claimables from previews', () => {
    const stakes = [
      stakeRec({ tokenId: 7n, won: true }),
      stakeRec({ tokenId: 8n, won: true, claimed: true }),
      stakeRec({ tokenId: 9n, won: false }),
      stakeRec({ tokenId: 10n, processed: false }),
    ];
    const out = summarizeUserRecord(stakes, [{ tokenId: 7n, preview: preview({}) }], {
      baseSymbol: 'cirBTC',
      baseDecimals: 8,
      ccy: '$',
    }) as { wins: number; losses: number; awaitingSettlement: number; alreadyClaimed: number; claimableNow: { positions: string[]; total: string } };
    expect(out.wins).toBe(2);
    expect(out.losses).toBe(1);
    expect(out.awaitingSettlement).toBe(1);
    expect(out.alreadyClaimed).toBe(1);
    expect(out.claimableNow.positions).toEqual(['7']);
    expect(out.claimableNow.total).toBe('$1.5 + 0.0001 cirBTC');
  });

  it('says so plainly when nothing is claimable', () => {
    const out = summarizeUserRecord([stakeRec({ won: false })], [], { baseSymbol: 'cirBTC', baseDecimals: 8, ccy: '$' }) as {
      claimableNow: string;
    };
    expect(out.claimableNow).toBe('nothing to claim right now');
  });
});

describe('chat route — wallet requirement', () => {
  it('refuses anonymous chat with 401 wallet_required', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const res = await POST(
        new Request('http://localhost/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], marketId: 'cirbtc' }),
        }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'wallet_required' });
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev; else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
