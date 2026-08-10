import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

// The bridge page composes two heavy children (each pulls wagmi/env); stub them so this test
// covers only the method-toggle behaviour.
vi.mock('@/components/BridgeUSDC', () => ({ BridgeUSDC: () => <div data-testid="bridge-usdc" /> }));
vi.mock('@/components/GatewayBridge', () => ({ GatewayBridge: () => <div data-testid="gateway-bridge" /> }));

import BridgePage from '@/app/bridge/page';

afterEach(cleanup);

describe('BridgePage method toggle', () => {
  it('defaults to the Standard (CCTP) method', () => {
    render(<BridgePage />);
    expect(screen.getByTestId('bridge-usdc')).toBeTruthy();
    expect(screen.queryByTestId('gateway-bridge')).toBeNull();
  });

  it('switches to the Instant (Gateway) method when its tab is clicked', () => {
    render(<BridgePage />);
    expect(screen.getByTestId('bridge-method-gateway').textContent).toMatch(/instant \(gateway\)/i);
    fireEvent.click(screen.getByTestId('bridge-method-gateway'));
    expect(screen.getByTestId('gateway-bridge')).toBeTruthy();
    expect(screen.queryByTestId('bridge-usdc')).toBeNull();
    // …and back to CCTP.
    fireEvent.click(screen.getByTestId('bridge-method-cctp'));
    expect(screen.getByTestId('bridge-usdc')).toBeTruthy();
    expect(screen.queryByTestId('gateway-bridge')).toBeNull();
  });
});
