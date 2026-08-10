import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const account = vi.hoisted(() => ({ connector: undefined as { id: string } | undefined }));
vi.mock('wagmi', () => ({ useAccount: () => ({ connector: account.connector }) }));
// Stub the connector module so the hook needs no env (lib/embedded/connector imports @/lib/chain).
vi.mock('@/lib/embedded/connector', () => ({ EMBEDDED_CONNECTOR_ID: 'circleEmbedded' }));

import { useIsEmbeddedWallet } from '@/hooks/useIsEmbeddedWallet';

afterEach(() => {
  account.connector = undefined;
});

describe('useIsEmbeddedWallet', () => {
  it('true only when the active connector IS the embedded one (write routes through Circle)', () => {
    account.connector = { id: 'circleEmbedded' };
    expect(renderHook(() => useIsEmbeddedWallet()).result.current).toBe(true);
  });

  it('false for the injected (MetaMask) connector', () => {
    account.connector = { id: 'injected' };
    expect(renderHook(() => useIsEmbeddedWallet()).result.current).toBe(false);
  });

  it('false when no wallet is connected', () => {
    account.connector = undefined;
    expect(renderHook(() => useIsEmbeddedWallet()).result.current).toBe(false);
  });
});
