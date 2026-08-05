// lib/activityText.ts - PURE decoders that turn a raw FeeArena event log into a human sentence
// ("0xab… staked UP on epoch #42", "Epoch #7 settled - DOWN won", "0xcd… claimed 1.2 USDC …") plus
// a relative-time helper for the activity feed. No React, no chain reads - fully unit-testable.
//
// Amounts are formatted (never math'd) via lib/format; the base leg uses the active market's
// symbol/decimals passed in `ctx`, defaulting to the legacy WETH 18dp so a missing ctx degrades safely.
import { Side } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { formatUSDC, formatBase } from '@/lib/format';
import type { FeedLog } from '@/lib/events';

/** Tone for the sentence (mirrors the Side accent tones used across the UI). */
export type ActivityTone = 'neutral' | 'up' | 'down' | 'range' | 'brand';

export interface ActivityDescription {
  text: string;
  tone: ActivityTone;
}

/** Per-market context for amount formatting (base leg symbol/decimals). Optional - defaults to WETH. */
export interface ActivityContext {
  baseSymbol?: string;
  baseDecimals?: number;
}

const arg = (log: FeedLog, key: string): unknown => log.args?.[key];

/** Short address "0xabcd…1234". Returns "Someone" for a missing/blank address. */
function shortAddr(addr: unknown): string {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'Someone';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** epochId arg → "#N" (defensive: blank when absent). */
function epochTag(log: FeedLog): string {
  const id = arg(log, 'epochId');
  return id === undefined || id === null ? '' : `#${String(id)}`;
}

/** Side arg → label + tone. */
function sideOf(log: FeedLog): { label: string; tone: ActivityTone } {
  const side = Number(arg(log, 'winningSide') ?? arg(log, 'side') ?? 0) as Side;
  const tone: ActivityTone =
    side === Side.UP ? 'up' : side === Side.DOWN ? 'down' : side === Side.RANGE ? 'range' : 'neutral';
  const label = side !== Side.NONE ? SIDE_LABELS[side] : SIDE_LABELS[Side.RANGE];
  return { label, tone };
}

/** Format a Claimed payout's legs as "0.001 cirBTC + 1.2 USDC" (omit zero legs). */
function payoutText(log: FeedLog, ctx: ActivityContext): string {
  const payBase = (arg(log, 'payWETH') as bigint) ?? 0n;
  const payUSDC = (arg(log, 'payUSDC') as bigint) ?? 0n;
  const parts: string[] = [];
  if (payBase > 0n) {
    parts.push(`${formatBase(payBase, ctx.baseDecimals ?? 18)} ${ctx.baseSymbol ?? 'WETH'}`);
  }
  if (payUSDC > 0n) parts.push(`${formatUSDC(payUSDC)} USDC`);
  return parts.join(' + ');
}

/**
 * Decode one FeeArena event log into a human sentence + tone. Unknown events degrade to their raw
 * name with a neutral tone (never throws). Pure - `ctx` only affects amount formatting.
 */
export function describeEvent(log: FeedLog, ctx: ActivityContext = {}): ActivityDescription {
  const tag = epochTag(log);
  switch (log.eventName) {
    case 'Staked': {
      const { label, tone } = sideOf(log);
      return { text: `${shortAddr(arg(log, 'owner'))} staked ${label} on epoch ${tag}`, tone };
    }
    case 'EpochStarted':
      return { text: `Epoch ${tag} started`, tone: 'brand' };
    case 'EpochSettled': {
      const { label, tone } = sideOf(log);
      return { text: `Epoch ${tag} settled - ${label} won`, tone };
    }
    case 'EpochResolved': {
      const { label, tone } = sideOf(log);
      return { text: `Epoch ${tag} resolved - ${label} won`, tone };
    }
    case 'EmptyWinnerRollover':
      return { text: `Epoch ${tag} had no winner - pot rolled forward`, tone: 'neutral' };
    case 'Claimed': {
      const amount = payoutText(log, ctx);
      const who = shortAddr(arg(log, 'owner'));
      const text = amount
        ? `${who} claimed ${amount} from epoch ${tag}`
        : `${who} claimed from epoch ${tag}`;
      return { text, tone: 'up' };
    }
    case 'Unstaked':
      return { text: `${shortAddr(arg(log, 'owner'))} withdrew their position from epoch ${tag}`, tone: 'neutral' };
    case 'Swept': {
      const tid = arg(log, 'tokenId');
      return {
        text: `Position #${tid === undefined ? '?' : String(tid)} swept into epoch ${tag}`,
        tone: 'neutral',
      };
    }
    default:
      return { text: log.eventName, tone: 'neutral' };
  }
}

/**
 * Relative time from a (chain-time) seconds timestamp to `now` (seconds): "just now", "2m ago",
 * "3h ago", "5d ago". A future or sub-minute delta clamps to "just now". Undefined → "" (unknown).
 * Pure (takes `now`) so it's testable without a clock.
 */
export function relativeTime(thenSec: bigint | undefined, nowSec: bigint): string {
  if (thenSec === undefined) return '';
  const delta = nowSec - thenSec;
  if (delta < 60n) return 'just now';
  const mins = delta / 60n;
  if (mins < 60n) return `${mins}m ago`;
  const hours = mins / 60n;
  if (hours < 24n) return `${hours}h ago`;
  const days = hours / 24n;
  return `${days}d ago`;
}
