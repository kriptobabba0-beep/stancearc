import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// The real app supplies a QueryClient via providers.tsx; page renders here need the same
// (the Stance page's AgentPanel fetches its signal through react-query).
const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
const qcWrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

// Phase 2 route smoke tests: each of the five relocated routes must mount its KEY component(s). We
// stub the (heavy, hook-driven) child components with lightweight testid markers, so these tests
// assert the COMPOSITION/relocation (the right components landed on the right page) without dragging
// in the full wagmi/contract graph. Each stub re-exports the real component's data-testid where the
// page itself doesn't add one.

// The root dispatcher calls useRouter().replace — stub the app-router context and capture the
// destination so the dispatch tests below can assert it.
const replaceMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: replaceMock, push: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/components/SwapForm', () => ({
  SwapForm: () => <div data-testid="swap-form" />,
}));
vi.mock('@/components/SettlementBanner', () => ({
  SettlementBanner: () => <div data-testid="settlement-banner" />,
}));
vi.mock('@/components/MarketSelector', () => ({
  MarketSelector: () => <div data-testid="market-selector" />,
}));
// /pool is a list page assembled from the stats header + the tabbed browser — stub them so this
// composition smoke test asserts the relocation without the wagmi/contract/react-query graph.
vi.mock('@/components/pool/PoolStatHeader', () => ({
  PoolStatHeader: () => <div data-testid="pool-stat-header" />,
}));
vi.mock('@/components/pool/PoolBrowser', () => ({
  PoolBrowser: () => <div data-testid="pool-browser" />,
}));
// /pool now imports the pool registry (which reads ENV eagerly via lib/tokens). Stub it so this
// composition smoke test mounts without the NEXT_PUBLIC_* env (the pair selector just needs labels).
vi.mock('@/lib/pools', () => {
  const POOLS = [
    { id: 'cirbtc-usdc', base: { symbol: 'cirBTC' }, quote: { symbol: 'USDC' } },
    { id: 'eurc-usdc', base: { symbol: 'EURC' }, quote: { symbol: 'USDC' } },
    { id: 'cirbtc-eurc', base: { symbol: 'cirBTC' }, quote: { symbol: 'EURC' } },
  ];
  return {
    POOLS,
    poolById: (id: string) => POOLS.find((p) => p.id === id),
    poolLabel: (p: { base: { symbol: string }; quote: { symbol: string } }) =>
      `${p.base.symbol} / ${p.quote.symbol}`,
  };
});
vi.mock('@/components/EpochPanel', () => ({
  EpochPanel: () => <div data-testid="epoch-panel" />,
}));
vi.mock('@/components/LiveStatus', () => ({
  LiveStatus: () => <div data-testid="live-status" />,
}));
vi.mock('@/components/StakeWithSideForm', () => ({
  StakeWithSideForm: () => <div data-testid="stake-form-stub" />,
}));
vi.mock('@/components/ClaimUnstakePanel', () => ({
  ClaimUnstakePanel: () => <div data-testid="claim-unstake" />,
}));
vi.mock('@/components/HowItWorks', () => ({
  HowItWorks: () => <div data-testid="how-it-works" />,
}));
vi.mock('@/components/EpochHistory', () => ({
  EpochHistory: () => <div data-testid="epoch-history" />,
}));
vi.mock('@/components/Leaderboard', () => ({
  Leaderboard: () => <div data-testid="leaderboard" />,
}));
vi.mock('@/components/ActivityFeed', () => ({
  ActivityFeed: () => <div data-testid="activity-feed" />,
}));
vi.mock('@/components/CircleActivityFeed', () => ({
  CircleActivityFeed: () => <div data-testid="circle-activity-feed" />,
}));

// /arena was rebuilt to the 3-column HUD flow — stub its new columns + modals + the flow hook so the
// page mounts as a COMPOSITION smoke test without dragging in the wagmi/contract graph.
vi.mock('@/components/arena/MarketContextCard', () => ({
  MarketContextCard: () => <div data-testid="market-context" />,
}));
vi.mock('@/components/arena/EpochCenterPanel', () => ({
  EpochCenterPanel: () => <div data-testid="epoch-center" />,
}));
vi.mock('@/components/arena/EnterArenaRail', () => ({
  EnterArenaRail: () => <div data-testid="enter-rail" />,
}));
vi.mock('@/components/arena/AddLiquidityModal', () => ({ AddLiquidityModal: () => null }));
vi.mock('@/components/arena/ChooseSideModal', () => ({ ChooseSideModal: () => null }));
vi.mock('@/components/arena/StakeReviewModal', () => ({ StakeReviewModal: () => null }));
vi.mock('@/components/arena/useArenaFlow', () => ({ useArenaFlow: () => ({}) }));

// Stub the data hooks (and MarketProvider) these route pages read so they mount without the
// wagmi/contract graph — enough for the composition smoke tests below to assert their section stubs.
vi.mock('@/hooks/useCurrentEpoch', () => ({ useCurrentEpoch: () => ({ data: undefined, isLoading: true }) }));
vi.mock('@/hooks/useOraclePrice', () => ({ useOraclePrice: () => ({ data: undefined }) }));
vi.mock('@/hooks/useEpochHistory', () => ({ useEpochHistory: () => ({ data: undefined }) }));
vi.mock('@/hooks/useLeaderboard', () => ({ useLeaderboard: () => ({ data: undefined }) }));
vi.mock('@/components/MarketProvider', () => ({
  useActiveMarket: () => ({ label: 'cirBTC/USDC', baseSymbol: 'cirBTC', baseDecimals: 8 }),
}));

import RootDispatcher from '@/app/page';
import SwapPage from '@/app/swap/page';
import PoolPage from '@/app/pool/page';
import StancePage from '@/app/stance/page';

afterEach(() => {
  cleanup();
  replaceMock.mockClear();
  window.localStorage.clear();
});

describe('route: / (dispatcher)', () => {
  it('sends a brand-new browser to the landing (/welcome)', () => {
    window.localStorage.removeItem('feearena.visited');
    render(<RootDispatcher />);
    expect(screen.getByTestId('root-dispatch')).toBeTruthy();
    expect(replaceMock).toHaveBeenCalledWith('/welcome');
  });

  it('sends a returning browser straight to the Stance', () => {
    window.localStorage.setItem('feearena.visited', '1');
    render(<RootDispatcher />);
    expect(replaceMock).toHaveBeenCalledWith('/stance');
  });
});

describe('route: /swap', () => {
  it('renders SwapForm as the hero', () => {
    render(<SwapPage />);
    expect(screen.getByTestId('trade-page')).toBeTruthy();
    expect(screen.getByTestId('swap-form')).toBeTruthy();
  });
});

describe('route: /pool', () => {
  it('renders the stats header and the tabbed pool browser', () => {
    render(<PoolPage />);
    // The list page is assembled from the stats header + the tabbed (Pools / My Positions) browser.
    expect(screen.getByTestId('pool-stat-header')).toBeTruthy();
    expect(screen.getByTestId('pool-browser')).toBeTruthy();
  });
});

describe('route: /stance', () => {
  it('renders the market-context, epoch hero, entry rail, and claim panel', () => {
    render(<StancePage />, { wrapper: qcWrapper });
    expect(screen.getByTestId('arena-page')).toBeTruthy();
    expect(screen.getByTestId('market-context')).toBeTruthy();
    expect(screen.getByTestId('epoch-center')).toBeTruthy();
    expect(screen.getByTestId('enter-rail')).toBeTruthy();
    expect(screen.getByTestId('arena-claim')).toBeTruthy();
    expect(screen.getByTestId('claim-unstake')).toBeTruthy();
  });
});

// A page with no link is a page nobody reaches. /campaign was built, deployed and returning 200
// while being invisible, because it was never added to the nav.
describe('every primary page is reachable from the nav', () => {
  it('links every open page', () => {
    const src = readFileSync(resolve(process.cwd(), 'components/NavBar.tsx'), 'utf8');
    for (const href of ['/stance', '/agent', '/swap', '/pool', '/bridge', '/leaderboard']) {
      expect(src, `${href} is not in the nav`).toContain(`href: '${href}'`);
    }
  });

  // The link and the route are driven by one flag so they cannot drift apart: a link to a
  // closed page is a dead end, and an open page with no link is invisible.
  it('shows or hides Campaign together with the route', () => {
    const nav = readFileSync(resolve(process.cwd(), 'components/NavBar.tsx'), 'utf8');
    const page = readFileSync(resolve(process.cwd(), 'app/campaign/page.tsx'), 'utf8');
    expect(nav).toContain('CAMPAIGN_PAGE_ENABLED');
    expect(page).toContain('CAMPAIGN_PAGE_ENABLED');
  });
});

// The closed campaign route must answer with a real 404, not a 404-looking page with a 200.
// notFound() alone changes the body but leaves the status at 200 on this runtime, and a 200 is
// what a crawler indexes — so the status is set in middleware, pinned to just this path.
describe('the closed campaign route', () => {
  it('is matched by middleware and nothing else is', () => {
    const src = readFileSync(resolve(process.cwd(), 'middleware.ts'), 'utf8');
    expect(src).toContain("matcher: ['/campaign', '/campaign/:path*']");
    expect(src).toContain('CAMPAIGN_PAGE_ENABLED');
  });
});

// Ordering and treatment were both asked for explicitly, and both are the kind of thing a later
// edit reshuffles without noticing.
describe('nav placement and treatment', () => {
  const nav = () => readFileSync(resolve(process.cwd(), 'components/NavBar.tsx'), 'utf8');

  it('puts Campaign after Leaderboard', () => {
    const src = nav();
    expect(src.indexOf("href: '/leaderboard'")).toBeLessThan(src.indexOf("href: '/campaign'"));
  });

  it('gives Campaign its own colour, not the Agent one', () => {
    const src = nav();
    expect(src).toContain('nav-campaign-cyan');
    // The two entries must not share a class, or Campaign becomes a second Agent.
    expect(src).toMatch(/campaign \? 'nav-campaign-cyan'/);
  });

  it('defines the campaign sweep with its own timing and a reduced-motion opt-out', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
    expect(css).toContain('.nav-campaign-cyan');
    expect(css).toContain('nav-campaign-shine');
    // Different period from Agent's 2.6s, so the two never run in lockstep.
    expect(css).toMatch(/nav-campaign-shine 3\.4s/);
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*nav-campaign-cyan \{ animation: none/);
  });
});
