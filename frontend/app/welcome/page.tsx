'use client';

// app/welcome/page.tsx - the LANDING page (first-visit destination; the app routes stay untouched).
//
// HERO (mockup 7.png, live-data faithful): "One market. / Three outcomes. / Fees decide." beside the
// OutcomeDiagram - the live price node branching to UP / RANGE / DOWN with the REAL settlement band -
// over a live stat band (fee pot · oracle price · next settlement) and the full-width market-depth bar.
//
// THE REST (storytelling, all real data, CSS-only motion):
//   · a live on-chain activity ticker (the arena is already running)
//   · "How a round works" - three interlocking HUD panels (the Arena's signature joint tabs)
//   · the fee flywheel - an animated loop diagram with the all-time claimed counter at its center
//   · "Provably fair" - oracle/band/proof cards + a REAL latest-settlement receipt
//   · count-up arena stats · final CTA
//
// New visitors hitting "/" are redirected here once (localStorage flag, set on mount below); the
// app chrome (NavBar/SiteFooter) is hidden on this route (RouteChrome) - the landing ships its own.
import { useEffect, useId, useMemo } from 'react';
import Link from 'next/link';
import { useCurrentEpoch } from '@/hooks/useCurrentEpoch';
import { useOraclePrice } from '@/hooks/useOraclePrice';
import { useEpochHistory } from '@/hooks/useEpochHistory';
import { useLeaderboard } from '@/hooks/useLeaderboard';
import { useFeesSettled } from '@/hooks/useFeesSettled';
import { useActiveMarket, FixedMarketProvider } from '@/components/MarketProvider';
import { useStakesByEpoch } from '@/hooks/useStakesByEpoch';
import { isV3Market, DEFAULT_MARKET_ID } from '@/lib/markets';
import type { RawStakeV3 } from '@/lib/epochV3';
import { OutcomeDiagram } from '@/components/landing/OutcomeDiagram';
import { Ticker } from '@/components/landing/Ticker';
import { CountUp } from '@/components/landing/CountUp';
import { ArenaPanel, arenaButtonClass } from '@/components/arena/ArenaPanel';
import { ARENA_SIDES, SIDE_HEX, SIDE_TEXT } from '@/components/arena/sides';
import { StatRow, type StatCellData } from '@/components/ui/StatRow';
import { Countdown } from '@/components/Countdown';
import { SiteFooter } from '@/components/SiteFooter';
import { Stars } from '@/components/ui/Stars';
import { BrandMark } from '@/components/ui/BrandMark';
import {
  Faucet,
  Lock,
  Layers,
  Trophy,
  Activity,
  Clock,
  Shield,
  External,
  SwapArrows,
  Gift,
  TrendUp,
  TrendDown,
  WaveRange,
  Check,
} from '@/components/ui/icons';
import { PhaseView, Side } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { totalClaimedUsd6, formatUsd6Precise, potUsd6 } from '@/lib/quant';
import { formatUsdPrice18 } from '@/lib/arena';
import { formatDeltaBps } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

const VISITED_KEY = 'feearena.visited';

/* ── The landing's own minimal chrome ──────────────────────────────────────────────────────────── */
function LandingNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 border-b border-line bg-canvas/70 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center justify-between px-4 sm:px-6 lg:px-8">
        <span className="flex items-center gap-2.5">
          <BrandMark className="h-7 w-7" />
          <span className="text-sm font-semibold uppercase tracking-[0.2em] text-ink">Limen Finance</span>
        </span>
        <nav className="flex items-center gap-2 sm:gap-4">
          <a
            href="#how"
            className="hidden rounded-lg px-2 py-1 font-mono text-[12px] uppercase tracking-wide text-ink-soft transition-colors hover:text-ink sm:block"
          >
            How it works
          </a>
          <a
            href="#fair"
            className="hidden rounded-lg px-2 py-1 font-mono text-[12px] uppercase tracking-wide text-ink-soft transition-colors hover:text-ink sm:block"
          >
            Transparency
          </a>
          <Link href="/stance" className={arenaButtonClass('primary', 'h-10 px-4')}>
            Launch App
            <Stars />
          </Link>
        </nav>
      </div>
    </header>
  );
}

/* ── Hero: full-width market depth (mockup's bottom strip) ─────────────────────────────────────── */
function MarketDepth({ depth }: { depth: readonly [bigint, bigint, bigint, bigint] }) {
  const total = ARENA_SIDES.reduce((s, x) => s + depth[x], 0n);
  const has = total > 0n;
  const pct = (s: Side) => (has ? Number((depth[s] * 10000n) / total) / 100 : 100 / 3);
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="kicker">Market depth</span>
        <span className="hidden font-mono text-[10px] uppercase tracking-wide text-ink-faint sm:block">
          Distribution of staked liquidity across market views
        </span>
      </div>
      <div className="flex h-10 w-full overflow-hidden rounded-lg border border-line bg-surface-inset">
        {ARENA_SIDES.map((s) => (
          <div
            key={s}
            className="flex min-w-0 items-center justify-center gap-2 font-mono text-[12px] font-semibold tnum text-white/95"
            style={{
              flexGrow: Math.max(pct(s), 0.5),
              flexBasis: 0,
              backgroundColor: has ? SIDE_HEX[s] : 'transparent',
            }}
          >
            {has && pct(s) >= 12 ? `${Math.round(pct(s))}% ${SIDE_LABELS[s]}` : has && pct(s) >= 7 ? `${Math.round(pct(s))}%` : ''}
          </div>
        ))}
      </div>
      {!has && (
        <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
          No staked depth yet this epoch - distribution updates as positions enter.
        </p>
      )}
    </div>
  );
}

/* ── Story: the range-band price chart (step 1's visual) ───────────────────────────────────────── */
function BandChart() {
  const gid = useId();
  // A price path weaving through a HORIZONTAL band (a range is a price zone over time).
  const d =
    'M0 56 C16 42 26 34 38 39 C52 45 58 62 72 64 C84 65 92 48 104 41 C116 34 124 30 136 37 C150 45 158 66 172 68 C184 69 196 50 208 43 C214 39 218 38 222 40';
  return (
    <svg viewBox="0 0 222 88" className="h-24 w-full" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--c-brand))" stopOpacity="0.16" />
          <stop offset="100%" stopColor="rgb(var(--c-brand))" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* the chosen band: a tinted zone with dashed min/max edges */}
      <rect x="0" y="28" width="222" height="30" fill="rgb(var(--c-brand) / 0.07)" />
      <line x1="0" y1="28" x2="222" y2="28" stroke="rgb(var(--c-brand) / 0.5)" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <line x1="0" y1="58" x2="222" y2="58" stroke="rgb(var(--c-brand) / 0.5)" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      <text x="219" y="23" textAnchor="end" fontSize="7.5" fontFamily="monospace" fill="rgb(var(--c-ink-faint))">
        MAX
      </text>
      <text x="219" y="69" textAnchor="end" fontSize="7.5" fontFamily="monospace" fill="rgb(var(--c-ink-faint))">
        MIN
      </text>
      {/* price line: soft area + glow underlay + crisp stroke + live endpoint */}
      <path d={`${d} L222 88 L0 88 Z`} fill={`url(#${gid})`} />
      <path d={d} fill="none" stroke="rgb(var(--c-brand) / 0.28)" strokeWidth="4" strokeLinecap="round" />
      <path d={d} fill="none" stroke="rgb(var(--c-brand))" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      <circle cx="222" cy="40" r="2.5" fill="rgb(var(--c-brand))" />
    </svg>
  );
}

/** Vibrant side-tinted tones for step 2's trio (CSS-var alpha so themes stay coherent). */
const SIDE_VIBRANT: Record<number, { bg: string; border: string; glow: string }> = {
  [Side.UP]: {
    bg: 'rgb(var(--c-side-up) / 0.10)',
    border: 'rgb(var(--c-side-up) / 0.55)',
    glow: '0 0 26px -12px rgb(var(--c-side-up) / 0.9)',
  },
  [Side.DOWN]: {
    bg: 'rgb(var(--c-side-down) / 0.10)',
    border: 'rgb(var(--c-side-down) / 0.55)',
    glow: '0 0 26px -12px rgb(var(--c-side-down) / 0.9)',
  },
  [Side.RANGE]: {
    bg: 'rgb(124 136 153 / 0.12)',
    border: 'rgb(124 136 153 / 0.55)',
    glow: '0 0 26px -12px rgb(124 136 153 / 0.8)',
  },
};

/* ── Story: one step panel (the Arena's interlocking HUD frames) ───────────────────────────────── */
function StepPanel({
  joint,
  n,
  icon,
  title,
  copy,
  children,
  delay,
}: {
  joint: 'left' | 'right' | 'both';
  n: number;
  icon: ReactNode;
  title: string;
  copy: string;
  children: ReactNode;
  delay: number;
}) {
  return (
    <div className="hud-col motion-safe:animate-fade-up" style={{ animationDelay: `${delay}ms` }}>
      <ArenaPanel joint={joint} className="flex h-full flex-col px-6 py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-brand bg-brand/15 font-mono text-[12px] font-semibold text-brand">
            {n}
          </span>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-muted/40 text-ink-muted">
            {icon}
          </span>
          <span className="font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-ink">{title}</span>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">{copy}</p>
        <div className="mt-auto pt-5">{children}</div>
      </ArenaPanel>
    </div>
  );
}

/* ── Story: the fee flywheel ───────────────────────────────────────────────────────────────────── */
function Flywheel({ claimedUsd }: { claimedUsd: number }) {
  const chips: Array<{ icon: ReactNode; label: string; pos: string }> = [
    { icon: <SwapArrows className="h-4 w-4" />, label: 'Swaps pay 0.3%', pos: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2' },
    { icon: <Trophy className="h-4 w-4" />, label: 'Fees accrue to the pool', pos: 'right-0 top-1/2 translate-x-1/3 -translate-y-1/2' },
    { icon: <Layers className="h-4 w-4" />, label: 'LPs choose a market view', pos: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2' },
    { icon: <Gift className="h-4 w-4" />, label: 'Qualifying positions claim', pos: 'left-0 top-1/2 -translate-x-1/3 -translate-y-1/2' },
  ];
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[420px]">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
        <circle cx="50" cy="50" r="40" fill="none" stroke="rgb(64 66 76)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="rgb(229 72 77)"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
          className="dash-anim"
        />
      </svg>
      {chips.map((c) => (
        <span
          key={c.label}
          className={cn(
            'absolute z-[1] inline-flex items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-ink-soft',
            c.pos,
          )}
        >
          <span className="text-ink-muted">{c.icon}</span>
          {c.label}
        </span>
      ))}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <div className="kicker">Claimed all-time</div>
        <div className="mt-1 font-mono text-3xl font-semibold tnum text-side-up">
          <CountUp value={claimedUsd} format={(n) => formatUsd6Precise(BigInt(Math.max(0, Math.round(n * 1_000_000))))} />
        </div>
        <div className="mt-1 font-mono text-[10px] uppercase tracking-wide text-ink-faint">paid to qualifying positions</div>
      </div>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────────────────────────── */
export default function WelcomePage() {
  // The landing is a fixed teaser for the flagship cirBTC/USDC market - PIN it so the hero price,
  // oracle label, band, depth and stats never follow the user's active dashboard selection (which
  // could be cirBTC/EURC, whose BTC/EUR oracle would otherwise render under a "/ USDC" label).
  return (
    <FixedMarketProvider marketId={DEFAULT_MARKET_ID}>
      <WelcomeBody />
    </FixedMarketProvider>
  );
}

function WelcomeBody() {
  const market = useActiveMarket();
  const { data: epoch } = useCurrentEpoch();
  const { data: oracle } = useOraclePrice();
  const { data: history } = useEpochHistory();
  const { data: leaders } = useLeaderboard();
  const { data: feesSettled } = useFeesSettled();

  // MARKET DEPTH - per-side distribution of staked liquidity. v1/v2 carry it on the epoch struct
  // (sideContribution6); v3 (entry-anchored) does NOT, so rebuild it from the current epoch's stakes:
  // sum each live position's USD contribution by side, falling back to a position COUNT split before
  // fees have accrued so the bar still reflects where liquidity sits. Stakes are only read for v3.
  const v3 = isV3Market(market);
  const { data: epochStakes } = useStakesByEpoch(v3 ? epoch?.epochId : undefined);
  const depth = useMemo<readonly [bigint, bigint, bigint, bigint]>(() => {
    if (!v3) return epoch?.sideContribution6 ?? [0n, 0n, 0n, 0n];
    const stakes = (epochStakes ?? []) as unknown as RawStakeV3[];
    const byContribution: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
    const byCount: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
    for (const s of stakes) {
      const side = Number(s.side);
      if (side < 0 || side > 3 || s.unstaked) continue;
      byContribution[side] += s.contributionUsd6 ?? 0n;
      byCount[side] += 1n;
    }
    const total = byContribution[0] + byContribution[1] + byContribution[2] + byContribution[3];
    return total > 0n ? byContribution : byCount;
  }, [v3, epoch?.sideContribution6, epochStakes]);

  // Returning visitors skip straight to the app from "/" - mark this browser as having seen the story.
  useEffect(() => {
    try {
      window.localStorage.setItem(VISITED_KEY, '1');
    } catch {
      /* private mode - harmless */
    }
  }, []);

  const price18 = oracle?.price18 ?? 0n;
  const bandBps = epoch?.bandBps ?? 20;
  const started = !!epoch && epoch.startPrice18 > 0n && epoch.phase !== PhaseView.Settled;
  const refPrice18 = started ? epoch!.startPrice18 : price18;

  // FEES SETTLED: the cumulative TOTAL trading fees the arena has collected across every settled epoch
  // (PositionProcessed.feeBase/feeUSDC) - winner-KEPT fees included, not just the small losers' forfeited
  // pot. This is the honest "real fee activity" figure: it grows in visible cents as swaps generate fees,
  // unlike the loser-pot (which is dust and looks frozen). The live epoch's fees aren't collected until
  // settlement, so this is intentionally a settled-to-date total.
  const feesSettledUsd6 = potUsd6({
    potWETH: feesSettled?.feeBase ?? 0n,
    potUSDC: feesSettled?.feeUSDC ?? 0n,
    baseDecimals: market.baseDecimals,
    price18,
  });

  // Next settlement: the running epoch's end; entry phase shows entry-close; otherwise settling.
  let settlement: ReactNode = <span className="text-ink-muted">settling…</span>;
  let settlementSub = 'Fees are distributed at settlement';
  if (epoch?.phase === PhaseView.Running) {
    settlement = <Countdown target={epoch.endTime} />;
  } else if (epoch?.phase === PhaseView.EntryOpen) {
    settlement = <Countdown target={epoch.entryCloseTime} className="text-brand" />;
    settlementSub = 'Entry window open - closes in';
  }

  const stats: StatCellData[] = [
    {
      label: 'Fees settled',
      value: formatUsd6Precise(feesSettledUsd6),
      valueClassName: 'text-brand',
      sub: 'Total LP trading fees settled to date',
    },
    {
      label: 'Oracle price',
      value: price18 > 0n ? formatUsdPrice18(price18) : '…',
      sub: `${market.baseSymbol} / ${market.quoteSymbol ?? 'USDC'} · Pyth`,
    },
    { label: 'Next settlement', value: settlement, sub: settlementSub },
  ];

  const settled = (history ?? []).filter((r) => r.settlePrice18 !== undefined || r.rolledOver);
  const latestProof = settled.find((r) => r.winningSide !== Side.NONE && r.settlePrice18 !== undefined);
  const participants = leaders?.length ?? 0;
  // Stance epoch-pool payouts paid to qualifying positions (real on-chain Claimed events). Keep this as
  // a FLOAT of dollars - the old `/1_000_000n` BigInt divide floored sub-$1 claims to $0; on this dust
  // testnet a real Stance claim is cents, so floor it and an actual payout still reads "$0". formatUsd6Precise
  // (below) then renders cents / sub-cent honestly.
  const claimedUsd = Number(totalClaimedUsd6(leaders ?? [], market.baseDecimals, price18)) / 1_000_000;

  return (
    <div data-testid="welcome-page" className="relative">
      <LandingNav />

      {/* ════ HERO ════ */}
      <section className="relative overflow-hidden pb-12 pt-28 sm:pt-32">
        <div className="landing-scanline" aria-hidden="true" />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-brand/10 blur-[120px]"
        />
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-14 lg:grid-cols-[1.02fr_1fr]">
            {/* Headline */}
            <div>
              <h1 className="text-5xl font-semibold leading-[1.04] tracking-tight text-ink sm:text-6xl lg:text-7xl">
                <span className="block motion-safe:animate-fade-up" style={{ animationDelay: '60ms' }}>
                  Provide liquidity.
                </span>
                <span className="block motion-safe:animate-fade-up" style={{ animationDelay: '140ms' }}>
                  Choose a market view.
                </span>
                <span className="block text-brand motion-safe:animate-fade-up" style={{ animationDelay: '220ms' }}>
                  Settle transparently.
                </span>
              </h1>
              <p
                className="mt-6 max-w-md text-[15px] leading-relaxed text-ink-soft motion-safe:animate-fade-up"
                style={{ animationDelay: '300ms' }}
              >
                Limen Finance lets LPs opt into an epoch-based fee allocation layer on Arc. Provide
                liquidity to a supported market, choose{' '}
                <span className="font-semibold text-side-up">UP</span>,{' '}
                <span className="font-semibold text-side-down">DOWN</span>, or{' '}
                <span className="font-semibold text-ink">RANGE</span> from your own entry reference
                price, and settlement allocates the epoch&apos;s fee pool to qualifying positions.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3 motion-safe:animate-fade-up" style={{ animationDelay: '380ms' }}>
                <a href="#how" className={arenaButtonClass('secondary', 'h-12 px-6')}>
                  How settlement works
                  <Stars />
                </a>
              </div>
            </div>

            {/* The live outcome circuit (mockup 7.png) */}
            <div className="motion-safe:animate-fade-up" style={{ animationDelay: '220ms' }}>
              <OutcomeDiagram
                pairLabel={`${market.baseSymbol} / ${market.quoteSymbol ?? 'USDC'}`}
                price18={price18}
                refPrice18={refPrice18}
                bandBps={bandBps}
                refIsLive={!started}
              />
            </div>
          </div>

          {/* Live stat band + market depth (mockup's lower half) */}
          <div className="mt-12 space-y-5 motion-safe:animate-fade-up" style={{ animationDelay: '420ms' }}>
            <StatRow data-testid="landing-stats" stats={stats} />
            <MarketDepth depth={depth} />
          </div>
        </div>
      </section>

      {/* ════ LIVE TICKER ════ */}
      <Ticker />

      {/* ════ HOW A ROUND WORKS ════ */}
      <section id="how" className="scroll-mt-24 py-20">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-2xl">
            <span className="kicker">The mechanic</span>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              How an epoch settles
            </h2>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">
              Each epoch has an entry window and a public settlement time. LPs can stay vanilla and
              keep normal fees, or opt into Stance settlement for that epoch.
            </p>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <StepPanel
              joint="right"
              n={1}
              icon={<Faucet className="h-[18px] w-[18px]" />}
              title="Provide liquidity"
              copy="Mint a V3-style LP position in a supported USDC market. Choose a price range for where your liquidity should be active. Your position earns swap fees while the market price stays inside that range."
              delay={0}
            >
              <div className="space-y-2 rounded-xl border border-line bg-surface-muted px-4 pb-2.5 pt-3.5">
                <div className="flex items-center justify-between gap-1.5">
                  {['Narrow ±5%', 'Balanced ±15%', 'Wide ±50%'].map((t, i) => (
                    <span
                      key={t}
                      className={cn(
                        'rounded-md border px-2 py-1 font-mono text-[10px] uppercase tracking-wide',
                        i === 1 ? 'border-brand bg-brand/15 font-semibold text-brand' : 'border-line bg-surface text-ink-muted',
                      )}
                    >
                      {t}
                    </span>
                  ))}
                </div>
                <BandChart />
                <p className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                  In range → earning fees
                  <br />
                  Out of range → inactive until price returns
                </p>
              </div>
            </StepPanel>

            <StepPanel
              joint="both"
              n={2}
              icon={<Lock className="h-[18px] w-[18px]" />}
              title="Choose your market view"
              copy="During the entry window, stake your LP position and choose UP, DOWN, or RANGE. Your entry reference price is recorded when you enter, and your thresholds are calculated from that price."
              delay={90}
            >
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      { s: Side.UP, icon: <TrendUp className="h-6 w-6" />, cap: 'settles above' },
                      { s: Side.DOWN, icon: <TrendDown className="h-6 w-6" />, cap: 'settles below' },
                      { s: Side.RANGE, icon: <WaveRange className="h-6 w-6" />, cap: 'settles inside' },
                    ] as const
                  ).map(({ s, icon, cap }) => (
                    <div
                      key={s}
                      className="flex flex-col items-center gap-1 rounded-xl border px-2 py-3.5"
                      style={{
                        backgroundColor: SIDE_VIBRANT[s].bg,
                        borderColor: SIDE_VIBRANT[s].border,
                        boxShadow: SIDE_VIBRANT[s].glow,
                      }}
                    >
                      <span className={SIDE_TEXT[s]}>{icon}</span>
                      <span className={cn('font-mono text-[12px] font-bold', SIDE_TEXT[s])}>{SIDE_LABELS[s]}</span>
                      <span className="font-mono text-[9px] uppercase tracking-wide text-ink-muted">{cap}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-muted">
                  <Lock className="h-3.5 w-3.5 shrink-0" />
                  Reference price locked at entry
                </div>
              </div>
            </StepPanel>

            <StepPanel
              joint="left"
              n={3}
              icon={<Trophy className="h-[18px] w-[18px]" />}
              title="Settle the fee pool"
              copy="At settlement, each Stance position is evaluated against its own entry reference price. Qualifying positions share the epoch’s fee pool by contribution; non-qualifying positions forfeit only that epoch’s fees."
              delay={180}
            >
              <div className="space-y-2.5">
                <div className="rounded-xl border border-side-up/40 bg-side-up/10 px-4 py-4 shadow-[0_0_40px_-16px_rgb(64_209_120/0.8)]">
                  <div className="kicker">Fee pool at stake</div>
                  <div className="mt-1 font-mono text-3xl font-semibold tnum text-side-up">$18,420</div>
                  <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-faint">
                    Example epoch · qualifying positions share fees · LP principal remains intact
                  </p>
                </div>
                <div className="flex items-center justify-center gap-2 rounded-lg border border-line bg-surface-muted px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-muted">
                  <Gift className="h-3.5 w-3.5 shrink-0" />
                  Position unlocks after settlement · claim in one click
                </div>
              </div>
            </StepPanel>
          </div>
        </div>
      </section>

      {/* ════ THE FLYWHEEL ════ */}
      <section className="border-y border-line bg-surface/40 py-20">
        <div className="mx-auto grid max-w-[1280px] items-center gap-14 px-4 sm:px-6 lg:grid-cols-2 lg:px-8">
          <div>
            <span className="kicker">The flywheel</span>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              Every swap creates fees.
              <span className="block text-ink-soft">Every position settles from its own entry price.</span>
            </h2>
            <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-soft">
              There is no protocol-side counterparty and no emissions. The fee pool comes from actual trading fees
              generated by active LP positions. Stance settlement reallocates epoch fees between
              participating LP positions based on transparent market conditions.
            </p>
            <ul className="mt-6 space-y-2.5">
              {[
                'LP principal is not forfeited - only epoch fees are at risk',
                'Out-of-range positions do not earn fees while inactive',
                'If no positions qualify, the fee pool rolls forward',
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-sm text-ink-soft">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-side-up" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <Flywheel claimedUsd={claimedUsd} />
        </div>
      </section>

      {/* ════ PROVABLY FAIR ════ */}
      <section id="fair" className="scroll-mt-24 py-20">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="mb-10 max-w-2xl">
            <span className="kicker">Onchain transparency</span>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
              Transparent settlement, end to end
            </h2>
          </div>
          <div className="grid gap-5 md:grid-cols-3">
            {[
              {
                icon: <Activity className="h-5 w-5" />,
                title: 'Pyth oracle settlement',
                copy: `Stance positions settle using Pyth market data, not the pool’s own price and not an admin-set value. Each position’s reference price is recorded at entry, and settlement uses the final Pyth-based market price for that epoch.`,
              },
              {
                icon: <Shield className="h-5 w-5" />,
                title: 'Every position leaves a receipt',
                copy: 'Entry reference price, settlement price, thresholds, position result, and fee allocation are emitted as onchain events so each position’s settlement can be reconstructed.',
              },
              {
                icon: <Clock className="h-5 w-5" />,
                title: 'Public epoch schedule',
                copy: 'Epochs follow a public schedule. If Pyth data is unavailable or stale, settlement moves into a delayed state instead of using stale data.',
              },
            ].map((c, i) => (
              <div key={c.title} className="hud-col motion-safe:animate-fade-up" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)] h-full px-6 py-6">
                  <span className="grid h-10 w-10 place-items-center rounded-lg border border-line bg-surface-muted/40 text-ink-muted">
                    {c.icon}
                  </span>
                  <h3 className="mt-4 font-mono text-[13px] font-bold uppercase tracking-[0.08em] text-ink">
                    {c.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">{c.copy}</p>
                </div>
              </div>
            ))}
          </div>

          {/* A REAL receipt - the latest settled round, straight from chain events. */}
          {latestProof && (
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface-muted px-5 py-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[13px] tnum">
                <span className="kicker">Latest receipt</span>
                <span className="text-ink">Epoch #{latestProof.epochId.toString()}</span>
                <span className="text-ink-soft">
                  {formatUsdPrice18(latestProof.startPrice18)} → {formatUsdPrice18(latestProof.settlePrice18!)}
                </span>
                {latestProof.deltaBps !== undefined && (
                  <span className={latestProof.deltaBps < 0n ? 'text-side-down' : 'text-side-up'}>
                    {formatDeltaBps(latestProof.deltaBps)}
                  </span>
                )}
                <span className={cn('font-bold', SIDE_TEXT[latestProof.winningSide])}>
                  {SIDE_LABELS[latestProof.winningSide]} won
                </span>
              </div>
              <Link
                href={`/epoch/${latestProof.epochId.toString()}`}
                className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold uppercase tracking-wide text-brand hover:text-brand-hover"
              >
                Verify the proof <External className="h-3.5 w-3.5" />
              </Link>
            </div>
          )}
        </div>
      </section>

      {/* ════ ARENA STATS ════ */}
      <section className="pb-20">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="hud-col">
            <div className="hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)] grid grid-cols-2 divide-x divide-y divide-line sm:flex sm:divide-y-0">
              {[
                { label: 'Epochs settled', node: <CountUp value={settled.length} /> },
                { label: 'Active participants', node: <CountUp value={participants} /> },
                {
                  label: 'Claimed all-time',
                  node: <CountUp value={claimedUsd} format={(n) => formatUsd6Precise(BigInt(Math.max(0, Math.round(n * 1_000_000))))} />,
                },
                {
                  label: 'Current epoch',
                  node: <span>#{epoch?.epochId.toString() ?? '…'}</span>,
                },
              ].map((c) => (
                <div key={c.label} className="min-w-0 flex-1 px-5 py-5">
                  <div className="kicker">{c.label}</div>
                  <div className="mt-1.5 font-mono text-3xl font-semibold leading-none tnum text-ink">{c.node}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ════ FINAL CTA ════ */}
      <section className="pb-24">
        <div className="mx-auto max-w-[1280px] px-4 sm:px-6 lg:px-8">
          <div className="hud-col">
            <div className="hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)] relative overflow-hidden px-6 py-16 text-center sm:py-20">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-1/2 top-0 h-64 w-[640px] -translate-x-1/2 rounded-full bg-brand/10 blur-[100px]"
              />
              <div className="landing-scanline" aria-hidden="true" />
              <BrandMark className="mx-auto h-9 w-9" />
              <h2 className="mt-5 font-mono text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
                Enter an epoch.
              </h2>
              <p className="mx-auto mt-3 max-w-md text-[15px] text-ink-soft">
                Choose a supported market, provide liquidity, and enter the next epoch with a market
                view. Your reference price locks when you enter.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link href="/stance" className={arenaButtonClass('primary', 'h-12 px-8')}>
                  Open Stance
                  <Stars />
                </Link>
                <Link href="/bridge" className={arenaButtonClass('secondary', 'h-12 px-6')}>
                  Bridge testnet USDC to Arc
                  <Stars />
                </Link>
              </div>
              <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
                Arc Testnet
              </p>
            </div>
          </div>
        </div>
      </section>

      <SiteFooter />
    </div>
  );
}
