'use client';

// components/pool/MyPositions.tsx — the connected wallet's LP positions across ALL registry pools, shown
// under the "My Positions" TAB of the Pool browser (PoolBrowser). Reuses the tested YourLiquidity
// (withdraw / collect) per pool, rendering a group ONLY for pools where the wallet holds positions, with
// one shared empty / disconnected state. Honors the browser's shared `query` (filters groups by pair)
// and an `onCreate` callback so the empty state's "Add Liquidity" opens the same Create modal as the
// toolbar. No heading of its own — the tab provides the label.
import { useAccount } from 'wagmi';
import { useOwnedPositions } from '@/hooks/useOwnedPositions';
import { POOLS, poolLabel } from '@/lib/pools';
import { YourLiquidity } from '@/components/YourLiquidity';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Connect } from '@/components/Connect';
import { Wallet, Layers, Plus } from '@/components/ui/icons';

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <Card className="bg-surface">
      <div className="flex flex-col items-center justify-center px-6 py-14 text-center">{children}</div>
    </Card>
  );
}

export function MyPositions({ query = '', onCreate }: { query?: string; onCreate?: () => void }) {
  const { isConnected } = useAccount();
  // The registry is a FIXED three-pool set, so call useOwnedPositions once per pool at the top level
  // (React's rules-of-hooks forbid calling hooks in a loop). If a pool is added to lib/pools, add a line.
  const q0 = useOwnedPositions({ pool: POOLS[0] });
  const q1 = useOwnedPositions({ pool: POOLS[1] });
  const q2 = useOwnedPositions({ pool: POOLS[2] });
  const perPool = [
    { pool: POOLS[0], q: q0 },
    { pool: POOLS[1], q: q1 },
    { pool: POOLS[2], q: q2 },
  ].filter((r) => r.pool);

  const anyLoading = perPool.some((r) => r.q.isLoading);
  const allWith = perPool.filter((r) => (r.q.data?.length ?? 0) > 0);
  const term = query.trim().toLowerCase();
  const withPositions = term
    ? allWith.filter((r) => poolLabel(r.pool).toLowerCase().includes(term))
    : allWith;

  return (
    <div data-testid="my-positions">
      {!isConnected ? (
        <CenteredCard>
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-muted text-ink-soft">
            <Wallet className="h-7 w-7" />
          </span>
          <h3 className="mt-5 font-display text-lg font-semibold text-ink">Connect your wallet</h3>
          <p className="mt-1.5 max-w-sm text-sm text-ink-soft">
            Connect to see the positions you hold and the trading fees they’ve earned.
          </p>
          <div className="mt-6">
            <Connect />
          </div>
        </CenteredCard>
      ) : anyLoading && allWith.length === 0 ? (
        <Card className="bg-surface">
          <div className="space-y-3 p-5" data-testid="my-positions-loading">
            <Skeleton className="h-20 w-full rounded-2xl" />
            <Skeleton className="h-20 w-full rounded-2xl" />
          </div>
        </Card>
      ) : allWith.length === 0 ? (
        <CenteredCard>
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-muted text-ink-soft">
            <Layers className="h-7 w-7" />
          </span>
          <h3 className="mt-5 font-display text-lg font-semibold text-ink">No active positions</h3>
          <p className="mt-1.5 max-w-sm text-sm text-ink-soft">
            Create a position to start earning a share of swap fees. Staked positions don’t appear here
            until they’re unstaked or settled.
          </p>
          <button
            type="button"
            data-testid="my-positions-create"
            onClick={onCreate}
            className={buttonClass('primary', 'md', 'mt-6')}
          >
            <Plus className="h-4 w-4" /> Add Liquidity
            <Stars />
          </button>
        </CenteredCard>
      ) : withPositions.length === 0 ? (
        <div
          data-testid="my-positions-no-match"
          className="rounded-2xl border border-line bg-surface px-4 py-10 text-center text-sm text-ink-muted"
        >
          No positions match “{query}”.
        </div>
      ) : (
        <div className="space-y-3">
          {withPositions.map((r) => (
            <YourLiquidity key={r.pool.id} pool={r.pool} />
          ))}
        </div>
      )}
    </div>
  );
}
