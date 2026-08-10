'use client';

// components/pool/DepositPanel.tsx — the "Add deposit amount" module (reference image #3, right card).
// Two linked token rows (last-edited drives, the other is the bigint-exact counterpart), 50% / Max
// shortcuts, a USD split bar, the total, and the approve→provide CTA. All mechanics come from
// useLiquidityDeposit; the RANGE is owned by the page (chart handles + presets) and passed to the hook.
import type { PoolInfo } from '@/lib/pools';
import type { LiquidityDeposit } from '@/hooks/useLiquidityDeposit';
import { usePoolStats } from '@/hooks/usePoolStats';
import { toHuman, formatUsd } from '@/lib/poolStats';
import { formatBase, formatUSDC } from '@/lib/format';
import { TokenGlyph } from '@/components/TokenGlyph';
import { TxButton } from '@/components/TxButton';
import { buttonClass } from '@/components/ui/Button';
import { Stars } from '@/components/ui/Stars';
import { Faucet, External, Alert, Plus } from '@/components/ui/icons';
import { ENV } from '@/lib/env';
import { cn } from '@/lib/cn';

const FAUCET_URL = 'https://faucet.circle.com';

function AmountRow({
  symbol,
  value,
  onChange,
  onHalf,
  onMax,
  balanceLabel,
  usdLabel,
  insufficient,
  approx,
  readOnly,
  disabled,
  testid,
}: {
  symbol: string;
  value: string;
  onChange: (v: string) => void;
  onHalf: () => void;
  onMax: () => void;
  balanceLabel: string;
  usdLabel: string;
  insufficient: boolean;
  approx: boolean;
  readOnly: boolean;
  disabled: boolean;
  testid: string;
}) {
  return (
    <div className="rounded-2xl bg-surface-muted px-4 py-3 transition-shadow focus-within:shadow-focus">
      <div className="flex items-center justify-between gap-2">
        <span className="kicker normal-case tracking-normal text-ink-muted">{symbol}</span>
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-mono text-ink-muted" data-testid={`${testid}-balance`}>
            {balanceLabel}
          </span>
          <button
            type="button"
            onClick={onHalf}
            disabled={disabled || readOnly}
            className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-medium text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
          >
            50%
          </button>
          <button
            type="button"
            onClick={onMax}
            disabled={disabled || readOnly}
            className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-medium text-brand transition-colors hover:text-brand-hover disabled:opacity-50"
          >
            Max
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-3">
        {approx && (
          <span aria-hidden="true" className="shrink-0 text-[26px] font-medium leading-tight text-ink-muted">
            ≈
          </span>
        )}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          readOnly={readOnly}
          disabled={disabled}
          aria-label={`Amount of ${symbol} to deposit`}
          data-testid={testid}
          className={cn(
            'w-full bg-transparent font-mono text-[26px] font-medium leading-tight tracking-tight text-ink outline-none placeholder:text-ink-faint',
            readOnly && 'cursor-default text-ink-muted',
          )}
        />
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-line bg-surface py-1.5 pl-1.5 pr-2.5 font-mono text-[15px] font-semibold text-ink">
          <TokenGlyph symbol={symbol} />
          {symbol}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[12px]">
        <span className="font-mono text-ink-muted">{usdLabel}</span>
        {insufficient && <span className="text-side-down">Insufficient {symbol}</span>}
      </div>
    </div>
  );
}

export function DepositPanel({ pool, deposit }: { pool: PoolInfo; deposit: LiquidityDeposit }) {
  const { prices } = usePoolStats();
  const baseUsd = prices?.[pool.base.symbol] ?? (pool.quote.symbol === 'USDC' ? deposit.currentPrice ?? 0 : 0);
  const quoteUsd = prices?.[pool.quote.symbol] ?? (pool.quote.symbol === 'USDC' ? 1 : 0);

  const baseUsdValue = toHuman(deposit.baseAmount, pool.base.decimals) * baseUsd;
  const quoteUsdValue = toHuman(deposit.usdcAmount, pool.quote.decimals) * quoteUsd;
  const totalUsd = baseUsdValue + quoteUsdValue;
  const baseShare = totalUsd > 0 ? (baseUsdValue / totalUsd) * 100 : 50;

  const label = deposit.provideBusy
    ? 'Providing liquidity…'
    : !deposit.isConnected
      ? 'Connect wallet to provide'
      : !deposit.rangeReady
        ? 'Set a range'
        : !deposit.amountsEntered
          ? 'Enter an amount'
          : deposit.needsApproval
            ? 'Approve tokens first'
            : 'Provide liquidity';

  return (
    <div data-testid="deposit-panel">
      <h3 className="mb-3 font-display text-[15px] font-semibold text-ink">Add deposit amount</h3>

      {/* Faucet hint — base is a real Circle token (no wrap/public mint). */}
      {deposit.isConnected && deposit.baseLow && (
        <a
          href={FAUCET_URL}
          target="_blank"
          rel="noreferrer"
          className="mb-2.5 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface-muted px-3 py-2 text-xs font-medium text-brand hover:text-brand-hover"
        >
          <Faucet className="h-3.5 w-3.5" /> Get {pool.base.symbol} from the Circle faucet
          <External className="h-3 w-3" />
        </a>
      )}

      <div className="space-y-2">
        <AmountRow
          symbol={pool.base.symbol}
          value={deposit.baseValue}
          onChange={deposit.onBaseChange}
          onHalf={() => deposit.onFractionBase(0.5)}
          onMax={deposit.onMaxBase}
          balanceLabel={`${formatBase(deposit.baseBalance, pool.base.decimals)}`}
          usdLabel={formatUsd(baseUsdValue)}
          insufficient={deposit.insufficientBase && !deposit.provideBusy}
          approx={deposit.baseApprox}
          readOnly={deposit.baseExcluded}
          disabled={!deposit.isConnected}
          testid="dp-base-input"
        />
        {/* linked-legs divider */}
        <div className="relative z-[1] mx-auto -my-3 grid h-7 w-7 place-items-center rounded-full border border-line bg-surface text-ink-muted">
          <Plus className="h-3.5 w-3.5" />
        </div>
        <AmountRow
          symbol={pool.quote.symbol}
          value={deposit.usdcValue}
          onChange={deposit.onUsdcChange}
          onHalf={() => deposit.onFractionUsdc(0.5)}
          onMax={deposit.onMaxUsdc}
          balanceLabel={`${formatUSDC(deposit.usdcBalance)}`}
          usdLabel={formatUsd(quoteUsdValue)}
          insufficient={deposit.insufficientUsdc && !deposit.provideBusy}
          approx={deposit.usdcApprox}
          readOnly={deposit.usdcExcluded}
          disabled={!deposit.isConnected}
          testid="dp-quote-input"
        />
      </div>

      {/* USD split bar */}
      <div className="mt-3">
        <div className="flex items-center justify-between text-[12px] text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <TokenGlyph symbol={pool.base.symbol} className="h-4 w-4 text-[9px]" />
            {Math.round(baseShare)}%
          </span>
          <span className="inline-flex items-center gap-1.5">
            {Math.round(100 - baseShare)}%
            <TokenGlyph symbol={pool.quote.symbol} className="h-4 w-4 text-[9px]" />
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div className="h-full rounded-full bg-side-up" style={{ width: `${baseShare}%` }} />
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-sm">
        <span className="text-ink-muted">Total deposit</span>
        <span className="font-mono font-semibold text-ink tnum" data-testid="dp-total">
          {formatUsd(totalUsd)}
        </span>
      </div>

      {/* Out-of-range one-sided warning */}
      {deposit.outOfRange && (
        <p
          data-testid="dp-oor"
          className="mt-3 flex items-start gap-1.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px] leading-snug text-amber-700 dark:text-amber-300"
        >
          <Alert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Price is outside this range — you’ll deposit only{' '}
            {deposit.baseActive ? pool.base.symbol : pool.quote.symbol} and earn no fees until price
            re-enters the band.
          </span>
        </p>
      )}

      {/* Approvals (only when needed) */}
      {(deposit.baseApproval.needsApproval || deposit.usdcApproval.needsApproval) && deposit.amountsEntered && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="dp-approvals">
          <span className="text-xs text-ink-muted">Approve the position manager:</span>
          {deposit.baseApproval.needsApproval && (
            <TxButton
              label={`Approve ${pool.base.symbol}`}
              disabled={deposit.baseApproval.isPending}
              isPending={deposit.baseApproval.isPending}
              onClick={() => void deposit.baseApproval.approve()}
              txHash={deposit.baseApproval.hash}
            />
          )}
          {deposit.usdcApproval.needsApproval && (
            <TxButton
              label={`Approve ${pool.quote.symbol}`}
              disabled={deposit.usdcApproval.isPending}
              isPending={deposit.usdcApproval.isPending}
              onClick={() => void deposit.usdcApproval.approve()}
              txHash={deposit.usdcApproval.hash}
            />
          )}
        </div>
      )}

      {/* Primary CTA */}
      <button
        type="button"
        data-testid="dp-submit"
        disabled={!deposit.canMint}
        onClick={() => void deposit.onMint()}
        className={cn(buttonClass('primary', 'lg', 'mt-4 w-full'))}
      >
        {label}
        <Stars />
      </button>

      {deposit.mintHash && (
        <a
          href={`${ENV.EXPLORER_URL}/tx/${deposit.mintHash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:text-brand-hover"
        >
          View mint on ArcScan <External className="h-3 w-3" />
        </a>
      )}
      {deposit.mintError && (
        <p role="alert" className="mt-2 text-sm text-side-down">
          {deposit.mintError.message}
        </p>
      )}
    </div>
  );
}
