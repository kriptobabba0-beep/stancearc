'use client';

// components/agent/ModelPicker.tsx - the copilot's model selector, in the user's terms.
//
// Each row answers the only questions a user has: how good, how fast - two dot scales and
// a plain tagline. What a message COSTS them is the flat platform price (or free), shown
// once in the footer, because model choice never changes their bill. Unknown-but-allowed
// model ids stay listable with no dots. The trigger keeps the agent-model testid.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

interface ModelMeta {
  label: string;
  /** What picking this model means for the user, in plain words. */
  tagline: string;
  qualityDots: number; // 1..5 - higher = smarter answers
  speedDots: number; // 1..5 - higher = faster replies
}

const MODEL_META: Record<string, ModelMeta> = {
  'claude-sonnet-5': { label: 'Claude Sonnet 5', tagline: 'Sharpest analysis', qualityDots: 5, speedDots: 3 },
  'claude-haiku-4-5-20251001': { label: 'Claude Haiku 4.5', tagline: 'Fastest replies', qualityDots: 3, speedDots: 5 },
  'claude-opus-4-8': { label: 'Claude Opus 4.8', tagline: 'Deepest reasoning', qualityDots: 5, speedDots: 2 },
};

function metaFor(id: string): ModelMeta {
  return MODEL_META[id] ?? { label: id.replace(/-\d{8}$/, ''), tagline: '', qualityDots: 0, speedDots: 0 };
}

function Dots({ filled, tone }: { filled: number; tone: 'speed' | 'quality' }) {
  return (
    <span className="flex items-center gap-[3px]">
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn(
            'h-[5px] w-[5px] rounded-full',
            i <= filled ? (tone === 'quality' ? 'bg-brand' : 'bg-[#d99e3b]') : 'bg-line',
          )}
        />
      ))}
    </span>
  );
}

export function ModelPicker({
  models,
  value,
  onChange,
  priceLabel,
}: {
  models: string[];
  value: string | null;
  onChange: (model: string) => void;
  /** What one message actually costs the user (e.g. "$0.01 per message" or "Free"). */
  priceLabel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  // The trigger lives inside a clip-path'd hud-panel, which would clip an in-place
  // dropdown - so the menu renders in a body portal at a fixed position instead.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLUListElement>(null);

  const toggle = () => {
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      setAnchor({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    }
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const current = metaFor(value ?? models[0] ?? '');

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid="agent-model"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className="flex min-w-[200px] items-center justify-between gap-3 rounded-lg border border-line bg-surface-muted/60 px-3.5 py-2 text-[13px] font-medium text-ink transition-colors hover:border-brand/50"
      >
        <span className="flex items-center gap-2.5">
          <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-[#7c6cf0]/60" aria-hidden="true">
            <span className="h-1.5 w-1.5 rounded-full bg-[#7c6cf0]" />
          </span>
          {current.label}
        </span>
        <svg viewBox="0 0 10 6" className="h-1.5 w-2.5 text-ink-faint" fill="none" aria-hidden="true">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && anchor !== null && typeof document !== 'undefined' && createPortal(
        <ul
          ref={panelRef}
          role="listbox"
          aria-label="Model"
          style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
          className="z-50 w-[300px] rounded-xl border border-line bg-surface p-1.5 shadow-[0_16px_40px_rgb(0_0_0/0.55)]"
        >
          {models.map((m) => {
            const meta = metaFor(m);
            const selected = m === value;
            return (
              <li key={m} role="option" aria-selected={selected}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(m);
                    setOpen(false);
                  }}
                  className={cn(
                    'w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-muted',
                    selected && 'bg-surface-muted',
                  )}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-mono text-[11.5px] font-bold uppercase tracking-wide text-ink">{meta.label}</span>
                    {selected && <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" />}
                  </span>
                  <span className="mt-1.5 flex items-center justify-between gap-3">
                    <span className="font-mono text-[11px] text-ink-faint">{meta.tagline}</span>
                    {meta.qualityDots > 0 && (
                      <span className="flex items-center gap-3.5">
                        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                          Quality <Dots filled={meta.qualityDots} tone="quality" />
                        </span>
                        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-faint">
                          Speed <Dots filled={meta.speedDots} tone="speed" />
                        </span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {priceLabel && (
            <li className="mt-1 border-t border-line px-3 py-2.5 font-mono text-[10.5px] text-ink-muted" aria-hidden="true">
              You pay {priceLabel} - same for every model.
            </li>
          )}
        </ul>,
        document.body,
      )}
    </div>
  );
}
