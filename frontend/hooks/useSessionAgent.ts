'use client';

// hooks/useSessionAgent.ts - the unattended in-browser autopilot: a SESSION SIGNER.
//
// The one thing a website can never do is make the user's own wallet sign silently - that
// prompt is the wallet's security model. So unattended operation gets its own signer: a
// throwaway key generated here, held in localStorage, funded ONCE from the user's wallet
// with a small budget (that single funding transfer is the only wallet prompt in the whole
// flow). From then on the session signer transacts by itself - approve, mint its own LP,
// enter epochs - signing locally, no prompts, until the user presses Stop, which sweeps
// the LP position and every remaining token back to the user's wallet.
//
// Security bounds, stated honestly: the key lives in THIS browser's localStorage and can
// spend AT MOST the budget the user handed it. Closing the page pauses it (nothing is
// lost - staked positions settle and auto-return to the session address; reopening
// resumes it, Stop reclaims everything). This is the session-key pattern smart accounts
// use, self-contained. Arc testnet - test funds.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createWalletClient, erc20Abi, fallback, formatUnits, http, parseUnits, parseSignature, keccak256, encodeAbiParameters, encodeFunctionData } from 'viem';
import { withRateLimitResilience } from '@/lib/rpcResilience';
import { ARC_EXTRA_HTTP_RPCS } from '@/lib/arcEndpoints';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { useAccount, usePublicClient, useSignTypedData } from 'wagmi';
import { ARC_CHAIN_ID, arcTestnet, withGasFloor } from '@/lib/chain';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { nonfungiblePositionManagerAbi } from '@/abis/nonfungiblePositionManager';
import { pythAbi } from '@/abis/pyth';
import { uniswapV3PoolAbi } from '@/abis/uniswapV3Pool';
import { decodeSlot0 } from '@/lib/rangeDisplay';
import { positionAmounts } from '@/lib/agent/lpPlan';
import { sqrtPriceX96ToPrice } from '@/lib/rangeMath';
import { ENV } from '@/lib/env';
import { quoteToken, tokenBySymbol } from '@/lib/tokens';
import { fetchPythUpdateWithPrice, fetchPythCrossUpdateWithPrice } from '@/lib/pyth';
import type { Market } from '@/lib/markets';
import type { StanceView } from '@/lib/agent/autopilot';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

// Sessions are PER MARKET: each market gets its own signer, budget and LP, so running
// cirBTC/USDC and cirBTC/EURC sessions side by side is just two keys. The market id lives
// in the key NAME - the old single-slot key (+ its separate market tag) migrates on load.
const LEGACY_SESSION_KEY = 'limen-agent-session-key-v1';
const LEGACY_MARKET_KEY = 'limen-agent-session-market-v1';
const sessionKeyFor = (marketId: string) => `limen-agent-session-key-v1:${marketId}`;
const SESSION_ADDRS_KEY = 'limen-agent-session-addrs-v1'; // recent signer addresses (newest first)

/** Market ids with a stored session key in THIS browser (the parked-session indicator). */
export function marketsWithSessions(marketIds: readonly string[]): string[] {
  try {
    if (typeof window === 'undefined') return [];
    const legacyMarket = window.localStorage.getItem(LEGACY_MARKET_KEY);
    const legacyKey = window.localStorage.getItem(LEGACY_SESSION_KEY);
    return marketIds.filter(
      (id) =>
        window.localStorage.getItem(sessionKeyFor(id)) !== null ||
        (legacyKey !== null && (legacyMarket === id || legacyMarket === null)),
    );
  } catch {
    return [];
  }
}

/** Recent session-signer addresses (this browser) - history keeps belonging to the user after sweeps. */
export function recentSessionAddresses(): `0x${string}`[] {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(SESSION_ADDRS_KEY) : null;
    const list = raw !== null ? (JSON.parse(raw) as unknown[]) : [];
    return list.filter((a): a is `0x${string}` => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)).slice(0, 6);
  } catch {
    return [];
  }
}

function rememberSessionAddress(addr: `0x${string}`): void {
  try {
    const next = [addr, ...recentSessionAddresses().filter((a) => a.toLowerCase() !== addr.toLowerCase())].slice(0, 6);
    window.localStorage.setItem(SESSION_ADDRS_KEY, JSON.stringify(next));
  } catch {
    // best-effort
  }
}
const FULL_RANGE_TICK = 887_220; // full-range bounds for the 0.3% tier (tick spacing 60)
const GAS_MARGIN_USDC = 1.5; // native head-room for approvals + mint + stakes
// Dust floor for the LP's base leg - just enough to keep the mint's amounts nonzero.
// (The old 60_000n floor dated from the fixed-leg era: it silently demanded ~$40-60 of
// cirBTC from EVERY session, so a $1 mandate failed with "needs ~0.0006 cirBTC".)
const MIN_BASE_LEG_UNITS = 1_000n; // 0.00001 cirBTC
const SIDE_ENUM: Record<StanceView, number> = { UP: 1, DOWN: 2, RANGE: 3 };
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT128 = 2n ** 128n - 1n;

// Circle FiatTokenV2 gasless-transfer surface (EIP-3009). cirBTC, EURC and the native USDC
// facade all implement it on Arc - proven live (domain separator matches; a signed
// authorization moves funds and a replay is rejected). Only the members we call.
const fiatToken3009Abi = [
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

export interface SessionInfo {
  address: `0x${string}`;
  usdc: bigint; // native balance, 18dp
  base: bigint; // base-token balance, token units
  /** Quote-token balance in TOKEN units (6dp). For USDC-quoted markets this is the native
   *  balance seen through the ERC-20 facade; for EURC markets it is the EURC balance. */
  quoteBal: bigint;
  tokenId: bigint | null;
  lpStaked: boolean;
  /** The LP's price band + the pool's live tick - null until the first mint (or if the
   *  reads fail). Lets the console show the range and flag out-of-range drift. */
  range: { tickLower: number; tickUpper: number; poolTick: number; baseIsToken0: boolean } | null;
  /** What the LP position HOLDS at the live price (amounts include uncollected fees):
   *  base/quote in raw token units + the quote-denominated total. Null until minted. */
  lpValue: { base: bigint; quote: bigint; totalQuote: number } | null;
}

function loadKey(marketId: string): `0x${string}` | null {
  try {
    if (typeof window === 'undefined') return null;
    let raw = window.localStorage.getItem(sessionKeyFor(marketId));
    if (raw === null) {
      // One-shot migration from the single-slot era: adopt the legacy key when it was
      // bound to THIS market (a missing tag counts - the pair was always written together).
      const legacyMarket = window.localStorage.getItem(LEGACY_MARKET_KEY);
      const legacyKey = window.localStorage.getItem(LEGACY_SESSION_KEY);
      if (legacyKey !== null && (legacyMarket === marketId || legacyMarket === null)) {
        window.localStorage.setItem(sessionKeyFor(marketId), legacyKey);
        window.localStorage.removeItem(LEGACY_SESSION_KEY);
        window.localStorage.removeItem(LEGACY_MARKET_KEY);
        raw = legacyKey;
      }
    }
    return raw !== null && /^0x[0-9a-f]{64}$/i.test(raw) ? (raw as `0x${string}`) : null;
  } catch {
    return null;
  }
}

export function useSessionAgent(market: Market, lpRangePct: number | null = null) {
  const { address: owner, connector } = useAccount();
  const publicClient = usePublicClient({ chainId: ARC_CHAIN_ID });
  const { writeContractAsync } = useArcWriteContract();
  const { signTypedDataAsync } = useSignTypedData();
  // The embedded (Circle MPC) wallet cannot produce raw EIP-712 signatures - but it does
  // not need the signature rail at all: its broadcasts run through Circle's own execution
  // API, not a local wallet RPC, so the rate-limit fragility that motivated EIP-3009
  // funding never applied to it. Its ERC-20 legs fund as plain transfers.
  const embeddedWallet = connector?.type === 'embedded';
  const [account, setAccount] = useState<PrivateKeyAccount | null>(null);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  // ONE writer at a time: enterEpoch / claimMany / stop all sign with the same key, and
  // concurrent sends would race the nonce. Entries bail (the watch loop retries); the
  // user-facing operations wait briefly for the lock instead.
  const acting = useRef(false);
  const acquireLock = async (waitMs: number): Promise<boolean> => {
    const deadline = Date.now() + waitMs;
    while (acting.current) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
    acting.current = true;
    return true;
  };

  useEffect(() => {
    const key = loadKey(market.id);
    setAccount(key !== null ? privateKeyToAccount(key) : null);
    setInfo(null); // the previous market's session state must never bleed into this one
  }, [market.id]);

  const wallet = useMemo(
    // Direct endpoints (NOT the caching proxy - writes and their simulations must see the
    // freshest state), Circle-documented mirrors as fallbacks, all behind the shared
    // rate-limit gate so a throttled moment delays a write instead of failing it.
    () =>
      account !== null
        ? createWalletClient({
            account,
            chain: arcTestnet,
            transport: withRateLimitResilience(
              fallback([http(), ...ARC_EXTRA_HTTP_RPCS.map((u) => http(u))]),
            ),
          })
        : null,
    [account],
  );
  const baseToken = tokenBySymbol(market.baseSymbol);

  /** Refresh the session signer's balances + LP custody state. */
  const refresh = useCallback(async (): Promise<SessionInfo | null> => {
    if (account === null || !publicClient || baseToken === undefined) return null;
    const me = account.address;
    const quoteTok = quoteToken(market.quoteSymbol);
    const [usdc, base, quoteBal, lpCount, stakes] = await Promise.all([
      publicClient.getBalance({ address: me }),
      publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
      publicClient.readContract({ address: quoteTok.address, abi: erc20Abi, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
      publicClient.readContract({ address: ENV.NPM_ADDRESS, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
      publicClient.readContract({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'getUserStakes', args: [me] }) as Promise<readonly { tokenId: bigint; unstaked: boolean; processed: boolean }[]>,
    ]);
    let tokenId: bigint | null = null;
    let lpStaked = false;
    if (lpCount > 0n) {
      tokenId = (await publicClient.readContract({
        address: ENV.NPM_ADDRESS,
        abi: nonfungiblePositionManagerAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [me, 0n],
      })) as bigint;
    } else if (stakes.length > 0) {
      tokenId = stakes[stakes.length - 1]!.tokenId;
      lpStaked = true; // custody is with the arena until settlement auto-return
    }
    // The position's tick band + the pool's live tick (works while staked too - position
    // data is keyed by tokenId, not custody). Best-effort: balances never wait on it.
    let range: SessionInfo['range'] = null;
    let lpValue: SessionInfo['lpValue'] = null;
    if (tokenId !== null) {
      try {
        const [pos, slot0] = await Promise.all([
          publicClient.readContract({
            address: ENV.NPM_ADDRESS,
            abi: nonfungiblePositionManagerAbi,
            functionName: 'positions',
            args: [tokenId],
          }) as Promise<readonly unknown[]>,
          publicClient.readContract({ address: market.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' }),
        ]);
        const decoded = decodeSlot0(slot0);
        const tickLower = Number(pos[5]);
        const tickUpper = Number(pos[6]);
        if (decoded !== undefined && Number.isFinite(tickLower) && Number.isFinite(tickUpper)) {
          const baseIsToken0 = BigInt(baseToken.address) < BigInt(quoteTok.address);
          range = { tickLower, tickUpper, poolTick: decoded.tick, baseIsToken0 };
          // The position's live worth (task: the budget display was cash-only, so a $100
          // session read as "$2 left" the moment the LP was minted). Same reads, no extra RPC.
          const { amount0, amount1 } = positionAmounts({
            liquidity: pos[7] as bigint,
            sqrtPriceX96: decoded.sqrtPriceX96,
            tickLower,
            tickUpper,
          });
          const baseIn = (baseIsToken0 ? amount0 : amount1) + ((baseIsToken0 ? pos[10] : pos[11]) as bigint);
          const quoteIn = (baseIsToken0 ? amount1 : amount0) + ((baseIsToken0 ? pos[11] : pos[10]) as bigint);
          const dec0 = baseIsToken0 ? baseToken.decimals : quoteTok.decimals;
          const dec1 = baseIsToken0 ? quoteTok.decimals : baseToken.decimals;
          const price = sqrtPriceX96ToPrice(decoded.sqrtPriceX96, dec0, dec1, baseIsToken0);
          const totalQuote =
            Number(formatUnits(quoteIn, quoteTok.decimals)) + Number(formatUnits(baseIn, baseToken.decimals)) * price;
          if (Number.isFinite(totalQuote)) lpValue = { base: baseIn, quote: quoteIn, totalQuote };
        }
      } catch {
        range = null;
        lpValue = null;
      }
    }
    const next: SessionInfo = { address: me, usdc, base, quoteBal, tokenId, lpStaked, range, lpValue };
    setInfo(next);
    return next;
  }, [account, publicClient, baseToken, market.feeArena, market.pool, market.quoteSymbol]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the console live while a session runs: balances, custody and the range/pool tick
  // drift with the market, not only with our own transactions.
  useEffect(() => {
    if (account === null || !publicClient) return;
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [account, publicClient, refresh]);

  /** A contract write signed by a GIVEN session signer (Arc gas floor, receipt awaited).
   *  Parametric so start() can drive the just-created signer before React state lands. */
  const writeWith = useCallback(
    async (
      walletX: NonNullable<typeof wallet>,
      acctX: PrivateKeyAccount,
      req: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint; gas?: bigint },
    ) => {
      if (!publicClient) throw new Error('no session');
      // Explicit gas bound on simulation: Arc's eth_call pre-deducts gasLimit×maxFee from
      // the balance, and an unbounded default fails a tightly-funded signer with STF.
      const sim = await publicClient.simulateContract({
        account: acctX,
        address: req.address,
        abi: req.abi as never,
        functionName: req.functionName as never,
        args: req.args as never,
        value: req.value,
        gas: req.gas ?? 1_000_000n,
      });
      const hash = await walletX.writeContract(withGasFloor(sim.request) as never);
      const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== 'success') throw new Error(`transaction reverted (${req.functionName})`);
      return hash;
    },
    [publicClient],
  );

  /** A session-signed contract write with the Arc gas floor; waits for the receipt. */
  const write = useCallback(
    async (req: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint; gas?: bigint }) => {
      if (wallet === null || account === null) throw new Error('no session');
      return writeWith(wallet, account, req);
    },
    [wallet, account, writeWith],
  );

  /** A wallet client bound to an arbitrary session signer - start() needs to drive the
   *  freshly generated key before setAccount()'s state update has landed. Same resilient
   *  transport as the memoised `wallet` (proxy-free direct + mirrors, behind the gate). */
  const sessionWalletFor = useCallback(
    (acctX: PrivateKeyAccount) =>
      createWalletClient({
        account: acctX,
        chain: arcTestnet,
        transport: withRateLimitResilience(fallback([http(), ...ARC_EXTRA_HTTP_RPCS.map((u) => http(u))])),
      }),
    [],
  );

  /**
   * An ERC-20 leg funded by an EIP-3009 AUTHORIZATION, not a wallet transaction: the user
   * SIGNS a `TransferWithAuthorization` (typed data - no RPC call, no broadcast, nothing a
   * wallet-side rate limit can kill), and the SESSION submits it on-chain through the
   * app's resilient transport. Circle's FiatTokenV2 tokens (cirBTC, EURC, and the native
   * USDC facade) all support it - proven live on Arc (domain separator matches; sign→submit
   * moves funds; replay rejected). The domain is built from the token's OWN name()/version()
   * so nothing is hardcoded to drift. `submit` lets start() drive the fresh session signer.
   */
  const pullByAuthorization = useCallback(
    async (
      submit: (req: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint }) => Promise<unknown>,
      to: `0x${string}`,
      token: `0x${string}`,
      from: `0x${string}`,
      amount: bigint,
      legTag: string,
    ): Promise<void> => {
      if (!publicClient) throw new Error('no rpc');
      const [tokName, tokVersion, block] = await Promise.all([
        publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'name' }) as Promise<string>,
        publicClient.readContract({ address: token, abi: fiatToken3009Abi, functionName: 'version' }) as Promise<string>,
        publicClient.getBlock(),
      ]);
      // DETERMINISTIC nonce, keyed on this (session, token, leg): a resume re-signs the SAME
      // nonce, so a still-pending original submit and the resume can never BOTH land - the
      // token's own replay guard (authorizationState[from][nonce]) reverts the duplicate.
      // (A random nonce made each attempt an independent authorization that both mined → a
      // double-fund when a receipt-timeout falsely reported the first as "failed".)
      const nonce = keccak256(
        encodeAbiParameters(
          [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'string' }],
          [from, to, token, legTag],
        ),
      );
      // CHAIN time, not Date.now(): a client clock skewed slow would otherwise sign an
      // already-expired authorization that reverts forever. 15 minutes is ample for the
      // submit and short enough to bound a stale one.
      const validBefore = block.timestamp + 900n;
      let signature: `0x${string}`;
      try {
        signature = await signTypedDataAsync({
          domain: { name: tokName, version: tokVersion, chainId: arcTestnet.id, verifyingContract: token },
          types: {
            TransferWithAuthorization: [
              { name: 'from', type: 'address' },
              { name: 'to', type: 'address' },
              { name: 'value', type: 'uint256' },
              { name: 'validAfter', type: 'uint256' },
              { name: 'validBefore', type: 'uint256' },
              { name: 'nonce', type: 'bytes32' },
            ],
          },
          primaryType: 'TransferWithAuthorization',
          message: { from, to, value: amount, validAfter: 0n, validBefore, nonce },
        });
      } catch (err) {
        // Tag SIGN-stage failures: nothing was submitted, so the caller may safely fall
        // back to a plain transfer broadcast. (A SUBMIT-stage failure must never fall
        // back - the authorization could still be pending, and a transfer on top of it
        // would double-fund; there the deterministic nonce is the safety net instead.)
        throw new Error(`SIGN_STAGE:${err instanceof Error ? err.message : 'typed-data signing failed'}`);
      }
      const sig = parseSignature(signature);
      const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
      await submit({
        address: token,
        abi: fiatToken3009Abi,
        functionName: 'transferWithAuthorization',
        args: [from, to, amount, 0n, validBefore, nonce, v, sig.r, sig.s],
        gas: 150_000n,
      });
    },
    [publicClient, signTypedDataAsync],
  );

  /**
   * Build the session's LP and every one-time approval - EPOCH-INDEPENDENT. Nothing here
   * touches an entry window: a Uniswap mint and its allowances are valid at any moment,
   * so this runs at session START (and as a fallback the instant a session is found
   * LP-less). Doing it lazily under window pressure was a wedge: first-time setup
   * demanded ≥60s of entry window while confident odds (5bp band) only ever crossed the
   * floor later than that - a fully funded session idled for two hours entering nothing.
   * After this runs, an entry is stake-only (~3-6s), so even late odds are enterable.
   */
  const prepareLpWith = useCallback(
    async (walletX: NonNullable<typeof wallet>, acctX: PrivateKeyAccount): Promise<void> => {
      if (!publicClient || baseToken === undefined) throw new Error('no rpc');
      const me = acctX.address;
      const quote = quoteToken(market.quoteSymbol).address;
      const submit = (req: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint }) =>
        writeWith(walletX, acctX, req);
      // Nothing to do when the LP already exists (custody here or staked in the arena).
      const [lpCount, stakes] = await Promise.all([
        publicClient.readContract({ address: ENV.NPM_ADDRESS, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
        publicClient.readContract({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'getUserStakes', args: [me] }) as Promise<readonly unknown[]>,
      ]);
      if (lpCount === 0n && stakes.length === 0) {
        // One-time allowances for the position manager.
        for (const token of [baseToken.address, quote]) {
          const allowance = (await publicClient.readContract({
            address: token,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [me, ENV.NPM_ADDRESS],
          })) as bigint;
          if (allowance < MAX_UINT256 / 2n) {
            await submit({ address: token, abi: erc20Abi, functionName: 'approve', args: [ENV.NPM_ADDRESS, MAX_UINT256], gas: 200_000n });
          }
        }
        const [nativeWei, baseBal, quoteBal] = await Promise.all([
          publicClient.getBalance({ address: me }),
          publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
          publicClient.readContract({ address: quote, abi: erc20Abi, functionName: 'balanceOf', args: [me] }) as Promise<bigint>,
        ]);
        const quoteIsNative = quoteToken(market.quoteSymbol).symbol === 'USDC';
        // Reserve the full gas margin native - but never so much that the quote leg drops
        // under the $1 mint floor (a minimum-budget session must still mint).
        const MINT_FLOOR_QUOTE6 = 1_000_000n;
        const mintFloorNative = MINT_FLOOR_QUOTE6 * 10n ** 12n;
        const desiredReserve = parseUnits(String(GAS_MARGIN_USDC), 18);
        const maxReserve = nativeWei > mintFloorNative ? nativeWei - mintFloorNative : 0n;
        const gasReserve = desiredReserve < maxReserve ? desiredReserve : maxReserve;
        const quoteLeg6 = quoteIsNative ? (nativeWei > gasReserve ? nativeWei - gasReserve : 0n) / 10n ** 12n : quoteBal;
        if (quoteLeg6 < MINT_FLOOR_QUOTE6 || baseBal === 0n) throw new Error('session budget too small to mint the LP');
        const [token0, token1] = BigInt(baseToken.address) < BigInt(quote) ? [baseToken.address, quote] : [quote, baseToken.address];
        const [amount0, amount1] = token0 === quote ? [quoteLeg6, baseBal] : [baseBal, quoteLeg6];
        // The mandate's LP range: full range by default, or ±N% around the pool's live
        // tick, rounded outward to the fee tier's tick spacing (60 for 0.3%).
        let tickLower = -FULL_RANGE_TICK;
        let tickUpper = FULL_RANGE_TICK;
        if (lpRangePct !== null && lpRangePct > 0) {
          const slot0 = (await publicClient.readContract({
            address: market.pool,
            abi: uniswapV3PoolAbi,
            functionName: 'slot0',
          })) as readonly [bigint, number, ...unknown[]];
          const currentTick = Number(slot0[1]);
          const deltaTicks = Math.max(60, Math.round(Math.log(1 + lpRangePct / 100) / Math.log(1.0001)));
          const SPACING = 60;
          tickLower = Math.floor((currentTick - deltaTicks) / SPACING) * SPACING;
          tickUpper = Math.ceil((currentTick + deltaTicks) / SPACING) * SPACING;
          if (tickLower >= tickUpper) tickUpper = tickLower + SPACING;
        }
        await submit({
          address: ENV.NPM_ADDRESS,
          abi: nonfungiblePositionManagerAbi,
          functionName: 'mint',
          args: [{
            token0,
            token1,
            fee: ENV.FEE_TIER,
            tickLower,
            tickUpper,
            amount0Desired: amount0,
            amount1Desired: amount1,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: me,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
          }],
          gas: 1_500_000n,
        });
      }
      // The arena operator approval is one-time too - move it out of the entry window.
      const approved = (await publicClient.readContract({
        address: ENV.NPM_ADDRESS,
        abi: nonfungiblePositionManagerAbi,
        functionName: 'isApprovedForAll',
        args: [me, market.feeArena],
      })) as boolean;
      if (!approved) {
        await submit({ address: ENV.NPM_ADDRESS, abi: nonfungiblePositionManagerAbi, functionName: 'setApprovalForAll', args: [market.feeArena, true], gas: 200_000n });
      }
    },
    [publicClient, baseToken, market.quoteSymbol, market.feeArena, market.pool, lpRangePct, writeWith],
  );

  /**
   * Start the session. ONE wallet BROADCAST - a single native-USDC transfer that seeds the
   * session's gas (and, for USDC markets, its whole budget). Every OTHER leg is an EIP-3009
   * signature the SESSION submits through the app's resilient RPC, so the user's wallet
   * touches its own (often rate-limited) RPC exactly once, on a first atomic transfer that
   * strands nothing if it fails. This is what killed the "second broadcast dies" class that
   * stranded sessions: there is no second wallet broadcast, and no pool is ever touched.
   */
  const start = useCallback(
    async (budgetUsdc: number) => {
      if (!owner || !publicClient || baseToken === undefined) throw new Error('Connect your wallet first.');
      // Serialize against every other session operation: a Stop clicked while funding is
      // pending must never race this flow (it could clear the key funds are heading to).
      if (!(await acquireLock(10_000))) throw new Error('another session operation is in flight - try again in a moment');
      setBusy(true);
      try {
        const key = loadKey(market.id) ?? generatePrivateKey();
        const acct = privateKeyToAccount(key);
        // The KEY is persisted before any funds move (recoverability), but the session is
        // NOT activated yet - activation happens only when funding has truly confirmed.
        try {
          window.localStorage.setItem(sessionKeyFor(market.id), key);
          rememberSessionAddress(acct.address);
        } catch {
          throw new Error('this browser blocks local storage - the session key could not be saved, so no funds were moved');
        }

        const quoteTok = quoteToken(market.quoteSymbol);
        const quoteIsNative = quoteTok.symbol === 'USDC';
        const usdcFacade = quoteToken('USDC');
        const sessionWallet = sessionWalletFor(acct);

        // Size the base leg (cirBTC) to the budget: a full-range LP pulls both tokens in
        // price ratio, so the user supplies budget-worth of each. Oracle price is
        // quote-per-base (the BTC/EUR cross for the EURC market) - quote-agnostic here.
        const { price18 } = market.quoteFeedId
          ? await fetchPythCrossUpdateWithPrice(ENV.HERMES_URL, market.feedId, market.quoteFeedId)
          : await fetchPythUpdateWithPrice(ENV.HERMES_URL, market.feedId);
        const priceQuote = Number(price18) / 1e18;
        const baseUnits = BigInt(Math.ceil((budgetUsdc / priceQuote) * 10 ** baseToken.decimals * 1.03));
        const baseLeg = baseUnits > MIN_BASE_LEG_UNITS ? baseUnits : MIN_BASE_LEG_UNITS;

        const gasMargin6 = parseUnits(String(GAS_MARGIN_USDC), usdcFacade.decimals);
        const budget6 = parseUnits(budgetUsdc.toFixed(quoteTok.decimals), quoteTok.decimals);
        // The ONE wallet broadcast carries native USDC. USDC markets fold the budget in
        // (native IS the quote leg via the facade); EURC markets send only gas here - the
        // EURC budget rides as a signature.
        const nativeTarget6 = quoteIsNative ? budget6 + gasMargin6 : gasMargin6;

        // What the session ALREADY holds - an interrupted Start parks funds at the session
        // address, so each leg sends only its SHORTFALL. Start is idempotent: pressing it
        // again after any failure finishes the missing leg, never double-funds a landed one.
        // These reads are NOT swallowed: a read that FAILS must abort Start (before any funds
        // move) rather than be read as a zero balance - treating "couldn't read" as "empty"
        // would re-fund a leg that already landed (a resume double-fund).
        const [ownerUsdc, ownerBase, ownerQuote, sessNative, sessBase, sessQuote] = await Promise.all([
          publicClient.readContract({ address: usdcFacade.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
          publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
          publicClient.readContract({ address: quoteTok.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>,
          publicClient.getBalance({ address: acct.address }),
          publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] }) as Promise<bigint>,
          publicClient.readContract({ address: quoteTok.address, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] }) as Promise<bigint>,
        ]);
        const sessNative6 = sessNative / 10n ** 12n; // 18dp native → 6dp facade units
        const usdcShort = nativeTarget6 > sessNative6 ? nativeTarget6 - sessNative6 : 0n;
        const baseShort = baseLeg > sessBase ? baseLeg - sessBase : 0n;
        const quoteShort = !quoteIsNative && budget6 > sessQuote ? budget6 - sessQuote : 0n;

        // Balance checks up front - before anything moves.
        if (ownerUsdc < usdcShort) {
          throw new Error(
            `the session needs ${formatUnits(usdcShort, usdcFacade.decimals)} USDC${quoteIsNative ? ' (budget + gas)' : ' for gas'} - your wallet holds ${formatUnits(ownerUsdc, usdcFacade.decimals)}. Lower the budget cap or top up USDC.`,
          );
        }
        if (ownerBase < baseShort) {
          throw new Error(
            `a ${budgetUsdc} ${quoteTok.symbol} LP needs ~${formatUnits(baseLeg, baseToken.decimals)} ${baseToken.symbol} as its other half - your wallet holds ${formatUnits(ownerBase, baseToken.decimals)}. Get ${baseToken.symbol} from the faucet or lower the budget cap.`,
          );
        }
        if (ownerQuote < quoteShort) {
          throw new Error(
            `the session needs ${formatUnits(quoteShort, quoteTok.decimals)} ${quoteTok.symbol} for its budget - your wallet holds ${formatUnits(ownerQuote, quoteTok.decimals)}. Lower the budget cap or top up ${quoteTok.symbol}.`,
          );
        }

        const isRejection = (err: unknown) => err instanceof Error && /reject|denied|cancel/i.test(err.message);
        // A wallet BROADCAST of one ERC-20 transfer, up to three attempts. A rejection is a
        // decision, never retried. Explicit gas limit skips the wallet's estimation
        // round-trip; the chainId pin makes a wrong-network wallet fail loud.
        const sendLegByTransfer = async (token: `0x${string}`, amount: bigint, what: string) => {
          for (let attempt = 1; ; attempt++) {
            try {
              const tx = await writeContractAsync({
                address: token,
                abi: erc20Abi,
                functionName: 'transfer',
                args: [acct.address, amount],
                chainId: arcTestnet.id,
                gas: 120_000n,
              } as Parameters<typeof writeContractAsync>[0]);
              const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });
              if (rc.status !== 'success') throw new Error(`the ${what} funding transaction reverted`);
              return;
            } catch (err) {
              if (isRejection(err) || attempt >= 3) throw err;
              await new Promise((r) => setTimeout(r, 3_000));
            }
          }
        };
        // An ERC-20 leg, funded by whatever rail THIS wallet actually supports:
        // - Browser wallets: EIP-3009 signature, submitted by the SESSION through the app's
        //   resilient transport (their own RPC is the fragile part - no second broadcast).
        // - The embedded Circle wallet: a plain transfer broadcast. It cannot sign raw
        //   EIP-712 (field case: three "unknown RPC error" strandings in a row), and it
        //   never needed the signature rail - its broadcasts run on Circle's server-side
        //   execution API, immune to the local-RPC rate-limit class.
        // - Any other wallet whose typed-data SIGNING fails (before anything is submitted):
        //   same transfer fallback. Submit-stage failures never fall back - the signed
        //   authorization could still be pending, and the deterministic nonce (not a second
        //   transfer) is the double-fund guard there.
        const submit = (req: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; gas?: bigint }) =>
          writeWith(sessionWallet, acct, req);
        const fundErc20Leg = async (token: `0x${string}`, amount: bigint, legTag: string) => {
          if (!embeddedWallet) {
            try {
              await pullByAuthorization(submit, acct.address, token, owner, amount, legTag);
              return;
            } catch (err) {
              const m = err instanceof Error ? err.message : '';
              if (!m.startsWith('SIGN_STAGE:') || isRejection(err)) throw err;
              // signing unavailable on this wallet - fall through to the broadcast rail
            }
          }
          await sendLegByTransfer(token, amount, legTag);
        };
        let legInFlight = '';
        try {
          // STEP 1 - the native-USDC broadcast: session gas, plus the budget for USDC
          // markets. It goes FIRST and is atomic: a failure strands nothing (the transfer
          // either lands whole or not at all).
          if (usdcShort > 0n) {
            legInFlight = 'gas';
            await sendLegByTransfer(usdcFacade.address, usdcShort, 'gas');
          }
          // STEP 2 - the cirBTC base leg (signature rail or broadcast, per wallet).
          if (baseShort > 0n) {
            legInFlight = 'base';
            await fundErc20Leg(baseToken.address, baseShort, 'base');
          }
          // STEP 3 (EURC markets only) - the EURC budget leg, same per-wallet rail.
          if (quoteShort > 0n) {
            legInFlight = 'budget';
            await fundErc20Leg(quoteTok.address, quoteShort, 'budget');
          }
        } catch (err) {
          // Decide by ON-CHAIN truth. A read that FAILS returns null, NOT 0n - the two must
          // never be conflated here, because the "nothing moved" branch DELETES the session
          // key, and the key is the only thing that can ever move funds that DID land back
          // out. So the destructive rollback fires ONLY when all three reads SUCCEEDED and
          // are truly zero; any read failure is treated as "funds may be present" → keep the
          // key and open recovery. (A rate-limit storm - the very thing that failed the
          // funding leg - used to fail these reads too, delete the key, and strand the funds
          // with an error that told the user nothing moved.)
          const [nativeBal, baseBal, quoteBal] = await Promise.all([
            publicClient.getBalance({ address: acct.address }).then((v) => v as bigint | null).catch(() => null),
            (publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] }) as Promise<bigint>).then((v) => v as bigint | null).catch(() => null),
            (publicClient.readContract({ address: quoteTok.address, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address] }) as Promise<bigint>).then((v) => v as bigint | null).catch(() => null),
          ]);
          const allRead = nativeBal !== null && baseBal !== null && quoteBal !== null;
          const nothingMoved = allRead && nativeBal === 0n && baseBal === 0n && quoteBal === 0n;
          if (nothingMoved) {
            // Clean rollback: reads succeeded and everything is truly zero - forget the key.
            try {
              window.localStorage.removeItem(sessionKeyFor(market.id));
            } catch {
              // best-effort
            }
            const reason = err instanceof Error ? err.message.slice(0, 140) : 'rejected in the wallet';
            throw new Error(`funding was not approved (${reason}) - no funds moved and no session was started`);
          }
          // Partial (or unverifiable) funding: money may be at the session address. Activate
          // for recovery and KEEP the key - Start resumes the shortfall, Stop returns it.
          setAccount(acct);
          void refresh();
          const legNote = legInFlight !== '' ? `the ${legInFlight} leg` : 'a funding leg';
          // Prefer viem's `.details` (the wallet's OWN words) over the wrapper message -
          // "An unknown RPC error occurred. Details:" once ate the whole 90-char budget and
          // hid the actual cause. Strip the internal SIGN_STAGE tag before showing it.
          const raw = err instanceof Error ? ((err as { details?: string }).details || err.message).replace(/^SIGN_STAGE:/, '') : '';
          const detail = raw !== '' ? ` (wallet: ${raw.slice(0, 120)})` : '';
          throw new Error(
            `funding stopped at ${legNote} - press Start again to finish it, or "Stop & sweep back" to return what moved${detail}`,
          );
        }

        // Every leg is on-chain - NOW the session is live.
        setAccount(acct);
        void refresh();

        // Build the LP + every one-time approval RIGHT NOW, outside any entry window -
        // entries become stake-only (~3-6s), so even a late odds-crossing is enterable.
        // Non-fatal: enterEpoch rebuilds anything missing the moment it notices.
        try {
          await prepareLpWith(sessionWallet, acct);
          void refresh();
        } catch {
          // completed at entry time instead
        }
      } finally {
        acting.current = false;
        setBusy(false);
      }
    },
    [owner, publicClient, baseToken, market.quoteSymbol, market.id, market.feedId, market.quoteFeedId, writeContractAsync, refresh, sessionWalletFor, writeWith, pullByAuthorization, prepareLpWith, embeddedWallet],
  );

  /** Enter the current epoch with `side` - approvals + LP mint on first use, then stake. */
  const enterEpoch = useCallback(
    async (side: StanceView): Promise<{ ok: true; txHash: string; claimedFirst: boolean } | { ok: false; reason: string; permanent?: boolean }> => {
      if (account === null || !publicClient || baseToken === undefined) return { ok: false, reason: 'session not active', permanent: true };
      if (!(await acquireLock(0))) return { ok: false, reason: 'another session operation is in flight' };
      setBusy(true);
      try {
        const me = account.address;
        const quote = quoteToken(market.quoteSymbol).address;
        let state = await refresh();
        if (state === null) return { ok: false, reason: 'could not read session state' };

        // Idempotency guard: one stake per epoch per position - if this epoch is already
        // entered, report it as settled business rather than retrying into a revert.
        const [epochNow, myStakes] = await Promise.all([
          publicClient.readContract({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'currentEpoch' }) as Promise<{ epochId: bigint; entryCloseTime: bigint }>,
          publicClient.readContract({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'getUserStakes', args: [me] }) as Promise<readonly { epochId: bigint; unstaked: boolean }[]>,
        ]);
        if (myStakes.some((s) => s.epochId === epochNow.epochId && !s.unstaked)) {
          return { ok: false, reason: 'already entered this epoch', permanent: true };
        }
        // LP setup is EPOCH-INDEPENDENT - build it the moment it is missing, whatever the
        // clock says. (The old "needs ≥60s of window" skip could repeat forever: at a tight
        // band, confident odds only ever crossed the floor late in the window, so a fully
        // funded session idled for hours entering nothing. A mint done at the buzzer is not
        // wasted - it makes every FUTURE entry stake-only.)
        let justMinted = false;
        if (state.tokenId === null) {
          if (wallet === null) return { ok: false, reason: 'session signer unavailable', permanent: true };
          try {
            await prepareLpWith(wallet, account);
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'LP setup failed';
            if (msg.includes('too small')) return { ok: false, reason: msg, permanent: true };
            return { ok: false, reason: `LP setup hit a snag: ${msg.slice(0, 120)}` };
          }
          justMinted = true;
          state = (await refresh()) ?? state;
          if (state.tokenId === null) return { ok: false, reason: 'LP mint did not complete' };
        }
        if (state.lpStaked) return { ok: false, reason: 'LP position not yet returned from the previous epoch' };

        // Bail BEFORE claims/stake when the window is nearly over - FRESH clock, because
        // the setup above takes real time. The final <6s re-check stays as the last line.
        const leftForStake = Number(epochNow.entryCloseTime) - Math.floor(Date.now() / 1000);
        if (leftForStake < 15) {
          return {
            ok: false,
            reason: justMinted ? 'LP is ready - entering from the next epoch' : 'not enough entry time left this epoch - ready for the next one',
            permanent: true,
          };
        }

        // Claim-before-restake: the arena keeps ONE position record per token, overwritten
        // on the next stake - an unclaimed win would be silently lost. Collect it first,
        // and REPORT it (claimedFirst) so the feed can tell the user their win was banked.
        let claimedFirst = false;
        if (state.tokenId !== null) {
          const pv = (await publicClient.readContract({
            address: market.feeArena,
            abi: feeArenaV3Abi,
            functionName: 'previewClaim',
            args: [state.tokenId],
          })) as { claimable: boolean };
          if (pv.claimable) {
            await write({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'claim', args: [state.tokenId], gas: 800_000n });
            claimedFirst = true;
          }
        }

        // Arena operator approval (once), then the entry-anchored stake with a fresh blob.
        const approved = (await publicClient.readContract({
          address: ENV.NPM_ADDRESS,
          abi: nonfungiblePositionManagerAbi,
          functionName: 'isApprovedForAll',
          args: [me, market.feeArena],
        })) as boolean;
        if (!approved) {
          await write({ address: ENV.NPM_ADDRESS, abi: nonfungiblePositionManagerAbi, functionName: 'setApprovalForAll', args: [market.feeArena, true], gas: 200_000n });
        }
        // Final window check right before committing - approvals/mint above take real time,
        // and a stake that lands after entry closes reverts (gas for nothing).
        const epochRecheck = (await publicClient.readContract({
          address: market.feeArena,
          abi: feeArenaV3Abi,
          functionName: 'currentEpoch',
        })) as { epochId: bigint; phase: number | bigint; entryCloseTime: bigint };
        if (Number(epochRecheck.phase) !== 1 || Number(epochRecheck.entryCloseTime) - Math.floor(Date.now() / 1000) < 6) {
          return { ok: false, reason: 'entry window closed during setup - ready for the next epoch', permanent: true };
        }

        const { updateData, price18 } = market.quoteFeedId
          ? await fetchPythCrossUpdateWithPrice(ENV.HERMES_URL, market.feedId, market.quoteFeedId)
          : await fetchPythUpdateWithPrice(ENV.HERMES_URL, market.feedId);
        const fee = (await publicClient.readContract({
          address: ENV.PYTH_ADDRESS,
          abi: pythAbi,
          functionName: 'getUpdateFee',
          args: [updateData],
        })) as bigint;
        const txHash = await write({
          address: market.feeArena,
          abi: feeArenaV3Abi,
          functionName: 'stakeWithSide',
          args: [state.tokenId, SIDE_ENUM[side], price18, 300n, updateData],
          value: fee,
          gas: 1_200_000n,
        });
        void refresh();
        return { ok: true, txHash, claimedFirst };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'entry failed' };
      } finally {
        acting.current = false;
        setBusy(false);
      }
    },
    [account, publicClient, baseToken, market.feeArena, market.pool, market.feedId, market.quoteFeedId, lpRangePct, refresh, write, wallet, prepareLpWith],
  );

  /** Claim settled wins with the session signer - zero prompts. Serialized like entries. */
  const claimMany = useCallback(
    async (tokenIds: readonly (string | bigint)[]): Promise<{ claimed: number; failed: number; failReason?: string }> => {
      if (account === null || !publicClient) return { claimed: 0, failed: tokenIds.length };
      if (!(await acquireLock(45_000))) return { claimed: 0, failed: tokenIds.length, failReason: 'another session operation is in flight' };
      let claimed = 0;
      let failed = 0;
      let failReason: string | undefined;
      for (const id of [...new Set(tokenIds.map((t) => BigInt(t)))]) {
        try {
          const pv = (await publicClient.readContract({
            address: market.feeArena,
            abi: feeArenaV3Abi,
            functionName: 'previewClaim',
            args: [id],
          })) as { claimable: boolean };
          if (!pv.claimable) continue; // stale record - nothing actually owed on this token
          await write({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'claim', args: [id], gas: 800_000n });
          claimed += 1;
        } catch (err) {
          // Receipt-truth before blame: a slow RPC can time out the receipt wait AFTER the
          // claim has already mined (field case: Claimed event at :36:34, "failed" note at
          // :37:35 - exactly the 60s timeout). If the win is no longer claimable, it WAS
          // claimed - count it as such instead of crying wolf.
          try {
            const pv2 = (await publicClient.readContract({
              address: market.feeArena,
              abi: feeArenaV3Abi,
              functionName: 'previewClaim',
              args: [id],
            })) as { claimable: boolean };
            if (!pv2.claimable) {
              claimed += 1;
              continue;
            }
          } catch {
            // even the re-check failed - report the original error below
          }
          failed += 1;
          // Keep the FIRST reason - a silent failure count taught us nothing when claims
          // kept failing in the field.
          failReason ??= err instanceof Error ? err.message.slice(0, 160) : 'claim failed';
        }
      }
      acting.current = false;
      if (claimed > 0) void refresh();
      return { claimed, failed, failReason };
    },
    [account, publicClient, market.feeArena, write, refresh],
  );

  /** Reveal the session key for backup (clipboard) - losing this browser's storage while
   *  the LP is staked would otherwise orphan the session's funds. */
  const exportKey = useCallback((): string | null => loadKey(market.id), [market.id]);

  /** Stop: claim anything claimable, then sweep the LP NFT and every balance back home.
   *  `retriable: true` marks the ONE failure that resolves by itself (LP staked in a live
   *  epoch - settlement returns it); every other failure needs the user to press Stop again. */
  const stop = useCallback(async (): Promise<{ swept: boolean; reason?: string; retriable?: boolean; moved?: string }> => {
    if (account === null || !publicClient || !owner || baseToken === undefined) return { swept: false, reason: 'no session' };
    if (!(await acquireLock(45_000))) return { swept: false, reason: 'an entry is in flight - try again in a few seconds' };
    setBusy(true);
    try {
      // Gas first: every recovery step below - claims, the LP unwind, the token sweeps -
      // is a session-signed transaction, and on Arc gas IS native USDC. A session whose
      // funding was interrupted can hold tokens with a zero native balance (field case:
      // ~$400 of cirBTC stranded), and such a signer cannot even simulate a transfer
      // (eth_call pre-deducts gasLimit×maxFee). Top it up from the connected wallet; the
      // surplus rides home again in the final native sweep.
      const pre = await refresh();
      if (pre === null) return { swept: false, reason: 'could not read session state' };
      const quoteTokPre = quoteToken(market.quoteSymbol);
      const holdsFunds =
        pre.base > 0n || pre.tokenId !== null || (quoteTokPre.symbol !== 'USDC' && pre.quoteBal > 0n);
      if (holdsFunds && pre.usdc < parseUnits('0.5', 18)) {
        try {
          const usdcFacade = quoteToken('USDC');
          const tx = await writeContractAsync({
            address: usdcFacade.address,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [account.address, parseUnits(String(GAS_MARGIN_USDC), usdcFacade.decimals)],
            // Pin the chain: on a wrong-network browser wallet wagmi then fails with an
            // explicit chain-mismatch message instead of an opaque instant throw. The
            // fixed gas limit skips the wallet's estimation round-trip (rate-limit surface).
            chainId: arcTestnet.id,
            gas: 120_000n,
          } as Parameters<typeof writeContractAsync>[0]);
          const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 90_000 });
          if (rc.status !== 'success') throw new Error('the gas top-up transaction reverted');
        } catch (err) {
          // Say what the WALLET said - a silent instant failure (no approval window at
          // all) has wallet-specific causes: browser wallets locked / parked on another
          // network / holding a stuck pending request; Google-email sign-ins expired.
          // "Approve the transfer" alone is useless advice when no prompt ever appeared.
          const detail = err instanceof Error && err.message !== '' ? ` Your wallet reported: ${err.message.slice(0, 120)}.` : '';
          return {
            swept: false,
            reason: `the session has funds but no gas money left - the sweep needs a small $${GAS_MARGIN_USDC} USDC top-up from your wallet (it comes straight back with the sweep).${detail} If no approval window appeared: unlock your wallet, make sure it is on Arc Testnet and has no stuck pending request (or for Google/email sign-ins, sign out and back in) - then press Stop again`,
          };
        }
      }
      // Unclaimed settled wins first - sweeping without claiming would strand them.
      const stakes = (await publicClient.readContract({
        address: market.feeArena,
        abi: feeArenaV3Abi,
        functionName: 'getUserStakes',
        args: [account.address],
      })) as readonly { tokenId: bigint; processed: boolean; won: boolean; claimed: boolean }[];
      for (const id of [...new Set(stakes.map((s) => s.tokenId))]) {
        try {
          const pv = (await publicClient.readContract({
            address: market.feeArena,
            abi: feeArenaV3Abi,
            functionName: 'previewClaim',
            args: [id],
          })) as { claimable: boolean };
          if (pv.claimable) {
            await write({ address: market.feeArena, abi: feeArenaV3Abi, functionName: 'claim', args: [id], gas: 800_000n });
          }
        } catch {
          // a failed claim is not lost - it stays claimable by this key (see exportKey)
        }
      }
      let state = await refresh();
      if (state === null) return { swept: false, reason: 'could not read session state' };
      if (state.lpStaked) {
        return { swept: false, retriable: true, reason: 'the LP is staked in a live epoch - press Stop again after it settles (it auto-returns)' };
      }
      const movedParts: string[] = [];
      if (state.tokenId !== null) {
        // Describe what the position CONTAINS - used in both outcomes below. Best-effort:
        // the sweep itself never depends on this.
        let lpDetail = '';
        let lpLiquidity = 0n;
        let lpOwed0 = 0n;
        let lpOwed1 = 0n;
        try {
          const [pos, slot0raw] = await Promise.all([
            publicClient.readContract({
              address: ENV.NPM_ADDRESS,
              abi: nonfungiblePositionManagerAbi,
              functionName: 'positions',
              args: [state.tokenId],
            }) as Promise<readonly unknown[]>,
            publicClient.readContract({ address: market.pool, abi: uniswapV3PoolAbi, functionName: 'slot0' }),
          ]);
          lpLiquidity = pos[7] as bigint;
          lpOwed0 = pos[10] as bigint;
          lpOwed1 = pos[11] as bigint;
          const s0 = decodeSlot0(slot0raw);
          if (s0 !== undefined) {
            const { amount0, amount1 } = positionAmounts({
              liquidity: lpLiquidity,
              sqrtPriceX96: s0.sqrtPriceX96,
              tickLower: Number(pos[5]),
              tickUpper: Number(pos[6]),
            });
            const quoteTok = quoteToken(market.quoteSymbol);
            const baseIsToken0 = BigInt(baseToken.address) < BigInt(quoteTok.address);
            const baseIn = (baseIsToken0 ? amount0 : amount1) + (baseIsToken0 ? lpOwed0 : lpOwed1);
            const quoteIn = (baseIsToken0 ? amount1 : amount0) + (baseIsToken0 ? lpOwed1 : lpOwed0);
            const dec0 = baseIsToken0 ? baseToken.decimals : quoteTok.decimals;
            const dec1 = baseIsToken0 ? quoteTok.decimals : baseToken.decimals;
            const price = sqrtPriceX96ToPrice(s0.sqrtPriceX96, dec0, dec1, baseIsToken0);
            const baseHuman = Number(formatUnits(baseIn, baseToken.decimals));
            const quoteHuman = Number(formatUnits(quoteIn, quoteTok.decimals));
            const total = quoteHuman + baseHuman * price;
            const money = (x: number) => (quoteTok.symbol === 'USDC' ? `$${x.toFixed(2)}` : `${x.toFixed(2)} ${quoteTok.symbol}`);
            lpDetail = `≈ ${baseHuman.toFixed(6)} ${baseToken.symbol} + ${money(quoteHuman)} - ≈ ${money(total)} in total`;
          }
        } catch {
          // best-effort description only
        }

        // Sweep Back means MONEY back, not a position NFT the wallet's token list can't
        // show (field case: a $203 position read as "only $2.69 returned"). Unwind the LP
        // into its tokens at the session (decreaseLiquidity + collect in ONE multicall),
        // then the ordinary token sweeps below carry everything home as balances.
        let unwound = false;
        try {
          const calls: `0x${string}`[] = [];
          if (lpLiquidity > 0n) {
            calls.push(
              encodeFunctionData({
                abi: nonfungiblePositionManagerAbi,
                functionName: 'decreaseLiquidity',
                args: [{ tokenId: state.tokenId, liquidity: lpLiquidity, amount0Min: 0n, amount1Min: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 1200) }],
              }),
            );
          }
          if (lpLiquidity > 0n || lpOwed0 > 0n || lpOwed1 > 0n) {
            calls.push(
              encodeFunctionData({
                abi: nonfungiblePositionManagerAbi,
                functionName: 'collect',
                args: [{ tokenId: state.tokenId, recipient: account.address, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
              }),
            );
          }
          if (calls.length > 0) {
            await write({ address: ENV.NPM_ADDRESS, abi: nonfungiblePositionManagerAbi, functionName: 'multicall', args: [calls], gas: 900_000n });
          }
          unwound = true;
        } catch {
          unwound = false;
        }

        if (unwound) {
          movedParts.push(`LP position #${state.tokenId.toString()} unwound into its tokens${lpDetail !== '' ? ` (${lpDetail})` : ''}`);
          // The collected amounts now sit at the session - refresh so the token sweeps
          // below move the FULL balances, not the pre-unwind dust.
          state = (await refresh()) ?? state;
        } else {
          // Never strand: if the unwind failed for any reason, ship the NFT itself - the
          // position (and everything in it) still belongs to the owner.
          await write({
            address: ENV.NPM_ADDRESS,
            abi: nonfungiblePositionManagerAbi,
            functionName: 'safeTransferFrom',
            args: [account.address, owner, state.tokenId],
            gas: 400_000n,
          });
          movedParts.push(
            `LP position #${state.tokenId.toString()}${lpDetail !== '' ? ` (holding ${lpDetail} - withdraw it on the Pools page)` : ''}`,
          );
        }
      }
      if (state.base > 0n) {
        await write({ address: baseToken.address, abi: erc20Abi, functionName: 'transfer', args: [owner, state.base], gas: 200_000n });
        movedParts.push(`${formatUnits(state.base, baseToken.decimals)} ${baseToken.symbol}`);
      }
      // Non-USDC quotes (EURC) live as a separate ERC-20 balance - sweep it explicitly.
      {
        const quoteTok = quoteToken(market.quoteSymbol);
        if (quoteTok.symbol !== 'USDC' && state.quoteBal > 0n) {
          await write({ address: quoteTok.address, abi: erc20Abi, functionName: 'transfer', args: [owner, state.quoteBal], gas: 200_000n });
          movedParts.push(`${formatUnits(state.quoteBal, quoteTok.decimals)} ${quoteTok.symbol}`);
        }
      }
      const balance = await publicClient.getBalance({ address: account.address });
      const sweepReserve = parseUnits('0.05', 18);
      if (balance > sweepReserve && wallet !== null) {
        const hash = await wallet.sendTransaction({ to: owner, value: balance - sweepReserve, ...withGasFloor({}) } as never);
        const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (rc.status !== 'success') throw new Error('the final USDC sweep reverted - the session stays open, try Stop again');
        movedParts.push(`$${Number(formatUnits(balance - sweepReserve, 18)).toFixed(2)} USDC`);
      }
      try {
        window.localStorage.removeItem(sessionKeyFor(market.id));
      } catch {
        // best-effort
      }
      setAccount(null);
      setInfo(null);
      return { swept: true, moved: movedParts.length > 0 ? movedParts.join(' + ') : undefined };
    } catch (err) {
      return { swept: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'sweep failed' };
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }, [account, publicClient, owner, baseToken, wallet, market.id, market.pool, market.quoteSymbol, refresh, write, writeContractAsync]);

  return { active: account !== null, address: account?.address ?? null, info, busy, start, stop, enterEpoch, claimMany, exportKey, refresh };
}
