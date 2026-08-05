'use client';

// app/swap/page.tsx - SWAP (moved from "/" - the root is now a dispatcher: first visit → /welcome,
// returning visits → /arena). A single token-pair <SwapForm/> centered as the hero. There is NO
// market selector here: the swap is pool-routed by the tokens you pick (cirBTC / USDC / EURC), not
// bound to an arena market - the market selector lives on the Arena + Pool pages where it belongs.
import { SwapForm } from '@/components/SwapForm';
import { SettlementBanner } from '@/components/SettlementBanner';

export default function SwapPage() {
  return (
    <div className="mx-auto max-w-[480px] px-4 py-10 sm:px-6">
      {/* Win moment: a prominent claimable-win banner for the just-settled epoch (Claim + Share). */}
      <SettlementBanner />

      <div className="mb-4 text-center motion-safe:animate-fade-up">
        <span className="kicker">Arc Testnet · V3 DEX</span>
      </div>

      <div
        data-testid="trade-page"
        className="motion-safe:animate-fade-up"
        style={{ animationDelay: '40ms' }}
      >
        <SwapForm />
      </div>

      <p className="mx-auto mt-5 max-w-md text-center text-[13px] leading-relaxed text-ink-muted">
        Swap supported Arc testnet markets such as cirBTC, USDC and EURC. Active LP positions earn
        trading fees; fees from Stance-entered positions flow into the epoch fee pool. Provide liquidity in{' '}
        <a href="/pool" className="font-medium text-brand hover:text-brand-hover">
          Pools
        </a>{' '}
        or{' '}
        <a href="/stance" className="font-medium text-brand hover:text-brand-hover">
          enter an epoch with a market view
        </a>
        .
      </p>
    </div>
  );
}
