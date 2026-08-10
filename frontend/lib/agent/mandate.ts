// lib/agent/mandate.ts — the user's autopilot mandate, and the self-custody unattended config.
//
// A mandate is the human contract every autonomous layer obeys: which views are allowed, the
// confidence floor, the budget cap, the expiry. In-app it drives the ASSISTED autopilot
// (proposals the user confirms). For UNATTENDED 24/7 operation the same mandate compiles to
// the env block of the open-source keeper agent (keeper/src/agent.ts) — which the USER runs
// with their OWN Circle Agent Wallet as treasury (2-of-2 MPC, bound to their own Circle CLI
// session). That is deliberate architecture, not a shortcut: Circle Agent Wallets cannot be
// created or operated server-side on a user's behalf, so per-user agents are self-custody —
// the platform never holds user keys, budgets, or wallets.
import type { StanceView } from '@/lib/agent/autopilot';

export interface AgentMandate {
  views: StanceView[];
  /** 0..1 — the signal confidence required to act. */
  minConfidence: number;
  /** The LP quote-leg budget cap for one position, whole USDC. */
  maxStakeUsdc: number;
  /** In-app autopilot: fire the entry transaction immediately instead of showing a card
   *  first. The connected wallet's own signing prompt still appears — browsers cannot
   *  sign silently; that last approval is the wallet's security model, not ours. */
  autoEnter: boolean;
  /** LP price range half-width in percent (e.g. 2 = ±2% around the live price);
   *  null = full range. Narrower earns denser fees in-range but can drift out of range. */
  lpRangePct: number | null;
}

export const DEFAULT_MANDATE: AgentMandate = { views: ['UP', 'DOWN', 'RANGE'], minConfidence: 0.55, maxStakeUsdc: 5, autoEnter: false, lpRangePct: null };

export const MANDATE_STORAGE_KEY = 'limen-agent-mandate-v1';

/** Parse a persisted mandate defensively — anything malformed falls back to the default. */
export function parseMandate(raw: string | null): AgentMandate {
  if (raw === null) return DEFAULT_MANDATE;
  try {
    const p = JSON.parse(raw) as Partial<AgentMandate>;
    const views = Array.isArray(p.views) ? p.views.filter((v): v is StanceView => v === 'UP' || v === 'DOWN' || v === 'RANGE') : [];
    return {
      views: views.length > 0 ? views : DEFAULT_MANDATE.views,
      minConfidence:
        // Floor 10% (matches the slider): with three outcomes the best view always carries
        // ≥~34%, so anything ≤33% effectively means "enter every epoch" — a legitimate,
        // user-chosen mode for tight bands where confidence rarely peaks high.
        typeof p.minConfidence === 'number' && p.minConfidence >= 0.1 && p.minConfidence <= 0.95
          ? p.minConfidence
          : DEFAULT_MANDATE.minConfidence,
      maxStakeUsdc:
        typeof p.maxStakeUsdc === 'number' && p.maxStakeUsdc >= 1 && p.maxStakeUsdc <= 1000
          ? p.maxStakeUsdc
          : DEFAULT_MANDATE.maxStakeUsdc,
      autoEnter: p.autoEnter === true,
      lpRangePct: typeof p.lpRangePct === 'number' && p.lpRangePct >= 0.5 && p.lpRangePct <= 50 ? p.lpRangePct : null,
    };
  } catch {
    return DEFAULT_MANDATE;
  }
}

export interface UnattendedConfigParams {
  mandate: AgentMandate;
  /** Mandate hard end, days from now (the agent refuses to outlive it). */
  expiresDays: number;
  market: {
    id: string;
    label: string;
    feeArena: string;
    pool: string;
    feedId: string;
    quoteFeedId?: string;
    baseDecimals: number;
  };
  tokens: { base: string; quote: string; quoteDecimals: number };
  addresses: { npm: string; router: string; pyth: string };
  agentWalletAddress: string;
  nowSec?: number;
}

/**
 * Compile the mandate into the keeper agent's exact environment block. The user pastes this
 * into `keeper/.env.agent`, funds their Agent Wallet, and runs `npx tsx src/agent.ts` — the
 * agent then draws mandate-capped funding from THEIR MPC wallet over Circle's transfer rail
 * (the same rail the platform's M2 pilot ran live).
 */
export function buildUnattendedConfig(p: UnattendedConfigParams): string {
  const now = p.nowSec ?? Math.floor(Date.now() / 1000);
  const expiresAtSec = now + Math.max(1, Math.floor(p.expiresDays)) * 24 * 60 * 60;
  const policy = {
    allowedViews: p.mandate.views,
    minConfidence: p.mandate.minConfidence,
    expiresAtSec,
    minEntryLeftSec: 20,
    maxStakeUsdc6: String(Math.round(p.mandate.maxStakeUsdc * 1_000_000)),
  };
  const marketJson = {
    id: p.market.id,
    label: p.market.label,
    arena: p.market.feeArena,
    pool: p.market.pool,
    base: p.tokens.base,
    baseDecimals: p.market.baseDecimals,
    quote: p.tokens.quote,
    quoteDecimals: p.tokens.quoteDecimals,
    feedId: p.market.feedId,
    ...(p.market.quoteFeedId !== undefined ? { quoteFeedId: p.market.quoteFeedId } : {}),
    router: p.addresses.router,
    feeTier: 3000,
  };
  return [
    '# Limen unattended agent — compiled from your mandate. Runs on YOUR machine with YOUR',
    '# Circle Agent Wallet as treasury; the platform holds nothing. Docs: docs/AGENT.md',
    'KEEPER_RPC_URL=https://rpc.testnet.arc.network',
    `PYTH_ADDRESS=${p.addresses.pyth}`,
    'HERMES_URL=https://hermes.pyth.network',
    `STAKERBOT_ARENA=${p.market.feeArena}`,
    `STAKERBOT_NPM=${p.addresses.npm}`,
    `KEEPER_ARB_MARKET='${JSON.stringify(marketJson)}'`,
    'LIMEN_AGENT_ENABLED=true',
    'LIMEN_AGENT_PRIVATE_KEY=<generate a FRESH key: `cast wallet new` — never reuse your main wallet>',
    'LIMEN_AGENT_LEDGER_FILE=./state/agent-epoch-ledger.json',
    `LIMEN_AGENT_POLICY='${JSON.stringify(policy)}'`,
    'LIMEN_AGENT_FUNDING=agent-wallet',
    `LIMEN_AGENT_WALLET_ADDRESS=${p.agentWalletAddress}`,
  ].join('\n');
}
