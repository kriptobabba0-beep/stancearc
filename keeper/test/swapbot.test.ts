import { describe, it, expect } from 'vitest';
import { decideSwapDirection, pegWithinBand, sellToFlatAmount, cappedSell, safeSellSize, pairSizeBase } from '../src/swapbot.js';

// Pool ~ $64,000 per cirBTC. cirBTC 8dp (base), USDC 6dp (quote).
const PRICE18 = 64_000n * 10n ** 18n;
const BASE_DEC = 8;
const QUOTE_DEC = 6;
const TRADE_BASE = 3_000n; // 0.00003 cirBTC ; quote cost = 3000*64000/100 = 1_920_000 (1.92 USDC)

const dir = (last: 'SELL_BASE' | 'BUY_BASE' | 'NONE', base: bigint, quote: bigint) =>
  decideSwapDirection(last, base, quote, PRICE18, TRADE_BASE, BASE_DEC, QUOTE_DEC);

describe('decideSwapDirection — strict alternating round-trips (price-neutral volume)', () => {
  // Both legs amply funded, so the funding fallbacks never override the alternation.
  const RICH_BASE = 1_000_000n; // 0.01 cirBTC
  const RICH_QUOTE = 100_000_000n; // 100 USDC

  it('alternates SELL after a BUY', () => {
    expect(dir('BUY_BASE', RICH_BASE, RICH_QUOTE)).toBe('SELL_BASE');
  });

  it('alternates BUY after a SELL', () => {
    expect(dir('SELL_BASE', RICH_BASE, RICH_QUOTE)).toBe('BUY_BASE');
  });

  it('treats NONE (cold start) as "sell next" so the first trade is a SELL_BASE', () => {
    expect(dir('NONE', RICH_BASE, RICH_QUOTE)).toBe('SELL_BASE');
  });

  it('overrides to BUY when it wants to SELL but the base leg cannot fund it', () => {
    // want SELL (last BUY) but base 1000 < tradeBase 3000 -> fall back to BUY (quote can fund)
    expect(dir('BUY_BASE', 1_000n, RICH_QUOTE)).toBe('BUY_BASE');
  });

  it('overrides to SELL when it wants to BUY but the quote leg cannot fund it', () => {
    // want BUY (last SELL) but quote 1.0 USDC < 1.92 cost -> fall back to SELL (base can fund)
    expect(dir('SELL_BASE', RICH_BASE, 1_000_000n)).toBe('SELL_BASE');
  });

  it('returns NONE when neither leg can fund a swap (bot drained — needs a refill)', () => {
    expect(dir('BUY_BASE', 1_000n, 1_000_000n)).toBe('NONE');
  });

  it('exactly the trade thresholds count as fundable (>= boundaries)', () => {
    // want SELL (last BUY); base exactly tradeBase funds the sell
    expect(dir('BUY_BASE', 3_000n, 0n)).toBe('SELL_BASE');
    // want BUY (last SELL); quote exactly the trade cost funds the buy
    expect(dir('SELL_BASE', 0n, 1_920_000n)).toBe('BUY_BASE');
  });
});

describe('pegWithinBand — swap-bot↔arb peg gate (stand down when off-peg)', () => {
  const REF = 63_000n * 10n ** 18n; // $63,000 reference

  it('is OPEN when the pool is at the reference', () => {
    expect(pegWithinBand(REF, REF, 200)).toBe(true);
  });

  it('is OPEN for small deviations within the band (e.g. 1% < 2%)', () => {
    const pool = (REF * 101n) / 100n; // +1%
    expect(pegWithinBand(pool, REF, 200)).toBe(true);
    expect(pegWithinBand((REF * 99n) / 100n, REF, 200)).toBe(true); // -1%
  });

  it('is CLOSED when the pool is off-peg beyond the band (the runaway case)', () => {
    const pool = (REF * 113n) / 100n; // +13% (the observed broken state)
    expect(pegWithinBand(pool, REF, 200)).toBe(false);
    expect(pegWithinBand((REF * 80n) / 100n, REF, 200)).toBe(false); // -20%
  });

  it('treats the exact band edge as still OPEN (<=)', () => {
    const pool = (REF * 10_200n) / 10_000n; // exactly +2.00%
    expect(pegWithinBand(pool, REF, 200)).toBe(true);
    const justOver = (REF * 10_201n) / 10_000n; // +2.01%
    expect(pegWithinBand(justOver, REF, 200)).toBe(false);
  });

  it('is DISABLED (always open) when maxDevBps <= 0 — legacy strict alternation', () => {
    expect(pegWithinBand((REF * 200n) / 100n, REF, 0)).toBe(true); // +100% but gate off
  });

  it('fails CLOSED when the reference is non-positive (can\'t verify the peg)', () => {
    expect(pegWithinBand(REF, 0n, 200)).toBe(false);
    expect(pegWithinBand(0n, REF, 200)).toBe(false);
  });
});

describe('sellToFlatAmount — round-trip returns the bot to flat (no directional position)', () => {
  it('sells exactly what a buy produced when starting flat (target 0)', () => {
    // started at 0, bought 10650 -> sell all 10650 back -> net 0 (neutral round-trip)
    expect(sellToFlatAmount(10_650n, 0n)).toBe(10_650n);
  });

  it('cleans up a leftover long from a prior failed sell (sells everything above target)', () => {
    // held 10650 leftover + bought 10650 = 21300 -> sell 21300 back to flat (self-correcting)
    expect(sellToFlatAmount(21_300n, 0n)).toBe(21_300n);
  });

  it('respects a non-zero flat target (keeps a small reserve)', () => {
    expect(sellToFlatAmount(15_000n, 5_000n)).toBe(10_000n);
  });

  it('returns 0 when already at/below the target (nothing to sell)', () => {
    expect(sellToFlatAmount(5_000n, 5_000n)).toBe(0n);
    expect(sellToFlatAmount(0n, 0n)).toBe(0n);
    expect(sellToFlatAmount(3_000n, 5_000n)).toBe(0n);
  });
});

describe('cappedSell — pool-deliverability cap on a SELL leg (the one-sided-pool wedge fix)', () => {
  // At $64k, 70% safety. A SELL is capped to the base whose ref-priced proceeds fit under 70% of the
  // pool's real USDC, so it can never ask for more USDC than the pool holds (-> no "Too little received").
  it('returns ~0 when the pool holds NO USDC (one-sided pool) -> caller idles, never a doomed swap', () => {
    const want = 1_000_000n; // wants to sell 0.01 cirBTC
    expect(cappedSell(want, 0n, PRICE18, 7000, BASE_DEC, QUOTE_DEC)).toBe(0n);
  });

  it('caps the SELL to what 70% of the pool USDC can buy when the pool is thin', () => {
    // Pool holds 6.4 USDC (6_400_000 raw). 70% = 4.48 USDC -> at $64k that's 0.00007 cirBTC = 7000 raw.
    const capped = cappedSell(1_000_000n, 6_400_000n, PRICE18, 7000, BASE_DEC, QUOTE_DEC);
    expect(capped).toBe(7000n);
  });

  it('does not cap below the desired size when the pool is deep enough', () => {
    const want = 3_000n;
    // Pool holds 1000 USDC -> 70% = 700 USDC, far more than the 3000-raw clip needs.
    expect(cappedSell(want, 1_000_000_000n, PRICE18, 7000, BASE_DEC, QUOTE_DEC)).toBe(want);
  });

  it('safety 0 disables the cap (legacy behavior — returns the wanted size unchanged)', () => {
    expect(cappedSell(1_000_000n, 0n, PRICE18, 0, BASE_DEC, QUOTE_DEC)).toBe(1_000_000n);
  });
});

describe('safeSellSize — slippage-safe SELL sizing (price-impact + deliverability)', () => {
  const L = 592_000_000n; // the live pool's in-range liquidity
  const POOLQ = 869_000_000n; // 869 USDC (6dp) in the pool

  it('clips a large long to a small slippage-safe size (NOT the whole 0.01 cirBTC the pool cannot absorb)', () => {
    const want = 1_017_000n; // 0.01017 cirBTC — the live over-size that reverted
    const safe = safeSellSize(want, L, POOLQ, PRICE18, 200, 7000, false, BASE_DEC, QUOTE_DEC);
    expect(safe).toBeGreaterThan(0n);
    expect(safe).toBeLessThan(want); // clipped well below the full long
  });

  it('returns 0 on a one-sided (USDC-empty) pool -> caller idles', () => {
    expect(safeSellSize(1_000_000n, L, 0n, PRICE18, 200, 7000, false, BASE_DEC, QUOTE_DEC)).toBe(0n);
  });

  it('does not clip a size already within both bounds', () => {
    const tiny = 100n; // 0.000001 cirBTC — far below the impact + deliverable caps
    expect(safeSellSize(tiny, L, POOLQ, PRICE18, 200, 7000, false, BASE_DEC, QUOTE_DEC)).toBe(tiny);
  });
});

describe('pairSizeBase — per-epoch peg-NEUTRAL pair sizing (depth-bounded, capped, dust-floored)', () => {
  // The live thin pool: in-range L ~ 6e6, base=cirBTC 8dp (token1), quote 6dp (token0), so baseIsToken0=false.
  const L = 6_000_000n;
  const REF = 60_000n * 10n ** 18n; // Pyth oracle: $60,000
  const PAIR = 200_000n; // 0.002 cirBTC intent per leg
  const MAX = 200_000n; // cap == intent by default
  const MIN = 100n; // dust floor
  const CLOSE = 1.0; // land AT the oracle

  const sz = (
    liq: bigint,
    pool: bigint,
    ref: bigint,
    close = CLOSE,
    pair = PAIR,
    max = MAX,
    min = MIN,
  ) => pairSizeBase(liq, pool, ref, close, pair, max, min, false, BASE_DEC, QUOTE_DEC);

  it('at peg (pool == ref) there is no gap, so it fires the full intent (pure fee volume)', () => {
    // A round-trip nets to zero at the peg; depth does not bound it -> returns the intent (capped).
    expect(sz(L, REF, REF)).toBe(PAIR);
  });

  it('on a thin pool with a real gap it CLIPS the leg to the depth-derived size (< intent)', () => {
    // pool 2% below the oracle on a paper-thin L: the base that moves the pool to the ref is tiny,
    // far below the 0.002 intent, so a single leg can never blow the thin pool past peg.
    const pool = (REF * 98n) / 100n; // -2%
    const s = sz(L, pool, REF);
    expect(s).toBeGreaterThan(0n);
    expect(s).toBeLessThan(PAIR); // depth-bounded, not the raw intent
  });

  it('a DEEP pool does not clip below the intent (depth cap exceeds intent -> intent wins)', () => {
    const deep = 10_000_000_000_000n; // very deep L
    const pool = (REF * 98n) / 100n; // -2%
    expect(sz(deep, pool, REF)).toBe(PAIR); // min(intent, hugeDepthCap) == intent
  });

  it('honors the hard max cap (never sizes a leg above pairMaxTradeBase)', () => {
    const deep = 10_000_000_000_000n;
    const pool = (REF * 90n) / 100n; // -10%, big gap
    const cap = 50_000n; // 0.0005 cirBTC cap, below the 0.002 intent
    expect(sz(deep, pool, REF, CLOSE, PAIR, cap)).toBe(cap);
  });

  it('closeFraction UNDERSHOOTS: a smaller fraction => a smaller (or equal) depth-bounded leg', () => {
    const pool = (REF * 95n) / 100n; // -5% gap
    const full = sz(L, pool, REF, 1.0);
    const half = sz(L, pool, REF, 0.5);
    expect(half).toBeLessThanOrEqual(full); // closing only half the gap never sizes larger
  });

  it('returns 0 (skip the pair) when the sized leg is below the dust floor', () => {
    const pool = (REF * 9999n) / 10_000n; // -0.01% — a hair off peg on a thin pool => sub-dust
    const highMin = 1_000_000n; // 0.01 cirBTC dust floor, far above the tiny depth size
    expect(sz(L, pool, REF, CLOSE, PAIR, MAX, highMin)).toBe(0n);
  });

  it('returns 0 on a degenerate intent / inputs (never sizes a swap it cannot fund)', () => {
    expect(sz(L, REF, REF, CLOSE, 0n)).toBe(0n); // zero intent
    expect(sz(0n, (REF * 98n) / 100n, REF)).toBe(PAIR); // zero liquidity -> depth doesn't bound; intent stands
    expect(sz(L, 0n, REF)).toBe(PAIR); // non-positive pool -> depth skipped; intent stands
    expect(sz(L, REF, 0n)).toBe(PAIR); // non-positive ref -> depth skipped; intent stands
  });
});
