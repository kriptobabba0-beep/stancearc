import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { ActivityEvent } from '@/lib/activity/types';

const activity = vi.hoisted(() => ({ events: [] as ActivityEvent[], degraded: false, isLoading: false }));
const account = vi.hoisted(() => ({ current: undefined as string | undefined }));

vi.mock('@/hooks/useArenaActivity', () => ({ useArenaActivity: () => activity }));
vi.mock('wagmi', () => ({ useAccount: () => ({ address: account.current }) }));
vi.mock('@/lib/env', () => ({ ENV: { EXPLORER_URL: 'https://testnet.arcscan.app' } }));

import { CircleActivityFeed } from '@/components/CircleActivityFeed';

const OWNER = '0x1111111111111111111111111111111111111111';
const ev = (over: Partial<ActivityEvent>): ActivityEvent =>
  ({
    id: 'e1',
    kind: 'staked',
    marketId: 'cirbtc',
    marketLabel: 'cirBTC / USDC',
    quoteSymbol: 'USDC',
    epochId: 42,
    txHash: '0xabc123',
    blockHeight: 1,
    logIndex: 0,
    side: 1,
    owner: OWNER,
    ...over,
  }) as ActivityEvent;

beforeEach(() => {
  activity.events = [];
  activity.degraded = false;
  activity.isLoading = false;
  account.current = undefined;
});
afterEach(cleanup);

describe('CircleActivityFeed', () => {
  it('renders rows, Circle branding and an ArcScan tx link', () => {
    activity.events = [ev({ id: 'e1' })];
    render(<CircleActivityFeed />);
    expect(screen.getByText('Powered by Circle Contracts')).toBeTruthy();
    expect(screen.getByText(/Indexed via Circle Smart Contract Platform event monitors/i)).toBeTruthy();
    const rows = screen.getAllByTestId('circle-activity-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('0x1111…1111 staked UP on epoch #42')).toBeTruthy();
    const link = within(rows[0]).getByRole('link');
    expect(link.getAttribute('href')).toBe('https://testnet.arcscan.app/tx/0xabc123');
  });

  it('shows the empty state when there are no events', () => {
    render(<CircleActivityFeed />);
    expect(screen.getByTestId('circle-activity-empty').textContent).toBe('No recent Stance events.');
  });

  it('shows a loading state', () => {
    activity.isLoading = true;
    render(<CircleActivityFeed />);
    expect(screen.getByTestId('circle-activity-empty').textContent).toBe('Loading activity…');
  });

  it('shows "catching up" when degraded', () => {
    activity.degraded = true;
    render(<CircleActivityFeed />);
    expect(screen.getByTestId('circle-activity-empty').textContent).toBe('Activity is catching up…');
  });

  it('highlights the connected wallet’s own rows', () => {
    account.current = OWNER;
    activity.events = [ev({ id: 'mine', owner: OWNER }), ev({ id: 'theirs', owner: '0x2222222222222222222222222222222222222222' })];
    render(<CircleActivityFeed />);
    const youBadges = screen.getAllByText('you');
    expect(youBadges).toHaveLength(1);
  });

  it('hides the green “live” badge when the Circle source is degraded', () => {
    activity.degraded = true;
    activity.events = [];
    render(<CircleActivityFeed />);
    expect(screen.queryByText('live')).toBeNull();
  });

  it('matches the own-address highlight case-insensitively (checksummed vs lowercase)', () => {
    const MIXED = '0xAbC0000000000000000000000000000000001234';
    account.current = MIXED; // wagmi returns a checksummed (mixed-case) address
    activity.events = [ev({ id: 'mine', owner: MIXED.toLowerCase() as `0x${string}` })]; // decode yields lowercase
    render(<CircleActivityFeed />);
    expect(screen.getAllByText('you')).toHaveLength(1);
  });
});
