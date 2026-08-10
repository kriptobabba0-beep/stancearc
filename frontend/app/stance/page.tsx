'use client';

// app/arena/page.tsx — ARENA, rebuilt to the mockup design: a 3-column "HUD" with the round's market
// context (left), the live epoch hero (center), and the guided entry rail (right) that walks the user
// through Add liquidity → Choose side → Stake via three modals. The full journey happens on this one
// page. Below the grid, the settlement banner + claim/unstake panel preserve the post-settlement
// lifecycle (claim winnings, return the NFT) — the mockups cover entry; this keeps claiming reachable.
//
// All on-chain wiring is the existing hooks (useArenaFlow composes useOwnedPositions / useUserStakes /
// useCurrentEpoch; the modals reuse ProvideLiquidity + useStakeWithSide). This file only assembles them.
import { SettlementBanner } from '@/components/SettlementBanner';
import { ClaimUnstakePanel } from '@/components/ClaimUnstakePanel';
import { MarketSelector } from '@/components/MarketSelector';
import { MARKETS } from '@/lib/markets';
import { MarketContextCard } from '@/components/arena/MarketContextCard';
import { EpochCenterPanel } from '@/components/arena/EpochCenterPanel';
import { EnterArenaRail } from '@/components/arena/EnterArenaRail';
import { AddLiquidityModal } from '@/components/arena/AddLiquidityModal';
import { ChooseSideModal } from '@/components/arena/ChooseSideModal';
import { StakeReviewModal } from '@/components/arena/StakeReviewModal';
import { useArenaFlow } from '@/components/arena/useArenaFlow';
import { CircleActivityFeed } from '@/components/CircleActivityFeed';

export default function StancePage() {
  const flow = useArenaFlow();

  // Top-left chip — a one-line live summary of where the user is in the flow, INCLUDING the
  // wallet-connection status. (Only the "STATE:" label was dropped; the status text stays.)
  const stateText = !flow.isConnected
    ? 'Wallet not connected'
    : flow.isStaked
      ? 'Liquidity added · Market view selected · Position staked'
      : flow.hasLiquidity
        ? 'Connected wallet · Has liquidity · Not yet staked'
        : 'Connected wallet · No liquidity yet';

  return (
    <div data-testid="arena-page" className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 lg:px-8">
      {/* Win moment: a prominent claimable-win banner for the just-settled epoch. */}
      <SettlementBanner />

      {/* Market switcher — pick WHICH arena to enter (cirBTC/USDC or cirBTC/EURC). Surfaced here on the
          Arena page (not just the navbar "···" menu) so the market choice is obvious before entering.
          Renders only when >1 market is configured (MarketSelector itself no-ops on a single market). */}
      {MARKETS.length >= 2 && (
        <div
          data-testid="arena-market-switcher"
          className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 motion-safe:animate-fade-up"
        >
          <span className="kicker text-ink-muted">Market</span>
          <MarketSelector />
        </div>
      )}

      {/* Live state chip: one-line flow summary incl. wallet-connection status. */}
      <div className="mb-4 motion-safe:animate-fade-up">
        <span
          data-testid="arena-state-chip"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[11px]"
        >
          <span className="text-ink-soft">{stateText}</span>
        </span>
      </div>

      {/* The 3-column HUD: market context · live epoch · entry rail. EQUAL columns, EQUAL height —
          the grid stretches all three panels to the tallest (with a generous floor), and each panel
          bottom-anchors its last section so the extra height reads intentional.
          Mobile order: rail (action) → epoch → context; desktop: context | epoch | rail. */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="hud-col order-3 motion-safe:animate-fade-up lg:order-1 lg:min-h-[720px]">
          <MarketContextCard />
        </div>
        <div
          className="hud-col order-1 motion-safe:animate-fade-up lg:order-2 lg:min-h-[720px]"
          style={{ animationDelay: '60ms' }}
        >
          <EpochCenterPanel />
        </div>
        <div
          className="hud-col order-2 motion-safe:animate-fade-up lg:order-3 lg:min-h-[720px]"
          style={{ animationDelay: '120ms' }}
        >
          <EnterArenaRail flow={flow} />
        </div>
      </div>

      {/* Live activity + your positions, SIDE BY SIDE on desktop (stacked on mobile) so the positions
          card sits next to the feed instead of far below it. Top-aligned (items-start) since the two
          cards have different natural heights.
            • Left  — the Circle SCP event-monitor pulse (polled).
            • Right — the post-settlement claim/unstake lifecycle; keeps the `arena-claim` anchor the
              rail's "View position" affordance scrolls to. */}
      <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
        <section className="motion-safe:animate-fade-up" style={{ animationDelay: '150ms' }}>
          <CircleActivityFeed />
        </section>
        <section
          id="arena-claim"
          data-testid="arena-claim"
          className="scroll-mt-24 motion-safe:animate-fade-up"
          style={{ animationDelay: '180ms' }}
        >
          <ClaimUnstakePanel />
        </section>
      </div>

      {/* Guided-entry modals, driven by the shared flow state. */}
      <AddLiquidityModal flow={flow} />
      <ChooseSideModal flow={flow} />
      <StakeReviewModal flow={flow} />
    </div>
  );
}
