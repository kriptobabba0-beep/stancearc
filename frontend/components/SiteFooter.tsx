// components/SiteFooter.tsx - the app-wide footer:
//   TOP    - the standing Arc Testnet / no-monetary-value notice (centered, spans the bar)
//   LEFT   - "Limen Finance · Arc Testnet"
//   CENTER - Docs · Terms · Privacy (muted text links)
//   RIGHT  - X / Discord / GitHub marks
//
// Legal/doc links are placeholders (href="#") to be wired to real destinations later. X points at
// the live account; Discord & GitHub aren't created yet, so they render as inactive marks with a
// "soon" tooltip on hover/focus. The whole bar is rendered once from the root layout, so it is
// consistent on every page (the user approved the whole-shell redesign).
import { XLogo, Discord, GitHub } from '@/components/ui/icons';
import { BrandMark } from '@/components/ui/BrandMark';

const FOOTER_LINKS = [
  { label: 'Docs', href: '#' }, // docs site not built yet
  { label: 'Terms', href: '/terms' },
  { label: 'Privacy', href: '/privacy' },
] as const;

const SOCIALS = [
  { label: 'Limen Finance on X', href: 'https://x.com/LimenFinance', Icon: XLogo, ready: true },
  { label: 'Limen Finance on Discord', href: null, Icon: Discord, ready: false },
  { label: 'Limen Finance on GitHub', href: null, Icon: GitHub, ready: false },
] as const;

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-[1600px] px-4 pb-8 pt-6 sm:px-6 lg:px-8 xl:px-10">
      <div className="border-t border-line pt-5">
        {/* Standing testnet notice. It sits in the footer because the root layout renders this bar on
            every page, so the disclaimer is present app-wide without shifting any layout. Deliberately
            text-ink-muted (the footer's own tone) rather than the fainter text-ink-faint - ink-faint is
            ~2.6:1 on the light background, and a legal notice must not be the least readable text on
            the page. */}
        <p className="mx-auto max-w-2xl text-center text-xs leading-relaxed text-ink-muted">
          Limen is currently available only on Arc Testnet for testing and demonstration. Test tokens
          have no monetary value, and no real funds, prizes, or financial returns are involved.
        </p>

        {/* lg+: a 3-column grid (each column 1fr) so the CENTER nav sits at the bar's TRUE midpoint
            regardless of how wide the left copyright vs the right icons are - justify-between would
            center it in the leftover space instead, shifting it right. */}
        <div className="mt-5 flex flex-col items-center gap-4 text-xs text-ink-muted lg:grid lg:grid-cols-3 lg:items-center">
          {/* Left - mark + copyright */}
          <span className="order-3 flex items-center justify-center gap-2 lg:order-1 lg:justify-self-start">
            <BrandMark className="h-[18px] w-[18px]" />
            <span>
              Limen Finance <span className="text-ink-faint">·</span> Arc Testnet
            </span>
          </span>

          {/* Center - doc/legal links */}
          <nav aria-label="Footer" className="order-1 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 lg:order-2 lg:justify-self-center">
            {FOOTER_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                className="rounded font-medium text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
              >
                {l.label}
              </a>
            ))}
          </nav>

          {/* Right - socials. X is live; the not-yet-created ones show a "soon" tooltip. */}
          <div className="order-2 flex items-center gap-4 lg:order-3 lg:justify-self-end">
            <div className="flex items-center gap-2.5">
              {SOCIALS.map(({ label, href, Icon, ready }) =>
                ready && href !== null ? (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={label}
                    className="rounded text-ink-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </a>
                ) : (
                  <span
                    key={label}
                    tabIndex={0}
                    role="img"
                    aria-label={`${label} - coming soon`}
                    className="group relative rounded text-ink-faint transition-colors hover:text-ink-muted focus-visible:outline-none focus-visible:shadow-focus"
                  >
                    <Icon className="h-[18px] w-[18px]" />
                    {/* "soon" bubble - hidden until hover/keyboard-focus of the mark. */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded-md border border-line bg-surface-inset px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-ink-muted opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                    >
                      soon
                    </span>
                  </span>
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
