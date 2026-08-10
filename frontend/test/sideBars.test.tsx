import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SideBars } from '@/components/SideBars';
import { Side } from '@/lib/types';

afterEach(cleanup);

describe('SideBars', () => {
  it('renders staked depth bars for UP/DOWN/RANGE and no projection', () => {
    render(<SideBars sideContribution6={[0n, 8000_000000n, 6000_000000n, 4000_000000n]} />);
    expect(screen.getByTestId(`bar-${Side.UP}`)).toBeTruthy();
    expect(screen.getByTestId(`bar-${Side.DOWN}`)).toBeTruthy();
    expect(screen.getByTestId(`bar-${Side.RANGE}`)).toBeTruthy();
    expect(screen.getByText(/hidden until the epoch settles/)).toBeTruthy();
    // Values rendered as plain integers (no $ prefix — this is liquidity, not USDC money).
    expect(screen.getByText('8,000,000,000')).toBeTruthy();
    expect(screen.getByText('6,000,000,000')).toBeTruthy();
    expect(screen.getByText('4,000,000,000')).toBeTruthy();
  });
});
