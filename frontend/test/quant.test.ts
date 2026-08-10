import { describe, it, expect } from 'vitest';
import {
  baseUsd6,
  potUsd6,
  totalClaimedUsd6,
  impliedMove,
  impliedMoveText,
  priceSymbol,
  formatUsd6,
  formatUsd6Precise,
  cumulativePot6,
  epochShareUrl,
  winShareText,
} from '@/lib/quant';

describe('baseUsd6 — base leg × oracle price, 6dp USD, floor', () => {
  const P_100K = 100_000n * 10n ** 18n; // $100,000 at 18dp

  it('cirBTC 8dp: 1 BTC at $100k = $100,000.000000 (100_000e6)', () => {
    const oneBtc = 1n * 10n ** 8n; // 1.00000000 cirBTC
    expect(baseUsd6(oneBtc, 8, P_100K)).toBe(100_000n * 10n ** 6n);
  });

  it('cirBTC 8dp: 0.001 BTC at $100k = $100.000000', () => {
    const milli = 100_000n; // 0.001 cirBTC at 8dp
    expect(baseUsd6(milli, 8, P_100K)).toBe(100n * 10n ** 6n);
  });

  it('WETH 18dp: 2 ETH at $3000 = $6000.000000', () => {
    const twoEth = 2n * 10n ** 18n;
    const p3000 = 3000n * 10n ** 18n;
    expect(baseUsd6(twoEth, 18, p3000)).toBe(6000n * 10n ** 6n);
  });

  it('zero amount or zero price → 0', () => {
    expect(baseUsd6(0n, 8, P_100K)).toBe(0n);
    expect(baseUsd6(1n * 10n ** 8n, 8, 0n)).toBe(0n);
  });

  it('floors a sub-cent dust amount toward zero', () => {
    // 1 satoshi (1 raw at 8dp) at $100k = $0.001 → 1000 micro-dollars (exact, no flooring loss here)
    expect(baseUsd6(1n, 8, P_100K)).toBe(1_000n);
  });
});

describe('potUsd6 — base leg + USDC leg', () => {
  it('adds the USDC leg (already 6dp) to the converted base leg', () => {
    const out = potUsd6({
      potWETH: 1n * 10n ** 8n, // 1 cirBTC
      potUSDC: 250n * 10n ** 6n, // $250 USDC
      baseDecimals: 8,
      price18: 100_000n * 10n ** 18n, // $100k
    });
    expect(out).toBe((100_000n + 250n) * 10n ** 6n);
  });

  it('price18==0 (oracle unread) → only the USDC leg counts', () => {
    const out = potUsd6({ potWETH: 5n * 10n ** 8n, potUSDC: 42n * 10n ** 6n, baseDecimals: 8, price18: 0n });
    expect(out).toBe(42n * 10n ** 6n);
  });
});

describe('totalClaimedUsd6 — lifetime claimed payouts across leaderboard rows', () => {
  const P_100K = 100_000n * 10n ** 18n; // $100k at 18dp

  it('sums USDC legs verbatim and values base legs at the live price', () => {
    const rows = [
      { claimedBase: 1n * 10n ** 8n, claimedUSDC: 250n * 10n ** 6n }, // 1 BTC ($100k) + $250
      { claimedBase: 0n, claimedUSDC: 50n * 10n ** 6n }, // $50
    ];
    expect(totalClaimedUsd6(rows, 8, P_100K)).toBe((100_000n + 250n + 50n) * 10n ** 6n);
  });

  it('empty rows → 0', () => {
    expect(totalClaimedUsd6([], 8, P_100K)).toBe(0n);
  });

  it('price18==0 (oracle unread) → only USDC legs count', () => {
    const rows = [{ claimedBase: 5n * 10n ** 8n, claimedUSDC: 42n * 10n ** 6n }];
    expect(totalClaimedUsd6(rows, 8, 0n)).toBe(42n * 10n ** 6n);
  });
});

describe('impliedMove — pure restatement of the band', () => {
  it('20 bps → 0.2%', () => {
    expect(impliedMove(20)).toEqual({ pct: 0.2, bps: 20 });
  });
  it('150 bps → 1.5%', () => {
    expect(impliedMove(150)).toEqual({ pct: 1.5, bps: 150 });
  });
  it('uses |band| so a negative band still reads sanely', () => {
    expect(impliedMove(-20)).toEqual({ pct: 0.2, bps: 20 });
  });
  it('zero band → 0', () => {
    expect(impliedMove(0)).toEqual({ pct: 0, bps: 0 });
  });
});

describe('impliedMoveText — honest one-liner', () => {
  it('20 bps keeps 2 decimals', () => {
    expect(impliedMoveText(20, 'BTC')).toBe('BTC must move >0.20% this epoch for UP/DOWN; else RANGE');
  });
  it('≥1% trims trailing zeros', () => {
    expect(impliedMoveText(150, 'BTC')).toBe('BTC must move >1.5% this epoch for UP/DOWN; else RANGE');
  });
  it('zero band degrades to a flat-epoch note', () => {
    expect(impliedMoveText(0, 'BTC')).toMatch(/Any move decides UP\/DOWN/);
  });
});

describe('priceSymbol — strip a leading W only before another capital', () => {
  it('WETH → ETH, WBTC → BTC', () => {
    expect(priceSymbol('WETH')).toBe('ETH');
    expect(priceSymbol('WBTC')).toBe('BTC');
  });
  it('cirBTC unchanged (lowercase after W is not a wrapped prefix)', () => {
    expect(priceSymbol('cirBTC')).toBe('cirBTC');
  });
});

describe('formatUsd6 — compact USD label', () => {
  it('sub-$1 shows cents', () => {
    expect(formatUsd6(420_000n)).toBe('$0.42'); // $0.42
    expect(formatUsd6(0n)).toBe('$0.00');
  });
  it('≥$1 rounds to whole dollars with thousands separators', () => {
    expect(formatUsd6(1_234_560_000n)).toBe('$1,234'); // $1,234.56 → $1,234
    expect(formatUsd6(1_000_000n)).toBe('$1');
    expect(formatUsd6(1_000_000_000n)).toBe('$1,000');
  });
  it('clamps negatives to zero', () => {
    expect(formatUsd6(-5n)).toBe('$0.00');
  });
});

describe('formatUsd6Precise — never rounds a real dust pot away to $0.00', () => {
  it('a genuine zero still shows $0.00', () => {
    expect(formatUsd6Precise(0n)).toBe('$0.00');
  });
  it('sub-cent dust shows the real micro-dollar value (trailing zeros trimmed)', () => {
    expect(formatUsd6Precise(526n)).toBe('$0.000526'); // $0.000526
    expect(formatUsd6Precise(64n)).toBe('$0.000064');
    expect(formatUsd6Precise(500n)).toBe('$0.0005'); // trailing zeros trimmed
    expect(formatUsd6Precise(1_246n)).toBe('$0.001246');
  });
  it('at or above a cent it defers to the compact formatUsd6', () => {
    expect(formatUsd6Precise(10_000n)).toBe('$0.01');
    expect(formatUsd6Precise(420_000n)).toBe('$0.42');
    expect(formatUsd6Precise(1_234_560_000n)).toBe('$1,234');
  });
  it('honors the currency symbol and clamps negatives', () => {
    expect(formatUsd6Precise(526n, '€')).toBe('€0.000526');
    expect(formatUsd6Precise(-5n)).toBe('$0.00');
  });
});

describe('cumulativePot6 — total fees settled across the epoch history', () => {
  const P_100K = 100_000n * 10n ** 18n;
  it('sums USDC legs verbatim and values base legs at the live price', () => {
    const rows = [
      { potBase: 0n, potUSDC: 64n }, // $0.000064
      { potBase: 0n, potUSDC: 526n }, // $0.000526
      { potBase: 1n * 10n ** 8n, potUSDC: 0n }, // 1 BTC at $100k
    ];
    expect(cumulativePot6(rows, 8, P_100K)).toBe(64n + 526n + 100_000n * 10n ** 6n);
  });
  it('empty history → 0', () => {
    expect(cumulativePot6([], 8, P_100K)).toBe(0n);
  });
  it('price18==0 (oracle unread) → only USDC legs count', () => {
    const rows = [{ potBase: 5n * 10n ** 8n, potUSDC: 42n }];
    expect(cumulativePot6(rows, 8, 0n)).toBe(42n);
  });
});

describe('epochShareUrl', () => {
  it('joins origin + /epoch/<id>', () => {
    expect(epochShareUrl('https://fee-arena.vercel.app', 7n)).toBe(
      'https://fee-arena.vercel.app/epoch/7',
    );
  });
  it('strips a trailing slash on origin', () => {
    expect(epochShareUrl('https://x.app/', 3n)).toBe('https://x.app/epoch/3');
  });
  it('empty origin → relative path', () => {
    expect(epochShareUrl('', 9n)).toBe('/epoch/9');
  });
});

describe('winShareText', () => {
  it('renders the branded one-liner with the earned amount', () => {
    expect(winShareText({ epochId: 7n, winningLabel: 'DOWN', usd6: 1_234_000_000n })).toBe(
      'Epoch #7 — DOWN won. I earned $1,234 on Limen Finance.',
    );
  });
});
