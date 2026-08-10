// agentFunding.ts — the agent's budget line to its Circle Agent Wallet treasury.
//
// The treasury is a 2-of-2 MPC wallet operated through the Circle CLI. Findings from the
// live encoding survey (docs/AGENT.md): `circle wallet execute` only encodes FLAT scalar
// params today, so the recurring on-chain actions (NPM mint takes a struct, stakeWithSide
// takes bytes[]) cannot be MPC-signed directly. What IS first-class is `circle wallet
// transfer` — so the treasury rail is a funding rail: when the execution signer is short,
// the agent draws the shortfall (never more than one mandate-capped stake plus a gas
// margin) from the Agent Wallet, waits for the balance to land, and proceeds. On Arc the
// native token IS USDC, so one native transfer covers both gas and the LP quote leg.
//
// planTopUp / planTokenTopUp are pure and fail closed; the CLI wrapper never sees keys —
// signing happens inside Circle's MPC, the keeper only shells out the transfer request.
import { spawn } from 'node:child_process';

const WEI_PER_USDC6 = 1_000_000_000_000n; // usdc6 -> native 18dp
const TOPUP_GRANULARITY_WEI = 1_000_000_000_000_000n; // round requests up to 0.001 USDC

export type TopUpPlan =
  | { fund: false; reason: 'sufficient' | 'exceeds-cap' }
  | { fund: true; amountWei: bigint; amount: string };

/** Decimal string for a native amount, trimmed (the CLI takes human units). */
export function formatUnits(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac === '' ? whole.toString() : `${whole.toString()}.${frac}`;
}

/**
 * How much native USDC (18dp) to draw from the treasury so the signer can cover one
 * mandate-capped stake plus gas. Never proposes more than that same bound in a single
 * transfer — a runaway loop cannot drain the treasury faster than the mandate allows.
 */
export function planTopUp(input: {
  balanceWei: bigint;
  quoteLegUsdc6: bigint;
  gasMarginWei: bigint;
}): TopUpPlan {
  const { balanceWei, quoteLegUsdc6, gasMarginWei } = input;
  if (balanceWei < 0n || quoteLegUsdc6 <= 0n || gasMarginWei < 0n) return { fund: false, reason: 'exceeds-cap' };
  const needWei = quoteLegUsdc6 * WEI_PER_USDC6 + gasMarginWei;
  if (balanceWei >= needWei) return { fund: false, reason: 'sufficient' };
  let shortfall = needWei - balanceWei;
  shortfall = ((shortfall + TOPUP_GRANULARITY_WEI - 1n) / TOPUP_GRANULARITY_WEI) * TOPUP_GRANULARITY_WEI;
  // One transfer may never exceed one full stake + margin, even if balance reads garbage.
  if (shortfall > needWei) return { fund: false, reason: 'exceeds-cap' };
  return { fund: true, amountWei: shortfall, amount: formatUnits(shortfall, 18) };
}

/** ERC20 leg (the LP's base token): fund exactly the shortfall for one mint, no more. */
export function planTokenTopUp(input: {
  balanceUnits: bigint;
  needUnits: bigint;
  decimals: number;
}): TopUpPlan {
  const { balanceUnits, needUnits, decimals } = input;
  if (balanceUnits < 0n || needUnits <= 0n || decimals <= 0) return { fund: false, reason: 'exceeds-cap' };
  if (balanceUnits >= needUnits) return { fund: false, reason: 'sufficient' };
  const shortfall = needUnits - balanceUnits;
  return { fund: true, amountWei: shortfall, amount: formatUnits(shortfall, decimals) };
}

/** The exact argv for `circle wallet transfer` — pure so tests can pin it. */
export function buildTransferArgs(input: {
  to: string;
  amount: string;
  from: string;
  chain: string;
  token?: string;
}): string[] {
  const args = ['wallet', 'transfer', input.to, '--amount', input.amount, '--address', input.from, '--chain', input.chain];
  if (input.token !== undefined) args.push('--token', input.token);
  args.push('--output', 'json');
  return args;
}

export interface CircleTransferResult {
  ok: boolean;
  detail: string;
}

/**
 * Shell out to the Circle CLI (the MPC co-signer lives behind it; no key material here).
 * The CLI session is device+email bound — if it is missing or expired this rejects and
 * the agent skips the epoch rather than guessing.
 */
export function runCircleTransfer(args: string[], timeoutMs: number): Promise<CircleTransferResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('circle', args, {
      shell: process.platform === 'win32',
      env: { ...process.env, CIRCLE_ACCEPT_TERMS: '1' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`circle transfer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const detail = (out + err).slice(0, 2_000);
      if (code === 0 && !/error/i.test(err)) resolve({ ok: true, detail });
      else resolve({ ok: false, detail });
    });
  });
}
