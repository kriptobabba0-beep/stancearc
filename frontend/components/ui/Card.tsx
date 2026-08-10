'use client';

// ui/Card.tsx — the app-wide card primitives, in the ARENA design language: every card is the
// chamfered "HUD" octagon frame (globals.css `.hud-panel`) rather than a plain rounded rectangle.
//
// Implementation notes:
//  • `--hud-ext:0px` pulls the frame's paint pseudos back inside the element box (the ±12px extension
//    exists only for the Arena columns' interlocking joint tabs), and the element-level
//    `clip-path: var(--hud-clip)` clips CHILDREN to the octagon too — full-bleed header/footer strips
//    can't square out the cut corners.
//  • Each card wraps itself in `.hud-col` (a container-query scope) so the chamfer size tracks the
//    CARD's own width (~5.2%, clamped), exactly like the Arena columns.
import { type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({
  children,
  className = '',
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <div className="hud-col">
      <div
        className={cn(
          'hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)]',
          interactive && 'transition-colors hover:[--hud-fill:var(--c-surface-muted)]',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-5 py-5', className)}>{children}</div>;
}

/**
 * The primary building block: a HUD panel with a hairline-separated header
 * (outlined icon tile + mono kicker + title + action) and a padded body. Used across all panels.
 */
export function SectionCard({
  title,
  kicker,
  icon,
  action,
  children,
  footer,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  kicker?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const hasHeader = title || action || kicker;
  return (
    <Card className={className}>
      {hasHeader && (
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-3">
            {icon && (
              // Outlined square tile (the Arena's icon-chip language — no filled brand tiles).
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface-muted/40 text-ink-muted">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {kicker && <div className="kicker">{kicker}</div>}
              {title && (
                <h2 className="font-display text-[15px] font-semibold leading-tight text-ink">
                  {title}
                </h2>
              )}
            </div>
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={cn('px-5 py-5', bodyClassName)}>{children}</div>
      {footer && (
        <div className="border-t border-line bg-surface-muted px-5 py-3 text-sm text-ink-muted">
          {footer}
        </div>
      )}
    </Card>
  );
}
