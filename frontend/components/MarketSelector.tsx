'use client';

// components/MarketSelector.tsx — segmented control listing MARKETS, each shown with its token-pair coins
// (so you see cirBTC/USDC vs cirBTC/EURC at a glance) and a crimson "selected" accent. Switching calls
// the context setter, which re-points every FeeArena/oracle/pool read & write at the selected market.
// Hidden when only one market is configured (single-market env = no selector, today's UI unchanged).
import { MARKETS } from '@/lib/markets';
import { useMarketSelector } from '@/components/MarketProvider';
import { TokenGlyph } from '@/components/TokenGlyph';
import { cn } from '@/lib/cn';

export function MarketSelector({ className }: { className?: string }) {
  const { marketId, setMarketId } = useMarketSelector();

  // Single market: render nothing so the default single-market dashboard looks exactly like today.
  if (MARKETS.length < 2) return null;

  return (
    <div
      data-testid="market-selector"
      role="tablist"
      aria-label="Select market"
      className={cn(
        'inline-flex items-center gap-1 rounded-xl border border-line bg-surface-inset p-1',
        className,
      )}
    >
      {MARKETS.map((m) => {
        const active = m.id === marketId;
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid={`market-tab-${m.id}`}
            data-active={active ? 'true' : 'false'}
            onClick={() => setMarketId(m.id)}
            className={cn(
              // flex-1 keeps the tabs equal width; NO min-w-0 + a nowrap label below means a tab
              // never shrinks under its single-line content — so every pair reads on ONE line the
              // way "cirBTC / EURC" does, instead of the shorter "cirBTC / USDC" wrapping to two.
              'flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:shadow-focus',
              active ? 'bg-brand/[0.12] ring-1 ring-inset ring-brand/40' : 'hover:bg-surface-muted',
            )}
          >
            <span className="flex shrink-0 items-center" aria-hidden="true">
              <TokenGlyph symbol={m.baseSymbol} className="z-10 h-5 w-5 text-[10px] ring-2 ring-surface-inset" />
              <TokenGlyph
                symbol={m.quoteSymbol ?? 'USDC'}
                className="-ml-2 h-5 w-5 text-[10px] ring-2 ring-surface-inset"
              />
            </span>
            <span className={cn('whitespace-nowrap text-[12px] font-semibold leading-tight', active ? 'text-ink' : 'text-ink-soft')}>
              {m.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
