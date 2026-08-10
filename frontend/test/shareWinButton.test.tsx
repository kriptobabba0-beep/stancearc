import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

// Mock the toast shim so the clipboard-fallback path doesn't need sonner's runtime.
// vi.hoisted keeps these mock fns above the hoisted vi.mock factory.
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: toastSuccess, error: toastError } }));

import { ShareWinButton } from '@/components/ShareWinButton';

const ORIGIN = 'https://fee-arena.vercel.app';

beforeEach(() => {
  vi.clearAllMocks();
  // Pin the origin for a deterministic share URL.
  Object.defineProperty(window, 'location', {
    value: { origin: ORIGIN },
    writable: true,
  });
});
afterEach(() => {
  cleanup();
  // Reset navigator.share capability between tests (redefine as undefined, configurable).
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
});

describe('ShareWinButton', () => {
  it('uses the native share sheet when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });

    render(<ShareWinButton epochId={7n} winningLabel="DOWN" usd6={1_234_000_000n} />);
    fireEvent.click(screen.getByTestId('share-win'));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const arg = share.mock.calls[0][0];
    expect(arg.url).toBe(`${ORIGIN}/epoch/7`);
    expect(arg.text).toBe('Epoch #7 — DOWN won. I earned $1,234 on Limen Finance.');
  });

  it('falls back to clipboard when navigator.share is unavailable', async () => {
    // No navigator.share defined → clipboard path.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ShareWinButton epochId={3n} winningLabel="UP" usd6={500_000_000n} />);
    fireEvent.click(screen.getByTestId('share-win'));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toBe(
      `Epoch #3 — UP won. I earned $500 on Limen Finance. ${ORIGIN}/epoch/3`,
    );
    expect(toastSuccess).toHaveBeenCalled();
  });
});
