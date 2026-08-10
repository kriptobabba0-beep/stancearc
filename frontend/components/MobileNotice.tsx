'use client';

// components/MobileNotice.tsx — tells a phone visitor the app is happier on a desktop.
//
// Informational only. Nothing is blocked, nothing is gated, and the notice can be dismissed for
// good — a wallet app's in-app browser is often the ONLY way someone can reach the site, so
// standing in their way would be worse than the cramped layout they came for.
//
// Visibility is a CSS media query (`sm:hidden`), not a JavaScript viewport check. A JS check reads
// a width the server never had, which makes the first client render disagree with the server one;
// letting CSS decide keeps the markup identical on both sides. The only JS here is the dismissal,
// which starts hidden and reveals after mount, so a returning visitor never sees it flash.
//
// Pinned to the BOTTOM, so it survives scrolling without fighting the header. NavBar is already
// `sticky top-0 z-40`; a second element sticking to the top would sit over it and swallow the nav
// on exactly the screens where the nav matters most. The bottom edge is free, and a thin strip
// there stays out of the way of everything the page is actually for.
import { useEffect, useState } from 'react';
import { Close } from '@/components/ui/icons';

const DISMISS_KEY = 'limen.mobile-notice-dismissed';

export function MobileNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(DISMISS_KEY) !== '1') setVisible(true);
    } catch {
      setVisible(true); // storage blocked (private mode): showing it once per visit is fine
    }
  }, []);

  if (!visible) return null;

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* nothing to remember it with — it simply returns next visit */
    }
  };

  return (
    <div
      role="note"
      data-testid="mobile-notice"
      className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-line bg-surface-muted/95 px-4 py-2 text-[12px] text-ink-soft backdrop-blur sm:hidden"
    >
      <span>Limen works best on desktop.</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        data-testid="mobile-notice-dismiss"
        className="shrink-0 rounded p-1 text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
      >
        <Close className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
