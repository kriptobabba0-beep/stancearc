// app/campaign/page.tsx — the campaign index.
//
// While campaigns are closed this is a genuine 404, not a page saying "closed": a visitor who
// finds the URL gets the same answer as for any address we don't serve. Everything behind it keeps
// running, so nothing is lost while it is shut. The status itself is set in middleware, because
// notFound() alone changes the body but leaves a 200 on this runtime.
import { notFound } from 'next/navigation';
import { CAMPAIGN_PAGE_ENABLED } from '@/lib/campaignVisibility';
import { CampaignIndex } from '@/components/campaign/CampaignIndex';

export const dynamic = 'force-dynamic';

export default function CampaignsPage() {
  if (!CAMPAIGN_PAGE_ENABLED) notFound();
  return <CampaignIndex />;
}
