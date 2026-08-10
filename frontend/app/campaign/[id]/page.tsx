// app/campaign/[id]/page.tsx — one campaign's standings.
//
// Named in the URL rather than read from a pointer, so a finished campaign stays linkable after
// the next one starts. Gated by the same flag as the index; see lib/campaignVisibility.ts.
import { notFound } from 'next/navigation';
import { CAMPAIGN_PAGE_ENABLED } from '@/lib/campaignVisibility';
import { CampaignStandings } from '@/components/campaign/CampaignStandings';

export const dynamic = 'force-dynamic';

export default async function CampaignDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!CAMPAIGN_PAGE_ENABLED) notFound();
  const { id } = await params;
  return <CampaignStandings id={id} />;
}
