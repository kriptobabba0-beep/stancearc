// lib/seo.ts — the public-facing site metadata used for link previews (OpenGraph / Twitter cards)
// and the document <title>/<meta description>. Kept ORIGINAL and specific to Limen Finance — it must
// never name another protocol. This is the single source of truth the root layout reads.
export const SITE_URL = 'https://limen.finance';
export const SITE_NAME = 'Limen Finance';
// Plain hyphens in titles on purpose (user call): the em dash reads as machine-written.
export const SITE_TITLE = 'Limen Finance - opt-in fee settlement for Arc LPs';
export const SITE_DESCRIPTION =
  'Provide liquidity, then enter an epoch with an UP, DOWN, or RANGE stance. At settlement, ' +
  'qualifying positions share the epoch fee pool funded by non-qualifying positions’ forfeited ' +
  'trading fees. LP principal stays intact.';
