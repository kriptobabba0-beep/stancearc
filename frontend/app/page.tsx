'use client';

// app/page.tsx - the ROOT DISPATCHER. Opening fee-arena.vercel.app routes by visitor state:
//   • first-ever visit (no localStorage flag) → /welcome - the landing tells the story once;
//   • every visit after                        → /arena  - the product's heart.
// Swap moved to /swap. The decision needs localStorage, so it runs client-side on mount; a quiet
// brand splash renders for the few frames before the redirect lands.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { BrandMark } from '@/components/ui/BrandMark';

/** Set by the landing page on mount - distinguishes brand-new browsers from returning ones. */
const VISITED_KEY = 'feearena.visited';

export default function RootDispatcher() {
  const router = useRouter();

  useEffect(() => {
    let dest = '/stance';
    try {
      if (!window.localStorage.getItem(VISITED_KEY)) dest = '/welcome';
    } catch {
      /* storage unavailable (private mode) - default to the app */
    }
    router.replace(dest);
  }, [router]);

  return (
    <div data-testid="root-dispatch" className="grid min-h-[70vh] place-items-center">
      <BrandMark className="h-10 w-10 animate-pulse-soft" label="Loading Limen Finance" />
    </div>
  );
}
