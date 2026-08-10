'use client';

// components/wallet/MyWallet.tsx — the full embedded-wallet experience (Google/Email/PIN users).
// Portfolio overview · assets with USD values · send · receive (QR) · transaction history ·
// network info · settings. On-brand dark HUD. Send routes through Circle contractExecution.

import { useEffect, useMemo, useState } from 'react';
import { parseUnits, formatUnits } from 'viem';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';
import { tokenArtFor } from '@/components/ui/TokenArt';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import { useWalletPortfolio, type TokenBalance } from '@/hooks/useWalletPortfolio';
import { useWalletTransactions } from '@/hooks/useWalletTransactions';
import { QrCode } from '@/components/wallet/QrCode';
import { SectionCard, Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import type { ExecuteContractArgs } from '@/components/circle/CircleWalletProvider';
import { classifyWalletTxs, type WalletRow, type WalletAction, type Role } from '@/lib/wallet/groupTxs';
import { MARKETS } from '@/lib/markets';
import {
  Wallet, ArrowUp, ArrowDown, Copy, Check, External, Settings, Activity, Clock, Shield, Lock,
  Spinner, Close, Info, SwapArrows, ChevronDown, Layers, Trophy, Gift,
} from '@/components/ui/icons';

const PAGE_SIZE = 8; // Activity rows per page — bounds the card height + aligns it with the right column.

const GAS_BUFFER = 100_000n; // reserve ~0.10 USDC for gas (gas is USDC on Arc)
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const KIND_LABEL: Record<string, string> = { email: 'Email', google: 'Google', pin: 'PIN' };

const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtAmt = (n: number, max = 6) => n.toLocaleString('en-US', { maximumFractionDigits: max });

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function TokenGlyph({ symbol, className }: { symbol: string; className?: string }) {
  const Art = tokenArtFor(symbol);
  return (
    <span className={cn('block shrink-0 overflow-hidden rounded-full', className)}>
      <Art className="h-full w-full" />
    </span>
  );
}

function useCopy(value: string): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }
  };
  return [copied, copy];
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 motion-safe:animate-fade-in" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-[420px] motion-safe:animate-fade-up">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h3 className="font-display text-[15px] font-semibold text-ink">{title}</h3>
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface-muted/60 text-ink-muted transition-colors hover:text-ink">
              <Close className="h-4 w-4" />
            </button>
          </div>
          <div className="px-5 py-5">{children}</div>
        </Card>
      </div>
    </div>
  );
}

const inputClass =
  'h-12 w-full rounded-xl border border-line bg-surface-inset px-3.5 text-sm text-ink placeholder:text-ink-faint transition focus-visible:border-brand/60 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50';

function SendForm({
  balances,
  busy,
  executeContract,
  refetch,
}: {
  balances: TokenBalance[];
  busy: boolean;
  executeContract: (args: ExecuteContractArgs) => Promise<{ challengeId: string }>;
  refetch: () => void;
}) {
  const [symbol, setSymbol] = useState(
    balances.find((b) => b.token.symbol === 'USDC')?.token.symbol ?? balances[0]?.token.symbol ?? 'USDC',
  );
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState<string>();
  const [sent, setSent] = useState(false);

  const bal = balances.find((b) => b.token.symbol === symbol) ?? balances[0];
  const token = bal.token;
  const parsed = useMemo(() => {
    try {
      return amount && Number(amount) > 0 ? parseUnits(amount, token.decimals) : undefined;
    } catch {
      return undefined;
    }
  }, [amount, token.decimals]);
  const spendable = token.symbol === 'USDC' ? (bal.raw > GAS_BUFFER ? bal.raw - GAS_BUFFER : 0n) : bal.raw;
  const recipientValid = ADDR_RE.test(recipient);
  const canSend = recipientValid && parsed !== undefined && parsed > 0n && parsed <= spendable && !busy;

  async function onSend() {
    if (!canSend || parsed === undefined) return;
    setErr(undefined);
    setSent(false);
    try {
      await executeContract({
        contractAddress: token.address,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [recipient, parsed.toString()],
      });
      setSent(true);
      setAmount('');
      refetch();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="kicker mb-2 block">Asset</span>
        <div className="grid grid-cols-3 gap-2">
          {balances.map((b) => (
            <button
              key={b.token.symbol}
              type="button"
              data-testid={`send-asset-${b.token.symbol}`}
              onClick={() => setSymbol(b.token.symbol)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 transition-colors',
                b.token.symbol === symbol ? 'border-brand bg-brand-soft/40' : 'border-line bg-surface-muted/40 hover:border-line-strong',
              )}
            >
              <TokenGlyph symbol={b.token.symbol} className="h-7 w-7 text-[13px]" />
              <span className="text-[11px] font-semibold text-ink">{b.token.symbol}</span>
            </button>
          ))}
        </div>
      </div>

      <label className="block">
        <span className="kicker mb-1.5 block">Recipient</span>
        <input data-testid="send-recipient" value={recipient} disabled={busy} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x…" className={inputClass} />
      </label>

      <label className="block">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="kicker">Amount</span>
          <button
            type="button"
            onClick={() => setAmount(formatUnits(spendable, token.decimals))}
            className="font-mono text-[11px] text-ink-muted transition-colors hover:text-brand"
          >
            Balance {fmtAmt(Number(formatUnits(bal.raw, token.decimals)))} · MAX
          </button>
        </div>
        <input
          data-testid="send-amount"
          value={amount}
          disabled={busy}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          placeholder="0.0"
          className={cn(inputClass, 'font-mono')}
        />
      </label>

      <p className="text-xs text-ink-muted">
        {recipient && !recipientValid
          ? 'Enter a valid 0x address.'
          : parsed !== undefined && parsed > spendable
            ? token.symbol === 'USDC'
              ? 'Leave ~0.10 USDC for gas.'
              : 'Amount exceeds your balance.'
            : 'You’ll approve this with your wallet (PIN / biometric). Gas is paid in USDC.'}
      </p>

      <button type="button" data-testid="send-submit" disabled={!canSend} onClick={() => void onSend()} className={buttonClass('primary', 'lg', 'w-full')}>
        {busy ? (
          <span className="inline-flex items-center gap-2"><Spinner className="h-4 w-4" /> Signing…</span>
        ) : (
          `Send ${token.symbol}`
        )}
        <Stars />
      </button>

      {sent && (
        <p className="inline-flex items-center gap-1.5 text-sm font-medium text-side-up">
          <Check className="h-4 w-4" /> Transfer signed + submitted.
        </p>
      )}
      {err && <p className="text-sm text-side-down">{err}</p>}
    </div>
  );
}

// Per-action presentation: label, icon, the icon-ring color, and a subtitle verb. send/receive use the
// counterparty address instead of a verb.
const ACTION_META: Record<WalletAction, { label: string; Icon: typeof ArrowUp; ring: string; verb: string }> = {
  swap: { label: 'Swap', Icon: SwapArrows, ring: 'border-brand/30 text-brand', verb: 'swapped on Arc' },
  addLiquidity: { label: 'Add Liquidity', Icon: Layers, ring: 'border-side-down/30 text-side-down', verb: 'added to a pool' },
  removeLiquidity: { label: 'Remove Liquidity', Icon: Layers, ring: 'border-side-up/30 text-side-up', verb: 'removed from a pool' },
  joinArena: { label: 'Join Stance', Icon: Trophy, ring: 'border-brand/30 text-brand', verb: 'staked into the Stance' },
  claimFees: { label: 'Claim Fees', Icon: Gift, ring: 'border-side-up/30 text-side-up', verb: 'claimed from the Stance' },
  send: { label: 'Sent', Icon: ArrowUp, ring: 'border-side-down/30 text-side-down', verb: '' },
  receive: { label: 'Received', Icon: ArrowDown, ring: 'border-side-up/30 text-side-up', verb: '' },
};

// Which legs each action shows as inflow (+, green) vs outflow (−, muted).
const SHOWS_RECEIVED = new Set<WalletAction>(['swap', 'removeLiquidity', 'claimFees', 'receive']);
const SHOWS_PAID = new Set<WalletAction>(['swap', 'addLiquidity', 'joinArena', 'send']);

/** One row per user ACTION (swap / add+remove liquidity / join arena / claim / send / receive). */
function ActionRow({ row }: { row: WalletRow }) {
  const meta = ACTION_META[row.action];
  const { Icon } = meta;
  const s = (row.state || '').toUpperCase();
  const tone: 'up' | 'down' | 'muted' = ['COMPLETE', 'CONFIRMED'].includes(s)
    ? 'up'
    : ['FAILED', 'DENIED', 'CANCELLED'].includes(s)
      ? 'down'
      : 'muted';

  const cp = row.action === 'send' ? row.outs[0]?.destinationAddress : row.action === 'receive' ? row.ins[0]?.sourceAddress : undefined;
  const subtitle = meta.verb
    ? `${meta.verb} · ${timeAgo(row.ts)}`
    : `${row.action === 'send' ? 'to' : 'from'} ${short(cp || '—')} · ${timeAgo(row.ts)}`;

  const amtLines = (legs: WalletRow['ins'], sign: string, cls: string) =>
    legs
      .filter((l) => l.amounts?.[0])
      .slice(0, 2)
      .map((l, i) => (
        <div key={`${sign}${i}`} className={cls}>
          {sign}
          {l.amounts![0]}
        </div>
      ));

  const inner = (
    <>
      <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-full border', meta.ring)}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">{meta.label}</span>
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide',
              tone === 'up' ? 'bg-side-up-soft text-side-up' : tone === 'down' ? 'bg-side-down-soft text-side-down' : 'bg-surface-muted text-ink-muted',
            )}
          >
            {row.state || 'pending'}
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-ink-muted">{subtitle}</div>
      </div>
      <div className="shrink-0 text-right font-mono text-sm leading-tight">
        {SHOWS_RECEIVED.has(row.action) && amtLines(row.ins, '+', 'text-side-up')}
        {SHOWS_PAID.has(row.action) && amtLines(row.outs, '-', 'text-ink-muted')}
      </div>
    </>
  );

  return row.txHash ? (
    <a
      href={`${ENV.EXPLORER_URL}/tx/${row.txHash}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-surface-muted/50"
    >
      {inner}
      <External className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
    </a>
  ) : (
    <div className="flex items-center gap-3 rounded-xl px-2 py-2.5">{inner}</div>
  );
}

/** The window of page numbers to show: all when few, else 7 centered on the current page. */
function pageWindow(page: number, pageCount: number): number[] {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i);
  const start = Math.max(0, Math.min(page - 3, pageCount - 7));
  return Array.from({ length: 7 }, (_, i) => start + i);
}

const pagerBtn =
  'grid h-8 min-w-[2rem] place-items-center rounded-lg border border-line bg-surface-muted/40 px-2 font-mono text-xs text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted';

function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <button type="button" aria-label="Previous page" disabled={page <= 0} onClick={() => onPage(page - 1)} className={pagerBtn}>
        <ChevronDown className="h-4 w-4 rotate-90" />
      </button>
      {pageWindow(page, pageCount).map((n) => (
        <button
          type="button"
          key={n}
          aria-current={n === page ? 'page' : undefined}
          onClick={() => onPage(n)}
          className={cn(pagerBtn, n === page && 'border-brand bg-brand-soft/40 text-ink')}
        >
          {n + 1}
        </button>
      ))}
      <button type="button" aria-label="Next page" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)} className={pagerBtn}>
        <ChevronDown className="h-4 w-4 -rotate-90" />
      </button>
    </div>
  );
}

export function MyWallet() {
  const { address, kind, executeContract, signOut, status } = useCircleWallet();
  const addr = (address ?? '0x') as `0x${string}`;
  const { balances, totalUsd, refetch, pricesReady } = useWalletPortfolio(addr);
  const txq = useWalletTransactions(true);

  const [copied, copyAddr] = useCopy(addr);
  const [sendOpen, setSendOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const busy = status === 'executing' || status === 'connecting';
  const method = kind ? KIND_LABEL[kind] : 'Embedded';
  const txs = useMemo(() => txq.data ?? [], [txq.data]);

  // Map known contracts → roles so a transaction can be classified by what the user actually did
  // (router/pool → swap, position manager → liquidity, arena → join/claim) rather than raw transfers.
  const roleOf = useMemo(() => {
    const m = new Map<string, Role>();
    const add = (a: string | undefined, r: Role) => {
      if (a) m.set(a.toLowerCase(), r);
    };
    add(ENV.SWAP_ROUTER_ADDRESS, 'router');
    add(ENV.NPM_ADDRESS, 'npm');
    for (const mk of MARKETS) {
      add(mk.pool, 'pool');
      add(mk.feeArena, 'arena');
    }
    return (a?: string): Role | undefined => (a ? m.get(a.toLowerCase()) : undefined);
  }, []);

  // Collapse each user action into ONE row, then paginate so Activity can't grow unbounded.
  const rows = useMemo(() => classifyWalletTxs(txs, addr, roleOf), [txs, addr, roleOf]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const [activityPage, setActivityPage] = useState(0);
  const page = Math.min(activityPage, pageCount - 1);
  useEffect(() => {
    if (activityPage > pageCount - 1) setActivityPage(0); // a shrinking feed mustn't strand us past the end
  }, [pageCount, activityPage]);
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="space-y-5">
      {/* Header */}
      <header className="flex flex-wrap items-end justify-between gap-3 motion-safe:animate-fade-up">
        <div>
          <span className="kicker">Wallet</span>
          <h1 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-ink">My Wallet</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="brand">Arc Testnet</Badge>
          <span className="rounded-md border border-line bg-surface-muted px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-ink-muted">{method}</span>
        </div>
      </header>

      {/* Portfolio overview */}
      <SectionCard kicker="Total balance" icon={<Wallet className="h-5 w-5" />} title="Portfolio" className="motion-safe:animate-fade-up">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="font-mono text-4xl font-medium tracking-tight text-ink">
              {pricesReady ? fmtUsd(totalUsd) : <span className="text-ink-faint">$ —</span>}
            </div>
            <p className="mt-1 text-xs text-ink-muted">Across {balances.length} assets on Arc Testnet</p>
          </div>
          <div className="flex gap-2.5">
            <button type="button" data-testid="open-send" onClick={() => setSendOpen(true)} className={buttonClass('primary', 'md')}>
              <ArrowUp className="h-4 w-4" /> Send
              <Stars />
            </button>
            <button type="button" data-testid="open-receive" onClick={() => setReceiveOpen(true)} className={buttonClass('secondary', 'md')}>
              <ArrowDown className="h-4 w-4" /> Receive
              <Stars />
            </button>
          </div>
        </div>
      </SectionCard>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        {/* LEFT: assets + activity */}
        <div className="space-y-5 lg:col-span-2">
          <SectionCard title="Assets" kicker="Balances + USD value" icon={<Activity className="h-5 w-5" />} bodyClassName="px-2 py-2">
            <ul>
              {balances.map((b) => (
                <li key={b.token.symbol} className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-surface-muted/40">
                  <TokenGlyph symbol={b.token.symbol} className="h-10 w-10 text-base" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-ink">{b.token.symbol}</div>
                    <div className="font-mono text-[11px] text-ink-muted">
                      {pricesReady && b.priceUsd > 0 ? `${fmtUsd(b.priceUsd)} / ${b.token.symbol}` : 'Arc Testnet'}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-sm text-ink">{fmtAmt(b.amount)}</div>
                    <div className="font-mono text-[11px] text-ink-muted">{pricesReady ? fmtUsd(b.usd) : '—'}</div>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>

          <SectionCard
            title="Activity"
            kicker="Recent transactions"
            icon={<Clock className="h-5 w-5" />}
            bodyClassName="px-2 py-2"
            footer={pageCount > 1 ? <Pager page={page} pageCount={pageCount} onPage={setActivityPage} /> : undefined}
          >
            {txq.isLoading ? (
              <div className="space-y-2 p-1">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-3 px-2 py-2.5">
                    <div className="h-9 w-9 animate-pulse rounded-full bg-surface-muted" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3 w-24 animate-pulse rounded bg-surface-muted" />
                      <div className="h-2.5 w-40 animate-pulse rounded bg-surface-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : rows.length > 0 ? (
              // min-height keeps the card a stable size (and aligned with the right column) even when
              // the last page is partial.
              <div className="min-h-[26rem]">
                <div className="divide-y divide-line/60">
                  {pageRows.map((row) => (
                    <ActionRow key={row.id} row={row} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <span className="grid h-11 w-11 place-items-center rounded-full border border-line bg-surface-muted/50 text-ink-faint">
                  <Clock className="h-5 w-5" />
                </span>
                <p className="text-sm font-medium text-ink-soft">No transactions yet</p>
                <p className="max-w-xs text-xs text-ink-muted">
                  Your sends, receives, and on-chain actions on Arc will appear here.
                </p>
              </div>
            )}
          </SectionCard>
        </div>

        {/* RIGHT: receive + network + settings */}
        <div className="space-y-5">
          <SectionCard title="Receive" kicker="Your Arc address" icon={<ArrowDown className="h-5 w-5" />}>
            <div className="flex flex-col items-center gap-4">
              <QrCode value={addr} className="h-40 w-40" />
              <div className="w-full rounded-xl border border-line bg-surface-muted/40 px-3 py-2.5">
                <div className="break-all text-center font-mono text-xs text-ink-soft">{addr}</div>
              </div>
              <div className="flex w-full gap-2">
                <button type="button" data-testid="copy-address" onClick={copyAddr} className={buttonClass('secondary', 'sm', 'flex-1')}>
                  {copied ? <><Check className="h-4 w-4 text-side-up" /> Copied</> : <><Copy className="h-4 w-4" /> Copy</>}
                  <Stars />
                </button>
                <a href={`${ENV.EXPLORER_URL}/address/${addr}`} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'sm', 'flex-1')}>
                  <External className="h-4 w-4" /> ArcScan
                  <Stars />
                </a>
              </div>
              <p className="flex items-start gap-1.5 text-[11px] text-ink-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                Only send Arc Testnet assets to this address.
              </p>
            </div>
          </SectionCard>

          <SectionCard title="Network" kicker="Connection" icon={<Shield className="h-5 w-5" />}>
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-ink-muted">Network</dt>
                <dd className="font-medium text-ink">Arc Testnet</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-muted">Chain ID</dt>
                <dd className="font-mono text-ink">{ENV.CHAIN_ID}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-ink-muted">Gas token</dt>
                <dd className="font-medium text-ink">USDC</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="shrink-0 text-ink-muted">Explorer</dt>
                <dd className="truncate">
                  <a href={ENV.EXPLORER_URL} target="_blank" rel="noreferrer" className="font-mono text-xs text-brand hover:underline">
                    {ENV.EXPLORER_URL.replace(/^https?:\/\//, '')}
                  </a>
                </dd>
              </div>
            </dl>
          </SectionCard>

          <SectionCard title="Settings" kicker="Account" icon={<Settings className="h-5 w-5" />}>
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">Signed in with</span>
                <span className="font-medium text-ink">{method}</span>
              </div>
              <p className="flex items-start gap-1.5 rounded-lg border border-line bg-surface-muted/40 px-3 py-2 text-[11px] text-ink-muted">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                Non-custodial · your key is MPC-secured and never leaves your device. Recover by signing in again.
              </p>
              <button
                type="button"
                data-testid="wallet-signout"
                onClick={signOut}
                className={buttonClass('secondary', 'md', 'w-full')}
              >
                <Lock className="h-4 w-4" /> Sign out
                <Stars />
              </button>
            </div>
          </SectionCard>
        </div>
      </div>

      {/* Dialogs */}
      {sendOpen && (
        <Dialog title="Send" onClose={() => setSendOpen(false)}>
          <SendForm balances={balances} busy={busy} executeContract={executeContract} refetch={refetch} />
        </Dialog>
      )}
      {receiveOpen && (
        <Dialog title="Receive" onClose={() => setReceiveOpen(false)}>
          <div className="flex flex-col items-center gap-4">
            <QrCode value={addr} className="h-52 w-52" />
            <div className="w-full break-all rounded-xl border border-line bg-surface-muted/40 px-3 py-2.5 text-center font-mono text-xs text-ink-soft">
              {addr}
            </div>
            <button type="button" onClick={copyAddr} className={buttonClass('primary', 'md', 'w-full')}>
              {copied ? <><Check className="h-4 w-4" /> Copied</> : <><Copy className="h-4 w-4" /> Copy address</>}
              <Stars />
            </button>
            <p className="text-center text-[11px] text-ink-muted">Only send Arc Testnet assets to this address.</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
