'use client';

// components/TokenGlyph.tsx - small round token avatars shared across the app (the Swap card, the Pool
// positions, the arena rails). Each token wears its REAL brand coin artwork (inline SVG from
// components/ui/TokenArt): cirBTC's purple→blue gradient ₿-mark, and the Circle-blue USDC/EURC coins -
// the same marks as the wallet's token list, applied everywhere. Crisp at any size, theme-neutral, no
// image assets, CSP-safe. TokenPairGlyph overlaps any two tokens the way Uniswap renders a pool's pair.
import { cn } from '@/lib/cn';
import { tokenArtFor } from '@/components/ui/TokenArt';

/** A single round token glyph - the token's real coin art. Size via className. */
export function TokenGlyph({ symbol, className }: { symbol: string; className?: string }) {
  const Art = tokenArtFor(symbol);
  return (
    <span aria-hidden="true" className={cn('block shrink-0 overflow-hidden rounded-full', className ?? 'h-6 w-6')}>
      <Art className="h-full w-full" />
    </span>
  );
}

/**
 * Overlapping pair avatar (first coin in front, second behind) - the way Uniswap renders a pool's two
 * tokens on the Pool page. The back coin gets a surface ring so the overlap reads cleanly on any card.
 * `quoteSymbol` defaults to USDC for back-compat with existing single-quote call sites.
 */
export function TokenPairGlyph({ baseSymbol, quoteSymbol = 'USDC' }: { baseSymbol: string; quoteSymbol?: string }) {
  return (
    <span aria-hidden="true" className="flex shrink-0 items-center">
      <TokenGlyph symbol={baseSymbol} className="z-10 h-8 w-8 text-[13px] ring-2 ring-surface" />
      <TokenGlyph symbol={quoteSymbol} className="-ml-3 h-8 w-8 text-[13px] ring-2 ring-surface" />
    </span>
  );
}
