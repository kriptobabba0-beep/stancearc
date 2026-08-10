'use client';

// components/agent/PayCard.tsx — the copilot's pay-per-message card (Circle x402 / Gateway).
//
// Appears when the chat API answers 402 (free daily quota exhausted, billing enabled). The
// user pays from their Circle Gateway balance with a SIGNATURE ONLY — an EIP-3009 transfer
// authorization that Circle's facilitator verifies and settles in batches, gasless. If the
// Gateway balance is short, a one-time on-chain deposit (approve + deposit) funds it; after
// that every message is a single wallet signature. Nothing is charged without the user's
// explicit click — the same consent rule as every other copilot action.
import { useCallback, useEffect, useState } from 'react';
import { useAccount, usePublicClient, useSignTypedData } from 'wagmi';
import { erc20Abi, formatUnits, maxUint256, parseUnits } from 'viem';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { USDC } from '@/lib/tokens';
import { friendlyError } from '@/lib/errors';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';
import {
  GATEWAY_WALLET,
  gatewayWalletAbi,
  pickPaymentOption,
  buildAuthorization,
  gatewayTypedData,
  buildPaymentHeader,
  type Payment402,
} from '@/lib/agent/x402Client';

// A deposit funds ~100 messages at the default price so the top-up is a rare event.
const MIN_DEPOSIT_USDC = '1';

export function PayCard({
  payment,
  onPaid,
  onDismiss,
}: {
  payment: Payment402;
  /** Called with the signed Payment-Signature header — the chat retries with it. */
  onPaid: (header: string) => void;
  onDismiss: () => void;
}) {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { writeContractAsync } = useArcWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  const [available, setAvailable] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<'idle' | 'depositing' | 'signing'>('idle');
  const [failed, setFailed] = useState<string | null>(null);

  const option = pickPaymentOption(payment, arcTestnet.id);
  const price = option !== null ? BigInt(option.amount) : 0n;

  const refreshBalance = useCallback(async () => {
    if (!publicClient || !address) return;
    try {
      const bal = (await publicClient.readContract({
        address: GATEWAY_WALLET,
        abi: gatewayWalletAbi,
        functionName: 'availableBalance',
        args: [USDC.address, address],
      })) as bigint;
      setAvailable(bal);
    } catch {
      setAvailable(null); // unknown — the pay attempt itself is still the source of truth
    }
  }, [publicClient, address]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const deposit = async () => {
    if (!publicClient || !address) return;
    setFailed(null);
    setBusy('depositing');
    try {
      const amount = parseUnits(MIN_DEPOSIT_USDC, USDC.decimals);
      const allowance = (await publicClient.readContract({
        address: USDC.address,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [address, GATEWAY_WALLET],
      })) as bigint;
      if (allowance < amount) {
        const { request } = await publicClient.simulateContract({
          account: address,
          address: USDC.address,
          abi: erc20Abi,
          functionName: 'approve',
          args: [GATEWAY_WALLET, maxUint256],
        });
        const tx = await writeContractAsync(withGasFloor(request) as Parameters<typeof writeContractAsync>[0]);
        await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
      }
      const { request } = await publicClient.simulateContract({
        account: address,
        address: GATEWAY_WALLET,
        abi: gatewayWalletAbi,
        functionName: 'deposit',
        args: [USDC.address, amount],
      });
      const tx = await writeContractAsync(withGasFloor(request) as Parameters<typeof writeContractAsync>[0]);
      await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
      await refreshBalance();
    } catch (err) {
      setFailed(friendlyError(err));
    } finally {
      setBusy('idle');
    }
  };

  const payAndSend = async () => {
    if (!address || option === null) return;
    setFailed(null);
    setBusy('signing');
    try {
      const authorization = buildAuthorization(address, option);
      const signature = await signTypedDataAsync(gatewayTypedData(option, authorization));
      onPaid(
        buildPaymentHeader({
          x402Version: payment.x402Version ?? 2,
          authorization,
          signature,
          resource: payment.resource,
          accepted: option,
        }),
      );
    } catch (err) {
      setFailed(friendlyError(err));
    } finally {
      setBusy('idle');
    }
  };

  const priceLabel = option !== null ? `$${formatUnits(price, USDC.decimals)}` : null;
  const hasFunds = available !== null && available >= price;

  return (
    <div data-testid="agent-pay-card" className="mt-3 rounded-2xl border border-brand/35 bg-surface px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <span className="kicker font-mono text-brand">Pay per message · Circle x402</span>
        {priceLabel && (
          <span className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-xs font-bold text-ink">
            {priceLabel} USDC
          </span>
        )}
      </div>

      <p className="mt-2 text-[14px] leading-relaxed text-ink-soft">
        {payment.error ?? 'Your free daily messages are used up.'} Paying is a single wallet signature — gasless, settled in
        batches by Circle Gateway from your Gateway USDC balance.
      </p>

      {option === null ? (
        <p className="mt-2 font-mono text-[12.5px] text-side-down">
          No payment option for this network was offered — try again later.
        </p>
      ) : (
        <>
          <p className="mt-2 font-mono text-[12.5px] text-ink-muted">
            Gateway balance:{' '}
            {available === null ? 'unknown' : `$${formatUnits(available, USDC.decimals)} USDC`}
            {!hasFunds && available !== null && ` — deposit $${MIN_DEPOSIT_USDC} once to cover ~100 messages.`}
          </p>
          {failed && <p className="mt-2 font-mono text-[12.5px] text-side-down">Failed: {failed}</p>}
          <div className="mt-3 flex items-center gap-2">
            {hasFunds || available === null ? (
              <button
                type="button"
                onClick={() => void payAndSend()}
                disabled={busy !== 'idle' || !address}
                className="rounded-lg bg-brand px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy === 'signing' ? 'Waiting for signature…' : `Pay ${priceLabel} & send`}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void deposit()}
                disabled={busy !== 'idle' || !address}
                className="rounded-lg bg-brand px-4 py-2 font-mono text-[13px] font-bold uppercase tracking-wide text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy === 'depositing' ? 'Depositing…' : `Deposit $${MIN_DEPOSIT_USDC} to Gateway`}
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              disabled={busy !== 'idle'}
              className="rounded-lg border border-line px-4 py-2 font-mono text-[13px] font-semibold uppercase tracking-wide text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              Not now
            </button>
          </div>
        </>
      )}
    </div>
  );
}
