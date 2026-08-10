'use client';

// components/RouteChrome.tsx — hides the APP chrome (NavBar/SiteFooter) on the landing page, which
// ships its own minimal top bar + footer. Wrapped around the chrome slots in the root layout so the
// rest of the tree stays a server layout.
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function RouteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '/';
  if (pathname === '/welcome' || pathname.startsWith('/welcome/')) return null;
  return <>{children}</>;
}
