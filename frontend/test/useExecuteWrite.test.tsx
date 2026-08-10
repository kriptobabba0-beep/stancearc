import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const writeMock = vi.hoisted(() => vi.fn(async () => '0xINJHASH'));
const circleMock = vi.hoisted(() => ({ address: '0x2222222222222222222222222222222222222222', executeContract: vi.fn() }));

vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111' }),
  useWriteContract: () => ({ writeContractAsync: writeMock }),
}));
vi.mock('@/lib/chain', () => ({
  ARC_CHAIN_ID: 5042002,
  arcTestnet: { id: 5042002 },
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
}));
vi.mock('@/components/circle/CircleWalletProvider', () => ({ useCircleWallet: () => circleMock }));

import { WalletModeProvider } from '@/components/circle/WalletModeProvider';
import { useActiveWallet, useExecuteWrite } from '@/hooks/useExecuteWrite';
import { useWalletMode } from '@/components/circle/WalletModeProvider';

const erc20 = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

const TOKEN = '0x4444444444444444444444444444444444444444' as const;
const RECIPIENT = '0x3333333333333333333333333333333333333333' as const;

function Consumer() {
  const { setMode } = useWalletMode();
  const aw = useActiveWallet();
  const { write } = useExecuteWrite();
  return (
    <div>
      <span data-testid="kind">{aw.kind}</span>
      <span data-testid="addr">{aw.address ?? ''}</span>
      <button data-testid="m-inj" onClick={() => setMode('injected')} />
      <button data-testid="m-emb" onClick={() => setMode('embedded')} />
      <button
        data-testid="w"
        onClick={() =>
          void write({ address: TOKEN, abi: erc20 as never, functionName: 'transfer', args: [RECIPIENT, 1_000_000n] }).catch(
            () => {},
          )
        }
      />
    </div>
  );
}

const renderIt = () =>
  render(
    <WalletModeProvider>
      <Consumer />
    </WalletModeProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  writeMock.mockClear();
  circleMock.executeContract.mockReset();
  circleMock.executeContract.mockResolvedValue({ challengeId: 'c' });
});
afterEach(cleanup);

describe('useActiveWallet + useExecuteWrite', () => {
  it('injected mode: reports the wagmi account and routes writes through writeContractAsync + gas floor', async () => {
    renderIt();
    fireEvent.click(screen.getByTestId('m-inj'));
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('injected'));
    expect(screen.getByTestId('addr').textContent).toBe('0x1111111111111111111111111111111111111111');
    fireEvent.click(screen.getByTestId('w'));
    await waitFor(() => expect(writeMock).toHaveBeenCalled());
    expect(writeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: 'transfer',
        maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      }),
    );
    expect(circleMock.executeContract).not.toHaveBeenCalled();
  });

  it('embedded mode: reports the Circle address and routes writes through executeContract (viem-encoded callData)', async () => {
    renderIt();
    fireEvent.click(screen.getByTestId('m-emb'));
    await waitFor(() => expect(screen.getByTestId('kind').textContent).toBe('embedded'));
    expect(screen.getByTestId('addr').textContent).toBe('0x2222222222222222222222222222222222222222');
    fireEvent.click(screen.getByTestId('w'));
    await waitFor(() => expect(circleMock.executeContract).toHaveBeenCalled());
    const arg = circleMock.executeContract.mock.calls[0][0];
    expect(arg.contractAddress).toBe(TOKEN);
    expect(arg.callData).toMatch(/^0xa9059cbb/); // transfer(address,uint256) selector
    expect(writeMock).not.toHaveBeenCalled();
  });
});
