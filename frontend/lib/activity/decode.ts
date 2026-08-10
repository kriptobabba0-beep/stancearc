// lib/activity/decode.ts — decode one raw Circle event log into a display-ready ActivityEvent.
//
// Circle's SCP returns events with decodedData: null (our arena is UNVERIFIED on Arc's explorer), so we
// decode the raw topics+data ourselves against the FeeArenaV3 ABI via viem. Only the events the feed
// surfaces are mapped; anything else (or anything undecodable) yields null and is skipped by the caller.

import { decodeEventLog } from 'viem';
import { feeArenaV3Abi } from '@/abis/feeArenaV3';
import type { ActivityEvent, ActivityKind, CircleEventLog } from '@/lib/activity/types';

/** Solidity event name (from the ABI) -> the feed's activity kind. Unmapped events are dropped. */
const KIND_BY_EVENT: Record<string, ActivityKind> = {
  Staked: 'staked',
  EpochSettled: 'settled',
  Claimed: 'claimed',
  SettlementPriceSubmitted: 'priceSubmitted',
  EmptyWinnerRollover: 'emptyRollover',
  EpochCreated: 'epochCreated',
};

/** Coerce a decoded arg (bigint/number/string) to a finite number; non-finite/absent → 0 (never NaN). */
const asNum = (v: unknown): number => {
  const n = Number(v as bigint);
  return Number.isFinite(n) ? n : 0;
};
const asStr = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v));

/**
 * Decode a raw Circle event log into an ActivityEvent, or null if it isn't a feed event or can't be
 * decoded. Pure + total (never throws): a bad/unknown log just returns null.
 */
export function decodeArenaEvent(
  raw: CircleEventLog,
  market: { id: string; label: string; quoteSymbol?: string },
): ActivityEvent | null {
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      abi: feeArenaV3Abi,
      data: raw.data,
      topics: raw.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
    }) as { eventName: string; args: Record<string, unknown> };
  } catch {
    return null; // unknown topic0 / mismatched data — not one of ours
  }

  const kind = KIND_BY_EVENT[decoded.eventName];
  if (!kind) return null;

  const args = decoded.args ?? {};
  const ev: ActivityEvent = {
    id: raw.id,
    kind,
    marketId: market.id,
    marketLabel: market.label,
    quoteSymbol: market.quoteSymbol ?? 'USDC',
    epochId: asNum(args.epochId),
    txHash: raw.txHash,
    blockHeight: asNum(raw.blockHeight),
    logIndex: asNum(raw.logIndex),
    ...(raw.firstConfirmDate ? { ts: raw.firstConfirmDate } : {}),
  };

  if (args.side !== undefined) ev.side = asNum(args.side); // raw Side enum (1=UP, 2=DOWN, 3=RANGE)
  if (args.owner !== undefined) ev.owner = args.owner as `0x${string}`;
  if (args.tokenId !== undefined) ev.tokenId = asStr(args.tokenId);
  if (args.finalPrice18 !== undefined) ev.finalPrice18 = asStr(args.finalPrice18);
  if (args.winnerCount !== undefined) ev.winnerCount = asNum(args.winnerCount);
  if (args.potUSDC !== undefined) ev.potUSDC = asStr(args.potUSDC);
  if (args.payUSDC !== undefined) ev.payUSDC = asStr(args.payUSDC);

  return ev;
}
