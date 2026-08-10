import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

// GatewayBridge: Circle Gateway instant cross-chain USDC onboarding. The component inlines the
// deposit + transfer orchestration (like BridgeUSDC) over the pure lib/gateway helpers. Tests mock
// wagmi + the lib's network functions (fetchUnifiedBalances/fetchExpirationHeight/submitTransfer),
// keeping the real pure builders/fee math.

const account = vi.hoisted(() => ({ address: '0x2B2B7f60644f4bc01bD15d38c36fCb2530efA27b', isConnected: true }));
const writeContractAsync = vi.hoisted(() => vi.fn(async (_args?: unknown) => '0xhash'));
const switchChainAsync = vi.hoisted(() => vi.fn(async () => ({})));
const signTypedDataAsync = vi.hoisted(() => vi.fn(async () => '0xusersig'));
const fetchUnifiedBalancesMock = vi.hoisted(() => vi.fn());
const fetchExpirationHeightMock = vi.hoisted(() => vi.fn(async () => 43_368_735n));
const submitTransferMock = vi.hoisted(() => vi.fn(async () => ({ attestation: '0xatt', signature: '0xgw' })));
const fetchDepositsMock = vi.hoisted(() => vi.fn());

vi.mock('wagmi', () => ({
  useAccount: () => account,
  useSwitchChain: () => ({ switchChainAsync }),
  useWriteContract: () => ({ writeContractAsync }),
  useSignTypedData: () => ({ signTypedDataAsync }),
}));
// The receipt every wait resolves with — per-test controllable so a REVERTED receipt and a
// mined-but-uncredited receipt can be exercised (the field-bug shape: "UI says completed, no USDC moved").
const receiptState = vi.hoisted(() => ({ current: { status: 'success', logs: [] as unknown[] } as Record<string, unknown> }));
const waitForReceiptMock = vi.hoisted(() => vi.fn(async (_cfg?: unknown, _args?: unknown) => receiptState.current));
// Chain reads the deposit flow confirms against (allowance / availableBalance) — the state-based
// proof that replaced hash-only confirmation.
const chainReads = vi.hoisted(() => ({ allowance: 0n, credit: 0n }));
const readContractMock = vi.hoisted(() =>
  vi.fn(async (_cfg: unknown, args: { functionName: string }) =>
    args.functionName === 'allowance' ? chainReads.allowance : chainReads.credit,
  ),
);
vi.mock('wagmi/actions', () => ({
  waitForTransactionReceipt: waitForReceiptMock,
  readContract: readContractMock,
}));
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
// lib/chain reads ENV at module load (NEXT_PUBLIC_* are unset in tests) — stub the bits we use.
vi.mock('@/lib/chain', () => ({
  withGasFloor: <T,>(r: T) => ({ ...r, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
  GAS_FLOOR_WEI: 20_000_000_000n,
  MAX_PRIORITY_FEE_WEI: 1_000_000_000n,
  arcTestnet: { id: 5042002 },
}));
vi.mock('@/lib/gateway', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/gateway')>();
  return {
    ...actual,
    fetchUnifiedBalances: fetchUnifiedBalancesMock,
    fetchExpirationHeight: fetchExpirationHeightMock,
    submitTransfer: submitTransferMock,
    fetchDeposits: fetchDepositsMock,
  };
});

import { encodeEventTopics, pad, toHex } from 'viem';
import { GatewayBridge } from '@/components/GatewayBridge';
import { GATEWAY_WALLET, gatewayWalletAbi } from '@/lib/gateway';

/** A real `Deposited` log, encoded the same way viem decodes it (no hardcoded topic hash). */
function depositedLog(args: { token: `0x${string}`; depositor: `0x${string}`; value: bigint }) {
  return {
    address: GATEWAY_WALLET,
    topics: encodeEventTopics({
      abi: gatewayWalletAbi,
      eventName: 'Deposited',
      args: { token: args.token, depositor: args.depositor, sender: args.depositor },
    }),
    data: pad(toHex(args.value), { size: 32 }),
  };
}

const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65' as const;
const DEPOSITOR = '0x2B2B7f60644f4bc01bD15d38c36fCb2530efA27b' as const;
/** The happy-path receipt for the "1 USDC into Fuji" deposit the tests drive. */
const successReceipt = () => ({
  status: 'success',
  logs: [depositedLog({ token: FUJI_USDC, depositor: DEPOSITOR, value: 1_000_000n })],
});

beforeEach(() => {
  account.address = '0x2B2B7f60644f4bc01bD15d38c36fCb2530efA27b';
  account.isConnected = true;
  writeContractAsync.mockClear();
  switchChainAsync.mockClear();
  signTypedDataAsync.mockClear();
  submitTransferMock.mockClear();
  // Default: Base Sepolia (domain 6) holds 2 USDC of unified balance, no in-flight deposits.
  fetchUnifiedBalancesMock.mockResolvedValue(new Map<number, bigint>([[6, 2_000_000n], [1, 0n], [0, 0n]]));
  fetchDepositsMock.mockReset();
  fetchDepositsMock.mockResolvedValue([]);
  waitForReceiptMock.mockClear();
  waitForReceiptMock.mockImplementation(async () => receiptState.current);
  receiptState.current = successReceipt();
  readContractMock.mockClear();
  // Default: no allowance yet, and the credit rises by the deposited amount once `deposit` is sent
  // (the mock below simulates the on-chain effect the flow now confirms against).
  chainReads.allowance = 0n;
  chainReads.credit = 0n;
  writeContractAsync.mockImplementation(async (args?: unknown) => {
    const fn = (args as { functionName?: string } | undefined)?.functionName;
    if (fn === 'approve') chainReads.allowance = 1_000_000n;
    if (fn === 'deposit') chainReads.credit += 1_000_000n;
    return '0xhash';
  });
});
afterEach(cleanup);

describe('GatewayBridge', () => {
  it('renders the panel', () => {
    render(<GatewayBridge />);
    expect(screen.getByTestId('gateway-bridge')).toBeTruthy();
  });

  it('shows a connect prompt when no wallet is connected', () => {
    account.isConnected = false;
    account.address = undefined as unknown as string;
    render(<GatewayBridge />);
    expect(screen.getByTestId('gateway-connect')).toBeTruthy();
  });

  it('shows the unified balance fetched from the Gateway API', async () => {
    render(<GatewayBridge />);
    await waitFor(() => expect(fetchUnifiedBalancesMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('gateway-balance-total').textContent).toContain('2.00'));
  });

  it('disables Sign & Mint and warns when the transfer amount is below the source minimum', async () => {
    render(<GatewayBridge />);
    await waitFor(() => expect(screen.getByTestId('gateway-balance-total').textContent).toContain('2.00'));
    // Base Sepolia min transfer = 0.02 USDC; 0.001 is below it.
    fireEvent.change(screen.getByTestId('gateway-transfer-amount'), { target: { value: '0.001' } });
    expect((screen.getByTestId('gateway-transfer-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('gateway-transfer-hint').textContent).toMatch(/minimum/i);
  });

  it('disables Sign & Mint and warns when the transfer amount exceeds the available balance', async () => {
    render(<GatewayBridge />);
    await waitFor(() => expect(screen.getByTestId('gateway-balance-total').textContent).toContain('2.00'));
    fireEvent.change(screen.getByTestId('gateway-transfer-amount'), { target: { value: '5' } });
    expect((screen.getByTestId('gateway-transfer-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('gateway-transfer-hint').textContent).toMatch(/exceeds|insufficient|available/i);
  });

  it('deposits: switches to the source chain, approves, then calls deposit', async () => {
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));
    await waitFor(() => expect(writeContractAsync).toHaveBeenCalledTimes(2));
    const calls = writeContractAsync.mock.calls.map((c) => c[0]) as Array<{ functionName: string; chainId: number }>;
    expect(calls[0].functionName).toBe('approve');
    expect(calls[1].functionName).toBe('deposit');
    // Default deposit source is the first source (Avalanche Fuji, chainId 43113).
    expect(switchChainAsync).toHaveBeenCalledWith({ chainId: 43113 });
    // Deposited event matched the connected address + amount, so the step may claim success.
    await waitFor(() => expect(screen.getByTestId('gateway-deposit-btn').textContent).toContain('Deposited'));
  });

  // ── The field bug, pinned: a deposit that REVERTS must never read as "Deposited" ───────────────
  // (Reported by another Arc developer: UI showed completed + a receipt, but no USDC left the wallet.
  // `deposit()` moves the USDC in the SAME transaction, so "no deduction" can only mean the tx failed.)
  it('a reverted deposit receipt surfaces an error and never shows "Deposited"', async () => {
    receiptState.current = { status: 'reverted', logs: [] };
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));

    await waitFor(() => expect(screen.getByTestId('gateway-error')).toBeTruthy());
    expect(screen.getByTestId('gateway-error').textContent).toMatch(/revert/i);
    expect(screen.getByTestId('gateway-deposit-btn').textContent).not.toContain('Deposited');
    // The approve reverted, so the deposit leg was never even attempted.
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
  });

  it('a mined deposit that credited nobody is reported, not celebrated', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Mined + status success, but no matching Deposited log AND no credit on chain — the shape of a
    // wrong-contract call. Neither signal can confirm, so the step must fail rather than celebrate.
    receiptState.current = { status: 'success', logs: [] };
    writeContractAsync.mockImplementation(async (args?: unknown) => {
      if ((args as { functionName?: string } | undefined)?.functionName === 'approve') chainReads.allowance = 1_000_000n;
      return '0xhash'; // deposit produces NO credit
    });
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));

    await vi.advanceTimersByTimeAsync(250_000); // ride out the state-confirmation window
    await waitFor(() => expect(screen.getByTestId('gateway-error')).toBeTruthy());
    expect(screen.getByTestId('gateway-error').textContent).toMatch(/not credited|explorer/i);
    expect(screen.getByTestId('gateway-deposit-btn').textContent).not.toContain('Deposited');
    vi.useRealTimers();
  });

  // ── Field report: the button stayed clickable after a successful deposit while reading
  // "Deposited", so a user checking whether it was stuck sent 4 x 20 USDC. A repeat deposit must be
  // a deliberate act (type a fresh amount), never a stray click on a finished step.
  it('after a successful deposit the button is disabled — a second click cannot re-deposit', async () => {
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));
    await waitFor(() => expect(screen.getByTestId('gateway-deposit-btn').textContent).toContain('Deposited'));

    const btn = screen.getByTestId('gateway-deposit-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // Even if a click lands anyway, no further approve/deposit pair goes out.
    fireEvent.click(btn);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
    expect(writeContractAsync).toHaveBeenCalledTimes(2); // still just the first approve + deposit
  });

  it('typing a new amount re-arms the deposit button', async () => {
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));
    await waitFor(() => expect((screen.getByTestId('gateway-deposit-btn') as HTMLButtonElement).disabled).toBe(true));

    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '2' } });
    const btn = screen.getByTestId('gateway-deposit-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Approve & Deposit'); // no longer claiming "Deposited"
  });

  it('a double click in the same tick sends only ONE deposit (synchronous latch)', async () => {
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    const btn = screen.getByTestId('gateway-deposit-btn');
    fireEvent.click(btn);
    fireEvent.click(btn); // before React can re-render with disabled=true
    await waitFor(() => expect(screen.getByTestId('gateway-deposit-btn').textContent).toContain('Deposited'));
    expect(writeContractAsync).toHaveBeenCalledTimes(2); // one approve + one deposit, not four calls
  });

  // ── Field report (EIP-7702 smart account + relayer): the deposit CREDITED 25 USDC on-chain, but the
  // hash returned to the dApp never appeared, so a hash-only wait sat "Depositing…" for 45 minutes.
  // Confirmation now reads the CREDIT, so the flow completes on the truth rather than on the hash.
  it('confirms a deposit whose returned hash never appears (relayer submitted a different one)', async () => {
    // The receipt for the returned hash is never found — exactly what a relayer/7702 wallet produces.
    waitForReceiptMock.mockImplementation(async () => {
      throw new Error('Timed out while waiting for transaction to be confirmed.');
    });
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));

    // The credit read (set by the write mock) proves it landed, so the step completes anyway.
    await waitFor(() => expect(screen.getByTestId('gateway-deposit-btn').textContent).toContain('Deposited'), {
      timeout: 5_000,
    });
    expect(screen.queryByTestId('gateway-error')).toBeNull();
  });

  it('reports failure when neither the receipt nor the credit ever confirms', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    waitForReceiptMock.mockImplementation(async () => {
      throw new Error('Timed out while waiting for transaction to be confirmed.');
    });
    // The write goes out but produces NO on-chain effect: allowance rises (approve) but no credit.
    writeContractAsync.mockImplementation(async (args?: unknown) => {
      if ((args as { functionName?: string } | undefined)?.functionName === 'approve') chainReads.allowance = 1_000_000n;
      return '0xhash';
    });
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));

    await vi.advanceTimersByTimeAsync(250_000);
    await waitFor(() => expect(screen.getByTestId('gateway-error')).toBeTruthy());
    expect(screen.getByTestId('gateway-deposit-btn').textContent).not.toContain('Deposited');
    vi.useRealTimers();
  });

  it('every receipt wait carries a timeout (wagmi defaults to waiting forever)', async () => {
    render(<GatewayBridge />);
    fireEvent.change(screen.getByTestId('gateway-deposit-amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('gateway-deposit-btn'));
    await waitFor(() => expect(waitForReceiptMock).toHaveBeenCalledTimes(2));
    for (const call of waitForReceiptMock.mock.calls) {
      const args = call[1] as { timeout?: number };
      expect(typeof args.timeout).toBe('number');
      expect(args.timeout).toBeGreaterThan(0);
    }
  });

  it('shows a live finality tracker for an in-flight (pending) deposit', async () => {
    fetchDepositsMock.mockResolvedValue([
      {
        transactionHash: '0xdead',
        domain: 6, // Base Sepolia
        amount: 5_000_000n,
        status: 'pending',
        blockHeight: 1n,
        blockTimestampMs: Date.now() - 60_000, // 1 min in → "confirming"
      },
    ]);
    render(<GatewayBridge />);
    await waitFor(() => expect(screen.getByTestId('gateway-pending')).toBeTruthy());
    const item = screen.getByTestId('gateway-pending-item');
    expect(item.textContent).toContain('Base Sepolia');
    expect(item.textContent).toContain('5.00');
    expect(item.textContent).toMatch(/confirming/i);
  });

  it('shows an explainer (not a blank "lost balance") when connected with nothing yet', async () => {
    fetchUnifiedBalancesMock.mockResolvedValue(new Map<number, bigint>());
    fetchDepositsMock.mockResolvedValue([]);
    render(<GatewayBridge />);
    await waitFor(() => expect(screen.getByTestId('gateway-empty')).toBeTruthy());
    expect(screen.getByTestId('gateway-empty').textContent).toMatch(/updates live|come back/i);
  });
});
