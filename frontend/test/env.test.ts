import { describe, it, expect } from 'vitest';
import { parseEnv } from '@/lib/env';

const valid: Record<string, string> = {
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

describe('parseEnv', () => {
  it('parses a valid env into a typed config', () => {
    const env = parseEnv(valid);
    expect(env.CHAIN_ID).toBe(5042002);
    expect(env.RPC_HTTP).toBe('https://rpc.testnet.arc.network');
    expect(env.RPC_WS).toBe('wss://rpc.testnet.arc.network');
    expect(env.EXPLORER_URL).toBe('https://testnet.arcscan.app');
    expect(env.FEE_ARENA_ADDRESS).toBe('0x1111111111111111111111111111111111111111');
    expect(env.USDC_ADDRESS).toBe('0x3600000000000000000000000000000000000000');
    expect(env.MULTICALL3_ADDRESS).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
    expect(env.PYTH_ADDRESS).toBe('0x2880aB155794e7179c9eE2e38200202908C17B43');
    expect(env.PYTH_ETHUSD_ID).toBe(
      '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
    );
  });

  it('defaults HERMES_URL when unset', () => {
    expect(parseEnv(valid).HERMES_URL).toBe('https://hermes.pyth.network');
  });

  it('defaults MARKETS to "" when unset', () => {
    expect(parseEnv(valid).MARKETS).toBe('');
  });

  it('passes through a valid MARKETS JSON array string', () => {
    const blob = '[{"id":"eth"},{"id":"btc"}]';
    expect(parseEnv({ ...valid, NEXT_PUBLIC_MARKETS: blob }).MARKETS).toBe(blob);
  });

  it('throws when MARKETS is set but not valid JSON', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_MARKETS: 'not-json' })).toThrow(/NEXT_PUBLIC_MARKETS/);
  });

  it('defaults EURC_ADDRESS to the canonical Arc testnet EURC when unset', () => {
    expect(parseEnv(valid).EURC_ADDRESS).toBe('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a');
  });

  it('accepts a NEXT_PUBLIC_EURC_ADDRESS override', () => {
    const env = parseEnv({ ...valid, NEXT_PUBLIC_EURC_ADDRESS: '0x8888888888888888888888888888888888888888' });
    expect(env.EURC_ADDRESS).toBe('0x8888888888888888888888888888888888888888');
  });

  it('throws when NEXT_PUBLIC_EURC_ADDRESS is set but malformed', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_EURC_ADDRESS: '0xnope' })).toThrow(/NEXT_PUBLIC_EURC_ADDRESS/);
  });

  it('throws when PYTH_ETHUSD_ID is not a 0x64-hex bytes32', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_PYTH_ETHUSD_ID: '0xabcd' })).toThrow(
      /NEXT_PUBLIC_PYTH_ETHUSD_ID/,
    );
  });

  it('throws when a required key is missing', () => {
    const { NEXT_PUBLIC_RPC_HTTP, ...missing } = valid;
    expect(() => parseEnv(missing)).toThrow(/NEXT_PUBLIC_RPC_HTTP/);
  });

  it('throws when CHAIN_ID is not a positive integer', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_CHAIN_ID: 'abc' })).toThrow(/NEXT_PUBLIC_CHAIN_ID/);
  });

  it('throws when an address is not a 0x40-hex string', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_POOL_ADDRESS: '0x123' })).toThrow(/NEXT_PUBLIC_POOL_ADDRESS/);
  });

  it('throws when an http url is not http(s)', () => {
    expect(() => parseEnv({ ...valid, NEXT_PUBLIC_RPC_HTTP: 'ftp://nope' })).toThrow(/NEXT_PUBLIC_RPC_HTTP/);
  });

  // ── RPC_HTTP_URLS (multi-RPC comma-separated list) ────────────────────────
  it('single URL → RPC_HTTP_URLS is a one-element list and RPC_HTTP equals that URL', () => {
    const env = parseEnv(valid);
    expect(env.RPC_HTTP_URLS).toEqual(['https://rpc.testnet.arc.network']);
    expect(env.RPC_HTTP).toBe('https://rpc.testnet.arc.network');
  });

  it('comma-separated URLs → RPC_HTTP_URLS preserves order and RPC_HTTP is the first', () => {
    const env = parseEnv({
      ...valid,
      NEXT_PUBLIC_RPC_HTTP:
        'https://rpc1.arc.network,https://rpc2.arc.network,https://rpc3.arc.network',
    });
    expect(env.RPC_HTTP_URLS).toEqual([
      'https://rpc1.arc.network',
      'https://rpc2.arc.network',
      'https://rpc3.arc.network',
    ]);
    expect(env.RPC_HTTP).toBe('https://rpc1.arc.network');
  });

  it('blank entries in a comma-separated list are silently dropped', () => {
    const env = parseEnv({
      ...valid,
      NEXT_PUBLIC_RPC_HTTP: 'https://rpc1.arc.network, , https://rpc2.arc.network,',
    });
    expect(env.RPC_HTTP_URLS).toEqual(['https://rpc1.arc.network', 'https://rpc2.arc.network']);
  });

  it('duplicate URLs in a comma-separated list are de-duped while preserving order', () => {
    const env = parseEnv({
      ...valid,
      NEXT_PUBLIC_RPC_HTTP:
        'https://rpc1.arc.network,https://rpc2.arc.network,https://rpc1.arc.network',
    });
    expect(env.RPC_HTTP_URLS).toEqual(['https://rpc1.arc.network', 'https://rpc2.arc.network']);
  });

  it('throws when any URL in the list is not http(s)', () => {
    expect(() =>
      parseEnv({
        ...valid,
        NEXT_PUBLIC_RPC_HTTP: 'https://rpc1.arc.network,ftp://bad.url',
      }),
    ).toThrow(/NEXT_PUBLIC_RPC_HTTP/);
  });

  it('throws when the comma-separated list resolves to no valid URLs', () => {
    expect(() =>
      parseEnv({ ...valid, NEXT_PUBLIC_RPC_HTTP: ' , , ' }),
    ).toThrow(/NEXT_PUBLIC_RPC_HTTP/);
  });
});
