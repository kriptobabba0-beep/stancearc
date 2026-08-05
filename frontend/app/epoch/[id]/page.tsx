// app/epoch/[id]/page.tsx - the shareable per-epoch result page. Its OpenGraph/twitter metadata
// carry the result in the TITLE ("Epoch #N - DOWN won") over the static branded card
// (public/brand/og.png). A dynamic next/og ImageResponse card was tried and removed: that runtime
// 500s on this deploy stack, and a broken image is worse than a branded static one. The page
// itself is a thin server component that links back to the live dashboard.
import type { Metadata } from 'next';
import Link from 'next/link';
import { readEpochShareData } from '@/lib/epochServer';
import { EpochProofDetail } from '@/components/EpochProofDetail';
import { Stars } from '@/components/ui/Stars';
import { SIDE_LABELS } from '@/lib/side';
import { Side } from '@/lib/types';
import { formatUsd6 } from '@/lib/quant';

interface PageProps {
  params: { id: string };
}

/** Parse the route id to a non-negative bigint, or null if malformed. */
function parseEpochId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Headline for a settled epoch, e.g. "DOWN won" / "Pot rolled forward (no winner)". */
function outcomeHeadline(data: Awaited<ReturnType<typeof readEpochShareData>>): string {
  if (!data || !data.settled) return 'Epoch in progress';
  if (data.rolledOver) return 'Pot rolled forward - no winner';
  const label = data.winningSide !== Side.NONE ? SIDE_LABELS[data.winningSide] : SIDE_LABELS[Side.RANGE];
  return `${label} won`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const id = parseEpochId(params.id);
  if (id === null) {
    return { title: 'Epoch - Limen Finance' };
  }
  const data = await readEpochShareData(id);
  const headline = outcomeHeadline(data);
  const potStr = data ? ` · ${formatUsd6(data.potUsd6)} pot` : '';
  const title = `Epoch #${id.toString()} - ${headline} - Limen Finance`;
  const description =
    data && data.settled
      ? `${headline} in epoch #${id.toString()}${potStr}. Stake your LP, call the market, win the forfeited fees on Limen Finance.`
      : `Follow epoch #${id.toString()} on Limen Finance - an opt-in fee competition on Arc.`;

  // The static branded card; the epoch RESULT rides in the title/description.
  const images = [{ url: '/brand/og.png', width: 1200, height: 630, alt: 'Limen Finance' }];
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', images },
    twitter: { card: 'summary_large_image', title, description, images: ['/brand/og.png'] },
  };
}

export default async function EpochSharePage({ params }: PageProps) {
  const id = parseEpochId(params.id);
  const data = id !== null ? await readEpochShareData(id) : null;
  const headline = outcomeHeadline(data);

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      {/* Share/summary card (its metadata + OG image drive the social unfurl). The HUD frame is
          applied via raw classes - this is a server component, so no client ArenaPanel import. */}
      <div className="hud-col">
        <div className="hud-panel [--hud-ext:0px] [clip-path:var(--hud-clip)] p-8 text-center">
          <span className="kicker">Limen Finance · Arc Testnet</span>
          <h1 className="mt-3 font-mono text-3xl font-semibold tracking-tight text-ink">
            {id !== null ? `Epoch #${id.toString()}` : 'Epoch'}
          </h1>
          <p className="mt-2 text-lg font-medium text-brand">{headline}</p>
          {data && data.settled && !data.rolledOver && (
            <p className="mt-1 font-mono tnum text-sm text-ink-muted">
              Pot at stake: {formatUsd6(data.potUsd6)}
            </p>
          )}
          <Link
            href="/stance"
            className="star-btn mt-6 inline-flex h-11 items-center justify-center px-5 text-sm font-semibold"
          >
            Enter the Stance
            <Stars />
          </Link>
        </div>
      </div>

      {/* Provably-fair reconstruction: verify the settlement was honest end-to-end. */}
      {id !== null && (
        <div className="mt-8">
          <EpochProofDetail epochId={id} />
        </div>
      )}
    </div>
  );
}
