// lib/activity/types.ts - shapes for the Circle SCP arena activity feed.
//
// A `CircleEventLog` is one entry from Circle's GET /v1/w3s/contracts/events (raw, UNDECODED - Circle
// returns decodedData: null for our UNVERIFIED-on-Arc contract, so we decode topics+data ourselves).
// An `ActivityEvent` is the decoded, display-ready row the feed renders. Big numeric values are kept as
// raw base-unit STRINGS (not bigint) so they serialize cleanly through the JSON API route.

export type ActivityKind =
  | 'staked'
  | 'settled'
  | 'claimed'
  | 'priceSubmitted'
  | 'emptyRollover'
  | 'epochCreated';

/** One raw event log as returned by Circle's /contracts/events. */
export interface CircleEventLog {
  id: string;
  txHash: `0x${string}`;
  blockHeight: number | string;
  /** Position of the log within its block - the tiebreaker for same-block ordering. */
  logIndex?: number | string;
  topics: readonly `0x${string}`[];
  data: `0x${string}`;
  /** Circle echoes the canonical signature; present but we decode by ABI/topic0 regardless. */
  eventName?: string;
  /** First on-chain confirmation time (ISO) - used as the row timestamp. */
  firstConfirmDate?: string;
}

/** A decoded, display-ready arena activity row. */
export interface ActivityEvent {
  /** Circle's event-log id (stable; used as the React key + dedupe key). */
  id: string;
  kind: ActivityKind;
  marketId: string;
  marketLabel: string;
  /** Quote token symbol ('USDC' | 'EURC') - the source of truth for the price glyph + payout label. */
  quoteSymbol: string;
  epochId: number;
  txHash: `0x${string}`;
  blockHeight: number;
  /** Log position within the block - deterministic same-block ordering tiebreaker. */
  logIndex: number;
  /** ISO timestamp of first confirmation, if Circle provided it. */
  ts?: string;
  /** Staked: the raw Side enum value (1=UP, 2=DOWN, 3=RANGE; matches lib/types `Side`). */
  side?: number;
  /** Staked/Claimed: the position owner. */
  owner?: `0x${string}`;
  /** Staked/Claimed: the position NFT id (raw uint as string). */
  tokenId?: string;
  /** Settled/PriceSubmitted: settlement price, raw 18dp base units as a string. */
  finalPrice18?: string;
  /** Settled: number of winning positions. */
  winnerCount?: number;
  /** Settled/EmptyRollover: USDC-leg pot, raw 6dp base units as a string. */
  potUSDC?: string;
  /** Claimed: USDC paid out, raw 6dp base units as a string. */
  payUSDC?: string;
}

/** The /api/circle/activity response shape (shared by the route + the client hook). */
export interface ActivityResponse {
  events: ActivityEvent[];
  /** True only when EVERY market query failed (total Circle/scope outage) - UI shows "catching up". */
  degraded?: boolean;
}
