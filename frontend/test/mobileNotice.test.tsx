// Informational only: phones are told desktop is smoother, and nothing about the app is withheld
// from them. A wallet's in-app browser is often someone's only route to the site.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MobileNotice } from '@/components/MobileNotice';

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('MobileNotice', () => {
  it('says desktop is better, and says only that', () => {
    render(<MobileNotice />);
    expect(screen.getByTestId('mobile-notice').textContent).toMatch(/^Limen works best on desktop\./);
  });

  // It has to survive scrolling, and it must not land on the header: NavBar is sticky at top-0, so
  // anything else pinned to the top would cover the nav on the very screens that need it.
  it('is pinned to the bottom, clear of the sticky header', () => {
    render(<MobileNotice />);
    const cls = screen.getByTestId('mobile-notice').className;
    expect(cls).toContain('fixed');
    expect(cls).toContain('bottom-0');
    expect(cls).not.toContain('top-0');
  });

  it('is hidden on anything wider than a phone by CSS, not by a JS width check', () => {
    // A JS check reads a width the server never had, which desynchronises the first client render.
    render(<MobileNotice />);
    expect(screen.getByTestId('mobile-notice').className).toContain('sm:hidden');
  });

  it('stays dismissed once dismissed', () => {
    render(<MobileNotice />);
    fireEvent.click(screen.getByTestId('mobile-notice-dismiss'));
    expect(screen.queryByTestId('mobile-notice')).toBeNull();

    cleanup();
    render(<MobileNotice />);
    expect(screen.queryByTestId('mobile-notice')).toBeNull();
  });

  it('never blocks anything: a strip, not a full-screen overlay', () => {
    render(<MobileNotice />);
    const note = screen.getByTestId('mobile-notice');
    expect(note.getAttribute('role')).toBe('note');
    // inset-x-0 is fine (full width); inset-0 would cover the page.
    expect(note.className).not.toContain('inset-0 ');
    expect(note.className).not.toMatch(/h-(screen|full)/);
  });
});
