// lib/agent/copilot.ts - the Limen Copilot's brain: system prompt, tool definitions, and
// the server-side tool executors the chat route runs between model turns.
//
// The copilot is a tool-driven assistant: every number it states comes from a tool that read
// the chain / the oracle / the curated knowledge base - never from the model's imagination.
// Actions are NEVER executed here: the model calls `propose_action`, the route forwards the
// proposal to the client, and the user confirms (or declines) in the UI, where the app's
// existing, battle-tested transaction hooks do the signing. The model is told exactly that.
import { createPublicClient, fallback, http, formatUnits } from 'viem';
import { arcTestnet } from '@/lib/chain';
import { marketById, MARKETS } from '@/lib/markets';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import { erc20Abi } from '@/abis/erc20';
import { TOKENS } from '@/lib/tokens';
import { buildSignalBundle, readEpochSlice, SIGNAL_DISCLAIMER } from '@/lib/agent/signalCore';
import { fetchPythUpdateWithPrice, fetchPythCrossUpdateWithPrice } from '@/lib/pyth';
import { ENV } from '@/lib/env';
import { withRateLimitResilience } from '@/lib/rpcResilience';
import { ARC_EXTRA_HTTP_RPCS } from '@/lib/arcEndpoints';

// Lazily constructed so importing this module (e.g. in tests) has no env/network side effects.
// Primary + Circle-documented mirrors behind the shared gate - tool reads survive throttles.
let _client: ReturnType<typeof createPublicClient> | undefined;
const client = () =>
  (_client ??= createPublicClient({
    chain: arcTestnet,
    transport: withRateLimitResilience(fallback([http(), ...ARC_EXTRA_HTTP_RPCS.map((u) => http(u))])),
  }));

// ─── System prompt ───────────────────────────────────────────────────────────────────────

/** The copilot's request context: who is asking, on which market, and which addresses are THEIRS. */
export interface CopilotCtx {
  address?: string;
  /** The LIVE unattended session signer, when one is running. */
  sessionAddress?: string;
  /** Recent (already swept) session signer addresses - their history still belongs to the user. */
  pastSessionAddresses?: string[];
  marketId: string;
}

export function systemPrompt(ctx: CopilotCtx): string {
  const markets = MARKETS.map((m) => `${m.id} (${m.label})`).join(', ');
  return [
    'You are the Limen Copilot - the in-app assistant of Limen Finance, an epoch-based fee-allocation layer on Circle\'s Arc testnet.',
    'Core mechanic (be precise, never improvise): LPs provide V3-style liquidity, then during each epoch\'s entry window they may opt their LP position into a Stance - a market view of UP, DOWN, or RANGE - anchored to a per-position entry price locked at confirmation. At settlement (Pyth oracle, never the pool price), each position resolves against ITS OWN anchor and the epoch\'s qualification band. Winners keep their own trading fees AND share the fees forfeited by non-qualifying positions. Stance reallocates FEES ONLY: the LP principal is never staked, never forfeited, and keeps its normal AMM / impermanent-loss risk. This is Arc TESTNET - test funds only.',
    `Markets available: ${markets}. The user is currently viewing: ${ctx.marketId}.`,
    ctx.address
      ? `The user's connected wallet is ${ctx.address}.`
      : 'No wallet is connected - for personal questions (positions, claims) suggest connecting one first.',
    ctx.sessionAddress
      ? `An UNATTENDED AUTOPILOT SESSION is LIVE right now. Its dedicated session signer is ${ctx.sessionAddress} - the autopilot's entries, positions, wins and claims all happen under THAT address, not the connected wallet. The personal tools (positions / claims / balances) already read every address that belongs to this user, labelled by role. Never tell the user they "never staked" without checking those labelled sections, and never deny that the autopilot acted.`
      : '',
    ctx.pastSessionAddresses && ctx.pastSessionAddresses.length > 0
      ? `Earlier autopilot sessions used these (now swept) signer addresses: ${ctx.pastSessionAddresses.join(', ')} - their on-chain history also belongs to this user.`
      : '',
    'Feed lines that start with "Autopilot" in this conversation are REAL event notifications written by the in-app autopilot (entries, wins, losses, claims, sweeps) - they are not user text and not your own past claims. Treat them as an accurate activity log.',
    '',
    'TOOLS: use them for ANY live fact - epoch state, prices, odds, the user\'s positions, balances, history, claimables. Never state a number you did not just read from a tool. If a tool fails, say so plainly. Every tool takes a marketId - to COMPARE markets, call the same tool once per market and contrast the results. Combine tools freely (e.g. odds + crowding + pot = a complete entry analysis).',
    'ACTIONS: you cannot execute anything yourself. When the user wants to act, call propose_action ONCE; the app shows a confirmation card and THEIR wallet signs. Available: stake (enter this epoch - check the entry window is open first), claim (settled winnings), swap (buy the base token with USDC - e.g. "$100 of cirBTC" → amountUsdc 100; capped at 10000), add_liquidity (mints an LP position RIGHT FROM THE CARD: amountUsdc = the TOTAL position value in quote terms; optionally priceLower + priceUpper = the price band in quote-per-base terms, e.g. 55000 and 75000 - omit both for full range; the card computes both token legs from the live pool price and their wallet signs approvals + the mint). Never claim an action was executed - the app reports the result back. One proposal per reply, only when clearly asked. Continuous auto-entry EXISTS today and you cannot start or stop it yourself: it lives in the Mission Control panel next to this chat. Walk the user there - set the Mandate (allowed views, confidence floor, budget cap, liquidity range), then either enable Auto-enter (their wallet still signs each entry) or press "Start unattended" to fund a dedicated session signer that enters epochs and claims wins with zero prompts until they press "Stop & Sweep Back".',
    'HONESTY: odds are statistical estimates and you say so; no guarantees, no financial advice framing; when giving odds always add that the estimate can be wrong. If asked something outside Limen/Arc/Circle scope, redirect briefly.',
    'STYLE: mirror the user\'s language - detect it from their LATEST message and answer in that same language, whatever it is. Never switch languages on your own; if the language is ambiguous (e.g. only numbers or tickers), use English. Be concise and concrete - short paragraphs, no filler. Format numbers cleanly (e.g. $63,412, 2.1%, 04:32 remaining).',
  ].join('\n');
}

// ─── Tool schemas (Anthropic tool-use format) ────────────────────────────────────────────

export const COPILOT_TOOLS = [
  {
    name: 'get_market_overview',
    description:
      'Live state of a Limen market: current epoch id/phase, time remaining in the entry window and until settlement, the qualification band, and the live oracle price.',
    input_schema: {
      type: 'object',
      properties: { marketId: { type: 'string', description: 'Market id, e.g. "cirbtc" or "cirbtc-eurc". Defaults to the market the user is viewing.' } },
      required: [],
    },
  },
  {
    name: 'get_stance_signal',
    description:
      'Statistical qualification-odds estimate for UP / DOWN / RANGE this epoch (realized volatility + momentum vs the band over the remaining time), with a plain-language rationale. Advisory only.',
    input_schema: {
      type: 'object',
      properties: { marketId: { type: 'string', description: 'Market id. Defaults to the market the user is viewing.' } },
      required: [],
    },
  },
  {
    name: 'get_user_positions',
    description:
      "The connected wallet's Limen state on a market: staked positions in the current epoch (side, entry anchor, whether qualifying at the live price) and LP positions available to stake.",
    input_schema: {
      type: 'object',
      properties: { marketId: { type: 'string', description: 'Market id. Defaults to the market the user is viewing.' } },
      required: [],
    },
  },
  {
    name: 'get_limen_knowledge',
    description:
      'Curated, accurate product knowledge. Topics: mechanics | risk | settlement | fees | markets | bridge | wallets | agent.',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'One of: mechanics, risk, settlement, fees, markets, bridge, wallets, agent.' } },
      required: ['topic'],
    },
  },
  {
    name: 'get_side_concentration',
    description:
      "Where the CURRENT epoch's participants sit: per-side position counts and staked-value share for UP / DOWN / RANGE, plus which side is most crowded. Useful because a crowded winning side splits the reallocated pot thinner.",
    input_schema: {
      type: 'object',
      properties: { marketId: { type: 'string', description: 'Market id. Defaults to the market the user is viewing.' } },
      required: [],
    },
  },
  {
    name: 'get_epoch_history',
    description:
      "How recent epochs actually settled: per epoch the final price, band, positions/winners (split by UP/DOWN/RANGE), the reallocated fee pot, and rollovers - plus aggregate win rates. Use for 'which side has been winning', 'how big are the pots', 'how often does RANGE qualify'.",
    input_schema: {
      type: 'object',
      properties: {
        marketId: { type: 'string', description: 'Market id. Defaults to the market the user is viewing.' },
        count: { type: 'number', description: 'How many settled epochs to include (1-12, default 6).' },
      },
      required: [],
    },
  },
  {
    name: 'get_claim_status',
    description:
      "The connected wallet's full Stance record on a market: epochs entered, wins/losses, what is claimable RIGHT NOW (exact amounts from the contract's previewClaim), and what was already claimed.",
    input_schema: {
      type: 'object',
      properties: { marketId: { type: 'string', description: 'Market id. Defaults to the market the user is viewing.' } },
      required: [],
    },
  },
  {
    name: 'get_wallet_balances',
    description:
      "The connected wallet's token balances on Arc (USDC, cirBTC, EURC) plus gas note. Use before proposing actions to check affordability, or when the user asks what they hold.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'propose_action',
    description:
      'Propose a transaction for the USER to confirm in the app UI (their wallet signs - you never execute). Use only when the user clearly asked to act.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            '"stake" (enter the current epoch with an LP position) · "claim" (collect settled winnings) · "swap" (buy the base token, e.g. cirBTC, with USDC on this market\'s pool) · "add_liquidity" (mint an LP position directly with amountUsdc as the total value and an optional priceLower/priceUpper band).',
        },
        side: { type: 'string', description: 'For stake: "UP", "DOWN", or "RANGE".' },
        amountUsdc: { type: 'number', description: 'For swap: the USDC amount to spend (e.g. 100 for $100). For add_liquidity: the TOTAL position value in quote terms (both legs combined). Max 10000.' },
        priceLower: { type: 'number', description: 'For add_liquidity: the LOWER bound of the price range, in quote per base (e.g. 55000). Omit together with priceUpper for full range.' },
        priceUpper: { type: 'number', description: 'For add_liquidity: the UPPER bound of the price range, in quote per base (e.g. 75000). Must be greater than priceLower.' },
        marketId: { type: 'string', description: 'Market id. Defaults to the market the user is viewing.' },
        note: { type: 'string', description: 'One sentence shown on the confirmation card explaining why.' },
      },
      required: ['type'],
    },
  },
] as const;

// ─── Knowledge base (curated - the copilot's ground truth for product questions) ─────────

const KNOWLEDGE: Record<string, string> = {
  mechanics:
    'Limen flow: 1) Provide liquidity to a supported market (a V3-style LP position NFT). 2) During an epoch\'s entry window, opt the position into a Stance - UP, DOWN, or RANGE - anchored to a fresh oracle price at confirmation (your personal entry anchor). 3) The epoch locks, then settles on a Pyth oracle price. 4) Each position resolves against ITS OWN anchor: UP qualifies if settlement ≥ anchor + band, DOWN if ≤ anchor − band, RANGE if it stayed inside ±band. 5) Qualifying positions keep their own trading fees AND split the fees of non-qualifying positions, pro-rata by fee contribution. 6) The LP NFT auto-returns after settlement; claim winnings any time.',
  risk:
    'What is at risk in Stance: ONLY that epoch\'s fee allocation. A non-qualifying view forfeits that epoch\'s collected fees into the winners\' pot - the LP principal itself is never staked, never forfeited, and cannot be taken by Limen. The LP position keeps its normal AMM risks (price movement, impermanent loss) exactly as it would outside Stance. If no position qualifies in an epoch, the pot rolls into the next epoch - never to the protocol. This is Arc TESTNET: test funds only.',
  settlement:
    'Settlement is oracle-anchored, never the pool price (so pool manipulation cannot corrupt outcomes). The keeper submits the epoch\'s settlement price as an average of live Pyth prices over the final 60 seconds before the settlement moment, and the contract independently verifies it against a fresh on-chain Pyth read (must be stamped at/after settlement and within a 1% sanity bound) - the keeper cannot invent a price. Each position then resolves against its own entry anchor. Settlement completes in roughly 25 seconds and every step is on-chain.',
  fees:
    'Fees come from real swap volume on the market\'s pool (0.3% per swap, accruing to in-range LPs). Stance reallocates the epoch\'s collected fees: winners keep their own and split the forfeited fees of non-qualifying positions (pro-rata by fee contribution). There are no deposit, withdrawal, or claim fees, and never a fee on LP principal.',
  markets:
    'Live markets: cirBTC/USDC - fast demo cadence (2-minute entry, 2-minute lock, ~25s settlement); cirBTC/EURC - mainnet-style cadence (12-hour entry, 12-hour lock), settling on a BTC/EUR composite oracle (BTC/USD ÷ EUR/USD). Both use Circle assets end to end (cirBTC, USDC, EURC).',
  bridge:
    'Bridging into Arc: the Bridge page supports Circle CCTP (e.g. from Base Sepolia) and Circle Gateway (e.g. from Avalanche Fuji) to bring USDC to Arc testnet. Gateway transfers are one-click via Circle\'s Forwarding Service. cirBTC comes from the Circle faucet (faucet.circle.com).',
  wallets:
    'Onboarding: connect an external wallet, or create an embedded Circle Wallet in-app (Google / email + PIN). Arc uses USDC natively for gas, so there is no separate gas token to acquire.',
  agent:
    'The Limen agent stack, all under human mandates: (1) this Copilot - information + user-confirmed actions, billed per message over Circle x402 nanopayments when enabled (gasless USDC signatures from a Circle Gateway balance). (2) The in-app Autopilot: set your mandate (allowed views, confidence floor, budget cap) and it watches epochs while the page is open, proposing entries you confirm. Start an UNATTENDED SESSION and it goes zero-prompt: a dedicated session signer (funded once from your wallet, capped at your budget) enters epochs AND claims wins entirely by itself until you press Stop, which sweeps everything back to your wallet. (3) Self-hosted 24/7: the same mandate compiles to an agent you run on your own machine with YOUR OWN Circle Agent Wallet (2-of-2 MPC) as treasury - it draws mandate-capped funding over Circle\'s transfer rail, mints its own LP, and enters epochs with no approvals after setup; piloted live on cirBTC/USDC. The platform never holds user keys or budgets; nothing autonomous ever touches user funds.',
};

// ─── Server-side tool executors ──────────────────────────────────────────────────────────

function fmtDuration(sec: number): string {
  if (sec <= 0) return 'now';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

const PHASE_NAMES: Record<number, string> = { 0: 'starting', 1: 'entry open', 2: 'locked (in progress)', 3: 'settling', 4: 'settled' };

async function livePrice18(marketId: string): Promise<bigint> {
  const m = marketById(marketId);
  const r = m.quoteFeedId
    ? await fetchPythCrossUpdateWithPrice(ENV.HERMES_URL, m.feedId, m.quoteFeedId)
    : await fetchPythUpdateWithPrice(ENV.HERMES_URL, m.feedId);
  return r.price18;
}

/** Human-format a token amount (base units + decimals). */
function fmtAmt(units: bigint, decimals: number, maxFrac = decimals <= 6 ? 2 : 6): string {
  return Number(formatUnits(units, decimals)).toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

async function execMarketOverview(marketId: string): Promise<string> {
  const m = marketById(marketId);
  const [epoch, price18, rollBase, rollUsdc] = await Promise.all([
    client().readContract({ address: m.feeArena, abi: feeArenaV3Abi, functionName: 'currentEpoch' }) as Promise<EpochRecord>,
    livePrice18(marketId),
    client().readContract({ address: m.feeArena, abi: feeArenaV3Abi, functionName: 'rolloverBase' }) as Promise<bigint>,
    client().readContract({ address: m.feeArena, abi: feeArenaV3Abi, functionName: 'rolloverUSDC' }) as Promise<bigint>,
  ]);
  const nowSec = Math.floor(Date.now() / 1000);
  const entryLeft = Number(epoch.entryCloseTime) - nowSec;
  const settleIn = Number(epoch.settlementTime) - nowSec;
  const phase = Number(epoch.phase);
  const ccy = m.quoteSymbol === 'EURC' ? '€' : '$';
  return JSON.stringify({
    market: m.label,
    epochId: epoch.epochId.toString(),
    phase: PHASE_NAMES[phase] ?? String(phase),
    entryWindowRemaining: phase === 1 ? fmtDuration(entryLeft) : 'closed',
    settlementIn: fmtDuration(settleIn),
    qualificationBand: `±${(Number(epoch.bandBps) / 100).toFixed(2)}%`,
    oraclePrice: `${ccy}${fmtAmt(price18, 18)}`,
    stakedPositions: Number(epoch.stakedCount),
    potCarriedFromPreviousEpochs:
      rollUsdc > 0n || rollBase > 0n
        ? `${ccy}${fmtAmt(rollUsdc, 6)} + ${fmtAmt(rollBase, m.baseDecimals)} ${m.baseSymbol} (unclaimed by any winner yet - boosts this epoch's prize)`
        : 'none',
    note: 'settlement uses the Pyth oracle, not the pool price; the epoch\'s own fee pot forms at settlement from forfeited fees',
  });
}

async function execStanceSignal(marketId: string): Promise<string> {
  const b = await buildSignalBundle(marketId);
  if (b.signal === null) return JSON.stringify({ signal: null, reason: b.reason });
  return JSON.stringify({
    recommendedView: b.signal.view,
    odds: {
      UP: `${(b.signal.pUp * 100).toFixed(0)}%`,
      DOWN: `${(b.signal.pDown * 100).toFixed(0)}%`,
      RANGE: `${(b.signal.pRange * 100).toFixed(0)}%`,
    },
    rationale: b.rationale,
    epochId: b.epoch.epochId,
    disclaimer: SIGNAL_DISCLAIMER,
  });
}

/** Every address that belongs to the asking user, labelled by role (connected wallet first). */
function ownedAddresses(ctx: CopilotCtx): Array<{ role: string; address: `0x${string}` }> {
  const out: Array<{ role: string; address: `0x${string}` }> = [];
  const seen = new Set<string>();
  const push = (role: string, a?: string) => {
    if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) return;
    const k = a.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ role, address: a as `0x${string}` });
  };
  push('connectedWallet', ctx.address);
  push('liveAutopilotSessionSigner', ctx.sessionAddress);
  for (const a of (ctx.pastSessionAddresses ?? []).slice(0, 3)) push('pastAutopilotSessionSigner', a);
  return out;
}

async function execUserPositions(ctx: CopilotCtx, marketId: string): Promise<string> {
  const owned = ownedAddresses(ctx);
  if (owned.length === 0) return JSON.stringify({ error: 'no wallet connected - ask the user to connect one first' });
  const m = marketById(marketId);
  const [price18, epoch] = await Promise.all([livePrice18(marketId), readEpochSlice(m.feeArena)]);
  const band = BigInt(epoch.bandBps);
  const wallets = await Promise.all(
    owned.map(async ({ role, address }) => {
      const stakes = (await client().readContract({
        address: m.feeArena,
        abi: feeArenaV3Abi,
        functionName: 'getUserStakes',
        args: [address],
      })) as readonly { tokenId: bigint; epochId: bigint; side: number; entryPrice18: bigint; unstaked: boolean }[];
      const current = stakes.filter((s) => s.epochId.toString() === epoch.epochId && !s.unstaked);
      const positions = current.map((s) => {
        const upEdge = (s.entryPrice18 * (10_000n + band)) / 10_000n;
        const downEdge = (s.entryPrice18 * (10_000n - band)) / 10_000n;
        const sideName = s.side === 1 ? 'UP' : s.side === 2 ? 'DOWN' : 'RANGE';
        const qualifyingNow =
          s.side === 1 ? price18 >= upEdge : s.side === 2 ? price18 <= downEdge : price18 > downEdge && price18 < upEdge;
        return {
          tokenId: s.tokenId.toString(),
          side: sideName,
          entryAnchor: Number(formatUnits(s.entryPrice18, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 }),
          qualifyingAtLivePrice: qualifyingNow,
        };
      });
      return { role, address, stakedThisEpoch: positions };
    }),
  );
  const total = wallets.reduce((n, w) => n + w.stakedThisEpoch.length, 0);
  return JSON.stringify({
    market: m.label,
    currentEpochId: epoch.epochId,
    wallets,
    note:
      total === 0
        ? 'no position staked in the current epoch on this market (checked every address listed)'
        : 'qualifyingAtLivePrice is a live check against the oracle - settlement decides the outcome. Autopilot entries sit under the session-signer address.',
  });
}

function execKnowledge(topic: string): string {
  const t = topic.trim().toLowerCase();
  return KNOWLEDGE[t] ?? `Unknown topic "${topic}". Available: ${Object.keys(KNOWLEDGE).join(', ')}.`;
}

async function execSideConcentration(marketId: string): Promise<string> {
  const m = marketById(marketId);
  const epoch = await readEpochSlice(m.feeArena);
  const stakes = (await client().readContract({
    address: m.feeArena,
    abi: feeArenaV3Abi,
    functionName: 'getStakesByEpoch',
    args: [BigInt(epoch.epochId)],
  })) as readonly { side: number; unstaked: boolean; contributionUsd6: bigint }[];

  const names = ['NONE', 'UP', 'DOWN', 'RANGE'] as const;
  const counts = [0, 0, 0, 0];
  const value: bigint[] = [0n, 0n, 0n, 0n];
  for (const s of stakes) {
    const side = Number(s.side);
    if (side < 1 || side > 3 || s.unstaked) continue;
    counts[side] += 1;
    value[side] += s.contributionUsd6 ?? 0n;
  }
  const totalPositions = counts[1] + counts[2] + counts[3];
  if (totalPositions === 0) {
    return JSON.stringify({ epochId: epoch.epochId, positions: 0, note: 'no positions staked in the current epoch yet' });
  }
  // Share by staked VALUE when fee contributions exist, else by position count (early epoch).
  const totalValue = value[1] + value[2] + value[3];
  const share = (i: number): string =>
    totalValue > 0n
      ? `${((Number(value[i]) / Number(totalValue)) * 100).toFixed(0)}%`
      : `${((counts[i] / totalPositions) * 100).toFixed(0)}%`;
  const crowdedIdx = [1, 2, 3].reduce((a, b) => ((totalValue > 0n ? value[a] >= value[b] : counts[a] >= counts[b]) ? a : b));
  return JSON.stringify({
    epochId: epoch.epochId,
    positions: totalPositions,
    distribution: { UP: { positions: counts[1], share: share(1) }, DOWN: { positions: counts[2], share: share(2) }, RANGE: { positions: counts[3], share: share(3) } },
    mostCrowded: names[crowdedIdx],
    insight: 'a crowded side splits the reallocated pot across more winners - a correct but less-crowded view earns a larger slice',
  });
}

// ─── Epoch history + claim record (pure cores, unit-tested) ──────────────────────────────

/** The FeeArenaV3 epoch tuple fields the summarizers need (viem decodes named tuples to objects). */
export interface EpochRecord {
  epochId: bigint;
  phase: number | bigint;
  entryCloseTime: bigint;
  settlementTime: bigint;
  bandBps: number | bigint;
  rolledOver: boolean;
  stakedCount: number | bigint;
  winnerCount: number | bigint;
  finalPrice18: bigint;
  potBase: bigint;
  potUSDC: bigint;
}

export interface StakeRecord {
  tokenId: bigint;
  epochId: bigint;
  side: number | bigint;
  processed: boolean;
  won: boolean;
  claimed: boolean;
  unstaked: boolean;
}

export interface ClaimPreview {
  claimable: boolean;
  ownFeeBase: bigint;
  ownFeeUSDC: bigint;
  potShareBase: bigint;
  potShareUSDC: bigint;
}

const SIDE_NAMES = ['NONE', 'UP', 'DOWN', 'RANGE'] as const;

/** Fold settled epochs + their stakes into a readable history digest. PURE. */
export function summarizeEpochHistory(
  epochs: readonly EpochRecord[],
  stakesPerEpoch: readonly (readonly StakeRecord[])[],
  opts: { baseSymbol: string; baseDecimals: number; ccy: string },
): Record<string, unknown> {
  const rows: Array<Record<string, unknown>> = [];
  const sideWins = { UP: 0, DOWN: 0, RANGE: 0 };
  let totalPositions = 0;
  let totalWinners = 0;
  let rolledEpochs = 0;
  epochs.forEach((e, i) => {
    if (Number(e.phase) !== 4) return; // only settled epochs are history
    const winnersBySide = { UP: 0, DOWN: 0, RANGE: 0 };
    for (const s of stakesPerEpoch[i] ?? []) {
      const name = SIDE_NAMES[Number(s.side)];
      if (s.won && (name === 'UP' || name === 'DOWN' || name === 'RANGE')) winnersBySide[name] += 1;
    }
    sideWins.UP += winnersBySide.UP;
    sideWins.DOWN += winnersBySide.DOWN;
    sideWins.RANGE += winnersBySide.RANGE;
    const staked = Number(e.stakedCount);
    const winners = Number(e.winnerCount);
    totalPositions += staked;
    totalWinners += winners;
    if (e.rolledOver) rolledEpochs += 1;
    rows.push({
      epochId: e.epochId.toString(),
      settledPrice: `${opts.ccy}${fmtAmt(e.finalPrice18, 18)}`,
      band: `±${(Number(e.bandBps) / 100).toFixed(2)}%`,
      positions: staked,
      winners,
      winnersBySide,
      reallocatedPot:
        e.potUSDC > 0n || e.potBase > 0n
          ? `${opts.ccy}${fmtAmt(e.potUSDC, 6)} + ${fmtAmt(e.potBase, opts.baseDecimals)} ${opts.baseSymbol}`
          : 'none',
      potRolledToNextEpoch: e.rolledOver,
    });
  });
  if (rows.length === 0) return { note: 'no settled epochs in the requested window yet' };
  return {
    epochsAnalyzed: rows.length,
    aggregate: {
      totalPositions,
      totalWinners,
      overallWinRate: totalPositions > 0 ? `${((totalWinners / totalPositions) * 100).toFixed(0)}%` : 'n/a',
      winsBySide: sideWins,
      epochsWherePotRolledOver: rolledEpochs,
    },
    epochs: rows,
    note: 'entry-anchored: each position resolves against ITS OWN entry price, so different sides can win in the same epoch',
  };
}

/** Fold a wallet's stakes + claim previews into a record + claimables digest. PURE. */
export function summarizeUserRecord(
  stakes: readonly StakeRecord[],
  previews: readonly { tokenId: bigint; preview: ClaimPreview }[],
  opts: { baseSymbol: string; baseDecimals: number; ccy: string },
): Record<string, unknown> {
  const active = stakes.filter((s) => !s.unstaked || s.processed);
  const wins = active.filter((s) => s.processed && s.won);
  const losses = active.filter((s) => s.processed && !s.won);
  const pending = stakes.filter((s) => !s.processed && !s.unstaked);
  const claimed = wins.filter((s) => s.claimed);
  let usdc = 0n;
  let base = 0n;
  const claimableTokens: string[] = [];
  for (const { tokenId, preview } of previews) {
    if (!preview.claimable) continue;
    usdc += preview.ownFeeUSDC + preview.potShareUSDC;
    base += preview.ownFeeBase + preview.potShareBase;
    claimableTokens.push(tokenId.toString());
  }
  return {
    epochsEntered: active.length,
    wins: wins.length,
    losses: losses.length,
    awaitingSettlement: pending.length,
    alreadyClaimed: claimed.length,
    claimableNow:
      claimableTokens.length > 0
        ? {
            positions: claimableTokens,
            total: `${opts.ccy}${fmtAmt(usdc, 6)} + ${fmtAmt(base, opts.baseDecimals)} ${opts.baseSymbol}`,
            note: 'exact amounts from the contract\'s previewClaim - claim any time, no deadline',
          }
        : 'nothing to claim right now',
  };
}

async function execEpochHistory(marketId: string, countRaw: unknown): Promise<string> {
  const m = marketById(marketId);
  const count = Math.min(12, Math.max(1, typeof countRaw === 'number' && Number.isFinite(countRaw) ? Math.floor(countRaw) : 6));
  const last = (await client().readContract({ address: m.feeArena, abi: feeArenaV3Abi, functionName: 'lastSettledEpochId' })) as bigint;
  if (last === 0n) return JSON.stringify({ note: 'no settled epochs yet on this market' });
  const from = last >= BigInt(count) ? last - BigInt(count - 1) : 1n;
  const ids: bigint[] = [];
  for (let id = last; id >= from; id -= 1n) ids.push(id);
  const [epochs, stakes] = await Promise.all([
    Promise.all(ids.map((id) => client().readContract({ address: m.feeArena, abi: feeArenaV3Abi, functionName: 'getEpoch', args: [id] }) as Promise<EpochRecord>)),
    Promise.all(ids.map((id) => client().readContract({ address: m.feeArena, abi: feeArenaV3Abi, functionName: 'getStakesByEpoch', args: [id] }) as Promise<readonly StakeRecord[]>)),
  ]);
  const ccy = m.quoteSymbol === 'EURC' ? '€' : '$';
  return JSON.stringify({
    market: m.label,
    ...summarizeEpochHistory(epochs, stakes, { baseSymbol: m.baseSymbol, baseDecimals: m.baseDecimals, ccy }),
  });
}

async function execClaimStatus(ctx: CopilotCtx, marketId: string): Promise<string> {
  const owned = ownedAddresses(ctx);
  if (owned.length === 0) return JSON.stringify({ error: 'no wallet connected - ask the user to connect one first' });
  const m = marketById(marketId);
  const ccy = m.quoteSymbol === 'EURC' ? '€' : '$';
  const wallets = await Promise.all(
    owned.map(async ({ role, address }) => {
      const stakes = (await client().readContract({
        address: m.feeArena,
        abi: feeArenaV3Abi,
        functionName: 'getUserStakes',
        args: [address],
      })) as readonly StakeRecord[];
      if (stakes.length === 0) return { role, address, note: 'this address has never staked on this market' };
      // previewClaim only for settled wins not yet claimed (bounded - a wallet's recent record).
      const candidates = stakes.filter((s) => s.processed && s.won && !s.claimed).slice(-20);
      const previews = await Promise.all(
        candidates.map(async (s) => ({
          tokenId: s.tokenId,
          preview: (await client().readContract({
            address: m.feeArena,
            abi: feeArenaV3Abi,
            functionName: 'previewClaim',
            args: [s.tokenId],
          })) as ClaimPreview,
        })),
      );
      return { role, address, ...summarizeUserRecord(stakes, previews, { baseSymbol: m.baseSymbol, baseDecimals: m.baseDecimals, ccy }) };
    }),
  );
  return JSON.stringify({
    market: m.label,
    wallets,
    note: 'Autopilot wins are claimed by the session signer automatically (before each re-entry, and at Stop & Sweep). A settled-but-unclaimed win listed here is simply awaiting its next collection point.',
  });
}

async function execWalletBalances(ctx: CopilotCtx): Promise<string> {
  const owned = ownedAddresses(ctx);
  if (owned.length === 0) return JSON.stringify({ error: 'no wallet connected - ask the user to connect one first' });
  const wallets = await Promise.all(
    owned.map(async ({ role, address }) => {
      const [native, ...tokenBals] = await Promise.all([
        client().getBalance({ address }),
        ...TOKENS.map((t) => client().readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] }) as Promise<bigint>),
      ]);
      const balances: Record<string, string> = {};
      TOKENS.forEach((t, i) => {
        balances[t.symbol] = fmtAmt(tokenBals[i] ?? 0n, t.decimals);
      });
      return { role, address, balances, native: fmtAmt(native, 18) };
    }),
  );
  return JSON.stringify({
    wallets,
    gas: 'Arc uses USDC natively for gas - each address\'s USDC covers its own transactions (native = the same USDC read at 18dp).',
  });
}

export interface ActionProposal {
  type: 'stake' | 'claim' | 'swap' | 'add_liquidity';
  side?: 'UP' | 'DOWN' | 'RANGE';
  /** For swap: USDC to spend (whole units, e.g. 100 = $100). */
  amountUsdc?: number;
  /** For claim: the LP position ids to claim for (the card fetches exact amounts). */
  tokenIds?: string[];
  /** For add_liquidity: optional price band (quote per base). Both set, or neither (= full range). */
  priceLower?: number;
  priceUpper?: number;
  marketId: string;
  note: string;
}

/** Validate the model's propose_action input into a well-formed proposal, or an error string. */
const MAX_SWAP_USDC = 10_000;

export function validateActionProposal(
  input: Record<string, unknown>,
  defaultMarketId: string,
): ActionProposal | { error: string } {
  const type = typeof input.type === 'string' ? input.type.toLowerCase() : '';
  if (type !== 'stake' && type !== 'claim' && type !== 'swap' && type !== 'add_liquidity') {
    return { error: `unsupported action type "${String(input.type)}" - use "stake", "claim", "swap", or "add_liquidity"` };
  }
  const marketId = typeof input.marketId === 'string' && input.marketId !== '' ? input.marketId : defaultMarketId;
  try {
    marketById(marketId);
  } catch {
    return { error: `unknown market "${marketId}"` };
  }
  let side: ActionProposal['side'];
  if (type === 'stake') {
    const s = typeof input.side === 'string' ? input.side.toUpperCase() : '';
    if (s !== 'UP' && s !== 'DOWN' && s !== 'RANGE') return { error: 'stake needs side: UP, DOWN, or RANGE' };
    side = s;
  }
  let amountUsdc: number | undefined;
  if (type === 'swap') {
    const a = typeof input.amountUsdc === 'number' ? input.amountUsdc : NaN;
    if (!Number.isFinite(a) || a <= 0) return { error: 'swap needs amountUsdc > 0 (the USDC amount to spend)' };
    if (a > MAX_SWAP_USDC) return { error: `swap amount capped at ${MAX_SWAP_USDC} USDC per proposal` };
    amountUsdc = a;
  }
  let priceLower: number | undefined;
  let priceUpper: number | undefined;
  if (type === 'add_liquidity') {
    const a = typeof input.amountUsdc === 'number' ? input.amountUsdc : NaN;
    if (!Number.isFinite(a) || a < 1) return { error: 'add_liquidity needs amountUsdc >= 1 (the total position value)' };
    if (a > MAX_SWAP_USDC) return { error: `add_liquidity amount capped at ${MAX_SWAP_USDC} per proposal` };
    amountUsdc = a;
    const lo = input.priceLower;
    const hi = input.priceUpper;
    if (lo !== undefined || hi !== undefined) {
      if (typeof lo !== 'number' || typeof hi !== 'number' || !Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || lo >= hi) {
        return { error: 'add_liquidity range needs 0 < priceLower < priceUpper (quote per base) - or omit both for full range' };
      }
      priceLower = lo;
      priceUpper = hi;
    }
  }
  let tokenIds: string[] | undefined;
  if (type === 'claim' && Array.isArray(input.tokenIds)) {
    tokenIds = input.tokenIds.filter((t): t is string => typeof t === 'string' && /^\d+$/.test(t)).slice(0, 12);
    if (tokenIds.length === 0) tokenIds = undefined;
  }
  const note = typeof input.note === 'string' && input.note.trim() !== '' ? input.note.trim() : 'Proposed by the Limen Copilot.';
  return { type, side, amountUsdc, tokenIds, priceLower, priceUpper, marketId, note };
}

/** Run one server-side tool. Returns the tool_result content string (errors become readable text). */
export async function runCopilotTool(
  name: string,
  input: Record<string, unknown>,
  ctx: CopilotCtx,
): Promise<string> {
  const marketId = typeof input.marketId === 'string' && input.marketId !== '' ? input.marketId : ctx.marketId;
  try {
    switch (name) {
      case 'get_market_overview':
        return await execMarketOverview(marketId);
      case 'get_stance_signal':
        return await execStanceSignal(marketId);
      case 'get_user_positions':
        return await execUserPositions(ctx, marketId);
      case 'get_limen_knowledge':
        return execKnowledge(typeof input.topic === 'string' ? input.topic : '');
      case 'get_side_concentration':
        return await execSideConcentration(marketId);
      case 'get_epoch_history':
        return await execEpochHistory(marketId, input.count);
      case 'get_claim_status':
        return await execClaimStatus(ctx, marketId);
      case 'get_wallet_balances':
        return await execWalletBalances(ctx);
      default:
        return `unknown tool: ${name}`;
    }
  } catch (err) {
    return `tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
