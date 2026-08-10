import { describe, it, expect } from 'vitest';
import { decideArb, type ArbState, type ArbParams } from '../src/decideArb.js';
import { baseAmountToMovePrice } from '../src/poolMath.js';

// ---------------------------------------------------------------------------
// Baselines. Each case overrides only the fields it cares about.
//
// Reference price ref18 = 100e18 ("$100" in 18dp). feeBps 30, thresholdBps 25
// -> no-trade band is |divBps| <= 55. So a 1% (100 bps) divergence trades; a
// 0.5% (50 bps) divergence does not.
//
// SIZING NOTE (post HIGH-1/HIGH-2 fix): the trade is now sized from the pool's
// in-range LIQUIDITY via the V3 sqrt-price relationship, NOT from a divergence-
// scaled fraction of maxTradeBase. So `liquidity` is a first-class input and the
// tests pick L values that exercise the genuine sizing path (uncapped, in (min,max))
// AND the cap path. The market here is cirBTC(8dp)/USDC(6dp) with token0=USDC,
// token1=cirBTC, i.e. baseIsToken0=false (cirBTC 0xf0C4 > USDC 0x3600 in sort order).
// ---------------------------------------------------------------------------
const ONE = 10n ** 18n;
const REF = 100n * ONE; // 100e18

// A liquidity deep enough that even a band-clearing divergence sizes well above the
// SWAP tests' maxTradeBase (1e8) -> the cap is the binding value there.
const DEEP_L = 10n ** 14n;

const baseState: ArbState = {
  poolPrice18: REF,
  ref18: REF,
  refAgeSec: 5,
  liquidity: DEEP_L,
  baseIsToken0: false, // cirBTC is token1 (token0=USDC)
  inventoryBase: 10n ** 8n * 1_000_000n, // huge base inventory (8dp token)
  inventoryUsdc: 10n ** 6n * 1_000_000_000n, // huge USDC inventory (6dp)
};

const baseParams: ArbParams = {
  feeBps: 30,
  thresholdBps: 25,
  closeFraction: 0.6,
  // base token is 8dp; 1 base unit = 1e8 raw.
  maxTradeBase: 10n ** 8n, // 1.0 base
  minTradeBase: 10n ** 6n, // 0.01 base
  maxRefAgeSec: 60,
  baseDecimals: 8,
  quoteDecimals: 6,
};

const st = (over: Partial<ArbState>): ArbState => ({ ...baseState, ...over });
const pr = (over: Partial<ArbParams>): ArbParams => ({ ...baseParams, ...over });

// bps -> a pool price that is `bps` basis points above (positive) / below (negative) ref.
const poolAtBps = (bps: number): bigint => REF + (REF * BigInt(bps)) / 10_000n;

describe('decideArb — inventory depletion surfaces as ALERT (not silent NONE)', () => {
  it('ALERTs when it must SELL_BASE (pool above ref) but base inventory is depleted', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(5000), inventoryBase: 0n }), baseParams);
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/depleted|cirBTC|out of/i);
  });

  it('ALERTs when it must BUY_BASE (pool below ref) but USDC inventory is depleted', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(-5000), inventoryUsdc: 0n }), baseParams);
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/depleted|USDC|out of/i);
  });

  it('still SWAPs normally when inventory is sufficient (no false ALERT)', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(5000) }), baseParams);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
  });
});

describe('decideArb — guards (SKIP / ALERT)', () => {
  it('SKIPs when the reference is stale (refAgeSec > maxRefAgeSec)', () => {
    const d = decideArb(st({ refAgeSec: 61, poolPrice18: poolAtBps(500) }), baseParams);
    expect(d.kind).toBe('SKIP');
    expect(d.reason).toMatch(/stale/i);
  });

  it('does NOT skip exactly at maxRefAgeSec (boundary is inclusive-OK)', () => {
    const d = decideArb(st({ refAgeSec: 60, poolPrice18: poolAtBps(500) }), baseParams);
    expect(d.kind).not.toBe('SKIP');
  });

  it('ALERTs when liquidity is zero (pool inert — cannot arb)', () => {
    const d = decideArb(st({ liquidity: 0n, poolPrice18: poolAtBps(500) }), baseParams);
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/liquidit/i);
  });

  it('stale-ref SKIP takes precedence over zero-liquidity ALERT', () => {
    const d = decideArb(st({ refAgeSec: 999, liquidity: 0n }), baseParams);
    expect(d.kind).toBe('SKIP');
  });
});

describe('decideArb — no-trade band (NONE)', () => {
  it('returns NONE when pool == ref (divBps 0)', () => {
    const d = decideArb(st({ poolPrice18: REF }), baseParams);
    expect(d.kind).toBe('NONE');
  });

  it('returns NONE inside the band (50 bps < 55 band)', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(50) }), baseParams);
    expect(d.kind).toBe('NONE');
  });

  it('returns NONE inside the band on the negative side (-50 bps)', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(-50) }), baseParams);
    expect(d.kind).toBe('NONE');
  });

  it('EXACT band boundary (|divBps| == feeBps+thresholdBps == 55) -> NONE (in-band)', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(55) }), baseParams);
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/band/i);
  });

  it('one bps past the boundary (56 bps) clears the BAND (not an in-band NONE)', () => {
    // 56 bps clears the no-trade band, so it is NOT rejected for being in-band. With deep
    // liquidity the size is well past the dust floor too, so this is a SWAP — the bot now
    // ACTIVATES right at the band edge (the HIGH-1 dead-zone is gone).
    const d = decideArb(st({ poolPrice18: poolAtBps(56) }), baseParams);
    expect(d.reason).not.toMatch(/band/i);
    expect(d.kind).toBe('SWAP');
  });

  it('just past the band with a non-dust size (200 bps) -> SWAP', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(200) }), baseParams);
    expect(d.kind).toBe('SWAP');
  });
});

describe('decideArb — direction', () => {
  it('SELL_BASE when pool > ref (push pool down toward ref)', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(200) }), baseParams);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
  });

  it('BUY_BASE when pool < ref (push pool up toward ref)', () => {
    const d = decideArb(st({ poolPrice18: poolAtBps(-200) }), baseParams);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
  });
});

describe('decideArb — sizing (liquidity-anchored)', () => {
  it('caps SELL_BASE size at maxTradeBase when liquidity is deep + inventory plentiful', () => {
    // Deep L + a large divergence so the liquidity-derived size exceeds maxTradeBase.
    const d = decideArb(st({ poolPrice18: poolAtBps(2_000) }), baseParams);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
    expect(d.amountInBase).toBe(baseParams.maxTradeBase);
  });

  it('caps SELL_BASE size at base inventory when inventory < the liquidity size & max', () => {
    const inv = baseParams.maxTradeBase / 2n; // 0.5 base available
    const d = decideArb(
      st({ poolPrice18: poolAtBps(2_000), inventoryBase: inv }),
      baseParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
    expect(d.amountInBase).toBe(inv);
  });

  it('caps BUY_BASE size by USDC inventory (converted to base via ref)', () => {
    // Only enough USDC to buy 0.25 base at the ref price (100 USDC/base, 6dp USDC).
    // 0.25 base -> 25 USDC -> 25e6 raw. The liquidity size (deep L, big div) far
    // exceeds this, so the USDC-derived base cap (0.25e8 raw) is the binding value.
    const usdc = 25n * 10n ** 6n;
    const d = decideArb(
      st({ poolPrice18: poolAtBps(-2_000), inventoryUsdc: usdc }),
      baseParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
    // 0.25 base = 0.25e8 raw = 25_000_000. Capped well under maxTradeBase (1e8).
    expect(d.amountInBase).toBe(25n * 10n ** 6n);
  });

  it('returns NONE when the liquidity-derived size is below minTradeBase (thin pool)', () => {
    // A SHALLOW pool: with tiny L even a band-clearing divergence moves the price with a
    // dust-sized trade -> NONE. (Correct: not worth gas; the size now tracks REAL depth.)
    const d = decideArb(
      st({ poolPrice18: poolAtBps(56), liquidity: 1_000_000n }),
      baseParams,
    );
    expect(d.kind).toBe('NONE');
    expect(d.reason).toMatch(/min/i);
  });

  // Depletion past the band now surfaces as ALERT (not a silent NONE) so an operator refills before
  // the pool runs away — see "decideArb — inventory depletion surfaces as ALERT" above.
  it('ALERTs when the capped size is below minTradeBase due to depleted inventory', () => {
    const tiny = baseParams.minTradeBase - 1n;
    const d = decideArb(
      st({ poolPrice18: poolAtBps(2_000), inventoryBase: tiny }),
      baseParams,
    );
    expect(d.kind).toBe('ALERT');
    expect(d.reason).toMatch(/depleted/i);
  });

  it('ALERTs for SELL_BASE when base inventory is zero', () => {
    const d = decideArb(
      st({ poolPrice18: poolAtBps(2_000), inventoryBase: 0n }),
      baseParams,
    );
    expect(d.kind).toBe('ALERT');
  });

  it('ALERTs for BUY_BASE when USDC inventory is zero', () => {
    const d = decideArb(
      st({ poolPrice18: poolAtBps(-2_000), inventoryUsdc: 0n }),
      baseParams,
    );
    expect(d.kind).toBe('ALERT');
  });

  // ---- The de-vacuum'd sizing test (MEDIUM fix) ----------------------------------
  // Previously this guarded every assertion behind `if (kind==='SWAP')` while the chosen
  // params yielded NONE, so it asserted NOTHING. Now we pick L so the UNCAPPED liquidity
  // size lands strictly in (minTradeBase, maxTradeBase) and assert kind==='SWAP' directly,
  // then assert the returned size equals the closed-form liquidity sizing primitive.
  it('SWAPs with an uncapped size strictly in (min, max) and matching the V3 sizing primitive', () => {
    // L chosen so 200bps @ closeFraction 0.6 sizes between min (1e6) and max (1e8). With
    // L=4e9 the size is ~7.4e6 raw base — comfortably inside the window.
    const L = 4_000_000_000n;
    const pool = poolAtBps(200);
    const state = st({ poolPrice18: pool, liquidity: L });

    const d = decideArb(state, baseParams);
    expect(d.kind).toBe('SWAP'); // <-- asserted directly, NOT guarded
    expect(d.direction).toBe('SELL_BASE');

    // Strictly between the floor and the cap (genuine sizing path, not a clamp).
    expect(d.amountInBase!).toBeGreaterThan(baseParams.minTradeBase);
    expect(d.amountInBase!).toBeLessThan(baseParams.maxTradeBase);

    // And it equals the closed-form liquidity sizing for a 60% undershoot of the gap.
    const gap = REF - pool;
    const target = pool + (gap * 600_000n) / 1_000_000n; // closeFraction 0.6 in 1e6 fixed-pt
    const expected = baseAmountToMovePrice(L, pool, target, 8, 6, false);
    expect(d.amountInBase).toBe(expected);
  });

  it('is pure + deterministic for the in-window sizing case', () => {
    const L = 4_000_000_000n;
    const state = st({ poolPrice18: poolAtBps(200), liquidity: L });
    const d1 = decideArb(state, baseParams);
    const d2 = decideArb(state, baseParams);
    expect(d1).toEqual(d2);
  });
});

// ---------------------------------------------------------------------------
// HIGH-1 PROOF: with the SHIPPED .env numbers (maxTradeBase=1e6, minTradeBase=5e4,
// closeFraction=0.6, band=55bps), the SMALLEST tradable divergence is right at the band
// (~56-100bps), NOT ~800bps. This is the regression the audit flagged: the OLD anchor-to-
// maxTradeBase sizing only produced a non-dust SWAP at ~834bps, leaving the 20bps arena
// band un-defended. We assert the bot fires at the band edge AND does NOT fire below it.
// ---------------------------------------------------------------------------
describe('decideArb — HIGH-1: activates at the band edge with the REAL .env config', () => {
  // Mirror the shipped keeper/.env.example ARB_* numbers EXACTLY (the SWAP tests above use
  // maxTradeBase=1e8; the real config ships 1e6 — this block uses the real one).
  const ENV_REF = 100_000n * ONE; // BTC ~ $100k (realistic for the cirBTC market)
  const envParams: ArbParams = {
    feeBps: 30,
    thresholdBps: 25,
    closeFraction: 0.6,
    maxTradeBase: 1_000_000n, // 0.01 BTC (8dp) — the SHIPPED ARB_MAX_TRADE_BASE
    minTradeBase: 50_000n, //   0.0005 BTC — the SHIPPED ARB_MIN_TRADE_BASE
    maxRefAgeSec: 60,
    baseDecimals: 8,
    quoteDecimals: 6,
  };
  // A realistic in-range liquidity for a cirBTC/USDC pool. At this depth a 56bps move is a
  // multi-BTC trade, so after the 0.01-BTC cap it's a full-cap SWAP.
  const envLiquidity = 10n ** 14n;
  const envState = (bps: number): ArbState => ({
    poolPrice18: ENV_REF + (ENV_REF * BigInt(bps)) / 10_000n,
    ref18: ENV_REF,
    refAgeSec: 5,
    liquidity: envLiquidity,
    baseIsToken0: false,
    inventoryBase: 10n ** 8n * 1_000n, // 1000 BTC of inventory (ample)
    inventoryUsdc: 10n ** 6n * 100_000_000n, // 100M USDC of inventory (ample)
  });

  it('does NOT trade inside the band (55 bps) — still NONE', () => {
    expect(decideArb(envState(55), envParams).kind).toBe('NONE');
  });

  it('TRADES at 56 bps — one bps past the band (was inert until ~834 bps before the fix)', () => {
    const d = decideArb(envState(56), envParams);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
  });

  it('the smallest tradable divergence is at the band (~56 bps), NOT ~800 bps', () => {
    // Scan upward from inside the band; the FIRST tradable divergence must be ~56bps.
    let firstTradable: number | null = null;
    for (let bps = 50; bps <= 900; bps += 1) {
      if (decideArb(envState(bps), envParams).kind === 'SWAP') {
        firstTradable = bps;
        break;
      }
    }
    expect(firstTradable).not.toBeNull();
    // Right at the band edge (band is 55) — comfortably under 100, nowhere near 800.
    expect(firstTradable!).toBeGreaterThanOrEqual(56);
    expect(firstTradable!).toBeLessThanOrEqual(100);
  });

  it('a 5% (500 bps) divergence is well past the band and trades the full cap', () => {
    const d = decideArb(envState(500), envParams);
    expect(d.kind).toBe('SWAP');
    expect(d.amountInBase).toBe(envParams.maxTradeBase); // capped at 0.01 BTC
  });
});

// ---------------------------------------------------------------------------
// HIGH-2 PROOF (partial-fill avoidance): closeFraction < 1 makes the sized trade move the
// pool to a price SHORT of the ref, so the trade fully consumes amountIn before the ref-
// pinned sqrtPriceLimit. We can't run the AMM here, but we CAN assert the sizing primitive
// the trade is built from targets a price strictly between pool and ref (the undershoot),
// which is the property that guarantees a full (not partial) fill.
// ---------------------------------------------------------------------------
describe('decideArb — HIGH-2: undershoot keeps the trade short of the ref', () => {
  it('SELL undershoot: the implied target price stays above the ref (does not reach it)', () => {
    const pool = poolAtBps(300); // pool 3% above ref
    const d = decideArb(st({ poolPrice18: pool, liquidity: 4_000_000_000n }), baseParams);
    expect(d.kind).toBe('SWAP');
    // Reconstruct the undershoot target and confirm pool > target > ref (short of ref).
    const gap = REF - pool; // negative (ref below pool)
    const target = pool + (gap * 600_000n) / 1_000_000n;
    expect(target).toBeLessThan(pool); // moved down toward ref
    expect(target).toBeGreaterThan(REF); // but NOT past the ref -> no partial fill
  });

  it('BUY undershoot: the implied target price stays below the ref (does not reach it)', () => {
    const pool = poolAtBps(-300); // pool 3% below ref
    const d = decideArb(st({ poolPrice18: pool, liquidity: 4_000_000_000n }), baseParams);
    expect(d.kind).toBe('SWAP');
    const gap = REF - pool; // positive
    const target = pool + (gap * 600_000n) / 1_000_000n;
    expect(target).toBeGreaterThan(pool); // moved up toward ref
    expect(target).toBeLessThan(REF); // but NOT past the ref -> no partial fill
  });
});

// ---------------------------------------------------------------------------
// LOW (decimals): the USDC->base inventory conversion + the V3 sizing must be decimals-
// GENERIC (no baked 1e20). A 6-vs-8 swap of decimals must NOT pass-but-be-wrong. We test
// the cirBTC pair (8/6) stays correct AND an 18/6 pair sizes 10^10x larger raw base for
// the same USDC budget (proving the helper reads baseDecimals, not a constant).
// ---------------------------------------------------------------------------
describe('decideArb — LOW: decimals-generic USDC->base inventory cap', () => {
  it('cirBTC 8dp/6dp: a USDC-limited BUY caps at the exact 8dp base amount', () => {
    // 25 USDC budget @ ref 100 USDC/base -> 0.25 base. At 8dp that is 25_000_000 raw.
    const usdc = 25n * 10n ** 6n;
    const d = decideArb(
      st({ poolPrice18: poolAtBps(-2_000), inventoryUsdc: usdc }),
      baseParams,
    );
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
    expect(d.amountInBase).toBe(25n * 10n ** 6n); // 0.25 base @ 8dp
  });

  it('18dp base/6dp quote: the SAME USDC budget caps at 0.25 base in 18dp (10^10 larger raw)', () => {
    // Same 25 USDC budget, same ref, but base is 18dp now. 0.25 base @ 18dp = 25e16 raw.
    // A hardcoded-1e20 helper would WRONGLY return the 8dp answer (25e6) here.
    const usdc = 25n * 10n ** 6n;
    // maxTradeBase/minTradeBase must be expressed in the 18dp base scale or the cap would
    // bind first and mask the (decimals-generic) USDC->base conversion under test. 10 base
    // max, 0.001 base min, both at 18dp.
    const params18 = pr({
      baseDecimals: 18,
      quoteDecimals: 6,
      maxTradeBase: 10n * 10n ** 18n, // 10 base @ 18dp
      minTradeBase: 10n ** 15n, //       0.001 base @ 18dp
    });
    // Use deep liquidity in the 18dp scale so the USDC cap is what binds (and a big div).
    const state18 = st({
      poolPrice18: poolAtBps(-2_000),
      inventoryUsdc: usdc,
      liquidity: 10n ** 24n, // deep in 18dp terms
    });
    const d = decideArb(state18, params18);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
    expect(d.amountInBase).toBe(25n * 10n ** 16n); // 0.25 base @ 18dp, NOT 25e6
    // And explicitly DIFFERENT from the 8dp answer -> can't pass-but-be-wrong.
    expect(d.amountInBase).not.toBe(25n * 10n ** 6n);
  });
});

describe('decideArb — purity', () => {
  it('does not mutate its inputs', () => {
    const state = st({ poolPrice18: poolAtBps(200) });
    const params = pr({});
    const stateCopy = { ...state };
    const paramsCopy = { ...params };
    decideArb(state, params);
    expect(state).toEqual(stateCopy);
    expect(params).toEqual(paramsCopy);
  });
});

// ---------------------------------------------------------------------------
// THE STRUCTURAL CURE for the cirBTC drain: the target-band inventory gate (sell only while
// cirBTC-heavy, buy only while light), the pool-deliverability cap (never revert on a thin pool),
// and the rolling-window flow budget (bound the worst-case net cirBTC sold). All OFF by default.
// At REF=$100, a 50/50 book is inventoryBase 1e8 ($100) + inventoryUsdc 1e8 (100 USDC, 6dp).
// ---------------------------------------------------------------------------
const balanced = { inventoryBase: 10n ** 8n, inventoryUsdc: 10n ** 8n }; // share 5000 (50/50)
const cirbtcHeavy = { inventoryBase: 2n * 10n ** 8n, inventoryUsdc: 10n ** 8n }; // ~6666 bps
const cirbtcLight = { inventoryBase: 5n * 10n ** 7n, inventoryUsdc: 10n ** 8n }; // ~3333 bps

describe('decideArb — target-band inventory gate (mean-reversion cure)', () => {
  const gated = pr({ targetBaseShareBps: 5000 });

  it('DECLINES a peg SELL when cirBTC is at/below target (conserve — let the peg drift down)', () => {
    // Pool +100bps (outside band -> wants SELL), but cirBTC-light -> the gate refuses to sell more.
    const d = decideArb(st({ ...cirbtcLight, poolPrice18: poolAtBps(100) }), gated);
    expect(d.kind).not.toBe('SWAP'); // no SELL fired; falls through to NONE (rebalance/heartbeat OFF)
  });

  it('ALLOWS a peg SELL when cirBTC is HEAVY (above target)', () => {
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(100) }), gated);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
  });

  it('DECLINES a peg BUY when cirBTC is at/above target (conserve USDC — let the peg drift up)', () => {
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(-100) }), gated);
    expect(d.kind).not.toBe('SWAP');
  });

  it('ALLOWS a peg BUY when cirBTC is LIGHT (below target) — the recycle that recharges the battery', () => {
    const d = decideArb(st({ ...cirbtcLight, poolPrice18: poolAtBps(-100) }), gated);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
  });

  it('gate OFF (target 0) keeps the legacy one-directional behavior', () => {
    const d = decideArb(st({ ...cirbtcLight, poolPrice18: poolAtBps(100) }), baseParams);
    expect(d.kind).toBe('SWAP'); // legacy: sells even while cirBTC-light
    expect(d.direction).toBe('SELL_BASE');
  });
});

// ---------------------------------------------------------------------------
// TWO-SIDED PEG DEFENSE (buyDefendsPeg). The legacy gate declines a peg-correcting BUY while cirBTC is
// heavy, so a pool can sit UNDER peg indefinitely (the cirBTC/EURC symptom after the rebalance overshoot).
// buyDefendsPeg lifts ONLY the BUY side of the gate so the keeper defends the downside up to its quote
// reserve. The SELL side (which drains the finite, non-mintable battery) is never relaxed. OFF by default
// so the USDC arb is byte-for-byte unchanged.
// ---------------------------------------------------------------------------
describe('decideArb — two-sided peg defense (buyDefendsPeg)', () => {
  const defended = pr({ targetBaseShareBps: 5000, buyDefendsPeg: true });

  it('DEFENDS the downside: a peg BUY fires even while cirBTC is HEAVY (lifts a sub-peg pool)', () => {
    // Pool -100bps wants a BUY; the legacy gate declines it while cirBTC-heavy — buyDefendsPeg lets it through.
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(-100) }), defended);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
  });

  it('still CONSERVES the battery: a peg SELL is STILL declined while cirBTC is LIGHT (one-sided relaxation)', () => {
    // The relaxation must NOT touch the SELL gate — selling drains the finite battery.
    const d = decideArb(st({ ...cirbtcLight, poolPrice18: poolAtBps(100) }), defended);
    expect(d.kind).not.toBe('SWAP');
  });

  it('respects the quote reserve: a defending BUY can never spend below reserveQuote', () => {
    // cirBTC-heavy + pool below peg, but USDC sits exactly at the reserve => no spendable quote => idle/ALERT.
    const atReserve = pr({ targetBaseShareBps: 5000, buyDefendsPeg: true, reserveQuote: 10n ** 8n });
    const d = decideArb(st({ ...cirbtcHeavy, inventoryUsdc: 10n ** 8n, poolPrice18: poolAtBps(-100) }), atReserve);
    expect(d.kind).not.toBe('SWAP');
  });

  it('OFF by default: the legacy gate still declines the cirBTC-heavy BUY (USDC arb unchanged)', () => {
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(-100) }), pr({ targetBaseShareBps: 5000 }));
    expect(d.kind).not.toBe('SWAP');
  });

  it('does not mutate its inputs (purity holds with the flag on)', () => {
    const state = st({ ...cirbtcHeavy, poolPrice18: poolAtBps(-100) });
    const params = { ...defended };
    const stateCopy = { ...state };
    decideArb(state, params);
    expect(state).toEqual(stateCopy);
    expect(params).toEqual(defended);
  });
});

describe('decideArb — pool-deliverability cap (never revert "Too little received")', () => {
  const safe = pr({ poolDeliverableSafetyBps: 7000 });

  it('a SELL into a USDC-EMPTY pool collapses to dust -> NONE/ALERT, never a doomed SWAP', () => {
    // cirBTC-heavy so the inventory allows the SELL, pool above ref so it wants to SELL — but the
    // pool holds ~0 USDC, so the deliverable cap drives the size to ~0.
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(100), poolQuoteBal: 0n }), safe);
    expect(d.kind).not.toBe('SWAP');
  });

  it('a SELL fires normally when the pool holds ample USDC', () => {
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(100), poolQuoteBal: 10n ** 12n }), safe);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('SELL_BASE');
  });
});

describe('decideArb — rolling-window flow budget (bounds the worst-case bleed)', () => {
  const budgeted = pr({ targetBaseShareBps: 5000 });
  const exhausted = { nowMs: 1000, windowMs: 86_400_000, netSoldBase: 300_000n, maxNetSoldPerWindowBase: 300_000n };

  it('a SELL is REFUSED once the window net-sold budget is exhausted', () => {
    const d = decideArb(st({ ...cirbtcHeavy, poolPrice18: poolAtBps(100), flow: exhausted }), budgeted);
    expect(d.kind).not.toBe('SWAP'); // budget spent -> size capped to 0 -> NONE
  });

  it('a BUY is NEVER flow-capped — recycling cirBTC back is always allowed even at budget exhaustion', () => {
    const d = decideArb(st({ ...cirbtcLight, poolPrice18: poolAtBps(-100), flow: exhausted }), budgeted);
    expect(d.kind).toBe('SWAP');
    expect(d.direction).toBe('BUY_BASE');
  });
});
