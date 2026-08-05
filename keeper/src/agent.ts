// agent.ts - the Limen Agent's ACT layer: a policy-bounded, signal-driven epoch participant.
//
// A SEPARATE process with a SEPARATE key (LIMEN_AGENT_PRIVATE_KEY), OFF unless
// LIMEN_AGENT_ENABLED=true. Each poll it reads the live epoch, computes the same stance
// signal the Advise panel shows (pure quant over Pyth benchmark bars - see agentQuant.ts),
// and asks the PURE mandate engine (decideAgent.ts) whether entering is allowed: allowed
// views, confidence floor, mandate expiry, entry-window floor, once-per-epoch. Only a full
// YES mints/uses its LP position and stakes the recommended side - the same entry-anchored
// stakeWithSide flow the stakerbot exercises, so nothing here touches user funds or adds a
// new contract surface. The once-per-epoch guard is the persisted epoch ledger (restart-safe).
//
// Funding model: this wallet's budget is intended to be drawn from a Circle Agent Wallet
// (2-of-2 MPC treasury) - see docs/AGENT.md. On Arc testnet, Circle's wallet-layer spending
// policies are mainnet-only, so THIS process's mandate engine is the enforcement until then.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { erc20Abi, pythAbi } from './abi.js';
import { fetchPythUpdateWithPrice } from './hermes.js';
import { fullRangeTicks, canAffordStake, npmAbi, arenaAbi } from './stakerbot.js';
import { computeStanceSignal, renderRationale, type StanceSignal } from './agentQuant.js';
import { planTopUp, planTokenTopUp, buildTransferArgs, runCircleTransfer } from './agentFunding.js';
import { decideAgentEntry } from './decideAgent.js';
import { loadEpochLedger, saveEpochLedgerSync, shouldActThisEpoch, recordEpochActed, type EpochLedger } from './epochLedger.js';
import { loadAgentBotConfig, type AgentBotConfig } from './config.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_UINT256 = 2n ** 256n - 1n;
const MIN_OPERATING_WEI = 5_000_000_000_000_000n;

const log = (o: Record<string, unknown>): void =>
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

// ─── Price history (Pyth benchmarks, same source/shape as the frontend agent) ───────────

const BENCHMARKS = 'https://benchmarks.pyth.network/v1/shims/tradingview/history';
const FEED_SYMBOLS: Record<string, string> = {
  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43': 'Crypto.BTC/USD',
  '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b': 'FX.EUR/USD',
};

async function fetchCloses(symbol: string, fromSec: number, toSec: number, timeoutMs: number): Promise<number[]> {
  const url = `${BENCHMARKS}?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${fromSec}&to=${toSec}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`benchmarks ${res.status} for ${symbol}`);
  const body = (await res.json()) as { s: string; c?: number[] };
  if (body.s !== 'ok' || !Array.isArray(body.c) || body.c.length === 0) throw new Error(`no bars for ${symbol}`);
  return body.c;
}

async function fetchMarketCloses(cfg: AgentBotConfig, windowSec = 3_600): Promise<number[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const baseSym = FEED_SYMBOLS[cfg.market.feedId.toLowerCase()];
  if (!baseSym) throw new Error(`no benchmarks symbol for feed ${cfg.market.feedId}`);
  const from = nowSec - windowSec;
  const quoteFeedId = cfg.market.quoteFeedId;
  if (!quoteFeedId) return fetchCloses(baseSym, from, nowSec, cfg.hermesTimeoutMs);
  const quoteSym = FEED_SYMBOLS[quoteFeedId.toLowerCase()];
  if (!quoteSym) throw new Error(`no benchmarks symbol for quote feed ${quoteFeedId}`);
  const [b, q] = await Promise.all([
    fetchCloses(baseSym, from, nowSec, cfg.hermesTimeoutMs),
    fetchCloses(quoteSym, from, nowSec, cfg.hermesTimeoutMs),
  ]);
  const n = Math.min(b.length, q.length);
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const bb = b[b.length - n + i];
    const qq = q[q.length - n + i];
    if (bb === undefined || qq === undefined || !(qq > 0)) throw new Error('quote leg has a non-positive close');
    out.push(bb / qq);
  }
  return out;
}

// ─── Execution (mirrors the stakerbot's mint/approve/stake, with a per-signal side) ──────

interface AgentRuntime {
  account: Account;
  wallet: WalletClient;
  tokenId: bigint | null;
  approvedForAll: boolean;
  ledger: EpochLedger;
}

async function discoverTokenId(client: PublicClient, cfg: AgentBotConfig, owner: `0x${string}`): Promise<bigint | null> {
  const bal = (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'balanceOf', args: [owner] })) as bigint;
  if (bal > 0n) {
    return (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [owner, 0n] })) as bigint;
  }
  const staked = (await client.readContract({ address: cfg.arena, abi: arenaAbi, functionName: 'getUserStakes', args: [owner] })) as readonly { tokenId: bigint }[];
  if (staked.length > 0) return staked[staked.length - 1]!.tokenId;
  return null;
}

async function mintLp(client: PublicClient, rt: AgentRuntime, chain: Chain, cfg: AgentBotConfig): Promise<bigint> {
  const gas = { maxFeePerGas: cfg.gasFloorWei, maxPriorityFeePerGas: cfg.gasFloorWei } as const;
  // The QUOTE leg is the mandate's budget cap - the agent can never mint a bigger position.
  const mintUsdc = cfg.policy.maxStakeUsdc6;
  for (const [token, need] of [
    [cfg.market.base, cfg.mintBase] as const,
    [cfg.market.quote, mintUsdc] as const,
  ]) {
    const allowance = (await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [rt.account.address, cfg.npm] })) as bigint;
    if (allowance < need) {
      const tx = (await rt.wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', account: rt.account, chain, ...gas, args: [cfg.npm, MAX_UINT256] } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
      await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
    }
  }
  const baseIsToken0 = BigInt(cfg.market.base) < BigInt(cfg.market.quote);
  const [token0, token1] = baseIsToken0 ? [cfg.market.base, cfg.market.quote] : [cfg.market.quote, cfg.market.base];
  const [amount0, amount1] = baseIsToken0 ? [cfg.mintBase, mintUsdc] : [mintUsdc, cfg.mintBase];
  const { tickLower, tickUpper } = fullRangeTicks(cfg.market.feeTier);
  const params = {
    token0,
    token1,
    fee: cfg.market.feeTier,
    tickLower,
    tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: rt.account.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  // Explicit gas bound: with fee params in the call, the node pre-deducts gasLimit×maxFee
  // from the balance BEFORE simulating; unbounded it assumes the RPC's ~16.7M cap, which
  // eats ~0.33 USDC of a tightly-funded signer and fails the mint's own transfer (STF).
  const sim = await client.simulateContract({ account: rt.account, address: cfg.npm, abi: npmAbi, functionName: 'mint', args: [params], gas: 1_500_000n });
  const tokenId = (sim.result as readonly [bigint, bigint, bigint, bigint])[0];
  const tx = (await rt.wallet.writeContract({ ...sim.request, ...gas } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
  await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
  log({ msg: 'agent.mint', signer: rt.account.address, tokenId, quoteLegUsdc6: mintUsdc, txHash: tx });
  return tokenId;
}

async function ensureApproval(client: PublicClient, rt: AgentRuntime, chain: Chain, cfg: AgentBotConfig): Promise<void> {
  if (rt.approvedForAll) return;
  const ok = (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'isApprovedForAll', args: [rt.account.address, cfg.arena] })) as boolean;
  if (!ok) {
    const tx = (await rt.wallet.writeContract({ address: cfg.npm, abi: npmAbi, functionName: 'setApprovalForAll', account: rt.account, chain, maxFeePerGas: cfg.gasFloorWei, maxPriorityFeePerGas: cfg.gasFloorWei, args: [cfg.arena, true] } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
    await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
    log({ msg: 'agent.approveAll', txHash: tx });
  }
  rt.approvedForAll = true;
}

async function stakeSide(client: PublicClient, rt: AgentRuntime, chain: Chain, cfg: AgentBotConfig, tokenId: bigint, side: 1 | 2 | 3): Promise<boolean> {
  const { updateData, price18 } = await fetchPythUpdateWithPrice(cfg.hermesUrl, cfg.market.feedId, cfg.hermesTimeoutMs);
  const fee = (await client.readContract({ address: cfg.pythAddress, abi: pythAbi, functionName: 'getUpdateFee', args: [updateData] })) as bigint;
  const tx = (await rt.wallet.writeContract({
    address: cfg.arena,
    abi: arenaAbi,
    functionName: 'stakeWithSide',
    account: rt.account,
    chain,
    maxFeePerGas: cfg.gasFloorWei,
    maxPriorityFeePerGas: cfg.gasFloorWei,
    value: fee,
    args: [tokenId, side, price18, cfg.maxDeviationBps, updateData],
  } as unknown as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
  const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
  if (receipt.status !== 'success') {
    log({ msg: 'agent.stake.reverted', tokenId, side, txHash: tx });
    return false;
  }
  log({ msg: 'agent.stake', tokenId, side, entryPrice18: price18, txHash: tx });
  return true;
}

// ─── Treasury funding (Circle Agent Wallet → execution signer, mandate-capped) ───────────

async function awaitBalanceAtLeast(client: PublicClient, address: `0x${string}`, minWei: bigint, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await client.getBalance({ address })) >= minWei) return true;
    if (Date.now() >= deadline) return false;
    await sleep(3_000);
  }
}

/**
 * Draw the native shortfall (gas + one mandate-capped LP quote leg) from the Circle Agent
 * Wallet. On Arc the native token IS USDC, so this one transfer funds both. Returns true
 * when the signer's balance covers a stake afterwards. Fails closed: any CLI error means
 * "skip this epoch", never "guess".
 */
async function fundNativeFromTreasury(client: PublicClient, cfg: AgentBotConfig, signer: `0x${string}`): Promise<boolean> {
  if (cfg.funding !== 'agent-wallet' || cfg.agentWalletAddress === null) return false;
  const balanceWei = await client.getBalance({ address: signer });
  const plan = planTopUp({ balanceWei, quoteLegUsdc6: cfg.policy.maxStakeUsdc6, gasMarginWei: cfg.fundGasMarginWei });
  if (!plan.fund) return plan.reason === 'sufficient';
  log({ msg: 'agent.funding.request', rail: 'circle-agent-wallet', from: cfg.agentWalletAddress, to: signer, amountUsdc: plan.amount });
  try {
    const res = await runCircleTransfer(
      buildTransferArgs({ to: signer, amount: plan.amount, from: cfg.agentWalletAddress, chain: cfg.circleChain }),
      cfg.circleCliTimeoutMs,
    );
    if (!res.ok) {
      log({ msg: 'agent.funding.failed', detail: res.detail.slice(0, 400) });
      return false;
    }
  } catch (err) {
    log({ msg: 'agent.funding.error', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  const landed = await awaitBalanceAtLeast(client, signer, balanceWei + plan.amountWei / 2n, 60_000);
  log({ msg: landed ? 'agent.funding.landed' : 'agent.funding.pending', amountUsdc: plan.amount });
  return landed;
}

/** ERC20 leg (the LP's base token, e.g. cirBTC): fund exactly one mint's shortfall. */
async function fundBaseFromTreasury(client: PublicClient, cfg: AgentBotConfig, signer: `0x${string}`, haveUnits: bigint): Promise<boolean> {
  if (cfg.funding !== 'agent-wallet' || cfg.agentWalletAddress === null) return false;
  const decimals = (await client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'decimals' })) as number;
  const plan = planTokenTopUp({ balanceUnits: haveUnits, needUnits: cfg.mintBase, decimals });
  if (!plan.fund) return plan.reason === 'sufficient';
  log({ msg: 'agent.funding.request', rail: 'circle-agent-wallet', token: cfg.market.base, from: cfg.agentWalletAddress, to: signer, amount: plan.amount });
  try {
    const res = await runCircleTransfer(
      buildTransferArgs({ to: signer, amount: plan.amount, from: cfg.agentWalletAddress, chain: cfg.circleChain, token: cfg.market.base }),
      cfg.circleCliTimeoutMs,
    );
    if (!res.ok) {
      log({ msg: 'agent.funding.failed', token: cfg.market.base, detail: res.detail.slice(0, 400) });
      return false;
    }
  } catch (err) {
    log({ msg: 'agent.funding.error', error: err instanceof Error ? err.message : String(err) });
    return false;
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    const units = (await client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [signer] })) as bigint;
    if (units >= cfg.mintBase) {
      log({ msg: 'agent.funding.landed', token: cfg.market.base, amount: plan.amount });
      return true;
    }
    if (Date.now() >= deadline) {
      log({ msg: 'agent.funding.pending', token: cfg.market.base, amount: plan.amount });
      return false;
    }
    await sleep(3_000);
  }
}

// ─── The tick ────────────────────────────────────────────────────────────────────────────

export async function tickAgent(client: PublicClient, chain: Chain, cfg: AgentBotConfig, rt: AgentRuntime): Promise<void> {
  const bal = await client.getBalance({ address: rt.account.address });
  if (bal < MIN_OPERATING_WEI) {
    // With the treasury rail on, a dry signer is a funding event, not a wait.
    if (!(await fundNativeFromTreasury(client, cfg, rt.account.address))) {
      log({ msg: 'agent.waiting', reason: 'insufficient gas - fund the agent wallet from its Agent Wallet treasury', balanceWei: bal.toString() });
      return;
    }
  }

  const ep = (await client.readContract({ address: cfg.arena, abi: arenaAbi, functionName: 'currentEpoch' })) as {
    epochId: bigint;
    phase: number | bigint;
    entryCloseTime: bigint;
    settlementTime: bigint;
    bandBps: number | bigint;
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const horizonSec = Number(ep.settlementTime) - nowSec;
  const bandBps = Number(ep.bandBps);

  // The same signal the Advise panel shows - computed here so the bot is self-contained.
  let signal: StanceSignal | null = null;
  if (horizonSec > 0 && bandBps > 0) {
    try {
      const closes = await fetchMarketCloses(cfg);
      signal = computeStanceSignal(closes, 60, horizonSec, bandBps);
    } catch (err) {
      log({ msg: 'agent.signal.error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const verdict = decideAgentEntry({
    policy: cfg.policy,
    nowSec,
    phase: Number(ep.phase),
    entryCloseTime: ep.entryCloseTime,
    alreadyActedThisEpoch: !shouldActThisEpoch(rt.ledger, ep.epochId),
    signal: signal === null ? null : { view: signal.view, confidence: signal.confidence },
  });

  if (!verdict.act) {
    log({ msg: 'agent.decision', epochId: ep.epochId, act: false, reason: verdict.reason, view: signal?.view ?? null, confidence: signal?.confidence ?? null });
    return;
  }

  log({ msg: 'agent.decision', epochId: ep.epochId, act: true, view: verdict.view, confidence: signal!.confidence, rationale: renderRationale(signal!) });

  // Discover-or-mint the agent's own LP position (never a user's), then stake the side.
  if (rt.tokenId === null) rt.tokenId = await discoverTokenId(client, cfg, rt.account.address);
  if (rt.tokenId === null) {
    const [haveBase, haveUsdc] = (await Promise.all([
      client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [rt.account.address] }),
      client.readContract({ address: cfg.market.quote, abi: erc20Abi, functionName: 'balanceOf', args: [rt.account.address] }),
    ])) as [bigint, bigint];
    if (!canAffordStake({ haveBase, haveUsdc, needBase: cfg.mintBase, needUsdc: cfg.policy.maxStakeUsdc6 })) {
      // Try the treasury before giving up: native USDC covers quote leg + gas in one
      // transfer; the base leg is a token transfer. Either landing short of the mark
      // just means the NEXT tick affords the mint - still inside the entry window.
      const [fundedNative, fundedBase] = [
        haveUsdc < cfg.policy.maxStakeUsdc6 ? await fundNativeFromTreasury(client, cfg, rt.account.address) : true,
        haveBase < cfg.mintBase ? await fundBaseFromTreasury(client, cfg, rt.account.address, haveBase) : true,
      ];
      if (!fundedNative || !fundedBase) {
        log({ msg: 'agent.skip.insufficient-tokens', needBase: cfg.mintBase, haveBase, needUsdc: cfg.policy.maxStakeUsdc6, haveUsdc });
        return;
      }
    }
    rt.tokenId = await mintLp(client, rt, chain, cfg);
  } else {
    // A token staked from a PREVIOUS epoch may not be back in the wallet yet (auto-return
    // runs right after settlement) - staking would revert, so wait for custody first.
    const owner = (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'ownerOf', args: [rt.tokenId] })) as string;
    if (owner.toLowerCase() !== rt.account.address.toLowerCase()) {
      log({ msg: 'agent.waiting', reason: 'LP position not yet returned from the previous epoch', tokenId: rt.tokenId });
      return;
    }
  }

  await ensureApproval(client, rt, chain, cfg);
  // Claim-before-restake: the arena keeps ONE position record per token, overwritten by
  // the next stake - an unclaimed win from the previous epoch would be silently lost.
  // Simulating claim() is the authoritative check (it reverts unless something is owed).
  try {
    const sim = await client.simulateContract({ account: rt.account, address: cfg.arena, abi: arenaAbi, functionName: 'claim', args: [rt.tokenId], gas: 900_000n });
    const tx = (await rt.wallet.writeContract({ ...sim.request, maxFeePerGas: cfg.gasFloorWei, maxPriorityFeePerGas: cfg.gasFloorWei } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
    await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
    log({ msg: 'agent.claim', tokenId: rt.tokenId, txHash: tx });
  } catch {
    // nothing claimable on this token - the normal case
  }
  const staked = await stakeSide(client, rt, chain, cfg, rt.tokenId, verdict.side);
  if (staked) {
    rt.ledger = recordEpochActed(rt.ledger, ep.epochId);
    saveEpochLedgerSync(rt.ledger, cfg.ledgerFile);
  }
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadAgentBotConfig();
  if (!cfg.enabled) {
    log({ msg: 'agent.disabled', note: 'set LIMEN_AGENT_ENABLED=true (plus LIMEN_AGENT_POLICY + LIMEN_AGENT_LEDGER_FILE + LIMEN_AGENT_PRIVATE_KEY) to run' });
    return;
  }

  let chainId: number | undefined;
  for (const url of cfg.rpcUrls) {
    try {
      chainId = await createPublicClient({ transport: http(url, { timeout: 10_000 }) }).getChainId();
      break;
    } catch (err) {
      log({ msg: 'agent.probe.error', rpc: url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (chainId === undefined) throw new Error('could not reach any RPC to probe chainId');

  const chain: Chain = defineChain({
    id: chainId,
    name: `arc-${chainId}`,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
  const transport = fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  const publicClient = createPublicClient({ chain, transport });
  const account = privateKeyToAccount(cfg.privateKey);
  const wallet = createWalletClient({ account, chain, transport });

  const rt: AgentRuntime = {
    account,
    wallet,
    tokenId: null,
    approvedForAll: false,
    ledger: loadEpochLedger(cfg.ledgerFile),
  };

  log({
    msg: 'agent.start',
    signer: account.address,
    chainId,
    arena: cfg.arena,
    market: cfg.market.id,
    policy: {
      allowedViews: cfg.policy.allowedViews,
      minConfidence: cfg.policy.minConfidence,
      expiresAtSec: cfg.policy.expiresAtSec,
      minEntryLeftSec: cfg.policy.minEntryLeftSec,
      maxStakeUsdc6: cfg.policy.maxStakeUsdc6,
    },
    pollIntervalMs: cfg.pollIntervalMs,
  });

  let running = true;
  const stop = (sig: string) => {
    log({ msg: 'agent.shutdown', signal: sig });
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (running) {
    const t0 = Date.now();
    try {
      await tickAgent(publicClient, chain, cfg, rt);
    } catch (err) {
      log({ msg: 'agent.tick.error', error: err instanceof Error ? err.message : String(err) });
    }
    const elapsed = Date.now() - t0;
    await sleep(Math.max(1_000, cfg.pollIntervalMs - elapsed));
  }
  log({ msg: 'agent.stopped' });
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'agent.fatal', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
