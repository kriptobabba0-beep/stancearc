'use client';

// components/auth/AuthModalProvider.tsx — app-wide control of the single "Sign in" modal.
// Any component calls useAuthModal().open() to launch it; the modal itself is rendered here so it
// sits inside the wagmi + wallet contexts.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { AuthModal } from '@/components/auth/AuthModal';

interface AuthModalValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const Ctx = createContext<AuthModalValue | null>(null);

export function AuthModalProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ isOpen, open, close }), [isOpen, open, close]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <AuthModal open={isOpen} onClose={close} />
    </Ctx.Provider>
  );
}

export function useAuthModal(): AuthModalValue {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuthModal must be used within an AuthModalProvider.');
  return c;
}
