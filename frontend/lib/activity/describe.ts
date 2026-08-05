// lib/activity/describe.ts - PURE: turn a decoded ActivityEvent into a human sentence + tone for the
// Circle-powered arena activity feed. Mirrors lib/activityText `describeEvent` (the eth_getLogs feed) so
// both feeds read the same. No React/chain reads - fully unit-testable.
//
// Currency is keyed off the market's QUOTE symbol (USDC/EURC), NOT the label - a EURC/USDC market (base
// EURC, quote USDC) settles in USD even though its label contains "EURC".
import { Side } from '@/lib/types';
import { SIDE_LABELS } from '@/lib/side';
import { formatUSDC, formatPrice18 } from '@/lib/format';
import type { ActivityEvent } from '@/lib/activity/types';

export type ActivityTone = 'neutral' | 'up' | 'down' | 'range' | 'brand';

export interface ActivityDescription {
  text: string;
  tone: ActivityTone;
}

/** Short address "0xabcd…1234". "Someone" for a missing/blank address. */
function shortAddr(addr?: string): string {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'Someone';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function toneForSide(side?: number): ActivityTone {
  return side === Side.UP ? 'up' : side === Side.DOWN ? 'down' : side === Side.RANGE ? 'range' : 'neutral';
}

/** Settlement price (raw 18dp base units) → "$63,859" / "€59,120". Blank when absent/non-numeric. */
function priceText(finalPrice18: string | undefined, glyph: string): string {
  if (!finalPrice18 || !/^\d+$/.test(finalPrice18)) return ''; // never throw on a bad/odd value
  const n = Number(formatPrice18(BigInt(finalPrice18)));
  if (!Number.isFinite(n)) return '';
  return `${glyph}${n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 0 : 2 })}`;
}

/** Decode one ActivityEvent into a human sentence + tone. Never throws. */
export function describeActivity(ev: ActivityEvent): ActivityDescription {
  const tag = `#${ev.epochId}`;
  const eur = ev.quoteSymbol === 'EURC';
  const glyph = eur ? '€' : '$';
  const quoteToken = eur ? 'EURC' : 'USDC';

  switch (ev.kind) {
    case 'staked': {
      const label = SIDE_LABELS[(ev.side ?? Side.NONE) as Side] ?? 'NONE';
      return { text: `${shortAddr(ev.owner)} staked ${label} on epoch ${tag}`, tone: toneForSide(ev.side) };
    }
    case 'priceSubmitted': {
      const price = priceText(ev.finalPrice18, glyph);
      return { text: `Epoch ${tag} settlement price posted${price ? ` - ${price}` : ''}`, tone: 'brand' };
    }
    case 'settled': {
      const n = ev.winnerCount ?? 0;
      const w = `${n} qualifying position${n === 1 ? '' : 's'}`;
      const price = priceText(ev.finalPrice18, glyph);
      return { text: `Epoch ${tag} settled - ${w}${price ? ` · ${price}` : ''}`, tone: 'brand' };
    }
    case 'emptyRollover':
      return { text: `Epoch ${tag} had no winner - pot rolled forward`, tone: 'neutral' };
    case 'claimed': {
      const amt =
        ev.payUSDC && /^\d+$/.test(ev.payUSDC) && ev.payUSDC !== '0' ? `${formatUSDC(BigInt(ev.payUSDC))} ${quoteToken}` : '';
      const who = shortAddr(ev.owner);
      return { text: amt ? `${who} claimed ${amt} from epoch ${tag}` : `${who} claimed from epoch ${tag}`, tone: 'up' };
    }
    case 'epochCreated':
      return { text: `Epoch ${tag} opened`, tone: 'brand' };
    default:
      return { text: `Epoch ${tag}`, tone: 'neutral' };
  }
}
