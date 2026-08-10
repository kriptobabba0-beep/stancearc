'use client';

// components/MarketProvider.tsx — React context holding the active market + setter, persisted to
// localStorage (SSR-guarded). All FeeArena/oracle/pool reads & writes resolve through the active
// market via useMarketContracts() (lib/contracts.ts), so switching here re-points the whole dashboard.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_MARKET_ID, MARKETS, marketById, type Market } from '@/lib/markets';

const STORAGE_KEY = 'feearena.marketId';

interface MarketContextValue {
  market: Market;
  marketId: string;
  setMarketId: (id: string) => void;
}

const MarketContext = createContext<MarketContextValue | null>(null);

/** Read the persisted marketId (SSR-guarded); validate against the known list. */
function readStoredMarketId(): string {
  if (typeof window === 'undefined') return DEFAULT_MARKET_ID;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && MARKETS.some((m) => m.id === stored)) return stored;
  } catch {
    /* localStorage may be unavailable (private mode) — fall back to default */
  }
  return DEFAULT_MARKET_ID;
}

export function MarketProvider({ children }: { children: ReactNode }) {
  // Initialize to DEFAULT_MARKET_ID for a stable SSR/first-paint; hydrate from localStorage after mount.
  const [marketId, setMarketIdState] = useState<string>(DEFAULT_MARKET_ID);

  useEffect(() => {
    const stored = readStoredMarketId();
    if (stored !== marketId) setMarketIdState(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setMarketId = useCallback((id: string) => {
    // Ignore unknown ids (keeps the dashboard pointed at a valid market).
    if (!MARKETS.some((m) => m.id === id)) return;
    setMarketIdState(id);
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* ignore persistence failures */
      }
    }
  }, []);

  const value = useMemo<MarketContextValue>(
    () => ({ market: marketById(marketId), marketId, setMarketId }),
    [marketId, setMarketId],
  );

  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

/**
 * PIN a subtree to a SPECIFIC market, overriding the app-wide active selection. All FeeArena/oracle
 * reads inside resolve to `marketId` (the setter is a no-op). Used by the landing/welcome hero, which
 * is a fixed teaser for the flagship market and must NOT follow whatever market the user last selected
 * (otherwise it would, e.g., show the cirBTC/EURC oracle price under a cirBTC/USDC label).
 */
export function FixedMarketProvider({ marketId, children }: { marketId: string; children: ReactNode }) {
  const value = useMemo<MarketContextValue>(
    () => ({ market: marketById(marketId), marketId, setMarketId: () => {} }),
    [marketId],
  );
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}

/** The active Market (id, label, base symbol/decimals, per-market addresses).
 * Outside a MarketProvider (e.g. isolated unit tests) it degrades to the DEFAULT market, so
 * single-market behavior is identical with or without the provider mounted. */
export function useActiveMarket(): Market {
  const ctx = useContext(MarketContext);
  return ctx?.market ?? marketById(DEFAULT_MARKET_ID);
}

/** The active marketId + setter, for the MarketSelector. No-ops the setter outside a provider. */
export function useMarketSelector(): { marketId: string; setMarketId: (id: string) => void } {
  const ctx = useContext(MarketContext);
  if (ctx) return { marketId: ctx.marketId, setMarketId: ctx.setMarketId };
  return { marketId: DEFAULT_MARKET_ID, setMarketId: () => {} };
}
