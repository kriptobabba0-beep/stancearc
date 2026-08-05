// lib/wallet/groupTxs.ts - turn the embedded wallet's raw Circle transaction legs into ONE meaningful
// activity row per user ACTION, instead of the individual token transfers that happened under the hood.
//
// A single action (swap, add/remove liquidity, join arena, claim) is one on-chain tx (one txHash) that
// moves several tokens. Circle lists each transfer as its own CircleTxDto, which the feed used to render
// as a confusing run of "Sent"/"Received" rows. Here we group legs by txHash and CLASSIFY the action by
// the known contract it touched (router/pool → swap, position manager → add/remove liquidity, arena →
// join/claim) plus the leg directions. CONSERVATIVE by design: anything we can't confidently identify
// falls back to plain Sent/Received rows (so we never mislabel a simple transfer). Pure + unit-tested.
import type { CircleTxDto } from '@/lib/circle/client';

/** The role a counterparty address plays - the primary signal for what a transaction actually did. */
export type Role = 'router' | 'npm' | 'pool' | 'arena';

/** The user-facing action a transaction represents. */
export type WalletAction =
  | 'swap'
  | 'addLiquidity'
  | 'removeLiquidity'
  | 'joinArena'
  | 'claimFees'
  | 'send'
  | 'receive';

/** One display row: the action + its outbound (paid) and inbound (received) legs. */
export interface WalletRow {
  id: string;
  action: WalletAction;
  txHash?: string;
  ts?: string;
  state?: string;
  outs: CircleTxDto[];
  ins: CircleTxDto[];
}

/** Resolve a counterparty address to its role (undefined when unknown). Built by the caller from ENV. */
export type RoleResolver = (addr?: string) => Role | undefined;

/** Outbound from THIS wallet's point of view. */
export function isOutbound(tx: CircleTxDto, addr: string): boolean {
  const t = (tx.transactionType ?? '').toUpperCase();
  if (t === 'OUTBOUND') return true;
  if (t === 'INBOUND') return false;
  return !!tx.sourceAddress && tx.sourceAddress.toLowerCase() === addr.toLowerCase();
}

/** Every known role any leg in the group touched (scanning BOTH source and destination of each leg). */
function rolesTouched(legs: CircleTxDto[], role: RoleResolver): Set<Role> {
  const out = new Set<Role>();
  for (const l of legs) {
    const r1 = role(l.sourceAddress);
    const r2 = role(l.destinationAddress);
    if (r1) out.add(r1);
    if (r2) out.add(r2);
  }
  return out;
}

/**
 * Classify a same-txHash group into an action, or null when it isn't a single recognizable action (so
 * the caller emits its legs as plain Sent/Received rows). Priority: arena > liquidity/AMM > router >
 * a bare swap-pair fallback (an outbound+inbound pair even with no recognized counterparty).
 */
function classifyGroup(outs: CircleTxDto[], ins: CircleTxDto[], roles: Set<Role>): WalletAction | null {
  if (roles.has('arena')) {
    // Tokens coming back from the arena = a claim/payout; otherwise the tx staked INTO the arena.
    return ins.length > 0 ? 'claimFees' : 'joinArena';
  }
  if (roles.has('npm') || roles.has('pool')) {
    if (outs.length > 0 && ins.length > 0) {
      // A clean one-in/one-out is a swap; anything heavier is liquidity (a mint may refund token dust,
      // so lean on which side dominates).
      if (outs.length === 1 && ins.length === 1) return 'swap';
      return outs.length >= ins.length ? 'addLiquidity' : 'removeLiquidity';
    }
    return ins.length > 0 ? 'removeLiquidity' : 'addLiquidity';
  }
  if (roles.has('router')) return 'swap';
  // No recognized counterparty, but a paired outbound+inbound in one tx is still almost certainly a swap.
  if (outs.length > 0 && ins.length > 0) return 'swap';
  return null;
}

/**
 * Collapse + classify the wallet's transaction legs into action rows, PRESERVING input order (the feed
 * is newest-first). Legs are grouped by a real txHash; a group that classifies to an action becomes one
 * row, otherwise its legs become plain send/receive rows. Hash-less legs are never grouped.
 */
export function classifyWalletTxs(txs: CircleTxDto[], addr: string, role: RoleResolver): WalletRow[] {
  const byHash = new Map<string, CircleTxDto[]>();
  for (const tx of txs) {
    if (!tx.txHash) continue;
    const g = byHash.get(tx.txHash);
    if (g) g.push(tx);
    else byHash.set(tx.txHash, [tx]);
  }

  const plain = (tx: CircleTxDto): WalletRow => ({
    id: tx.id,
    action: isOutbound(tx, addr) ? 'send' : 'receive',
    txHash: tx.txHash,
    ts: tx.createDate,
    state: tx.state,
    outs: isOutbound(tx, addr) ? [tx] : [],
    ins: isOutbound(tx, addr) ? [] : [tx],
  });

  const rows: WalletRow[] = [];
  const done = new Set<string>();
  for (const tx of txs) {
    if (!tx.txHash) {
      rows.push(plain(tx));
      continue;
    }
    if (done.has(tx.txHash)) continue;
    done.add(tx.txHash);

    const legs = byHash.get(tx.txHash)!;
    const outs = legs.filter((l) => isOutbound(l, addr));
    const ins = legs.filter((l) => !isOutbound(l, addr));
    const action = classifyGroup(outs, ins, rolesTouched(legs, role));
    if (action) {
      const primary = outs[0] ?? ins[0];
      rows.push({
        id: tx.txHash,
        action,
        txHash: tx.txHash,
        ts: primary?.createDate,
        state: primary?.state,
        outs,
        ins,
      });
    } else {
      for (const l of legs) rows.push(plain(l));
    }
  }
  return rows;
}
