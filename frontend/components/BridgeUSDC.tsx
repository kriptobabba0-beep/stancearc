'use client';

// components/BridgeUSDC.tsx - "Bridge USDC to Arc" panel.
// CCTP V2 onboarding: source testnet (Base / Ethereum Sepolia) -> Arc, via burn -> Iris attestation -> mint.
//   Step 1  Approve & Burn on {source}: switchChain -> approve(USDC -> source TokenMessengerV2) ->
//           depositForBurn(destinationDomain=26, mintRecipient=bytes32(you)); capture burn tx + MessageSent message.
//   Step 2  Awaiting Circle attestation: pollAttestation(srcDomain, burnTx) until status=complete.
//   Step 3  Mint on Arc: switchChain to Arc -> receiveMessage(message, attestation).
//
// Renders without a connected/source wallet (form + connect prompt), so the dashboard e2e still boots.
// The full round-trip needs source-chain testnet USDC (see the note in the footer).

import { useMemo, useState } from 'react';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { waitForTransactionReceipt } from 'wagmi/actions';
import { parseUnits, formatUnits } from 'viem';
import { erc20Abi } from '@/abis';
import { wagmiConfig } from '@/lib/wagmi';
import { GAS_FLOOR_WEI } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import {
  ARC,
  SOURCES,
  sourceByKey,
  depositForBurnAbi,
  receiveMessageAbi,
  buildDepositForBurnArgs,
  messageFromReceipt,
  pollAttestation,
  quoteMaxFee,
  toBytes32,
  USDC_DECIMALS,
  FINALITY_FAST,
  type AttestationResult,
  type CctpChain,
} from '@/lib/cctp';
/** Arc testnet gas-fee floor (same values used by useAdminCranks). */
const MAX_FEE_PER_GAS_ARC = GAS_FLOOR_WEI; // 20 Gwei
const MAX_PRIORITY_FEE_ARC = 1_000_000_000n; // 1 Gwei

import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Wallet, External, Spinner, Check, Info, ArrowDown } from '@/components/ui/icons';

type StepState = 'idle' | 'pending' | 'done' | 'error';

function StepBadge({ n, state }: { n: number; state: StepState }) {
  if (state === 'done') {
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-side-up text-white">
        <Check className="h-4 w-4" />
      </span>
    );
  }
  if (state === 'pending') {
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand text-white">
        <Spinner className="h-4 w-4" />
      </span>
    );
  }
  const tone = state === 'error' ? 'bg-side-down text-white' : 'bg-surface-muted text-ink-soft';
  return (
    <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold ${tone}`}>
      {n}
    </span>
  );
}

function TxLink({ chain, hash, label }: { chain: CctpChain; hash: `0x${string}`; label: string }) {
  return (
    <a
      href={`${chain.explorer}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
    >
      {label}
      <External className="h-3 w-3" />
    </a>
  );
}

export function BridgeUSDC() {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [sourceKey, setSourceKey] = useState<string>(SOURCES[0].key);
  const [amount, setAmount] = useState<string>('1');

  // Step state
  const [burnState, setBurnState] = useState<StepState>('idle');
  const [attestState, setAttestState] = useState<StepState>('idle');
  const [mintState, setMintState] = useState<StepState>('idle');

  const [burnHash, setBurnHash] = useState<`0x${string}`>();
  const [mintHash, setMintHash] = useState<`0x${string}`>();
  const [message, setMessage] = useState<`0x${string}`>();
  const [attestation, setAttestation] = useState<AttestationResult>();
  const [attestStatus, setAttestStatus] = useState<string>('');
  const [error, setError] = useState<string>();

  const source = useMemo(() => sourceByKey(sourceKey) ?? SOURCES[0], [sourceKey]);

  const parsedAmount = useMemo(() => {
    try {
      if (!amount || Number(amount) <= 0) return undefined;
      return parseUnits(amount, USDC_DECIMALS);
    } catch {
      return undefined;
    }
  }, [amount]);

  const busy = burnState === 'pending' || attestState === 'pending' || mintState === 'pending';

  function resetFlow() {
    setBurnState('idle');
    setAttestState('idle');
    setMintState('idle');
    setBurnHash(undefined);
    setMintHash(undefined);
    setMessage(undefined);
    setAttestation(undefined);
    setAttestStatus('');
    setError(undefined);
  }

  // ── Step 1: switch to source, approve, depositForBurn ───────────────────────────
  async function runBurn() {
    if (!address || !parsedAmount) return;
    setError(undefined);
    setBurnState('pending');
    try {
      await switchChainAsync({ chainId: source.chainId });

      // Exact-amount approval of USDC to the source TokenMessengerV2.
      const approveHash = await writeContractAsync({
        chainId: source.chainId,
        address: source.usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [source.tokenMessengerV2, parsedAmount],
      });
      await waitForTransactionReceipt(wagmiConfig, { chainId: source.chainId, hash: approveHash });

      // Quote the Fast Transfer fee from Iris before burning.
      // A Fast Transfer requires maxFee >= the minimum fast fee; passing 0 silently degrades to
      // Standard (~15-20 min) and the 5-min attestation poll times out. Fail loud instead.
      const maxFee = await quoteMaxFee(source.domain, ARC.domain, parsedAmount);

      // Burn: destinationDomain pinned to Arc (26), recipient = connected address as bytes32.
      const args = buildDepositForBurnArgs({
        amount: parsedAmount,
        mintRecipient: toBytes32(address),
        burnToken: source.usdc,
        maxFee,
        minFinalityThreshold: FINALITY_FAST,
      });
      // Circle CCTP V2 burn - call TokenMessengerV2.depositForBurn (0x8FE6B999…2542DAA, deterministic across
      // testnets) to burn USDC on the source chain; destinationDomain=26 routes the cross-chain mint to Arc.
      const burn = await writeContractAsync({
        chainId: source.chainId,
        address: source.tokenMessengerV2,
        abi: depositForBurnAbi,
        functionName: 'depositForBurn',
        args,
      });
      setBurnHash(burn);

      const receipt = await waitForTransactionReceipt(wagmiConfig, {
        chainId: source.chainId,
        hash: burn,
      });
      const msg = messageFromReceipt(receipt.logs);
      setMessage(msg);
      setBurnState('done');
      // Auto-advance into attestation polling (pass the fresh hash - state may not be flushed yet).
      void runAttest(burn);
    } catch (e) {
      setError(friendlyError(e));
      setBurnState('error');
    }
  }

  // ── Step 2: poll Iris for the attestation ───────────────────────────────────────
  // `hash` is passed on auto-advance; the retry button falls back to the stored burnHash.
  async function runAttest(hash?: `0x${string}`) {
    const burnTx = hash ?? burnHash;
    if (!burnTx) return;
    setError(undefined);
    setAttestState('pending');
    setAttestStatus('pending');
    try {
      const result = await pollAttestation(source.domain, burnTx, {
        onStatus: (s) => setAttestStatus(s),
      });
      setAttestation(result);
      setAttestState('done');
    } catch (e) {
      setError(friendlyError(e));
      setAttestState('error');
    }
  }

  // ── Step 3: switch to Arc, receiveMessage (mint) ─────────────────────────────────
  async function runMint() {
    if (!attestation) return;
    setError(undefined);
    setMintState('pending');
    try {
      await switchChainAsync({ chainId: ARC.chainId });
      // Arc has a ~20 Gwei base-fee floor; supply the floor so the tx is never under-priced.
      const mint = await writeContractAsync({
        chainId: ARC.chainId,
        address: ARC.messageTransmitterV2,
        abi: receiveMessageAbi,
        functionName: 'receiveMessage',
        args: [attestation.message, attestation.attestation],
        maxFeePerGas: MAX_FEE_PER_GAS_ARC,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE_ARC,
      });
      setMintHash(mint);
      await waitForTransactionReceipt(wagmiConfig, { chainId: ARC.chainId, hash: mint });
      setMintState('done');
    } catch (e) {
      setError(friendlyError(e));
      setMintState('error');
    }
  }

  const formValid = Boolean(parsedAmount);

  return (
    <SectionCard
      title="Bridge USDC to Arc"
      kicker="Onboard · Circle CCTP V2"
      icon={<ArrowDown className="h-5 w-5" />}
      footer={
        <span className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          Live bridging requires testnet USDC on the source chain. Get some from{' '}
          <a
            href="https://faucet.circle.com"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-brand hover:text-brand-hover"
          >
            Circle&apos;s faucet
          </a>{' '}
          first.
        </span>
      }
    >
      <div data-testid="bridge-usdc" className="space-y-5">
        {/* Source + amount form */}
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
          <label className="block">
            <span className="kicker mb-1.5 block">Source chain</span>
            <select
              data-testid="bridge-source"
              value={sourceKey}
              disabled={busy}
              onChange={(e) => {
                setSourceKey(e.target.value);
                resetFlow();
              }}
              className="h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
            >
              {SOURCES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="kicker mb-1.5 block">Amount (USDC)</span>
            <input
              data-testid="bridge-amount"
              type="text"
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="1.0"
              className="h-10 w-full rounded-xl border border-line bg-surface px-3 font-mono text-sm text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
            />
          </label>
        </div>

        {/* Route summary */}
        <div className="flex items-center justify-center gap-2 text-xs text-ink-muted">
          <Badge tone="neutral">{source.label}</Badge>
          <ArrowDown className="h-3.5 w-3.5 -rotate-90" />
          <Badge tone="brand">{ARC.label}</Badge>
        </div>

        {!isConnected && (
          <div className="flex items-center gap-2 rounded-xl border border-line bg-surface-muted px-3 py-2.5 text-sm text-ink-soft">
            <Wallet className="h-4 w-4 shrink-0 text-ink-faint" />
            Connect a wallet to bridge. You will switch to {source.label} for the burn, then back to{' '}
            {ARC.label} for the mint.
          </div>
        )}

        {/* Stepper */}
        <ol className="space-y-3">
          {/* Step 1 */}
          <li className="flex gap-3">
            <StepBadge n={1} state={burnState} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">Approve &amp; Burn on {source.label}</span>
                <button
                  type="button"
                  data-testid="bridge-burn"
                  disabled={!isConnected || !formValid || busy || burnState === 'done'}
                  onClick={() => runBurn()}
                  className={buttonClass('primary', 'sm')}
                >
                  {burnState === 'pending'
                    ? 'Burning…'
                    : burnState === 'done'
                      ? 'Burned'
                      : 'Approve & Burn'}
                  <Stars />
                </button>
              </div>
              {burnHash && (
                <div className="mt-1">
                  <TxLink chain={source} hash={burnHash} label="View burn on explorer" />
                </div>
              )}
              {message && (
                <p className="mt-1 truncate font-mono text-[11px] text-ink-faint" title={message}>
                  message {message.slice(0, 10)}…{message.slice(-8)}
                </p>
              )}
            </div>
          </li>

          {/* Step 2 */}
          <li className="flex gap-3">
            <StepBadge n={2} state={attestState} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">Awaiting Circle attestation</span>
                {attestState === 'error' && (
                  <button
                    type="button"
                    data-testid="bridge-attest-retry"
                    disabled={busy}
                    onClick={() => runAttest()}
                    className={buttonClass('secondary', 'sm')}
                  >
                    Retry
                    <Stars />
                  </button>
                )}
              </div>
              <p className="mt-0.5 text-xs text-ink-muted">
                {attestState === 'pending' && (
                  <span className="inline-flex items-center gap-1.5">
                    <Spinner className="h-3 w-3" />
                    Polling Iris {attestStatus ? `(${attestStatus})` : ''}…
                  </span>
                )}
                {attestState === 'done' && 'Attestation received from Circle.'}
                {attestState === 'idle' && 'Starts automatically after the burn confirms.'}
              </p>
            </div>
          </li>

          {/* Step 3 */}
          <li className="flex gap-3">
            <StepBadge n={3} state={mintState} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">Mint on {ARC.label}</span>
                <button
                  type="button"
                  data-testid="bridge-mint"
                  disabled={attestState !== 'done' || busy || mintState === 'done'}
                  onClick={() => runMint()}
                  className={buttonClass('primary', 'sm')}
                >
                  {mintState === 'pending' ? 'Minting…' : mintState === 'done' ? 'Minted' : 'Mint on Arc'}
                  <Stars />
                </button>
              </div>
              {mintHash && (
                <div className="mt-1">
                  <TxLink chain={ARC} hash={mintHash} label="View mint on ArcScan" />
                </div>
              )}
            </div>
          </li>
        </ol>

        {error && (
          <p data-testid="bridge-error" className="text-sm text-side-down">
            {error}
          </p>
        )}

        {mintState === 'done' && parsedAmount && (
          <p className="text-sm font-medium text-side-up">
            Bridged {formatUnits(parsedAmount, USDC_DECIMALS)} USDC to {ARC.label}.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
