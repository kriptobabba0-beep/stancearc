import { describe, it, expect, vi, beforeEach } from 'vitest';

// The module-level MARKETS in lib/markets.ts is built at import time from the live ENV. It must:
//   (1) fall back to the all-zero PLACEHOLDER market only when ENV itself is unreadable (the test-time
//       throwing Proxy = no NEXT_PUBLIC_* configured), so component tests can import the module; and
//   (2) THROW on a present-but-invalid NEXT_PUBLIC_MARKETS (valid JSON, bad shape) when ENV is real,
//       instead of silently booting the zero-address placeholder (Fix D).
// We control what '@/lib/env' exports per case and re-import the module fresh each time.

const ZERO = '0x0000000000000000000000000000000000000000';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('lib/markets module-level MARKETS (Fix D)', () => {
  it('placeholders (all-zero ETH) when ENV is the throwing Proxy (no env configured)', async () => {
    // Mirror lib/env.ts: ENV is a Proxy that throws on ANY property access.
    vi.doMock('@/lib/env', () => ({
      ENV: new Proxy(
        {},
        {
          get() {
            throw new Error('[env] ENV accessed before NEXT_PUBLIC_* were set.');
          },
        },
      ),
      parseAddress: (v: string) => v,
      parseBytes32: (v: string) => v,
    }));

    const mod = await import('@/lib/markets');
    expect(mod.MARKETS).toHaveLength(1);
    expect(mod.MARKETS[0].id).toBe('eth');
    expect(mod.MARKETS[0].feeArena).toBe(ZERO); // the placeholder zero-address market
  });

  it('THROWS at import when ENV is real but NEXT_PUBLIC_MARKETS is present-but-invalid', async () => {
    const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
    const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
    // A real, readable ENV whose MARKETS blob is valid JSON but has a malformed address (bad shape).
    vi.doMock('@/lib/env', () => ({
      ENV: {
        FEE_ARENA_ADDRESS: '0x1111111111111111111111111111111111111111',
        ORACLE_ADDRESS: '0x2222222222222222222222222222222222222222',
        POOL_ADDRESS: '0x5555555555555555555555555555555555555555',
        PYTH_ETHUSD_ID: `0x${'a'.repeat(64)}`,
        MARKETS: JSON.stringify([
          { id: 'btc', label: 'BTC', baseSymbol: 'WBTC', baseDecimals: 8, feeArena: '0xNOTANADDR', oracle: '0x2', pool: '0x3', feedId: `0x${'b'.repeat(64)}` },
        ]),
      },
      parseAddress: (v: string, label: string) => {
        if (!ADDRESS_RE.test(v)) throw new Error(`[markets] ${label} must be a 0x-prefixed 40-hex address, got "${v}"`);
        return v;
      },
      parseBytes32: (v: string, label: string) => {
        if (!BYTES32_RE.test(v)) throw new Error(`[markets] ${label} must be a 0x-prefixed 64-hex bytes32, got "${v}"`);
        return v;
      },
    }));

    // The import must reject (the IIFE lets buildMarkets throw — NOT swallowed to a placeholder).
    await expect(import('@/lib/markets')).rejects.toThrow(/feeArena/);
  });
});
