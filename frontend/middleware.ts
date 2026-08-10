// middleware.ts — the one place that can set a response status before a page renders.
//
// It exists for a single job: making the closed campaign route answer with a real 404. The page
// already refuses to render (see lib/campaignVisibility.ts), but notFound() on this runtime
// changes the body while the status stays 200, and a 200 is what a crawler indexes.
//
// The matcher below is the important part. Middleware normally runs on every request, which is
// a lot of new surface for a status code, so this one is pinned to the single path it is for —
// nothing else on the site is routed through this file.
import { NextResponse } from 'next/server';
import { CAMPAIGN_PAGE_ENABLED } from '@/lib/campaignVisibility';

export function middleware(): NextResponse {
  if (CAMPAIGN_PAGE_ENABLED) return NextResponse.next();
  return new NextResponse(null, { status: 404 });
}

export const config = {
  matcher: ['/campaign', '/campaign/:path*'],
};
