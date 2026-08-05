'use client';

// components/pool/PoolBrowser.tsx - the tabbed Pool browser (reference: Synthra's "Pools / My Positions"
// tabs). A tab bar on the left + a shared search + Create toolbar on the right; the panel below swaps
// between the pool table (PoolTable) and the wallet's positions (MyPositions). The search query and the
// Create modal are shared across both tabs. Proper ARIA tablist with roving tabindex + arrow-key nav.
import { useRef, useState } from 'react';
import { PoolTable } from '@/components/pool/PoolTable';
import { MyPositions } from '@/components/pool/MyPositions';
import { CreatePoolModal } from '@/components/pool/CreatePoolModal';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Search, Plus } from '@/components/ui/icons';
import { cn } from '@/lib/cn';

type Tab = 'pools' | 'positions';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'pools', label: 'Pools' },
  { id: 'positions', label: 'My Positions' },
];

export function PoolBrowser() {
  const [tab, setTab] = useState<Tab>('pools');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // WAI-ARIA tablist keyboard support: ←/→ wrap, Home/End jump to the ends (focus follows selection).
  const onTabKey = (e: React.KeyboardEvent) => {
    const idx = TABS.findIndex((t) => t.id === tab);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = TABS.length - 1;
    if (nextIdx === null) return;
    e.preventDefault();
    setTab(TABS[nextIdx].id);
    tabRefs.current[nextIdx]?.focus();
  };

  // The shared search filters the ACTIVE panel - pools on the Pools tab, positions on the My Positions
  // tab - so the label must follow the tab (the no-match copy already does).
  const searchLabel = tab === 'pools' ? 'Search pools' : 'Search positions';

  return (
    <div data-testid="pool-browser">
      {/* Toolbar: tabs (left) + search + Create (right) */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div
          role="tablist"
          aria-label="Pools or my positions"
          onKeyDown={onTabKey}
          className="inline-flex items-center rounded-xl border border-line bg-surface-muted p-1"
        >
          {TABS.map((t, i) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`pooltab-${t.id}`}
                aria-selected={active}
                aria-controls={`poolpanel-${t.id}`}
                tabIndex={active ? 0 : -1}
                data-testid={`pool-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                className={cn(
                  'rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus',
                  active ? 'bg-surface text-ink shadow-card' : 'text-ink-soft hover:text-ink',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="flex flex-1 items-center gap-3 sm:flex-none">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              data-testid="pool-search"
              className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-4 text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:border-line-strong focus-visible:shadow-focus"
            />
          </div>
          <button
            type="button"
            data-testid="pool-create"
            onClick={() => setCreateOpen(true)}
            className={buttonClass('primary', 'md', 'shrink-0')}
          >
            <Plus className="h-4 w-4" /> Create
            <Stars />
          </button>
        </div>
      </div>

      {/* Panels */}
      {tab === 'pools' ? (
        <div id="poolpanel-pools" role="tabpanel" aria-labelledby="pooltab-pools">
          <PoolTable query={query} />
        </div>
      ) : (
        <div id="poolpanel-positions" role="tabpanel" aria-labelledby="pooltab-positions">
          <MyPositions query={query} onCreate={() => setCreateOpen(true)} />
        </div>
      )}

      <CreatePoolModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}
