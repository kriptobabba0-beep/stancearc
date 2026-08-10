import { describe, it, expect, vi } from 'vitest';

// Same stubbing as copilot.test.ts: the route's import graph touches lib/env eagerly via
// lib/chain and lib/markets.
vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 5042002 } }));
vi.mock('@/lib/env', () => ({ ENV: { HERMES_URL: 'https://hermes.test' } }));
vi.mock('@/lib/markets', () => ({
  MARKETS: [{ id: 'cirbtc', label: 'cirBTC / USDC' }],
  marketById: () => ({
    id: 'cirbtc',
    label: 'cirBTC / USDC',
    feeArena: `0x${'1'.repeat(40)}`,
    feedId: `0x${'e'.repeat(64)}`,
    baseDecimals: 8,
  }),
}));

import { loadX402Config, buildPaymentRequirements, payment402Body, parsePaymentHeader } from '@/lib/agent/x402';
import { POST } from '@/app/api/agent/chat/route';

// x402 nanopayment metering for the copilot: OFF by default, and when ON the chat route
// answers unpaid requests with a spec-shaped 402 carrying Circle Gateway requirements.

describe('loadX402Config', () => {
  it('is disabled by default and requires a valid payTo to enable', () => {
    expect(loadX402Config({}).enabled).toBe(false);
    expect(loadX402Config({ X402_ENABLED: 'true' }).enabled).toBe(false);
    expect(loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: 'not-an-address' }).enabled).toBe(false);
    const on = loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: `0x${'a'.repeat(40)}` });
    expect(on.enabled).toBe(true);
    expect(on.amount).toBe('10000'); // $0.01 default
  });
});

describe('buildPaymentRequirements / payment402Body', () => {
  const cfg = loadX402Config({ X402_ENABLED: 'true', X402_PAY_TO: `0x${'b'.repeat(40)}`, X402_PRICE_USDC6: '25000' });

  it('targets USDC on Arc testnet with the Gateway batching scheme', () => {
    const req = buildPaymentRequirements(cfg);
    expect(req.network).toBe('eip155:5042002');
    expect(req.asset).toBe('0x3600000000000000000000000000000000000000');
    expect(req.amount).toBe('25000');
    expect(req.payTo).toBe(`0x${'b'.repeat(40)}`);
    expect(req.extra).toMatchObject({ name: 'GatewayWalletBatched', version: 1 });
  });

  it('shapes the 402 body per the x402 spec (version 2 — matches Circle\'s reference buyer)', () => {
    const body = payment402Body(cfg, 'payment required', 'https://limen.finance/api/agent/chat');
    expect(body.x402Version).toBe(2);
    expect(body.error).toBe('payment required');
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.resource).toMatchObject({ url: 'https://limen.finance/api/agent/chat', mimeType: 'text/event-stream' });
  });
});

describe('parsePaymentHeader', () => {
  it('round-trips a base64 payment payload', () => {
    const payload = { x402Version: 1, payload: { signature: '0xsig' } };
    const header = Buffer.from(JSON.stringify(payload)).toString('base64');
    expect(parsePaymentHeader(header)).toEqual(payload);
  });

  it('treats garbage as "no payment"', () => {
    expect(parsePaymentHeader(null)).toBeNull();
    expect(parsePaymentHeader('')).toBeNull();
    expect(parsePaymentHeader('%%%not-base64%%%')).toBeNull();
    expect(parsePaymentHeader(Buffer.from('{"nope":true}').toString('base64'))).toBeNull();
  });
});

describe('chat route — free tier first, 402 past the quota', () => {
  it('once the free quota is exhausted, an unpaid request gets a spec-shaped 402 (body + PAYMENT-REQUIRED header)', async () => {
    const prev = {
      key: process.env.ANTHROPIC_API_KEY,
      on: process.env.AGENT_ENABLED,
      en: process.env.X402_ENABLED,
      to: process.env.X402_PAY_TO,
      lim: process.env.AGENT_DAILY_MSG_LIMIT,
    };
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.AGENT_ENABLED = 'true';
    process.env.X402_ENABLED = 'true';
    process.env.X402_PAY_TO = `0x${'c'.repeat(40)}`;
    process.env.AGENT_DAILY_MSG_LIMIT = '0'; // free tier spent — the paid path takes over
    try {
      const res = await POST(
        new Request('http://localhost/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], marketId: 'cirbtc', address: `0x${'d'.repeat(40)}` }),
        }),
      );
      expect(res.status).toBe(402);
      const body = (await res.json()) as { x402Version: number; accepts: Array<{ network: string }>; resource: { mimeType: string } };
      expect(body.x402Version).toBe(2);
      expect(body.accepts[0]?.network).toBe('eip155:5042002');
      expect(body.resource.mimeType).toBe('text/event-stream');
      // Circle's reference buyer reads the requirements from this header, not the body.
      const header = res.headers.get('PAYMENT-REQUIRED');
      expect(header).toBeTruthy();
      expect(JSON.parse(Buffer.from(header!, 'base64').toString('utf8'))).toEqual(body);
    } finally {
      if (prev.key !== undefined) process.env.ANTHROPIC_API_KEY = prev.key; else delete process.env.ANTHROPIC_API_KEY;
      if (prev.on !== undefined) process.env.AGENT_ENABLED = prev.on; else delete process.env.AGENT_ENABLED;
      if (prev.en !== undefined) process.env.X402_ENABLED = prev.en; else delete process.env.X402_ENABLED;
      if (prev.to !== undefined) process.env.X402_PAY_TO = prev.to; else delete process.env.X402_PAY_TO;
      if (prev.lim !== undefined) process.env.AGENT_DAILY_MSG_LIMIT = prev.lim; else delete process.env.AGENT_DAILY_MSG_LIMIT;
    }
  });
});

describe('chat route — abuse bounds', () => {
  it('rejects oversized request bodies with 413', async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const res = await POST(
        new Request('http://localhost/api/agent/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(1_000_000) },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        }),
      );
      expect(res.status).toBe(413);
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev; else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
