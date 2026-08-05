'use client';

// components/circle/WalletModeProvider.tsx - which wallet the user chose: 'injected' (MetaMask) or
// 'embedded' (Circle). Persisted so the choice survives reloads. Drives useActiveWallet/useExecuteWrite.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type WalletMode = 'injected' | 'embedded';
const LS_MODE = 'feearena.walletMode';

interface WalletModeValue {
  mode: WalletMode | null;
  setMode: (m: WalletMode | null) => void;
}

const Ctx = createContext<WalletModeValue | null>(null);

export function WalletModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<WalletMode | null>(null);

  useEffect(() => {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(LS_MODE) : null;
    if (v === 'injected' || v === 'embedded') setModeState(v);
  }, []);

  const setMode = useCallback((m: WalletMode | null) => {
    setModeState(m);
    if (typeof window !== 'undefined') {
      if (m) window.localStorage.setItem(LS_MODE, m);
      else window.localStorage.removeItem(LS_MODE);
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWalletMode(): WalletModeValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useWalletMode must be used within a WalletModeProvider.');
  return c;
}
