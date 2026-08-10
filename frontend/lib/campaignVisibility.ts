// lib/campaignVisibility.ts — one switch for whether the campaign page is public.
//
// Kept as a shared constant rather than an environment variable so the page, its sub-routes and
// the nav link can never disagree: a page with no link is invisible, a link to a closed page is a
// dead end, and middleware answering 404 for a page that renders would be worse than either.
//
// Setting this to false closes the whole surface again without losing anything: the keeper goes
// on indexing and publishing and /api/campaign goes on answering, so no history is lost and
// nothing has to be rebuilt to reopen it.
export const CAMPAIGN_PAGE_ENABLED = false;
