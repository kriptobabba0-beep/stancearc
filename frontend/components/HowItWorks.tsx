'use client';

// components/HowItWorks.tsx — a visual "How it works" explainer for the landing. It describes BOTH
// paths so a newcomer can follow at a glance:
//   1. Classic LP (the welcoming, OPTIONAL path): add liquidity → earn trading fees → withdraw anytime.
//   2. Staking (opt-in): stake your LP + call UP / DOWN / RANGE → the winning side splits the forfeited
//      fees. Side-only on the live market — NO conviction / at-risk USDC.
// Presentational only; copy uses the active market's base symbol for flavor.
import { useActiveMarket } from '@/components/MarketProvider';
import { RangeIcon, Activity, ArrowDown, ArrowUp, Trophy } from '@/components/ui/icons';

function Step({
  n,
  title,
  children,
  icon,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="relative rounded-2xl border border-line bg-surface p-5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-muted/40 text-ink-muted">
          {icon}
        </span>
        <span className="kicker">Step {n}</span>
      </div>
      <h3 className="mt-3 font-display text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{children}</p>
    </div>
  );
}

export function HowItWorks() {
  const market = useActiveMarket();
  const base = market.baseSymbol;

  return (
    <section className="motion-safe:animate-fade-up" aria-labelledby="how-it-works-heading">
      <h2
        id="how-it-works-heading"
        className="mb-4 font-display text-lg font-semibold tracking-tight text-ink"
      >
        How it works
      </h2>

      {/* Path 1 — Classic LP. The welcoming, OPTIONAL baseline: add liquidity, earn fees, withdraw. */}
      <div className="mb-3 flex items-center gap-2">
        <span className="kicker text-ink-soft">Provide liquidity &amp; earn fees</span>
        <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          Always optional
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Step n={1} title="Add liquidity" icon={<RangeIcon className="h-4 w-4" />}>
          Deposit <span className="font-medium text-ink">{base}</span> and{' '}
          <span className="font-medium text-ink">USDC</span> over a price range you choose — Narrow,
          Balanced, Wide, Full range, or a custom band. The range is your strategy:{' '}
          <span className="font-medium text-ink">tighter earns more fees while the price stays
          inside it, and nothing while it&apos;s outside</span>.
        </Step>
        <Step n={2} title="Earn trading fees" icon={<Activity className="h-4 w-4" />}>
          Every swap through the pool pays a trading fee, and your position earns a{' '}
          <span className="font-medium text-ink">share of those fees</span> proportional to your
          liquidity. Fees accrue to your position automatically — no action needed.
        </Step>
        <Step n={3} title="Withdraw anytime" icon={<ArrowDown className="h-4 w-4" />}>
          Whenever you like, withdraw your position to pull{' '}
          <span className="font-medium text-ink">100% of your liquidity</span> — both pool tokens, plus
          the trading fees you’ve accrued — back to your wallet. No lock-up, no obligation to stake.
        </Step>
      </div>

      {/* Path 2 — Staking (opt-in). Stake your LP + call a side; the winning side splits forfeited fees.
          Side-only on the live market — NO conviction / at-risk USDC anywhere. */}
      <div className="mb-3 mt-6 flex items-center gap-2">
        <span className="kicker text-ink-soft">Want more? Stake a side</span>
        <span className="rounded-full border border-line bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-muted">
          Opt-in
        </span>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Step
          n={1}
          title="Stake your LP & pick a side"
          icon={
            <span className="flex">
              <ArrowUp className="h-4 w-4" />
              <ArrowDown className="h-4 w-4" />
            </span>
          }
        >
          Deposit your LP position into the Stance for one epoch and call the market:{' '}
          <span className="font-medium text-side-up">UP</span>,{' '}
          <span className="font-medium text-side-down">DOWN</span>, or{' '}
          <span className="font-medium text-side-range">RANGE</span>. Your trading fees for that epoch
          go into a shared pot.
        </Step>
        <Step n={2} title="The market moves" icon={<RangeIcon className="h-4 w-4" />}>
          At the close, the price is compared to a fixed band. Beyond the band is UP or DOWN; inside it
          is RANGE. No one — not even us — picks the winner; the price does.
        </Step>
        <Step n={3} title="Winners split the pot" icon={<Trophy className="h-4 w-4" />}>
          Everyone who called the winning side splits the forfeited fees pro-rata by their staked
          in-range liquidity. Lose, and your fees fund the winners. Don’t stake, and you keep 100% of
          your fees.
        </Step>
      </div>

      {/* One concrete worked example for the staking path. */}
      <div className="mt-4 rounded-2xl border border-line bg-surface-muted p-5">
        <span className="kicker">Worked example</span>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Say three LPs stake and each forfeits <span className="font-mono tnum text-ink">$100</span>{' '}
          of fees — a <span className="font-mono tnum text-ink">$300</span> pot. Two call{' '}
          <span className="font-medium text-side-up">UP</span>, one calls{' '}
          <span className="font-medium text-side-down">DOWN</span>. {base} closes{' '}
          <span className="font-medium text-side-up">up</span> beyond the band, so UP wins. The two UP
          LPs split the full <span className="font-mono tnum text-ink">$300</span> pro-rata by their
          staked liquidity — turning their <span className="font-mono tnum text-ink">$200</span> of
          forfeited fees into <span className="font-mono tnum text-side-up">$300</span>. The DOWN LP’s{' '}
          <span className="font-mono tnum text-ink">$100</span> funded the win.
        </p>
      </div>
    </section>
  );
}
