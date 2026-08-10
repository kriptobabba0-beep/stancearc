import { describe, it, expect, vi, beforeEach } from 'vitest';

// stakeOnce fetches a Pyth blob+price from Hermes — stub it so the tick is pure-in-test.
vi.mock('../src/hermes.js', () => ({
  fetchPythUpdateWithPrice: vi.fn(async () => ({ updateData: ['0xdead'], price18: 60_000n * 10n ** 18n, publishTimeSec: 0 })),
}));

import {
  decideStakerAction,
  fullRangeTicks,
  canAffordStake,
  tickStaker,
  type StakerRuntime,
} from '../src/stakerbot.js';
import type { StakerbotConfig } from '../src/config.js';

// PhaseView: 0 Idle, 1 EntryOpen, 2 Locked, 3 Settling, 4 Settled.
const base = {
  phase: 1, // EntryOpen
  epochId: 5n,
  hasTokenId: true,
  ownsToken: true,
  lastStakedEpoch: null as bigint | null,
};
const d = (over: Partial<typeof base> = {}) => decideStakerAction({ ...base, ...over });

describe('decideStakerAction — per-tick staker decision', () => {
  it('MINTs when the wallet has no LP NFT yet (first run)', () => {
    expect(d({ hasTokenId: false })).toBe('MINT');
    // MINT takes precedence even outside the entry window.
    expect(d({ hasTokenId: false, phase: 2 })).toBe('MINT');
  });

  it('STAKEs when entry is open, the wallet holds its NFT, and it has not staked this epoch', () => {
    expect(d()).toBe('STAKE');
    expect(d({ lastStakedEpoch: 4n })).toBe('STAKE'); // staked a PRIOR epoch -> stake again
  });

  it('WAITs when it already staked THIS epoch (no double-stake)', () => {
    expect(d({ lastStakedEpoch: 5n })).toBe('WAIT');
  });

  it('WAITs when the NFT is still escrowed (not yet auto-returned)', () => {
    expect(d({ ownsToken: false })).toBe('WAIT');
  });

  it('WAITs outside the entry window (Idle/Locked/Settling/Settled)', () => {
    expect(d({ phase: 0 })).toBe('WAIT');
    expect(d({ phase: 2 })).toBe('WAIT');
    expect(d({ phase: 3 })).toBe('WAIT');
    expect(d({ phase: 4 })).toBe('WAIT');
  });
});

describe('fullRangeTicks — spacing-aligned full range per fee tier', () => {
  it('0.3% tier (spacing 60) -> ±887220', () => {
    expect(fullRangeTicks(3000)).toEqual({ tickLower: -887220, tickUpper: 887220 });
  });
  it('1% tier (spacing 200) -> ±887200', () => {
    expect(fullRangeTicks(10000)).toEqual({ tickLower: -887200, tickUpper: 887200 });
  });
});

describe('canAffordStake — token gate before minting an LP (FIX 1)', () => {
  const need = { needBase: 40_000n, needUsdc: 26_000_000n };
  it('affordable when BOTH legs are >= the required amount', () => {
    expect(canAffordStake({ haveBase: 40_000n, haveUsdc: 26_000_000n, ...need })).toBe(true); // exactly enough
    expect(canAffordStake({ haveBase: 99_999n, haveUsdc: 99_000_000n, ...need })).toBe(true); // plenty
  });
  it('NOT affordable when out of cirBTC (base)', () => {
    expect(canAffordStake({ haveBase: 0n, haveUsdc: 26_000_000n, ...need })).toBe(false);
    expect(canAffordStake({ haveBase: 39_999n, haveUsdc: 26_000_000n, ...need })).toBe(false);
  });
  it('NOT affordable when out of USDC (quote)', () => {
    expect(canAffordStake({ haveBase: 40_000n, haveUsdc: 0n, ...need })).toBe(false);
    expect(canAffordStake({ haveBase: 40_000n, haveUsdc: 25_999_999n, ...need })).toBe(false);
  });
  it('NOT affordable when out of BOTH', () => {
    expect(canAffordStake({ haveBase: 0n, haveUsdc: 0n, ...need })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tickStaker integration with mocked viem clients (FIX 1 skip + FIX 2 mark-on-success).
// ---------------------------------------------------------------------------
const BASE = '0x0000000000000000000000000000000000000b00' as const; // cirBTC
const QUOTE = '0x0000000000000000000000000000000000000c00' as const; // USDC
const NPM = '0x0000000000000000000000000000000000000d00' as const;
const ARENA = '0x0000000000000000000000000000000000000e00' as const;
const PYTH = '0x0000000000000000000000000000000000000f00' as const;
const WALLET = '0x00000000000000000000000000000000000000aa' as const;

function cfg(): StakerbotConfig {
  return {
    rpcUrl: 'http://x',
    rpcUrls: ['http://x'],
    market: { base: BASE, quote: QUOTE, feedId: '0xfeed', feeTier: 3000 } as unknown as StakerbotConfig['market'],
    arena: ARENA,
    npm: NPM,
    pythAddress: PYTH,
    hermesUrl: 'http://hermes',
    hermesTimeoutMs: 1_000,
    stakers: [],
    mintBase: 40_000n,
    mintUsdc: 26_000_000n,
    maxDeviationBps: 300n,
    pollIntervalMs: 10_000,
    gasFloorWei: 1_000_000_000n,
    receiptTimeoutMs: 1_000,
    lowBalanceWei: 1n,
  } as StakerbotConfig;
}

function runtime(over: Partial<StakerRuntime> = {}): StakerRuntime {
  return {
    cfg: { side: 1, sideLabel: 'UP', privateKey: '0x00' as `0x${string}` },
    account: { address: WALLET } as unknown as StakerRuntime['account'],
    wallet: {} as StakerRuntime['wallet'],
    tokenId: 7n,
    approvedForAll: true,
    lastStakedEpoch: null,
    sinceBalanceLog: 30,
    ...over,
  };
}

// Build a fake PublicClient. `tokenBalances` controls the FIX-1 token gate; `receiptStatus`
// controls the FIX-2 stake outcome. `writeContract` records calls so we can assert no mint.
function fakeClients(opts: {
  nativeWei?: bigint;
  phase?: number;
  haveBase?: bigint;
  haveUsdc?: bigint;
  receiptStatus?: 'success' | 'reverted';
}) {
  const writes: string[] = [];
  const wallet = {
    writeContract: vi.fn(async (a: { functionName?: string }) => {
      writes.push(a.functionName ?? 'mint');
      return '0xabc' as `0x${string}`;
    }),
  };
  const client = {
    getBalance: vi.fn(async () => opts.nativeWei ?? 10n ** 18n),
    readContract: vi.fn(async (a: { address: string; functionName: string }) => {
      if (a.functionName === 'currentEpoch') return { epochId: 5n, phase: opts.phase ?? 1 };
      if (a.functionName === 'ownerOf') return WALLET; // wallet holds its NFT
      if (a.functionName === 'isApprovedForAll') return true;
      if (a.functionName === 'getUpdateFee') return 1n;
      if (a.functionName === 'allowance') return 0n;
      if (a.functionName === 'balanceOf') {
        if (a.address.toLowerCase() === BASE) return opts.haveBase ?? 0n;
        if (a.address.toLowerCase() === QUOTE) return opts.haveUsdc ?? 0n;
        return 0n;
      }
      return 0n;
    }),
    simulateContract: vi.fn(async () => ({ result: [99n, 0n, 0n, 0n], request: {} })),
    waitForTransactionReceipt: vi.fn(async () => ({ status: opts.receiptStatus ?? 'success' })),
  };
  return { client, wallet, writes };
}

describe('tickStaker — token gate skips minting when out of cirBTC/USDC (FIX 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SKIPs (no mint) when the wallet has gas but no LP tokens', async () => {
    const { client, wallet, writes } = fakeClients({ haveBase: 0n, haveUsdc: 0n });
    const st = runtime({ tokenId: null }); // no NFT yet -> action would be MINT
    await tickStaker(client as never, {} as never, cfg(), st);
    expect(writes).toEqual([]); // nothing minted
    expect(st.tokenId).toBeNull(); // still no position
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('MINTs when the wallet holds enough of BOTH legs', async () => {
    const { client, wallet, writes } = fakeClients({ haveBase: 40_000n, haveUsdc: 26_000_000n });
    const st = runtime({ tokenId: null, wallet: wallet as never });
    await tickStaker(client as never, {} as never, cfg(), st);
    expect(writes).toContain('mint');
    expect(st.tokenId).toBe(99n); // minted token id from the simulate result
  });
});

describe('tickStaker — mark epoch staked only on a SUCCESSFUL receipt (FIX 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('SUCCESS receipt -> epoch is marked staked', async () => {
    const { client, wallet } = fakeClients({ phase: 1, receiptStatus: 'success' });
    const st = runtime({ lastStakedEpoch: null, wallet: wallet as never });
    await tickStaker(client as never, {} as never, cfg(), st);
    expect(st.lastStakedEpoch).toBe(5n);
  });

  it('REVERTED receipt -> epoch is NOT marked (retryable next tick)', async () => {
    const { client, wallet } = fakeClients({ phase: 1, receiptStatus: 'reverted' });
    const st = runtime({ lastStakedEpoch: null, wallet: wallet as never });
    await tickStaker(client as never, {} as never, cfg(), st);
    expect(st.lastStakedEpoch).toBeNull();

    // A second tick with a now-successful receipt DOES mark it — proving the revert was retried.
    const ok = fakeClients({ phase: 1, receiptStatus: 'success' });
    st.wallet = ok.wallet as never;
    await tickStaker(ok.client as never, {} as never, cfg(), st);
    expect(st.lastStakedEpoch).toBe(5n);
  });
});
