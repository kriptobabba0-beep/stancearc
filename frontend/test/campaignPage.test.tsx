// campaignPage.test.tsx — the campaign surface: an index that splits running from settled, and a
// per-campaign page that ranks with the arena leaderboard's own board.
//
// These numbers decide who gets paid, so what is tested is that they are reported faithfully: the
// standings as published, the viewer's own place, an honest state before anything has published,
// and a route that stays shut while the feature is closed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const ME = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD = '0xcccccccccccccccccccccccccccccccccccccccc';
const FOURTH = '0xdddddddddddddddddddddddddddddddddddddddd';

const account = vi.hoisted(() => ({ address: undefined as string | undefined }));
vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app' } }));
vi.mock('wagmi', () => ({ useAccount: () => ({ address: account.address }) }));
vi.mock('@/components/leaderboard/Identicon', () => ({ Identicon: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import CampaignsPage from '@/app/campaign/page';
import { CampaignIndex } from '@/components/campaign/CampaignIndex';
import { CampaignStandings } from '@/components/campaign/CampaignStandings';
import { CAMPAIGN_PAGE_ENABLED } from '@/lib/campaignVisibility';

const row = (address: string, rank: number, volume: bigint, pnl: bigint) => ({
  address,
  rank,
  volumeUsd6: volume.toString(),
  swapUsd6: volume.toString(),
  liqUsd6: '0',
  feeUsd6: '0',
  pnlUsd6: pnl.toString(),
  claimedUsd6: (pnl > 0n ? pnl : 0n).toString(),
  claimedBase: '0',
  claimedQuote: '0',
  entered: 4,
  won: 2,
});

const payload = (over: Record<string, unknown> = {}) => ({
  id: 'aug',
  live: true,
  startBlock: '100',
  endBlock: '200',
  cursor: '150',
  generatedAt: 1,
  totals: { volumeUsd6: '300000000000', participants: 4 },
  prize: { prizeUsd: 400, nextTierAtUsd6: '500000000000' },
  // Deliberately different orders: each board is already the top N by ITS metric.
  volume: [row(OTHER, 1, 200_000000000n, 0n), row(ME, 2, 100_000000000n, 0n), row(THIRD, 3, 5_000000n, 0n), row(FOURTH, 4, 1_000000n, 0n)],
  pnl: [row(ME, 1, 0n, 5_000000n), row(OTHER, 2, 0n, -2_000000n)],
  ...over,
});

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'aug',
  title: 'Aug',
  live: true,
  startBlock: '100',
  endBlock: '200',
  cursor: '150',
  generatedAt: 1,
  volumeUsd6: '300000000000',
  participants: 4,
  prizeUsd: 400,
  ...over,
});

function renderWith(node: ReactNode, body: unknown) {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => body }) as never;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  account.address = undefined;
});
afterEach(cleanup);

describe('campaign index', () => {
  it('splits campaigns into running and settled', async () => {
    renderWith(<CampaignIndex />, {
      campaigns: [summary(), summary({ id: 'jul', title: 'Jul', live: false, prizeUsd: 300 })],
    });
    await waitFor(() => expect(screen.getAllByTestId('campaign-card')).toHaveLength(2));
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Finished')).toBeTruthy();
    const pills = screen.getAllByTestId('campaign-card-status').map((p) => p.textContent);
    expect(pills).toContain('Live');
    expect(pills).toContain('Ended');
  });

  it('leaves out a group that has nothing in it', async () => {
    // A page that always shows an empty "Finished" heading teaches readers to ignore headings.
    renderWith(<CampaignIndex />, { campaigns: [summary()] });
    await waitFor(() => expect(screen.getAllByTestId('campaign-card')).toHaveLength(1));
    expect(screen.queryByText('Finished')).toBeNull();
  });

  it('makes the whole card open that campaign', async () => {
    renderWith(<CampaignIndex />, { campaigns: [summary({ id: 'test 1h' })] });
    await waitFor(() => expect(screen.getByTestId('campaign-card')).toBeTruthy());
    expect(screen.getByTestId('campaign-card').getAttribute('href')).toBe('/campaign/test%201h');
  });

  it('says so plainly when no campaign has ever run', async () => {
    renderWith(<CampaignIndex />, { campaigns: [] });
    await waitFor(() => expect(screen.getByTestId('campaign-index-empty')).toBeTruthy());
  });
});

describe('one campaign', () => {
  it('reports the prize tier it bought, the total that bought it, and the next one', async () => {
    renderWith(<CampaignStandings id="aug" />, payload());
    await waitFor(() => expect(screen.getByTestId('campaign-prize').textContent).toBe('400 USDC'));
    expect(screen.getByTestId('campaign-volume').textContent).toMatch(/300/);
    expect(screen.getByTestId('campaign-wallets').textContent).toBe('4');
    expect(screen.getByTestId('campaign-next-tier')).toBeTruthy();
  });

  it('ranks with the leaderboard board: a podium and a table under it', async () => {
    renderWith(<CampaignStandings id="aug" />, payload());
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    // Four rows: three on the podium, the fourth in the table.
    expect(screen.getAllByTestId('campaign-row')).toHaveLength(1);
  });

  it('switches to the PnL board, which is ranked on its own figures', async () => {
    renderWith(<CampaignStandings id="aug" />, payload());
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    // By volume the podium is led by OTHER; by PnL it is led by ME. Switching must re-rank from
    // the PnL board rather than re-sorting the volume board's rows.
    expect(screen.getByTestId('campaign-podium').textContent).toContain('0xbbbb…bbbb');
    fireEvent.click(screen.getByRole('tab', { name: 'Realized PnL' }));
    await waitFor(() => expect(screen.getByTestId('campaign-podium').textContent).toContain('0xaaaa…aaaa'));
    // The PnL board carries two rows, so nothing spills into the table.
    expect(screen.queryAllByTestId('campaign-row')).toHaveLength(0);
  });

  it('pins the viewer to their own place', async () => {
    account.address = ME;
    renderWith(<CampaignStandings id="aug" />, payload());
    await waitFor(() => expect(screen.getByTestId('campaign-my-standing')).toBeTruthy());
    expect(screen.getByTestId('campaign-my-standing').textContent).toContain('#2');
  });

  it('shows no standing block when no wallet is connected', async () => {
    renderWith(<CampaignStandings id="aug" />, payload());
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    expect(screen.queryByTestId('campaign-my-standing')).toBeNull();
  });

  it('reads as Starting before the first publish, and Ended once it is over', async () => {
    renderWith(<CampaignStandings id="aug" />, { id: 'aug', live: true, pending: true, volume: [], pnl: [] });
    await waitFor(() => expect(screen.getByTestId('campaign-status').textContent).toBe('Starting'));
    expect(screen.getByTestId('campaign-empty')).toBeTruthy();

    cleanup();
    renderWith(<CampaignStandings id="aug" />, payload({ live: false }));
    await waitFor(() => expect(screen.getByTestId('campaign-status').textContent).toBe('Ended'));
  });

  it('offers the way back to the other campaigns', async () => {
    renderWith(<CampaignStandings id="aug" />, payload());
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    expect(screen.getByText(/All campaigns/).getAttribute('href')).toBe('/campaign');
  });
});

// Closed on purpose while the campaign surface is still being worked on. The route must be a real
// 404 rather than a page that renders half-finished standings to anyone who has the URL.
describe('the closed route', () => {
  it('answers 404 while campaigns are closed', () => {
    if (CAMPAIGN_PAGE_ENABLED) {
      expect(() => CampaignsPage()).not.toThrow();
      return;
    }
    expect(() => CampaignsPage()).toThrow('NEXT_NOT_FOUND');
  });
});

// A volume board used to carry Entries and Qualified, which are Stance-epoch figures. A pure
// trader always saw 0 and "—" there, which reads as something broken or as a hurdle they failed —
// on the board that decides a prize. The columns now belong to the metric.
describe('columns match the metric being ranked', () => {
  const payloadWithFour = () => payload();

  it('the volume board shows what volume is made of, not epoch figures', async () => {
    renderWith(<CampaignStandings id="aug" />, payloadWithFour());
    await waitFor(() => expect(screen.getByTestId('campaign-table')).toBeTruthy());
    const head = screen.getByTestId('campaign-table').textContent ?? '';
    expect(head).toContain('Swaps');
    expect(head).toContain('LP');
    expect(head).toContain('Fees');
    expect(head).not.toContain('Entries');
    expect(head).not.toContain('Qualified');
  });

  it('the PnL board keeps the epoch figures, where they are the right question', async () => {
    renderWith(<CampaignStandings id="aug" />, payload({
      pnl: [
        row(OTHER, 1, 0n, 9_000000n), row(ME, 2, 0n, 5_000000n), row(THIRD, 3, 0n, 1_000000n),
        row(FOURTH, 4, 0n, -2_000000n),
      ],
    }));
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Realized PnL' }));
    await waitFor(() => expect(screen.getByTestId('campaign-table')).toBeTruthy());
    const head = screen.getByTestId('campaign-table').textContent ?? '';
    expect(head).toContain('Entries');
    expect(head).toContain('Qualified');
  });

  it('keeps "no Stance entries yet" off the volume podium', async () => {
    // Printed beside a trader's biggest number it reads as a requirement they have missed.
    renderWith(<CampaignStandings id="aug" />, payloadWithFour());
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    expect(screen.getByTestId('campaign-podium').textContent).not.toMatch(/qualified|Stance entries/i);
  });

  it('states the claim rule where it can be read without hovering', async () => {
    // Realized PnL counts CLAIMED fee shares, so a winner who never pressed Claim ranks below one
    // who did on identical trading. A prize page must say that outright.
    renderWith(<CampaignStandings id="aug" />, payloadWithFour());
    await waitFor(() => expect(screen.getByText(/How this is scored/i)).toBeTruthy());
    expect(screen.getByText(/claim before the campaign ends/i)).toBeTruthy();
  });

  it('tells a visitor how long is left, not just a percentage', async () => {
    renderWith(<CampaignStandings id="aug" />, payload({ startBlock: '100', endBlock: '5000', cursor: '2000' }));
    await waitFor(() => expect(screen.getByText(/Ends in about/i)).toBeTruthy());
  });
});

// The payout reads the API; the claimant screenshots the page. If those two orders can differ,
// the difference is the dispute — so the page shows the published order and never re-sorts it.
describe('the page shows the order the payout will read', () => {
  it('renders the published ranking as published, even when another sort would disagree', async () => {
    // Both on zero. By the engine's rule OTHER leads (won 2 beats won 0); a sort that looked at
    // entries alone would put ME first. The page must not apply that second sort.
    renderWith(<CampaignStandings id="aug" />, payload({
      pnl: [
        { ...row(OTHER, 1, 0n, 0n), entered: 2, won: 2 },
        { ...row(ME, 2, 0n, 0n), entered: 5, won: 0 },
      ],
    }));
    await waitFor(() => expect(screen.getByTestId('campaign-podium')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Realized PnL' }));
    await waitFor(() => expect(screen.getByTestId('campaign-podium').textContent).toContain('0xbbbb…bbbb'));
    const podium = screen.getByTestId('campaign-podium').textContent ?? '';
    expect(podium.indexOf('0xbbbb…bbbb')).toBeLessThan(podium.indexOf('0xaaaa…aaaa'));
  });
});
