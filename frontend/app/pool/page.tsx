// app/pool/page.tsx — POOLS surface (reference image #1): a TVL / 24h Volume / 24h Fees stats header with
// real sparklines, then a tabbed browser (PoolBrowser) — a "Pools / My Positions" tab bar with a shared
// search + Create toolbar. The Pools tab lists every registry pool SORTED BY LIQUIDITY (each row links to
// /pool/[id]); the My Positions tab lists the connected wallet's LP positions. No version selector — the
// app is single-version. Pure assembly: all data + interaction live in the client components below.
import { PoolStatHeader } from '@/components/pool/PoolStatHeader';
import { PoolBrowser } from '@/components/pool/PoolBrowser';

export default function PoolPage() {
  return (
    <div className="pool-upscale mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-6 motion-safe:animate-fade-up">
        <span className="kicker">Liquidity</span>
        <h1 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">Pools</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-ink-soft">
          Provide liquidity to a pool and earn a share of every swap’s fee. Pick a pool to set your price
          range and deposit, or hit Create to start a new position. Eligible positions can be entered into
          the{' '}
          <a href="/stance" className="font-medium text-brand hover:text-brand-hover">
            Stance
          </a>{' '}
          with an UP, DOWN or RANGE view.
        </p>
      </header>

      <div className="mb-8">
        <PoolStatHeader />
      </div>

      <PoolBrowser />
    </div>
  );
}
