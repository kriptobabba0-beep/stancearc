// stakerbot.ts — THREE auto-staking LP bots. Each of three SEPARATE wallets (UP / DOWN / RANGE)
// adds liquidity (mints a full-range cirBTC/USDC LP position) and then automatically stakes that
// position into the v3 ENTRY-ANCHORED arena every epoch, ALWAYS on its fixed side. So the arena
// always has a participant calling each of UP, DOWN and RANGE.
//
// Lifecycle per wallet (driven each poll tick):
//   1. Discover its LP NFT (owned OR currently staked) — restart-safe, never double-mints.
//   2. If it has none, MINT a full-range LP (approve cirBTC+USDC -> NPM, then NPM.mint).
//   3. setApprovalForAll(arena) ONCE (operator approval persists across the post-settlement auto-
//      return, so re-staking the same NFT each epoch needs no re-approval).
//   4. When the entry window is OPEN and the wallet currently HOLDS the NFT (i.e. it was auto-
//      returned after the previous epoch) and it hasn't staked this epoch yet, place an
//      entry-anchored stake: fetch a fresh Hermes blob + price, pay the Pyth update fee (excess
//      refunds), call stakeWithSide(tokenId, side, price18, maxDeviationBps, blob).
//
// Resilient like the swap bot: each wallet idles until it has gas, and starts on its own once
// funded — no restart needed after a top-up. Reuses the keeper's installed viem + Hermes helpers.
import {
  defineChain,
  fallback,
  http,
  parseAbi,
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { erc20Abi } from './abi.js';
import { fetchPythUpdateWithPrice } from './hermes.js';
import { loadStakerbotConfig, type StakerbotConfig, type StakerConfig } from './config.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const log = (o: Record<string, unknown>): void =>
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

// IFeeArenaV3.PhaseView: 0 Idle, 1 EntryOpen, 2 Locked, 3 Settling, 4 Settled. We stake during EntryOpen.
const PHASE_ENTRY_OPEN = 1;
const MIN_OPERATING_WEI = 5_000_000_000_000_000n; // 0.005 native — enough to mint/approve/stake.
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_TICK = 887272;

export const npmAbi = parseAbi([
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
  'function setApprovalForAll(address operator,bool approved)',
  'function isApprovedForAll(address owner,address operator) view returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const pythAbi = parseAbi(['function getUpdateFee(bytes[] updateData) view returns (uint256)']);
export const arenaAbi = parseAbi([
  'function currentEpoch() view returns ((uint64 epochId,uint8 phase,uint64 entryOpenTime,uint64 entryCloseTime,uint64 settlementTime,uint64 settleTimeActual,int32 bandBps,bool rolledOver,uint32 stakedCount,uint32 processedCursor,uint32 winnerCount,uint32 claimedCount,uint256 finalPrice18,uint256 potBase,uint256 potUSDC,uint256 totalWinnerContribution,bool rolloverPendingIn,uint256 rolloverInBase,uint256 rolloverInUSDC))',
  'function stakeWithSide(uint256 tokenId,uint8 side,uint256 expectedEntryPrice18,uint256 maxDeviationBps,bytes[] priceData) payable',
  'function claim(uint256 tokenId)',
  'function getUserStakes(address user) view returns ((uint256 tokenId,address owner,uint64 epochId,uint8 side,uint64 entryTime,uint256 entryPrice18,bool processed,bool won,bool claimed,bool unstaked,uint128 feeBase,uint128 feeUSDC,uint256 contributionUsd6)[])',
]);

export type StakerAction = 'MINT' | 'STAKE' | 'WAIT';

/**
 * PURE per-tick decision for one staker. Unit-testable (no I/O).
 *   - MINT  — it has no LP NFT yet (first run) -> mint one.
 *   - STAKE — entry window is open, the wallet currently HOLDS its NFT (auto-returned / freshly
 *             minted, not escrowed), and it hasn't staked this epoch yet.
 *   - WAIT  — otherwise (between windows, NFT still escrowed, or already staked this epoch).
 */
export function decideStakerAction(input: {
  phase: number;
  epochId: bigint;
  hasTokenId: boolean;
  ownsToken: boolean;
  lastStakedEpoch: bigint | null;
}): StakerAction {
  if (!input.hasTokenId) return 'MINT';
  if (input.phase === PHASE_ENTRY_OPEN && input.ownsToken && input.lastStakedEpoch !== input.epochId) {
    return 'STAKE';
  }
  return 'WAIT';
}

/**
 * PURE: does the wallet hold enough of BOTH legs to mint+stake one LP position? The staker
 * gas-gates on native balance separately; this is the TOKEN gate. A wallet that's out of
 * cirBTC and/or USDC must SKIP the tick (not retry-spin / mint a dead position). Inclusive
 * (>=) — exactly the required amount is affordable.
 */
export function canAffordStake(b: { haveBase: bigint; haveUsdc: bigint; needBase: bigint; needUsdc: bigint }): boolean {
  return b.haveBase >= b.needBase && b.haveUsdc >= b.needUsdc;
}

/** Spacing-aligned full-range ticks for a fee tier (0.3% -> spacing 60 -> ±887220). */
export function fullRangeTicks(feeTier: number): { tickLower: number; tickUpper: number } {
  const spacing = feeTier === 100 ? 1 : feeTier === 500 ? 10 : feeTier === 10000 ? 200 : 60;
  const upper = Math.floor(MAX_TICK / spacing) * spacing;
  return { tickLower: -upper, tickUpper: upper };
}

const eqAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export interface StakerRuntime {
  cfg: StakerConfig;
  account: Account;
  wallet: WalletClient;
  tokenId: bigint | null;
  approvedForAll: boolean;
  lastStakedEpoch: bigint | null;
  sinceBalanceLog: number;
}

/** Build viem clients (shared chain/transport; one wallet client per staker key). */
function buildChain(cfg: StakerbotConfig, chainId: number): { chain: Chain; publicClient: PublicClient } {
  const chain: Chain = defineChain({
    id: chainId,
    name: `arc-${chainId}`,
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: cfg.rpcUrls } },
  });
  const transport = fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  return { chain, publicClient: createPublicClient({ chain, transport }) };
}

/** Read-only: find this wallet's LP NFT — one it currently OWNS, else one it has STAKED. null if none. */
async function discoverTokenId(client: PublicClient, cfg: StakerbotConfig, owner: `0x${string}`): Promise<bigint | null> {
  const bal = (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'balanceOf', args: [owner] })) as bigint;
  if (bal > 0n) {
    return (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [owner, 0n] })) as bigint;
  }
  const staked = (await client.readContract({ address: cfg.arena, abi: arenaAbi, functionName: 'getUserStakes', args: [owner] })) as readonly { tokenId: bigint }[];
  if (staked.length > 0) return staked[staked.length - 1]!.tokenId;
  return null;
}

/** Mint a full-range LP for this wallet (approve cirBTC+USDC -> NPM if needed, then NPM.mint). */
async function mintLp(client: PublicClient, st: StakerRuntime, chain: Chain, cfg: StakerbotConfig): Promise<bigint> {
  const gas = { maxFeePerGas: cfg.gasFloorWei, maxPriorityFeePerGas: cfg.gasFloorWei } as const;
  // Approve both legs to the NPM (idempotent — only when allowance is short).
  for (const [token, need] of [
    [cfg.market.base, cfg.mintBase] as const,
    [cfg.market.quote, cfg.mintUsdc] as const,
  ]) {
    const allowance = (await client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [st.account.address, cfg.npm] })) as bigint;
    if (allowance < need) {
      const tx = (await st.wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', account: st.account, chain, ...gas, args: [cfg.npm, MAX_UINT256] } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
      await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
    }
  }
  // Sort (base, USDC) into the pool's (token0, token1) by address; map amounts accordingly.
  const baseIsToken0 = BigInt(cfg.market.base) < BigInt(cfg.market.quote);
  const [token0, token1] = baseIsToken0 ? [cfg.market.base, cfg.market.quote] : [cfg.market.quote, cfg.market.base];
  const [amount0, amount1] = baseIsToken0 ? [cfg.mintBase, cfg.mintUsdc] : [cfg.mintUsdc, cfg.mintBase];
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
    recipient: st.account.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const sim = await client.simulateContract({ account: st.account, address: cfg.npm, abi: npmAbi, functionName: 'mint', args: [params] });
  const tokenId = (sim.result as readonly [bigint, bigint, bigint, bigint])[0];
  const tx = (await st.wallet.writeContract({ ...sim.request, ...gas } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
  await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
  log({ msg: 'stakerbot.mint', side: st.cfg.sideLabel, signer: st.account.address, tokenId, txHash: tx });
  return tokenId;
}

/** One-time operator approval so the arena can pull this wallet's NFT each epoch. */
async function ensureApproval(client: PublicClient, st: StakerRuntime, chain: Chain, cfg: StakerbotConfig): Promise<void> {
  if (st.approvedForAll) return;
  const ok = (await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'isApprovedForAll', args: [st.account.address, cfg.arena] })) as boolean;
  if (!ok) {
    const tx = (await st.wallet.writeContract({ address: cfg.npm, abi: npmAbi, functionName: 'setApprovalForAll', account: st.account, chain, maxFeePerGas: cfg.gasFloorWei, maxPriorityFeePerGas: cfg.gasFloorWei, args: [cfg.arena, true] } as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
    await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
    log({ msg: 'stakerbot.approveAll', side: st.cfg.sideLabel, txHash: tx });
  }
  st.approvedForAll = true;
}

/**
 * Place the entry-anchored stake for this wallet's fixed side. Returns true ONLY on a
 * SUCCESSFUL receipt; false on a mined-but-reverted tx so the caller does NOT mark the epoch
 * staked (a revert is retried next tick — the poll cadence throttles it, one attempt per tick).
 */
async function stakeOnce(client: PublicClient, st: StakerRuntime, chain: Chain, cfg: StakerbotConfig, tokenId: bigint): Promise<boolean> {
  const { updateData, price18 } = await fetchPythUpdateWithPrice(cfg.hermesUrl, cfg.market.feedId, cfg.hermesTimeoutMs);
  const fee = (await client.readContract({ address: cfg.pythAddress, abi: pythAbi, functionName: 'getUpdateFee', args: [updateData] })) as bigint;
  const tx = (await st.wallet.writeContract({
    address: cfg.arena,
    abi: arenaAbi,
    functionName: 'stakeWithSide',
    account: st.account,
    chain,
    maxFeePerGas: cfg.gasFloorWei,
    maxPriorityFeePerGas: cfg.gasFloorWei,
    value: fee,
    args: [tokenId, st.cfg.side, price18, cfg.maxDeviationBps, updateData],
  } as unknown as Parameters<WalletClient['writeContract']>[0])) as `0x${string}`;
  const receipt = await client.waitForTransactionReceipt({ hash: tx, timeout: cfg.receiptTimeoutMs });
  if (receipt.status !== 'success') {
    log({ msg: 'stakerbot.stake.reverted', side: st.cfg.sideLabel, tokenId, txHash: tx });
    return false;
  }
  log({ msg: 'stakerbot.stake', sideLabel: st.cfg.sideLabel, tokenId, side: st.cfg.side, entryPrice18: price18, txHash: tx });
  return true;
}

/** One staker's tick: gas-gate, discover/mint, approve, and stake when the entry window is open. */
export async function tickStaker(client: PublicClient, chain: Chain, cfg: StakerbotConfig, st: StakerRuntime): Promise<void> {
  const bal = await client.getBalance({ address: st.account.address });
  if (st.sinceBalanceLog <= 0) {
    log({ msg: bal < cfg.lowBalanceWei ? 'WARN low stakerbot balance' : 'stakerbot.balance', side: st.cfg.sideLabel, signer: st.account.address, balanceWei: bal.toString() });
    st.sinceBalanceLog = 30;
  }
  st.sinceBalanceLog -= 1;

  if (bal < MIN_OPERATING_WEI) {
    log({ msg: 'stakerbot.waiting', side: st.cfg.sideLabel, signer: st.account.address, reason: 'insufficient gas — fund this wallet (gas + cirBTC + USDC)', balanceWei: bal.toString() });
    return;
  }

  // Read-only discovery (restart-safe; never mints a duplicate if one already exists/is staked).
  if (st.tokenId === null) st.tokenId = await discoverTokenId(client, cfg, st.account.address);

  const ep = (await client.readContract({ address: cfg.arena, abi: arenaAbi, functionName: 'currentEpoch' })) as { epochId: bigint; phase: number };
  const epochId = ep.epochId;
  const phase = Number(ep.phase);

  const ownsToken =
    st.tokenId !== null &&
    eqAddr((await client.readContract({ address: cfg.npm, abi: npmAbi, functionName: 'ownerOf', args: [st.tokenId] })) as string, st.account.address);

  const action = decideStakerAction({ phase, epochId, hasTokenId: st.tokenId !== null, ownsToken, lastStakedEpoch: st.lastStakedEpoch });

  if (action === 'MINT') {
    // TOKEN gate (separate from the native gas gate above): minting an LP pulls BOTH legs.
    // A wallet that has gas but is out of cirBTC and/or USDC must SKIP — minting anyway would
    // revert (or mint a dead position) and the bot would retry it every tick forever.
    const [haveBase, haveUsdc] = (await Promise.all([
      client.readContract({ address: cfg.market.base, abi: erc20Abi, functionName: 'balanceOf', args: [st.account.address] }),
      client.readContract({ address: cfg.market.quote, abi: erc20Abi, functionName: 'balanceOf', args: [st.account.address] }),
    ])) as [bigint, bigint];
    if (!canAffordStake({ haveBase, haveUsdc, needBase: cfg.mintBase, needUsdc: cfg.mintUsdc })) {
      log({ msg: 'stakerbot.skip.insufficient-tokens', side: st.cfg.sideLabel, wallet: st.account.address, needBase: cfg.mintBase, haveBase, needUsdc: cfg.mintUsdc, haveUsdc });
      return;
    }
    st.tokenId = await mintLp(client, st, chain, cfg);
  } else if (action === 'STAKE') {
    await ensureApproval(client, st, chain, cfg);
    // Only mark the epoch staked on a SUCCESSFUL receipt. A reverted stake stays unmarked so the
    // next tick retries it — otherwise this side silently drops out of the epoch for good.
    const staked = await stakeOnce(client, st, chain, cfg, st.tokenId!);
    if (staked) st.lastStakedEpoch = epochId;
  }
}

async function main(): Promise<void> {
  const cfg = loadStakerbotConfig();

  let chainId: number | undefined;
  for (const url of cfg.rpcUrls) {
    try {
      chainId = await createPublicClient({ transport: http(url, { timeout: 10_000 }) }).getChainId();
      break;
    } catch (err) {
      log({ msg: 'stakerbot.probe.error', rpc: url, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (chainId === undefined) throw new Error('could not reach any RPC to probe chainId');

  const { chain, publicClient } = buildChain(cfg, chainId);
  const transport = fallback(cfg.rpcUrls.map((u) => http(u, { timeout: 10_000 })));
  const stakers: StakerRuntime[] = cfg.stakers.map((s) => {
    const account = privateKeyToAccount(s.privateKey);
    return {
      cfg: s,
      account,
      wallet: createWalletClient({ account, chain, transport }),
      tokenId: null,
      approvedForAll: false,
      lastStakedEpoch: null,
      sinceBalanceLog: 0,
    };
  });

  log({
    msg: 'stakerbot.start',
    chainId,
    arena: cfg.arena,
    npm: cfg.npm,
    pool: cfg.market.pool,
    feeTier: cfg.market.feeTier,
    mintBase: cfg.mintBase,
    mintUsdc: cfg.mintUsdc,
    maxDeviationBps: cfg.maxDeviationBps,
    pollIntervalMs: cfg.pollIntervalMs,
    stakers: stakers.map((s) => ({ side: s.cfg.sideLabel, signer: s.account.address })),
  });

  let running = true;
  const stop = (sig: string) => {
    log({ msg: 'stakerbot.shutdown', signal: sig });
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (running) {
    const t0 = Date.now();
    for (const st of stakers) {
      if (!running) break;
      try {
        await tickStaker(publicClient, chain, cfg, st);
      } catch (err) {
        log({ msg: 'stakerbot.error', side: st.cfg.sideLabel, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!running) break;
    const elapsed = Date.now() - t0;
    await sleep(Math.max(0, cfg.pollIntervalMs - elapsed));
  }
  log({ msg: 'stakerbot.stopped' });
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), msg: 'stakerbot.fatal', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  });
}
