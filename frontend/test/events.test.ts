import { describe, it, expect, vi } from 'vitest';

// Stub ENV-touching imports before the module under test is loaded.
vi.mock('@/lib/wagmi', () => ({ wagmiConfig: {} }));
vi.mock('@/lib/chain', () => ({
  arcTestnet: { id: 5042002, name: 'Arc Testnet' },
  ARC_CHAIN_ID: 5042002,
  GAS_FLOOR_WEI: 20_000_000_000n,
}));
vi.mock('@/lib/contracts', () => ({
  feeArena: { address: '0x0000000000000000000000000000000000000000', abi: [] },
  MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11',
}));

import { getEventLogsChunked, CHUNK_BLOCKS } from '@/lib/events';
import type { PublicClient, AbiEvent } from 'viem';

// Minimal stub ABI event for typed calls.
const DUMMY_EVENT: AbiEvent = {
  type: 'event',
  name: 'Transfer',
  inputs: [{ name: 'from', type: 'address', indexed: true }],
};

const ADDR = '0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef' as `0x${string}`;

/** Build a mock PublicClient whose getLogs records every call (incl. args) and returns matching logs. */
function makeClient(logs: Array<{ blockNumber: bigint; logIndex: number }>) {
  const calls: Array<{ fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> }> = [];
  const getLogs = vi.fn(async (args: { fromBlock: bigint; toBlock: bigint; args?: Record<string, unknown> }) => {
    calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock, args: args.args });
    // Return log entries that fall within [fromBlock..toBlock].
    return logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
  });
  return { client: { getLogs } as unknown as PublicClient, calls };
}

describe('getEventLogsChunked', () => {
  it('returns an empty array when toBlock < fromBlock', async () => {
    const { client } = makeClient([]);
    const result = await getEventLogsChunked(client, {
      address: ADDR,
      event: DUMMY_EVENT,
      fromBlock: 100n,
      toBlock: 50n,
    });
    expect(result).toHaveLength(0);
  });

  it('covers the full range with non-overlapping contiguous windows', async () => {
    // Range: [0..27002] with chunk=9000 →
    //   window 1: [0..9000], window 2: [9001..18001], window 3: [18002..27002]
    // (start increments by chunkBlocks+1 = 9001 each time; end = min(start+chunk, toBlock))
    const { client, calls } = makeClient([]);
    await getEventLogsChunked(client, {
      address: ADDR,
      event: DUMMY_EVENT,
      fromBlock: 0n,
      toBlock: 27_002n,
      chunkBlocks: 9_000n,
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ fromBlock: 0n, toBlock: 9_000n });
    expect(calls[1]).toEqual({ fromBlock: 9_001n, toBlock: 18_001n });
    expect(calls[2]).toEqual({ fromBlock: 18_002n, toBlock: 27_002n });
  });

  it('returns the same complete set of logs as serial fetching would', async () => {
    // Place one log in each of three windows and confirm all three are returned.
    // Windows for [0..27002] chunk=9000: [0..9000],[9001..18001],[18002..27002]
    const logs = [
      { blockNumber: 5n, logIndex: 0 },      // window 1
      { blockNumber: 9_500n, logIndex: 1 },   // window 2
      { blockNumber: 18_200n, logIndex: 2 },  // window 3
    ];
    const { client } = makeClient(logs);
    const result = await getEventLogsChunked(client, {
      address: ADDR,
      event: DUMMY_EVENT,
      fromBlock: 0n,
      toBlock: 27_002n,
      chunkBlocks: 9_000n,
    });
    expect(result).toHaveLength(3);
    // Results are in ascending block order (window order preserved).
    expect((result[0] as { blockNumber: bigint }).blockNumber).toBe(5n);
    expect((result[1] as { blockNumber: bigint }).blockNumber).toBe(9_500n);
    expect((result[2] as { blockNumber: bigint }).blockNumber).toBe(18_200n);
  });

  it('fetches in parallel batches: total getLogs calls equals window count', async () => {
    // 10 windows with concurrency=5 → two batches of 5; all 10 calls must still happen.
    const { client, calls } = makeClient([]);
    const toBlock = 10n * (CHUNK_BLOCKS + 1n) - 1n;
    await getEventLogsChunked(client, {
      address: ADDR,
      event: DUMMY_EVENT,
      fromBlock: 0n,
      toBlock,
      chunkBlocks: CHUNK_BLOCKS,
      concurrency: 5,
    });
    expect(calls).toHaveLength(10);
  });

  it('forwards an indexed eventArgs filter (e.g. owner) to every getLogs window', async () => {
    const { client, calls } = makeClient([]);
    await getEventLogsChunked(client, {
      address: ADDR,
      event: DUMMY_EVENT,
      fromBlock: 0n,
      toBlock: 27_002n,
      chunkBlocks: 9_000n,
      eventArgs: { owner: ADDR },
    });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.args).toEqual({ owner: ADDR });
  });

  it('omits args entirely when no eventArgs filter is given (unchanged behavior)', async () => {
    const { client, calls } = makeClient([]);
    await getEventLogsChunked(client, { address: ADDR, event: DUMMY_EVENT, fromBlock: 0n, toBlock: 5n });
    expect(calls[0]!.args).toBeUndefined();
  });

  it('handles a single-block range (fromBlock === toBlock)', async () => {
    const logs = [{ blockNumber: 42n, logIndex: 0 }];
    const { client } = makeClient(logs);
    const result = await getEventLogsChunked(client, {
      address: ADDR,
      event: DUMMY_EVENT,
      fromBlock: 42n,
      toBlock: 42n,
    });
    expect(result).toHaveLength(1);
  });
});
