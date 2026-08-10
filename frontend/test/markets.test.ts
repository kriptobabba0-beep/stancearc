import { describe, it, expect } from 'vitest';
import { parseEnv } from '@/lib/env';
import {
  buildMarkets,
  selectableMarkets,
  baseAcquireMode,
  marketVersion,
  isReadOnlyMarket,
  isV3Market,
  type Market,
} from '@/lib/markets';

// A valid single-market env (the ETH fallback source). NEXT_PUBLIC_MARKETS unset by default.
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

const BTC_FEED = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

describe('selectableMarkets — hides the shelved v2 conviction arena', () => {
  const mk = (id: string, version?: 'v1' | 'v2' | 'v3'): Market => ({
    id,
    label: id,
    baseSymbol: 'X',
    baseDecimals: 8,
    feeArena: '0x1111111111111111111111111111111111111111',
    oracle: '0x2222222222222222222222222222222222222222',
    pool: '0x5555555555555555555555555555555555555555',
    feedId: `0x${'a'.repeat(64)}`,
    fromBlock: 0n,
    version,
  });

  it('drops v2 markets and keeps v1/v3 in order', () => {
    const out = selectableMarkets([mk('cirbtc', 'v3'), mk('btc', 'v2')]);
    expect(out.map((m) => m.id)).toEqual(['cirbtc']);
  });

  it('leaves a list with no v2 markets unchanged', () => {
    const all = [mk('eth', 'v1'), mk('cirbtc', 'v3')];
    expect(selectableMarkets(all).map((m) => m.id)).toEqual(['eth', 'cirbtc']);
  });

  it('never empties the list — an all-v2 list returns the original (app stays bootable)', () => {
    const all = [mk('a', 'v2'), mk('b', 'v2')];
    expect(selectableMarkets(all)).toEqual(all);
  });
});

describe('buildMarkets', () => {
  it('falls back to a single ETH market built from the existing env when MARKETS is unset', () => {
    const markets = buildMarkets(parseEnv(baseRaw));
    expect(markets).toHaveLength(1);
    expect(markets[0]).toEqual({
      id: 'eth',
      label: 'ETH / USDC',
      baseSymbol: 'WETH',
      baseDecimals: 18,
      feeArena: '0x1111111111111111111111111111111111111111',
      oracle: '0x2222222222222222222222222222222222222222',
      pool: '0x5555555555555555555555555555555555555555',
      feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      fromBlock: 0n,
    });
  });

  it('reads an optional per-market fromBlock (numeric string) into a bigint', () => {
    const blob = JSON.stringify([
      {
        id: 'eth', label: 'ETH / USDC', baseSymbol: 'WETH', baseDecimals: 18,
        feeArena: '0x1111111111111111111111111111111111111111',
        oracle: '0x2222222222222222222222222222222222222222',
        pool: '0x5555555555555555555555555555555555555555',
        feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        fromBlock: '12345',
      },
    ]);
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }));
    expect(markets[0].fromBlock).toBe(12345n);
  });

  it('parses a 2-market MARKETS blob (eth + btc) with per-market base decimals', () => {
    const blob = JSON.stringify([
      {
        id: 'eth',
        label: 'ETH / USDC',
        baseSymbol: 'WETH',
        baseDecimals: 18,
        feeArena: '0x1111111111111111111111111111111111111111',
        oracle: '0x2222222222222222222222222222222222222222',
        pool: '0x5555555555555555555555555555555555555555',
        feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      },
      {
        id: 'btc',
        label: 'BTC / USDC',
        baseSymbol: 'WBTC',
        baseDecimals: 8,
        feeArena: '0xaaaa111111111111111111111111111111111111',
        oracle: '0xbbbb222222222222222222222222222222222222',
        pool: '0xcccc555555555555555555555555555555555555',
        feedId: BTC_FEED,
      },
    ]);
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }));
    expect(markets).toHaveLength(2);
    expect(markets[0].id).toBe('eth');
    expect(markets[1]).toMatchObject({ id: 'btc', baseSymbol: 'WBTC', baseDecimals: 8, feedId: BTC_FEED });
  });

  it('rejects a market with an invalid address', () => {
    const blob = JSON.stringify([
      { id: 'x', label: 'X', baseSymbol: 'WX', baseDecimals: 18, feeArena: '0x123', oracle: '0x2', pool: '0x3', feedId: BTC_FEED },
    ]);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }))).toThrow(/feeArena/);
  });

  it('rejects duplicate market ids', () => {
    const one = {
      id: 'dup', label: 'A', baseSymbol: 'WA', baseDecimals: 18,
      feeArena: '0x1111111111111111111111111111111111111111',
      oracle: '0x2222222222222222222222222222222222222222',
      pool: '0x5555555555555555555555555555555555555555',
      feedId: BTC_FEED,
    };
    const blob = JSON.stringify([one, one]);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }))).toThrow(/duplicate/);
  });

  it('rejects an empty MARKETS array', () => {
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: '[]' }))).toThrow(/non-empty/);
  });
});

// ── FeeArena v2 config: version marker + Lens + conviction bounds + treasury + legacy read-only ──
describe('markets: FeeArena v2 config (version / lens / conviction bounds / treasury)', () => {
  const V2_BLOB = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify([
      {
        id: 'btc',
        label: 'BTC / USDC',
        baseSymbol: 'cirBTC',
        baseDecimals: 8,
        feeArena: '0xaeb33d3bfd63e4c330bb78a0a0b249e53daa5c68',
        oracle: '0xf8ac3c46a062acc1d4c1ba23158bd0ef7242688e',
        pool: '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b',
        feedId: BTC_FEED,
        version: 'v2',
        lens: '0xa0db836f8a24781b5a4f457924c9860dfe2a80b9',
        treasury: '0x891b0000000000000000000000000000000000ab',
        minConv: '100000000', // 100 USDC (6dp)
        maxConv: '1000000000', // 1000 USDC (6dp)
        ...overrides,
      },
    ]);

  it('parses a v2 market: version marker, Lens address, conviction bounds (bigint), treasury', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB() }));
    const m = markets[0];
    expect(m.version).toBe('v2');
    expect(marketVersion(m)).toBe('v2');
    expect(m.lens).toBe('0xa0db836f8a24781b5a4f457924c9860dfe2a80b9');
    expect(m.treasury).toBe('0x891b0000000000000000000000000000000000ab');
    expect(m.minConv).toBe(100_000000n);
    expect(m.maxConv).toBe(1_000_000000n);
  });

  it('defaults version to v1 (and no lens/conviction bounds) when version is omitted', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ version: undefined, lens: undefined, treasury: undefined, minConv: undefined, maxConv: undefined }) }));
    const m = markets[0];
    expect(m.version).toBeUndefined();
    expect(marketVersion(m)).toBe('v1');
    expect(m.lens).toBeUndefined();
    expect(m.minConv).toBeUndefined();
    expect(m.maxConv).toBeUndefined();
  });

  it('requires lens + conviction bounds + treasury when version is v2', () => {
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ lens: undefined }) }))).toThrow(/lens/);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ minConv: undefined }) }))).toThrow(/minConv/);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ maxConv: undefined }) }))).toThrow(/maxConv/);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ treasury: undefined }) }))).toThrow(/treasury/);
  });

  it('rejects an invalid version value', () => {
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ version: 'v4' }) }))).toThrow(/version/);
  });

  it('parses a v3 (entry-anchored) market — no lens/conviction fields required', () => {
    const markets = buildMarkets(
      parseEnv({
        ...baseRaw,
        NEXT_PUBLIC_MARKETS: V2_BLOB({
          version: 'v3',
          lens: undefined,
          treasury: undefined,
          minConv: undefined,
          maxConv: undefined,
        }),
      }),
    );
    const m = markets[0];
    expect(m.version).toBe('v3');
    expect(marketVersion(m)).toBe('v3');
    expect(isV3Market(m)).toBe(true);
    expect(m.lens).toBeUndefined();
  });

  it('rejects conviction bounds with minConv > maxConv (or non-positive)', () => {
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ minConv: '2000000000', maxConv: '1000000000' }) }))).toThrow(/minConv|maxConv/);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ minConv: '0' }) }))).toThrow(/minConv/);
  });

  it('rejects a malformed Lens address', () => {
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB({ lens: '0xnope' }) }))).toThrow(/lens/);
  });

  it('parses a legacy (read-only v1) market entry so pending v1 winners can still claim', () => {
    const blob = JSON.stringify([
      JSON.parse(V2_BLOB())[0],
      {
        id: 'btc-v1',
        label: 'BTC / USDC (legacy)',
        baseSymbol: 'cirBTC',
        baseDecimals: 8,
        feeArena: '0xd0aedc19e1c27e7643255432006942ccfba5b8ce',
        oracle: '0xec6214cb521d4c7178b8cdefaef76e5b021dde59',
        pool: '0x969f2e3cb9929b5d50b6a59cf49cf30870e1658b',
        feedId: BTC_FEED,
        version: 'v1',
        readOnly: true,
      },
    ]);
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }));
    expect(markets).toHaveLength(2);
    const v2 = markets[0];
    const legacy = markets[1];
    expect(marketVersion(v2)).toBe('v2');
    expect(isReadOnlyMarket(v2)).toBe(false);
    expect(marketVersion(legacy)).toBe('v1');
    expect(legacy.readOnly).toBe(true);
    expect(isReadOnlyMarket(legacy)).toBe(true);
  });

  it('isReadOnlyMarket defaults to false when readOnly is omitted', () => {
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: V2_BLOB() }));
    expect(isReadOnlyMarket(markets[0])).toBe(false);
  });
});

describe('baseAcquireMode (on-ramp token acquisition — faucet-only)', () => {
  const mk = (baseSymbol: string, acquireMode?: Market['acquireMode']): Market => ({
    id: 'm', label: 'M', baseSymbol, baseDecimals: 18,
    feeArena: '0x1111111111111111111111111111111111111111',
    oracle: '0x2222222222222222222222222222222222222222',
    pool: '0x5555555555555555555555555555555555555555',
    feedId: BTC_FEED, fromBlock: 0n, acquireMode,
  });
  // The live arena runs on a REAL Circle token (cirBTC) with NO wrap and NO public mint. The legacy
  // 'wrap' (WETH9.deposit) and 'mint' (open-mint mock) on-ramps were removed with the mock tokens, so
  // baseAcquireMode always resolves to 'faucet' — regardless of symbol or whether acquireMode is set.
  it("always returns 'faucet' (the only supported on-ramp), for any base symbol", () => {
    expect(baseAcquireMode(mk('cirBTC'))).toBe('faucet');
    expect(baseAcquireMode(mk('WETH'))).toBe('faucet');
    expect(baseAcquireMode(mk('WBTC'))).toBe('faucet');
  });
  it("returns 'faucet' whether acquireMode is set or omitted", () => {
    expect(baseAcquireMode(mk('cirBTC', 'faucet'))).toBe('faucet');
    expect(baseAcquireMode(mk('cirBTC', undefined))).toBe('faucet');
  });
});

describe('markets: acquireMode + priceLabel config fields', () => {
  it('parses an explicit acquireMode and priceLabel from a MARKETS blob', () => {
    const blob = JSON.stringify([
      {
        id: 'btc',
        label: 'BTC / USDC',
        baseSymbol: 'cirBTC',
        baseDecimals: 8,
        feeArena: '0xaaaa111111111111111111111111111111111111',
        oracle: '0xbbbb222222222222222222222222222222222222',
        pool: '0xcccc555555555555555555555555555555555555',
        feedId: BTC_FEED,
        acquireMode: 'faucet',
        priceLabel: 'BTC / USD',
      },
    ]);
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }));
    expect(markets[0].acquireMode).toBe('faucet');
    expect(markets[0].priceLabel).toBe('BTC / USD');
    expect(baseAcquireMode(markets[0])).toBe('faucet');
  });

  it('leaves acquireMode/priceLabel undefined when not provided', () => {
    const blob = JSON.stringify([
      {
        id: 'eth', label: 'ETH / USDC', baseSymbol: 'WETH', baseDecimals: 18,
        feeArena: '0x1111111111111111111111111111111111111111',
        oracle: '0x2222222222222222222222222222222222222222',
        pool: '0x5555555555555555555555555555555555555555',
        feedId: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
      },
    ]);
    const markets = buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }));
    expect(markets[0].acquireMode).toBeUndefined();
    expect(markets[0].priceLabel).toBeUndefined();
  });

  it('rejects an invalid acquireMode value', () => {
    const blob = JSON.stringify([
      {
        id: 'x', label: 'X', baseSymbol: 'WX', baseDecimals: 18,
        feeArena: '0x1111111111111111111111111111111111111111',
        oracle: '0x2222222222222222222222222222222222222222',
        pool: '0x5555555555555555555555555555555555555555',
        feedId: BTC_FEED, acquireMode: 'bogus',
      },
    ]);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }))).toThrow(/acquireMode/);
  });

  // The legacy 'wrap'/'mint' modes were removed with the mock tokens — 'faucet' is now the only
  // accepted acquireMode, so a config still carrying the old values fails loudly at boot.
  it.each(['wrap', 'mint'])("rejects the removed legacy acquireMode '%s'", (mode) => {
    const blob = JSON.stringify([
      {
        id: 'x', label: 'X', baseSymbol: 'WX', baseDecimals: 18,
        feeArena: '0x1111111111111111111111111111111111111111',
        oracle: '0x2222222222222222222222222222222222222222',
        pool: '0x5555555555555555555555555555555555555555',
        feedId: BTC_FEED, acquireMode: mode,
      },
    ]);
    expect(() => buildMarkets(parseEnv({ ...baseRaw, NEXT_PUBLIC_MARKETS: blob }))).toThrow(/acquireMode/);
  });
});
