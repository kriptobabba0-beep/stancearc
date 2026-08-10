// envExampleCutover.test.ts — CUTOVER-SAFETY GUARD for .env.example (Task 3a).
//
// frontend-ci copies .env.example -> .env.local for the e2e build, and a Vercel env resync would pull
// NEXT_PUBLIC_MARKETS from the same source of truth. lib/markets.ts sets DEFAULT_MARKET_ID = MARKETS[0].id
// — so whichever market is listed FIRST is the default the live product opens on.
//
// The v2 conviction-parimutuel arena is deployed but NOT cranking (shelved). If it is listed FIRST,
// the default (and any Vercel resync) would point the live product at an idle, un-cranked arena. The
// LIVE product is now the ENTRY-ANCHORED v3 arena, which MUST be ordered FIRST, with v2 as a clearly
// marked secondary preview entry. This test FAILS LOUDLY if that ordering regresses.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseEnv } from '@/lib/env';
import { buildMarkets, marketVersion, isReadOnlyMarket } from '@/lib/markets';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE = resolve(HERE, '..', '.env.example');

/** Read the raw NEXT_PUBLIC_MARKETS value (single line) from .env.example. */
function readMarketsLine(): string {
  const text = readFileSync(ENV_EXAMPLE, 'utf8');
  // The active (uncommented) NEXT_PUBLIC_MARKETS line — NOT the commented example near the bottom.
  const line = text
    .split(/\r?\n/)
    .find((l) => l.startsWith('NEXT_PUBLIC_MARKETS='));
  if (!line) throw new Error('NEXT_PUBLIC_MARKETS line not found in .env.example');
  return line.slice('NEXT_PUBLIC_MARKETS='.length);
}

/** A minimal valid single-market env so parseEnv succeeds; MARKETS is overridden per case. */
const baseRaw: Record<string, string> = {
  NEXT_PUBLIC_CHAIN_ID: '5042002',
  NEXT_PUBLIC_RPC_HTTP: 'https://rpc.testnet.arc.network',
  NEXT_PUBLIC_RPC_WS: 'wss://rpc.testnet.arc.network',
  NEXT_PUBLIC_EXPLORER_URL: 'https://testnet.arcscan.app',
  NEXT_PUBLIC_FEE_ARENA_ADDRESS: '0x1111111111111111111111111111111111111111',
  NEXT_PUBLIC_ORACLE_ADDRESS: '0x2222222222222222222222222222222222222222',
  NEXT_PUBLIC_NPM_ADDRESS: '0x3333333333333333333333333333333333333333',
  NEXT_PUBLIC_FACTORY_ADDRESS: '0x4444444444444444444444444444444444444444',
  NEXT_PUBLIC_POOL_ADDRESS: '0x5555555555555555555555555555555555555555',
  NEXT_PUBLIC_SWAP_ROUTER_ADDRESS: '0x6666666666666666666666666666666666666666',
  NEXT_PUBLIC_USDC_ADDRESS: '0x3600000000000000000000000000000000000000',
  NEXT_PUBLIC_WETH_ADDRESS: '0x7777777777777777777777777777777777777777',
  NEXT_PUBLIC_MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11',
  NEXT_PUBLIC_PYTH_ADDRESS: '0x2880aB155794e7179c9eE2e38200202908C17B43',
  NEXT_PUBLIC_PYTH_ETHUSD_ID: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
};

describe('.env.example cutover-safety: the DEFAULT market must be the LIVE (entry-anchored v3) arena, not the idle v2', () => {
  it('NEXT_PUBLIC_MARKETS in .env.example is valid JSON and parses through buildMarkets', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: readMarketsLine() }));
    expect(markets.length).toBeGreaterThanOrEqual(2);
  });

  it('the FIRST market (= DEFAULT_MARKET_ID source) is the LIVE entry-anchored v3 arena (not v2, not readOnly)', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: readMarketsLine() }));
    const first = markets[0];
    // MARKETS[0] is what lib/markets.ts uses for DEFAULT_MARKET_ID — it must be the live cranking
    // product (the entry-anchored v3 arena), never the shelved v2 conviction preview or a readOnly arena.
    expect(marketVersion(first)).toBe('v3');
    expect(isReadOnlyMarket(first)).toBe(false);
  });

  it('the v2 conviction arena IS present, but only as a SECONDARY (non-first) entry', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: readMarketsLine() }));
    const v2Markets = markets.filter((m) => marketVersion(m) === 'v2');
    // v2 must still be reachable (so it can be cranked/tested), just not the default.
    expect(v2Markets.length).toBeGreaterThanOrEqual(1);
    // None of the v2 entries may be at index 0.
    expect(markets.findIndex((m) => marketVersion(m) === 'v2')).toBeGreaterThan(0);
  });

  it('still binds the deployed v2 arena + Lens addresses (the secondary v2 entry is fully configured)', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: readMarketsLine() }));
    const v2 = markets.find((m) => marketVersion(m) === 'v2');
    expect(v2?.feeArena.toLowerCase()).toBe('0xaeb33d3bfd63e4c330bb78a0a0b249e53daa5c68');
    expect(v2?.lens?.toLowerCase()).toBe('0xa0db836f8a24781b5a4f457924c9860dfe2a80b9');
  });

  it('carries a comment instructing Vercel to keep the live v3 market at index 0 (not the shelved v2)', () => {
    const text = readFileSync(ENV_EXAMPLE, 'utf8');
    // A human-facing guard so an operator does not "fix" the ordering by putting v2 first on Vercel.
    expect(text).toMatch(/v3 market at index 0/i);
    expect(text).toMatch(/Vercel/i);
  });
});
