// scripts/keeper/gasWatchdog.mjs — self-healing gas for the settlement keeper.
//
// THE PROBLEM IT SOLVES: the keeper crank signer pays native USDC for every settlement tx (+ a Pyth
// update per settle, across 3 markets on short epochs). It drains steadily, and the keeper itself only
// WARNs on low balance — it never refills. When the signer hits the floor, every settle fails with
// "insufficient funds for gas" and ALL markets wedge on "Settlement in progress…" until a human funds it.
//
// THIS WATCHDOG runs as its OWN container (decoupled from the keeper, so it keeps refilling even if the
// keeper is unhealthy). Each tick it reads the keeper signer's balance and, when it dips below a
// threshold, tops it up from the owner reserve — keeping the signer well ABOVE the keeper's own floor so
// it can never wedge on gas. It NEVER drains the reserve below a safety floor, caps each refill, and
// alerts loudly (in its log) when the reserve runs low so an operator can top it up from the faucet.
//
// It signs refills with the OWNER key only (KEEPER_OWNER_PRIVATE_KEY); it merely DERIVES the keeper
// signer address from KEEPER_PRIVATE_KEY (never signs with it), so it auto-tracks the right signer.
import { createPublicClient, createWalletClient, http, fallback, formatEther, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const env = process.env;
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), svc: 'gas-watchdog', ...o }));
const die = (m) => {
  log({ msg: 'fatal', error: m });
  process.exit(1);
};

const RPC_URLS = (env.KEEPER_RPC_URL || env.ARC_RPC_URL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (!RPC_URLS.length) die('no KEEPER_RPC_URL / ARC_RPC_URL configured');

const HEX64 = /^0x[0-9a-fA-F]{64}$/;
const ownerKey = env.KEEPER_OWNER_PRIVATE_KEY;
if (!HEX64.test(ownerKey || '')) die('KEEPER_OWNER_PRIVATE_KEY missing/invalid (the funded reserve)');
const keeperKey = env.KEEPER_PRIVATE_KEY;
if (!HEX64.test(keeperKey || '')) die('KEEPER_PRIVATE_KEY missing/invalid (the signer to top up)');

const CHAIN_ID = Number(env.KEEPER_CHAIN_ID || '5042002');
const chain = {
  id: CHAIN_ID,
  name: 'arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
};

// Tunables (USDC). Defaults keep the signer oscillating ~3 -> ~12, far above the keeper's 0.5 floor.
const REFILL_BELOW = parseEther(env.GASWD_REFILL_BELOW_USDC || '3'); // top up when signer dips below this
const REFILL_TO = parseEther(env.GASWD_REFILL_TO_USDC || '12'); // bring the signer up to this
const RESERVE_MIN = parseEther(env.GASWD_RESERVE_MIN_USDC || '3'); // NEVER drain the owner below this
const RESERVE_WARN = parseEther(env.GASWD_RESERVE_WARN_USDC || '25'); // alert to refill the reserve below this
const MAX_PER_REFILL = parseEther(env.GASWD_MAX_PER_REFILL_USDC || '25'); // hard cap on a single transfer
const intervalRaw = Number(env.GASWD_INTERVAL_MS || '30000'); // guard a non-numeric value -> NaN -> 0ms spin
const INTERVAL = Number.isFinite(intervalRaw) ? Math.max(10_000, intervalRaw) : 30_000;
const GAS = BigInt(env.GAS_FLOOR_GWEI || '28') * 1_000_000_000n; // bid the same floor the keeper uses
// Headroom for the refill tx's OWN gas (a native transfer is 21k gas) so a refill never dips the reserve
// below RESERVE_MIN — the owner pays `amount` as value PLUS this gas fee from the same balance.
const GAS_RESERVE = 30_000n * GAS;
if (REFILL_TO <= REFILL_BELOW) die('GASWD_REFILL_TO_USDC must be greater than GASWD_REFILL_BELOW_USDC');

// REFILL-SAFE INTERLOCK. The keeper rewrites a tiny sentinel ({ts, refillSafe}) every poll pass.
// We refill ONLY when that sentinel is FRESH and refillSafe===true. This is what stops the watchdog
// from being a blind "drain pump": a keeper whose spend cap has TRIPPED publishes refillSafe:false,
// and a CRASH-LOOPING keeper never rewrites the sentinel so it goes STALE — in both cases we fail
// CLOSED (no refill), disconnecting the reserve from a keeper that's burning pathologically. The
// interlock is OPT-IN: leave GASWD_REFILL_SAFE_FILE unset to keep the old always-refill behavior.
const REFILL_SAFE_FILE = (env.GASWD_REFILL_SAFE_FILE || '').trim();
const staleRaw = Number(env.GASWD_REFILL_SAFE_STALE_MS || '120000');
const REFILL_SAFE_STALE_MS = Number.isFinite(staleRaw) ? Math.max(30_000, staleRaw) : 120_000;

/**
 * Decide whether it's safe to refill the keeper signer right now, reading the keeper's sentinel.
 * Fails CLOSED on every uncertainty (no file, unreadable, unparseable, stale ts, refillSafe!==true).
 * When the interlock is not configured (no path) it returns safe — preserving prior behavior.
 */
function refillSafe() {
  if (!REFILL_SAFE_FILE) return { safe: true, reason: 'interlock-disabled' };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(REFILL_SAFE_FILE, 'utf8'));
  } catch (e) {
    return { safe: false, reason: `sentinel-unreadable:${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { safe: false, reason: 'sentinel-malformed' };
  if (parsed.refillSafe !== true) return { safe: false, reason: `refillSafe=${parsed.refillSafe} (${parsed.reason ?? 'n/a'})` };
  const ts = Number(parsed.ts);
  if (!Number.isFinite(ts)) return { safe: false, reason: 'sentinel-no-ts' };
  const age = Date.now() - ts;
  if (age > REFILL_SAFE_STALE_MS) return { safe: false, reason: `sentinel-stale:${Math.round(age / 1000)}s` };
  return { safe: true, reason: 'fresh' };
}

const transport = fallback(RPC_URLS.map((u) => http(u, { timeout: 10_000 })));
const pub = createPublicClient({ chain, transport });
const owner = privateKeyToAccount(ownerKey);
const wallet = createWalletClient({ account: owner, chain, transport });
const keeperSigner = privateKeyToAccount(keeperKey).address;

if (owner.address.toLowerCase() === keeperSigner.toLowerCase()) {
  die('owner and keeper signer are the SAME address — refusing to run (refill would be a no-op self-send)');
}

let busy = false; // re-entrancy guard: a slow tick must never overlap the next and double-send
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const [kbal, obal] = await Promise.all([
      pub.getBalance({ address: keeperSigner }),
      pub.getBalance({ address: owner.address }),
    ]);

    if (kbal >= REFILL_BELOW) {
      if (obal < RESERVE_WARN)
        log({ msg: 'WARN reserve low — top up the owner from the faucet', reserveUsdc: formatEther(obal), owner: owner.address });
      else log({ msg: 'ok', keeperUsdc: formatEther(kbal), reserveUsdc: formatEther(obal) });
      return;
    }

    // Signer is low and wants a refill — but FAIL CLOSED unless the keeper says it's safe. A tripped
    // spend cap (refillSafe:false) or a crash-looping keeper (stale sentinel) must NOT be refilled, or
    // the watchdog just pumps the reserve into a keeper that's burning pathologically.
    const rs = refillSafe();
    if (!rs.safe) {
      log({ msg: 'refill BLOCKED — keeper not in a refill-safe state (failing closed)', reason: rs.reason, keeperUsdc: formatEther(kbal), reserveUsdc: formatEther(obal) });
      return;
    }

    // Signer is low — compute a safe refill that never breaches the reserve floor (value + this tx's gas)
    // or the per-tx cap.
    const spendable = obal > RESERVE_MIN + GAS_RESERVE ? obal - RESERVE_MIN - GAS_RESERVE : 0n;
    if (spendable <= 0n) {
      log({
        msg: 'ALERT reserve DEPLETED — cannot refill the keeper signer; FUND the owner NOW',
        keeperUsdc: formatEther(kbal),
        reserveUsdc: formatEther(obal),
        owner: owner.address,
      });
      return;
    }
    let amount = REFILL_TO - kbal;
    if (amount > spendable) amount = spendable;
    if (amount > MAX_PER_REFILL) amount = MAX_PER_REFILL;

    log({ msg: 'refilling keeper signer', keeperUsdc: formatEther(kbal), sendUsdc: formatEther(amount), reserveUsdc: formatEther(obal) });
    const hash = await wallet.sendTransaction({
      to: keeperSigner,
      value: amount,
      maxFeePerGas: GAS,
      maxPriorityFeePerGas: GAS,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    const after = await pub.getBalance({ address: keeperSigner });
    const gasPaid = rcpt.gasUsed * (rcpt.effectiveGasPrice ?? GAS);
    log({
      msg: rcpt.status === 'success' ? 'REFILLED keeper signer' : 'refill tx REVERTED',
      txHash: hash,
      status: rcpt.status,
      sentUsdc: formatEther(amount),
      keeperAfterUsdc: formatEther(after),
    });
    const reserveAfter = obal - amount - gasPaid;
    if (reserveAfter < RESERVE_WARN)
      log({ msg: 'WARN reserve low after refill — top up the owner from the faucet', reserveUsdc: formatEther(reserveAfter), owner: owner.address });
  } catch (e) {
    log({ msg: 'tick.error', error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy = false;
  }
}

log({
  msg: 'gas-watchdog started',
  keeperSigner,
  owner: owner.address,
  refillBelowUsdc: formatEther(REFILL_BELOW),
  refillToUsdc: formatEther(REFILL_TO),
  reserveMinUsdc: formatEther(RESERVE_MIN),
  reserveWarnUsdc: formatEther(RESERVE_WARN),
  intervalMs: INTERVAL,
  gasGwei: Number(GAS / 1_000_000_000n),
  refillSafeInterlock: REFILL_SAFE_FILE ? { file: REFILL_SAFE_FILE, staleMs: REFILL_SAFE_STALE_MS } : 'disabled',
});
// Defense-in-depth: never let a stray rejection/exception take the watchdog down — log and keep running.
process.on('unhandledRejection', (e) => log({ msg: 'unhandledRejection', error: e instanceof Error ? e.message : String(e) }));
process.on('uncaughtException', (e) => log({ msg: 'uncaughtException', error: e instanceof Error ? e.message : String(e) }));

// Self-rescheduling loop: the NEXT tick is scheduled INTERVAL after the current one FINISHES (tick never
// rejects — it wraps everything in try/finally), so slow refills can't pile up a backlog of ticks.
const loop = () => {
  tick().finally(() => setTimeout(loop, INTERVAL));
};
loop();
