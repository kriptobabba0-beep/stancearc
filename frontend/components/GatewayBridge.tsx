'use client';

// components/GatewayBridge.tsx — "Instant USDC to Arc" via Circle Gateway.
//
// Gateway is deposit-once / transfer-many. The panel has three regions:
//   • Unified balance — polls POST /v1/balances for the user's spendable balance per source chain.
//   • Deposit         — approve(USDC -> GatewayWallet) + GatewayWallet.deposit(usdc, amount) on a source
//                       chain. The only slow leg (deposit finality); balance updates above when ready.
//   • Transfer to Arc — sign an EIP-712 BurnIntent -> POST /v1/transfer -> gatewayMint(attestation,sig)
//                       on Arc. <500ms once the deposit is finalized.
//
// Orchestration is inlined (mirrors BridgeUSDC.tsx) over the pure lib/gateway helpers; renders without a
// connected wallet (connect prompt) so the dashboard e2e still boots.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccount, useSwitchChain, useWriteContract, useSignTypedData } from 'wagmi';
import { waitForTransactionReceipt, readContract } from 'wagmi/actions';
import { parseUnits, formatUnits, parseEventLogs } from 'viem';
import { erc20Abi } from '@/abis';
import { wagmiConfig } from '@/lib/wagmi';
import { GAS_FLOOR_WEI, MAX_PRIORITY_FEE_WEI } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';
import {
  GATEWAY_WALLET,
  GATEWAY_MINTER,
  ARC_GATEWAY,
  GATEWAY_SOURCES,
  sourceByKey,
  sourceByDomain,
  gatewayWalletAbi,
  gatewayMinterAbi,
  buildBurnIntent,
  burnIntentTypedData,
  computeMaxFee,
  expectedFee,
  minTransferValue,
  fetchUnifiedBalances,
  fetchExpirationHeight,
  fetchDeposits,
  isPendingDeposit,
  depositProgress,
  formatEta,
  submitTransfer,
  FORWARDER_ENABLED,
  estimateForwarderFee,
  submitForwarderTransfer,
  pollForwarderTransfer,
  USDC_DECIMALS,
  type GatewaySource,
  type GatewayDeposit,
  type BurnIntentMessage,
} from '@/lib/gateway';
import { SectionCard } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Wallet, External, Spinner, Check, Info, ArrowDown, Activity, Clock } from '@/components/ui/icons';

type StepState = 'idle' | 'pending' | 'done' | 'error';
const MAX_UINT256 = 2n ** 256n - 1n;
/** Receipt wait ceiling. wagmi passes `timeout: 0` by default, i.e. no deadline of its own — viem's
 *  retry budget still bounds a NOT-FOUND hash, but a found-yet-unconfirmed one has no ceiling at all.
 *  An explicit one keeps a stuck step from spinning until the tab closes. */
const RECEIPT_TIMEOUT_MS = 120_000;
/** How long to keep polling the CHAIN STATE for a step's effect. Longer than the receipt wait: with a
 *  relayer the returned hash may never appear, and the state read is the only honest signal left. */
const STATE_CONFIRM_TIMEOUT_MS = 240_000;

/** A signal's verdict: `decisive` ones end the race immediately; the rest only vote if nothing else does. */
type Verdict = { decisive: boolean; ok: boolean; detail?: string };

/** Resolve on the FIRST decisive verdict; otherwise once every signal has spoken (failure). */
function firstDecisive(signals: Promise<Verdict>[]): Promise<Verdict> {
  return new Promise((resolve) => {
    let left = signals.length;
    let fallback: Verdict = { decisive: false, ok: false };
    const settle = (v: Verdict) => {
      if (v.decisive) resolve(v);
      else {
        if (v.detail && !fallback.detail) fallback = v;
        if (--left === 0) resolve(fallback);
      }
    };
    for (const s of signals) s.then(settle, () => settle({ decisive: false, ok: false }));
  });
}

/** Poll a chain read until it reports done, or the deadline passes. Transient RPC errors are ignored —
 *  a read failing is not evidence of anything, and giving up on one would be worse than waiting. */
async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, intervalMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return true;
    } catch {
      /* transient — keep polling */
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Confirm a write by the STATE it was supposed to produce — with the receipt as a fast path, never as
 * the sole proof.
 *
 * Why: a returned transaction hash is not a promise that THAT hash will mine. Smart-account wallets
 * (EIP-7702 delegation + a relayer submitting on the user's behalf — MetaMask does this by default for
 * upgraded accounts) can land the call under a DIFFERENT hash. Waiting on the returned hash then hangs
 * forever on a transaction that actually succeeded: the field report that prompted this was a Gateway
 * deposit that credited 25 USDC on-chain while the UI sat "Depositing…" for 45 minutes.
 *
 * `check` reads the exact state the step exists to produce (allowance raised, credit increased), so it
 * is true only if the work really happened, whoever submitted it and under whatever hash.
 */
async function confirmByState(opts: {
  chainId: number;
  hash: `0x${string}`;
  check: () => Promise<boolean>;
  /** Extra assertion for the fast path when the receipt IS findable (e.g. the right event fired). */
  verifyReceipt?: (receipt: Awaited<ReturnType<typeof waitForTransactionReceipt>>) => boolean;
  timeoutMs?: number;
}): Promise<{ ok: boolean; detail?: string }> {
  const timeoutMs = opts.timeoutMs ?? STATE_CONFIRM_TIMEOUT_MS;

  const viaReceipt: Promise<Verdict> = waitForTransactionReceipt(wagmiConfig, {
    chainId: opts.chainId,
    hash: opts.hash,
    timeout: RECEIPT_TIMEOUT_MS,
  })
    .then((r): Verdict => {
      // A found-and-reverted receipt is PROOF of failure — end the race now instead of making the
      // user watch a state poll that can only confirm what already didn't happen.
      if (r.status !== 'success') return { decisive: true, ok: false, detail: 'the transaction reverted' };
      // Succeeded and carries the expected effect: done.
      if (!opts.verifyReceipt || opts.verifyReceipt(r)) return { decisive: true, ok: true };
      // Succeeded but isn't the call we meant (relayer wrapper, or the hash belongs to another tx) —
      // that is not a failure either. Say nothing decisive; let the state read rule.
      return { decisive: false, ok: false, detail: 'the returned transaction did not carry the expected event' };
    })
    // Not found / timed out / the relayer used a different hash — NOT proof of failure.
    .catch((e): Verdict => ({ decisive: false, ok: false, detail: friendlyError(e) }));

  const viaState: Promise<Verdict> = pollUntil(opts.check, timeoutMs).then(
    (ok): Verdict =>
      ok
        ? { decisive: true, ok: true }
        : { decisive: false, ok: false, detail: 'the expected on-chain effect never appeared' },
  );

  const verdict = await firstDecisive([viaReceipt, viaState]);
  return { ok: verdict.ok, detail: verdict.detail };
}

/** Format a 6-dp USDC atomic bigint as a 2-decimal string ("2.00"). */
function fmtUsdc(v: bigint): string {
  return Number(formatUnits(v, USDC_DECIMALS)).toFixed(2);
}

function parseAmount(s: string): bigint | undefined {
  try {
    if (!s || Number(s) <= 0) return undefined;
    return parseUnits(s.trim(), USDC_DECIMALS);
  } catch {
    return undefined;
  }
}

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

function TxLink({ explorer, hash, label }: { explorer: string; hash: `0x${string}`; label: string }) {
  return (
    <a
      href={`${explorer}/tx/${hash}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
    >
      {label}
      <External className="h-3 w-3" />
    </a>
  );
}

export function GatewayBridge() {
  const { address, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { signTypedDataAsync } = useSignTypedData();

  // Unified balance per source domain + the live deposit-finality tracker.
  const [balances, setBalances] = useState<Map<number, bigint>>(new Map());
  const [deposits, setDeposits] = useState<GatewayDeposit[]>([]);
  const [credited, setCredited] = useState<{ key: string; label: string; amount: bigint }[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());
  // Deposits that were pending on the previous poll (to detect ones that just got credited).
  const prevPendingRef = useRef<Map<`0x${string}`, GatewayDeposit>>(new Map());

  // One poll fetches BOTH the spendable balance and the in-flight deposits, so a finalizing deposit is
  // always visible (driven by Circle's /v1/deposits, not the local action — survives reloads + UI errors).
  const refresh = useCallback(async () => {
    if (!address) return;
    const src = GATEWAY_SOURCES.map((s) => ({ domain: s.domain, depositor: address }));
    const [bals, deps] = await Promise.all([
      fetchUnifiedBalances(src).catch(() => null),
      fetchDeposits(src).catch(() => null),
    ]);
    if (bals) setBalances(bals);
    if (deps) {
      const pendingNow = new Map(deps.filter(isPendingDeposit).map((d) => [d.transactionHash, d] as const));
      // Anything that WAS pending last poll and isn't now → it just finalized + got credited.
      const justCredited: { key: string; label: string; amount: bigint }[] = [];
      for (const [hash, d] of prevPendingRef.current) {
        if (!pendingNow.has(hash)) {
          justCredited.push({ key: hash, label: sourceByDomain(d.domain)?.label ?? `domain ${d.domain}`, amount: d.amount });
        }
      }
      if (justCredited.length) setCredited((prev) => [...prev, ...justCredited]);
      prevPendingRef.current = pendingNow;
      setDeposits(deps);
    }
  }, [address]);

  useEffect(() => {
    if (!address) {
      setBalances(new Map());
      setDeposits([]);
      prevPendingRef.current = new Map();
      return;
    }
    void refresh();
    const id = setInterval(() => void refresh(), 12_000);
    return () => clearInterval(id);
  }, [address, refresh]);

  const pendingDeposits = useMemo(() => deposits.filter(isPendingDeposit), [deposits]);

  // Smooth 1s ETA countdown while a deposit is confirming (the poll itself stays at 12s).
  useEffect(() => {
    if (pendingDeposits.length === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pendingDeposits.length]);

  // Auto-dismiss the "now available" confirmations.
  useEffect(() => {
    if (credited.length === 0) return;
    const id = setTimeout(() => setCredited([]), 12_000);
    return () => clearTimeout(id);
  }, [credited]);

  const totalAvailable = useMemo(
    () => [...balances.values()].reduce((a, b) => a + b, 0n),
    [balances],
  );
  const sourcesWithBalance = useMemo(
    () => GATEWAY_SOURCES.filter((s) => (balances.get(s.domain) ?? 0n) > 0n),
    [balances],
  );

  // ── Deposit state ──────────────────────────────────────────────────────────────
  const [depositKey, setDepositKey] = useState<string>(GATEWAY_SOURCES[0].key);
  const [depositAmount, setDepositAmount] = useState<string>('');
  /** Synchronous in-flight latch — see runDeposit (a disabled prop lands one render too late). */
  const depositInFlight = useRef(false);
  const [depositState, setDepositState] = useState<StepState>('idle');
  const [depositHash, setDepositHash] = useState<`0x${string}`>();
  const depositSource = sourceByKey(depositKey) ?? GATEWAY_SOURCES[0];
  const depositAmountParsed = parseAmount(depositAmount);

  // ── Transfer state ─────────────────────────────────────────────────────────────
  const [transferKey, setTransferKey] = useState<string>('');
  const [transferAmount, setTransferAmount] = useState<string>('');
  const [recipient, setRecipient] = useState<string>('');
  const [transferState, setTransferState] = useState<StepState>('idle');
  const [mintHash, setMintHash] = useState<`0x${string}`>();
  // Live note while Circle mints on the forwarder path (no user mint tx to watch).
  const [forwardNote, setForwardNote] = useState<string>();
  // Captured at success time (source is guaranteed set then) so the banner shows the NET minted amount.
  const [minted, setMinted] = useState<{ net: bigint; fee: bigint } | null>(null);

  // Default/repair the selected transfer source to one that actually has a balance.
  useEffect(() => {
    if (!transferKey || !sourcesWithBalance.some((s) => s.key === transferKey)) {
      setTransferKey(sourcesWithBalance[0]?.key ?? '');
    }
  }, [sourcesWithBalance, transferKey]);

  const transferSource: GatewaySource | undefined = sourceByKey(transferKey);
  const transferAmountParsed = parseAmount(transferAmount);
  const transferAvailable = transferSource ? balances.get(transferSource.domain) ?? 0n : 0n;
  const transferMin = transferSource ? minTransferValue(transferSource) : 0n;

  const [error, setError] = useState<string>();
  const busy = depositState === 'pending' || transferState === 'pending';

  // Transfer validation + hint.
  let transferHint = '';
  let transferValid = false;
  if (transferSource) {
    if (transferAmountParsed === undefined) {
      transferHint = `Available: ${fmtUsdc(transferAvailable)} USDC on ${transferSource.label}.`;
    } else if (transferAmountParsed < transferMin) {
      transferHint = `Minimum transfer from ${transferSource.label} is ${fmtUsdc(transferMin)} USDC (covers the fee).`;
    } else if (transferAmountParsed > transferAvailable) {
      transferHint = `Amount exceeds your available balance (${fmtUsdc(transferAvailable)} USDC).`;
    } else {
      transferValid = true;
      transferHint = `Fee ≈ ${fmtUsdc(expectedFee(transferSource, transferAmountParsed))} USDC, deducted from the amount.`;
    }
  }

  // ── Deposit: switch to source, approve, deposit ──────────────────────────────────
  async function runDeposit() {
    if (!address || !depositAmountParsed) return;
    // Re-entry guard. The disabled prop alone is not enough: it only takes effect after React
    // re-renders, so two clicks inside the same tick would both reach the wallet and send TWO
    // deposits. A ref flips synchronously, before any await.
    if (depositInFlight.current) return;
    depositInFlight.current = true;
    setError(undefined);
    setDepositState('pending');
    setDepositHash(undefined);
    try {
      await switchChainAsync({ chainId: depositSource.chainId });
      const chainId = depositSource.chainId;
      const readAllowance = () =>
        readContract(wagmiConfig, {
          chainId,
          address: depositSource.usdc,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [address, GATEWAY_WALLET],
        }) as Promise<bigint>;
      const readCredit = () =>
        readContract(wagmiConfig, {
          chainId,
          address: GATEWAY_WALLET,
          abi: gatewayWalletAbi,
          functionName: 'availableBalance',
          args: [depositSource.usdc, address],
        }) as Promise<bigint>;

      // `deposit()` consumes the allowance in full, so an exact-amount approval is single-use.
      if ((await readAllowance()) < depositAmountParsed) {
        const approveHash = await writeContractAsync({
          chainId,
          address: depositSource.usdc,
          abi: erc20Abi,
          functionName: 'approve',
          args: [GATEWAY_WALLET, depositAmountParsed],
        });
        const approved = await confirmByState({
          chainId,
          hash: approveHash,
          check: async () => (await readAllowance()) >= depositAmountParsed,
        });
        if (!approved.ok) {
          throw new Error(`The approval did not go through${approved.detail ? ` — ${approved.detail}` : '.'}`);
        }
      }

      // Snapshot BEFORE the send: the credit is the difference, so a stale read can't fake success.
      const creditBefore = await readCredit();
      const dHash = await writeContractAsync({
        chainId,
        address: GATEWAY_WALLET,
        abi: gatewayWalletAbi,
        functionName: 'deposit',
        args: [depositSource.usdc, depositAmountParsed],
      });
      setDepositHash(dHash);
      // Confirm the CREDIT, not the hash. `deposit()` raises availableBalance in the same transaction
      // it moves the USDC, so this read IS the deposit landing — and unlike a hash it cannot be wrong
      // about which transaction actually mined.
      const deposited = await confirmByState({
        chainId,
        hash: dHash,
        check: async () => (await readCredit()) >= creditBefore + depositAmountParsed,
        verifyReceipt: (r) =>
          // Fast path: when the returned hash IS findable, also prove the event credited US.
          parseEventLogs({ abi: gatewayWalletAbi, eventName: 'Deposited', logs: r.logs }).some(
            (l) =>
              l.address.toLowerCase() === GATEWAY_WALLET.toLowerCase() &&
              l.args.depositor.toLowerCase() === address.toLowerCase() &&
              l.args.value === depositAmountParsed,
          ),
      });
      if (!deposited.ok) {
        throw new Error(
          `The deposit was not credited to your address${deposited.detail ? ` — ${deposited.detail}` : ''} — open the transaction on ${depositSource.label} to check.`,
        );
      }
      setDepositState('done');
      void refresh();
    } catch (e) {
      setError(friendlyError(e));
      setDepositState('error');
    } finally {
      depositInFlight.current = false;
    }
  }

  // ── Transfer: sign burn intent, POST /transfer, gatewayMint on Arc ───────────────
  async function runTransfer() {
    const to = (recipient || address) as `0x${string}` | undefined;
    if (!address || !to || !transferSource || !transferValid || transferAmountParsed === undefined) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      setError('Recipient must be a valid 0x Ethereum address.');
      setTransferState('error');
      return;
    }
    setError(undefined);
    setTransferState('pending');
    setMintHash(undefined);
    setMinted(null);
    setForwardNote(undefined);
    try {
      // Bound the intent by the source domain's live expiration height (fall back to no-expiry).
      const maxBlockHeight = await fetchExpirationHeight(transferSource.domain).catch(() => MAX_UINT256);
      const baseFee = expectedFee(transferSource, transferAmountParsed);
      const baseMaxFee = computeMaxFee(transferSource, transferAmountParsed);
      const base = buildBurnIntent({
        source: transferSource,
        value: transferAmountParsed,
        depositor: address,
        recipient: to,
        maxBlockHeight,
        maxFee: baseMaxFee,
      });

      // Circle Gateway — instant deposit→mint. One-click FORWARDER path: size the maxFee via /v1/estimate,
      // sign the EIP-712 BurnIntent ONCE, POST it to /v1/transfer?enableForwarder=true, and Circle broadcasts
      // the Arc mint itself (no chain switch, no second user tx) — we just poll /v1/transfer/{id}. Falls back
      // to the manual GatewayMinter.gatewayMint path below if the estimate is unavailable.
      const est = FORWARDER_ENABLED ? await estimateForwarderFee(base).catch(() => null) : null;
      if (est) {
        const message: BurnIntentMessage = { ...base, maxFee: est.maxFee, maxBlockHeight: est.maxBlockHeight };
        const signature = (await signTypedDataAsync(burnIntentTypedData(message))) as `0x${string}`;
        const { transferId } = await submitForwarderTransfer(message, signature);
        setForwardNote('Circle is minting on Arc…');
        const { transactionHash } = await pollForwarderTransfer(transferId, {
          onStatus: (s) => setForwardNote(`Circle is minting on Arc (${s})…`),
        });
        setMintHash(transactionHash);
        // Realistic fee = base fee + the estimate's forwarding bump (Circle's destination-mint gas).
        const fee = baseFee + (est.maxFee > baseMaxFee ? est.maxFee - baseMaxFee : 0n);
        setMinted({ net: transferAmountParsed - fee, fee });
        setForwardNote(undefined);
        setTransferState('done');
        void refresh();
        return;
      }

      // ── MANUAL (fallback): sign the BurnIntent, POST /v1/transfer for the attestation, then call
      // gatewayMint on Circle's GatewayMinter (0x0022222A…052475B) on Arc ourselves. ──
      const signature = (await signTypedDataAsync(burnIntentTypedData(base))) as `0x${string}`;
      const { attestation, signature: gatewaySig } = await submitTransfer(base, signature);

      await switchChainAsync({ chainId: ARC_GATEWAY.chainId });
      // Arc has a ~20 Gwei base-fee floor — supply it inline so the mint is never under-priced.
      const mHash = await writeContractAsync({
        chainId: ARC_GATEWAY.chainId,
        address: GATEWAY_MINTER,
        abi: gatewayMinterAbi,
        functionName: 'gatewayMint',
        args: [attestation, gatewaySig],
        maxFeePerGas: GAS_FLOOR_WEI,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE_WEI,
      });
      setMintHash(mHash);
      const mReceipt = await waitForTransactionReceipt(wagmiConfig, {
        chainId: ARC_GATEWAY.chainId,
        hash: mHash,
        timeout: RECEIPT_TIMEOUT_MS,
      });
      if (mReceipt.status !== 'success') throw new Error('The mint transaction reverted on Arc.');
      setMinted({ net: transferAmountParsed - baseFee, fee: baseFee });
      setTransferState('done');
      void refresh();
    } catch (e) {
      const msg = friendlyError(e);
      // Circle's Gateway transfer backend intermittently goes fully down (503 on every submit — forwarder
      // AND standard). The client already retried; a sustained outage can't be beaten here. Reassure that
      // the deposit is untouched (the burn never happened) and to retry once Circle recovers.
      const serviceDown = /HTTP 503|temporarily unavailable/i.test(msg);
      setError(
        serviceDown
          ? 'Circle’s Gateway transfer service is temporarily unavailable (HTTP 503) — this is on Circle’s side, not your transfer. Your deposited balance is safe and untouched; please try again in a few minutes.'
          : msg,
      );
      setTransferState('error');
      setForwardNote(undefined);
    }
  }

  const panelClass = 'rounded-xl border border-line bg-surface-muted px-4 py-4';
  const selectClass =
    'h-10 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50';
  const inputClass =
    'h-10 w-full rounded-xl border border-line bg-surface px-3 font-mono text-sm text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50';

  return (
    <SectionCard
      title="Instant USDC to Arc"
      kicker="Onboard · Circle Gateway"
      icon={<Activity className="h-5 w-5" />}
      footer={
        <span className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          Deposit once into Gateway (the only wait — source-chain finality), then every transfer to Arc is
          near-instant. Get testnet USDC from{' '}
          <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="font-medium text-brand hover:text-brand-hover">
            Circle&apos;s faucet
          </a>
          .
        </span>
      }
    >
      <div data-testid="gateway-bridge" className="space-y-5">
        {!isConnected && (
          <div
            data-testid="gateway-connect"
            className="flex items-center gap-2 rounded-xl border border-line bg-surface-muted px-3 py-2.5 text-sm text-ink-soft"
          >
            <Wallet className="h-4 w-4 shrink-0 text-ink-faint" />
            Connect a wallet to view your Gateway balance and onboard USDC to {ARC_GATEWAY.label}.
          </div>
        )}

        {/* Unified balance */}
        <div className={panelClass}>
          <div className="flex items-center justify-between">
            <span className="kicker">Unified Gateway balance</span>
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <Clock className="h-3.5 w-3.5" /> ready to send to Arc
            </span>
          </div>
          <div data-testid="gateway-balance-total" className="mt-1 font-mono text-3xl font-medium tracking-tight text-ink">
            {fmtUsdc(totalAvailable)}
            <span className="ml-1.5 text-base text-ink-muted">USDC</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {GATEWAY_SOURCES.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-[12px] text-ink-soft">
                {s.label}
                <span className="font-mono text-ink">{fmtUsdc(balances.get(s.domain) ?? 0n)}</span>
              </span>
            ))}
          </div>
          {totalAvailable > 0n && (
            <p data-testid="gateway-balance-hint" className="mt-2 text-[13px] text-ink-muted">
              This is a Gateway balance held off-Arc. <span className="text-ink-soft">Send it to Arc below</span> to
              get real USDC on Arc you can use for Stance, Swap, and Pools — it isn&apos;t spendable on Arc until you do.
            </p>
          )}
          {isConnected && pendingDeposits.length === 0 && totalAvailable === 0n && (
            <p data-testid="gateway-empty" className="mt-2 text-[13px] text-ink-muted">
              No spendable balance yet. Deposit below — it confirms on the source chain (instant on Avalanche
              Fuji, ~13–19 min from Ethereum or Base), then appears here ready to send to Arc. You can leave
              and come back; the status updates live.
            </p>
          )}
        </div>

        {/* Deposits in progress — the live finality tracker */}
        {pendingDeposits.length > 0 && (
          <div data-testid="gateway-pending" className={panelClass}>
            <div className="flex items-center justify-between">
              <span className="kicker">Deposits in progress</span>
              <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <Spinner className="h-3.5 w-3.5" /> finalizing
              </span>
            </div>
            <p className="mt-1 text-[12px] text-ink-muted">
              Your USDC isn&apos;t lost — Gateway is finalizing the deposit on the source chain. This one-time
              wait is what makes every later transfer to Arc instant.
            </p>
            <div className="mt-3 space-y-3">
              {pendingDeposits.map((d) => {
                const s = sourceByDomain(d.domain);
                const prog = depositProgress({
                  blockTimestampMs: d.blockTimestampMs,
                  now,
                  finalitySeconds: s?.finalitySeconds ?? 1140,
                });
                return (
                  <div key={d.transactionHash} data-testid="gateway-pending-item" className="rounded-lg border border-line bg-surface px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-medium text-ink">
                        <span className="font-mono">{fmtUsdc(d.amount)}</span> USDC from {s?.label ?? `domain ${d.domain}`}
                      </span>
                      <span className="text-xs font-semibold text-brand">
                        {prog.phase === 'confirming' ? `Confirming · ${formatEta(prog.etaSec)} left` : 'Crediting your balance…'}
                      </span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuenow={Math.round(prog.pct * 100)}>
                      <div className="h-full rounded-full bg-brand transition-all duration-700 ease-out" style={{ width: `${Math.round(prog.pct * 100)}%` }} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-muted">
                      <span>
                        {prog.phase === 'confirming'
                          ? `Waiting for ${s?.label ?? 'source'} finality (one-time)`
                          : 'On-chain finality reached — almost there'}
                      </span>
                      {s && (
                        <a
                          href={`${s.explorer}/tx/${d.transactionHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium text-brand hover:text-brand-hover"
                        >
                          tx <External className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Just-credited confirmations (auto-dismiss) */}
        {credited.map((c) => (
          <div
            key={c.key}
            data-testid="gateway-credited"
            className="flex items-center gap-2 rounded-xl border border-side-up/30 bg-side-up/10 px-3 py-2 text-sm font-medium text-side-up"
          >
            <Check className="h-4 w-4 shrink-0" />
            {fmtUsdc(c.amount)} USDC from {c.label} is now available — ready to send to Arc.
          </div>
        ))}

        {/* Deposit */}
        <div className={panelClass} data-testid="gateway-deposit-panel">
          <div className="mb-2 flex items-center gap-2">
            <StepBadge n={1} state={depositState} />
            <span className="text-sm font-medium text-ink">Deposit into Gateway</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <label className="block">
              <span className="kicker mb-1.5 block">From chain</span>
              <select
                data-testid="gateway-deposit-source"
                value={depositKey}
                disabled={busy}
                onChange={(e) => {
                  setDepositKey(e.target.value);
                  setDepositState('idle');
                  setDepositHash(undefined);
                }}
                className={selectClass}
              >
                {GATEWAY_SOURCES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label} ({s.approxFinality})
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="kicker mb-1.5 block">Amount (USDC)</span>
              <input
                data-testid="gateway-deposit-amount"
                type="text"
                inputMode="decimal"
                value={depositAmount}
                disabled={busy}
                onChange={(e) => {
                  setDepositAmount(e.target.value.replace(/[^0-9.]/g, ''));
                  // Typing a new amount arms a NEW deposit: leave the finished/failed state so the
                  // button stops reading "Deposited" and becomes a deliberate action again.
                  if (depositState !== 'pending') setDepositState('idle');
                }}
                placeholder="1.0"
                className={inputClass}
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-ink-muted">
              Finality on {depositSource.label}: <span className="text-ink-soft">{depositSource.approxFinality}</span>.
            </p>
            <button
              type="button"
              data-testid="gateway-deposit-btn"
              // `depositState === 'done'` is part of the guard on purpose. Without it the button stayed
              // ENABLED after a successful deposit while still labelled "Deposited", so every further
              // click silently sent ANOTHER deposit of the same amount — a user testing whether the
              // button was stuck ended up depositing 4x20 USDC. A repeat deposit must be deliberate:
              // type a fresh amount (which resets the state above) to re-arm it.
              disabled={!isConnected || !depositAmountParsed || busy || depositState === 'done'}
              onClick={() => runDeposit()}
              className={buttonClass('primary', 'sm')}
            >
              {depositState === 'pending' ? 'Depositing…' : depositState === 'done' ? 'Deposited' : 'Approve & Deposit'}
              <Stars />
            </button>
          </div>
          {depositHash && (
            <div className="mt-2">
              <TxLink explorer={depositSource.explorer} hash={depositHash} label={`View deposit on ${depositSource.label}`} />
            </div>
          )}
          {depositState === 'done' && (
            <p className="mt-1.5 text-xs text-ink-muted">
              Deposit submitted — watch it finalize under “Deposits in progress” above ({depositSource.approxFinality}).
              It becomes spendable automatically; you don&apos;t need to keep this page open.
            </p>
          )}
        </div>

        {/* Transfer to Arc */}
        <div className={panelClass} data-testid="gateway-transfer-panel">
          <div className="mb-2 flex items-center gap-2">
            <StepBadge n={2} state={transferState} />
            <span className="text-sm font-medium text-ink">Transfer to {ARC_GATEWAY.label}</span>
          </div>

          {sourcesWithBalance.length === 0 ? (
            <p className="text-sm text-ink-muted">
              Deposit first to build a unified balance, then transfer it to Arc here.
            </p>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                <label className="block">
                  <span className="kicker mb-1.5 block">From balance</span>
                  <select
                    data-testid="gateway-transfer-source"
                    value={transferKey}
                    disabled={busy}
                    onChange={(e) => {
                      setTransferKey(e.target.value);
                      setTransferState('idle');
                      setMintHash(undefined);
                      setMinted(null);
                    }}
                    className={selectClass}
                  >
                    {sourcesWithBalance.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label} · {fmtUsdc(balances.get(s.domain) ?? 0n)} USDC
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="kicker mb-1.5 block">Amount (USDC)</span>
                  <input
                    data-testid="gateway-transfer-amount"
                    type="text"
                    inputMode="decimal"
                    value={transferAmount}
                    disabled={busy}
                    onChange={(e) => setTransferAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                    placeholder="1.0"
                    className={inputClass}
                  />
                </label>
              </div>
              <label className="mt-3 block">
                <span className="kicker mb-1.5 block">Recipient on Arc (defaults to you)</span>
                <input
                  data-testid="gateway-transfer-recipient"
                  type="text"
                  value={recipient}
                  disabled={busy}
                  onChange={(e) => setRecipient(e.target.value.trim())}
                  placeholder={address ?? '0x…'}
                  className={inputClass}
                />
              </label>

              <div className="mt-2 flex items-center justify-center gap-2 text-xs text-ink-muted">
                <Badge tone="neutral">{transferSource?.label ?? '—'}</Badge>
                <ArrowDown className="h-3.5 w-3.5 -rotate-90" />
                <Badge tone="brand">{ARC_GATEWAY.label}</Badge>
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <p data-testid="gateway-transfer-hint" className="text-xs text-ink-muted">
                  {transferHint}
                </p>
                <button
                  type="button"
                  data-testid="gateway-transfer-btn"
                  disabled={!isConnected || !transferValid || busy}
                  onClick={() => runTransfer()}
                  className={buttonClass('primary', 'sm')}
                >
                  {transferState === 'pending' ? 'Minting…' : transferState === 'done' ? 'Minted' : 'Sign & Mint on Arc'}
                  <Stars />
                </button>
              </div>
              {forwardNote && transferState === 'pending' && (
                <p data-testid="gateway-forward-note" className="mt-2 text-xs text-ink-muted">
                  {forwardNote}
                </p>
              )}
              {mintHash && (
                <div className="mt-2">
                  <TxLink explorer={ARC_GATEWAY.explorer} hash={mintHash} label="View mint on ArcScan" />
                </div>
              )}
              {transferState === 'done' && minted && (
                <p className="mt-1.5 text-sm font-medium text-side-up">
                  Minted ~{fmtUsdc(minted.net)} USDC to {ARC_GATEWAY.label} (fee ≈ {fmtUsdc(minted.fee)} USDC deducted).
                </p>
              )}
            </>
          )}
        </div>

        {error && (
          <p data-testid="gateway-error" className="text-sm text-side-down">
            {error}
          </p>
        )}
      </div>
    </SectionCard>
  );
}
