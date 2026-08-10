import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SiteFooter } from '@/components/SiteFooter';

afterEach(cleanup);

describe('SiteFooter', () => {
  // The testnet notice is a legal disclosure, not decoration: it has to survive future footer
  // edits, so its three load-bearing claims are asserted individually rather than as one blob.
  it('carries the standing testnet notice', () => {
    render(<SiteFooter />);
    expect(screen.getByText(/only on Arc Testnet for testing and demonstration/)).toBeTruthy();
    expect(screen.getByText(/no monetary value/)).toBeTruthy();
    expect(screen.getByText(/no real funds, prizes, or financial returns are involved/)).toBeTruthy();
  });

  it('still renders the legal links and the live X account alongside it', () => {
    render(<SiteFooter />);
    expect(screen.getByText('Terms').getAttribute('href')).toBe('/terms');
    expect(screen.getByText('Privacy').getAttribute('href')).toBe('/privacy');
    expect(screen.getByLabelText('Limen Finance on X').getAttribute('href')).toBe(
      'https://x.com/LimenFinance',
    );
  });
});
