import { describe, it, expect } from 'vitest';
import { SITE_TITLE, SITE_DESCRIPTION, SITE_NAME } from '@/lib/seo';

// The link-preview copy must stay ORIGINAL — it must never name another protocol (the user
// explicitly does not want "Uniswap" anywhere public-facing) and should describe Limen Finance's mechanic.
describe('site SEO copy (link preview / OpenGraph)', () => {
  it('never names another protocol (no "Uniswap")', () => {
    expect(SITE_TITLE).not.toMatch(/uniswap/i);
    expect(SITE_DESCRIPTION).not.toMatch(/uniswap/i);
  });

  it('is branded and specific to Limen Finance', () => {
    expect(SITE_NAME).toBe('Limen Finance');
    expect(SITE_TITLE).toContain('Limen Finance');
    expect(SITE_DESCRIPTION).toMatch(/UP, DOWN, or RANGE/);
    expect(SITE_DESCRIPTION).toMatch(/forfeited trading fees/);
  });
});
