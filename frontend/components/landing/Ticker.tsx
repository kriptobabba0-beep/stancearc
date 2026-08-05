'use client';

// components/landing/Ticker.tsx - the landing's "the chain is already running" strip: a seamless
// marquee of REAL FeeArena events (stakes, claims, settlements) from the live activity feed. The
// track holds two copies of the items and slides −50% (CSS .landing-marquee); hovering pauses it.
// With no events yet this session, an honest static line renders instead of fabricated activity.
import { useActivityFeed } from '@/hooks/useActivityFeed';
import { SIDE_LABELS } from '@/lib/side';
import { Side } from '@/lib/types';
import { formatUSDC } from '@/lib/format';
import { cn } from '@/lib/cn';

function short(addr: unknown): string {
  const a = typeof addr === 'string' ? addr : '';
  return a.startsWith('0x') && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'someone';
}

function sideLabel(raw: unknown): string {
  const n = Number(raw);
  return SIDE_LABELS[(Number.isFinite(n) ? n : Side.NONE) as Side] ?? '-';
}

/** One feed log → a ticker line + a tone for its leading dot. */
function lineFor(eventName: string, args: Record<string, unknown>): { text: string; tone: string } | null {
  switch (eventName) {
    case 'Staked':
      return {
        text: `position #${String(args.tokenId ?? '?')} staked ${sideLabel(args.side)} in epoch #${String(args.epochId ?? '?')}`,
        tone: 'bg-brand',
      };
    case 'Claimed':
      return {
        text: `${short(args.owner)} claimed ${formatUSDC((args.payUSDC as bigint) ?? 0n)} USDC from epoch #${String(args.epochId ?? '?')}`,
        tone: 'bg-side-up',
      };
    case 'EpochStarted':
      return { text: `epoch #${String(args.epochId ?? '?')} started`, tone: 'bg-ink-faint' };
    case 'EpochResolved':
      return {
        text: `epoch #${String(args.epochId ?? '?')} resolved - ${sideLabel(args.winningSide)} wins`,
        tone: 'bg-side-up',
      };
    case 'EmptyWinnerRollover':
      return { text: `epoch #${String(args.epochId ?? '?')} pot rolled forward`, tone: 'bg-ink-faint' };
    case 'Unstaked':
      return { text: `position #${String(args.tokenId ?? '?')} unstaked`, tone: 'bg-ink-faint' };
    default:
      return null;
  }
}

export function Ticker() {
  const { events } = useActivityFeed();
  const items = events
    .map((e) => lineFor(e.eventName, e.args))
    .filter((x): x is { text: string; tone: string } => x !== null)
    .slice(0, 18);

  return (
    <div className="border-y border-line bg-surface/60">
      <div className="mx-auto flex max-w-[1440px] items-center gap-4 overflow-hidden px-4 py-2.5 sm:px-6">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
          <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-brand" aria-hidden="true" />
          Live on-chain
        </span>
        <div className="relative min-w-0 flex-1 overflow-hidden" aria-hidden={items.length === 0 ? undefined : 'false'}>
          {items.length === 0 ? (
            <p className="truncate font-mono text-[12px] text-ink-muted">
              Watching the chain - recent stakes, claims and settlements stream here.
            </p>
          ) : (
            <div className="landing-marquee">
              {[0, 1].map((copy) => (
                <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
                  {items.map((it, i) => (
                    <span
                      key={`${copy}-${i}`}
                      className="inline-flex items-center gap-2 whitespace-nowrap pr-10 font-mono text-[12px] text-ink-soft"
                    >
                      <span className={cn('h-1.5 w-1.5 rounded-full', it.tone)} aria-hidden="true" />
                      {it.text}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
