import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '@/components/ThemeProvider';

// The app is DARK ONLY: there is no light mode, no localStorage/prefers-color-scheme branching, and
// no ThemeToggle. useTheme always resolves 'dark' and its setters are no-ops.

// A tiny probe so we can assert the resolved theme exposed by the hook.
function Probe() {
  const { theme, resolved, setTheme, toggle } = useTheme();
  return (
    <span
      data-testid="probe"
      data-theme={theme}
      data-resolved={resolved}
      data-has-setters={typeof setTheme === 'function' && typeof toggle === 'function' ? 'yes' : 'no'}
    >
      {resolved}
    </span>
  );
}

afterEach(() => {
  cleanup();
});

describe('ThemeProvider (dark-only)', () => {
  it('useTheme always resolves dark', () => {
    render(<Probe />);
    act(() => {});
    const probe = screen.getByTestId('probe');
    expect(probe.getAttribute('data-resolved')).toBe('dark');
    expect(probe.getAttribute('data-theme')).toBe('dark');
  });

  it('exposes no-op setTheme/toggle (callable, but theme stays dark)', () => {
    render(<Probe />);
    act(() => {});
    expect(screen.getByTestId('probe').getAttribute('data-has-setters')).toBe('yes');
    // Calling toggle/setTheme does not change the resolved theme.
    expect(screen.getByTestId('probe').getAttribute('data-resolved')).toBe('dark');
  });

  it('ThemeProvider renders its children', () => {
    render(
      <ThemeProvider>
        <span data-testid="child">hello</span>
      </ThemeProvider>,
    );
    act(() => {});
    expect(screen.getByTestId('child').textContent).toBe('hello');
  });
});
