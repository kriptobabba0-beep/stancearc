import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Two contracts pinned by field incidents, both about the SAME failure class: a session
// funded by MULTIPLE wallet broadcasts, where a later broadcast dies on the wallet's own
// (rate-limited) RPC and strands funds. The fix is architectural:
//   • start() makes the user's wallet BROADCAST exactly once (a native-USDC transfer that
//     seeds gas + budget). Every ERC-20 leg (cirBTC always) is an EIP-3009 signature the
//     SESSION submits through the app's resilient transport — no second wallet broadcast
//     exists to die, and no pool is ever touched.
//   • stop() still recovers a legacy gasless session by fronting it a $1.50 gas top-up.

const OWNER = `0x${'1'.repeat(40)}` as `0x${string}`;
const FACADE = `0x${'2'.repeat(40)}` as `0x${string}`; // USDC facade (native dual-interface)
const CIRBTC = `0x${'3'.repeat(40)}` as `0x${string}`;
const NPM_ADDR = `0x${'4'.repeat(40)}` as `0x${string}`;
const ARENA = `0x${'5'.repeat(40)}` as `0x${string}`;
const POOL = `0x${'6'.repeat(40)}` as `0x${string}`;

// Mutable fake-chain state, reset per test.
const chain = {
  native: 0n, // session's native USDC (18dp)
  base: 0n, // session's cirBTC (8dp)
  ownerBase: 10n ** 12n, // plenty
  ownerQuote: 10n ** 12n,
  nftCount: 0n,
  operatorApproved: false,
  // The live epoch enterEpoch sees — entryCloseTime is set per test.
  epoch: { epochId: 9n, phase: 1n, entryOpenTime: 0n, entryCloseTime: 0n, settlementTime: 0n, bandBps: 5 },
  stakes: [] as { tokenId: bigint; epochId: bigint; unstaked: boolean; processed: boolean; claimed: boolean; won: boolean }[],
  log: [] as string[], // cross-spy ordering
  // Simulate a rate-limit storm: when a cirBTC authorization submit fails, the NEXT few
  // reads (the funding catch's post-mortem) fail too — the exact correlated failure the
  // key-deletion guard must survive.
  armReadFailOnAuth: false,
  failNextReads: 0,
};

// The user's wallet BROADCAST path (writeContractAsync). In the new architecture start()
// calls this exactly once — the native-USDC facade transfer.
const writeContractAsync = vi.fn(async (req: { address: `0x${string}`; args: readonly unknown[] }) => {
  chain.log.push(`wallet:${req.address}`);
  if (req.address === FACADE) chain.native += (req.args[1] as bigint) * 10n ** 12n; // 6dp facade → 18dp native
  if (req.address === CIRBTC) chain.base += req.args[1] as bigint;
  return '0xfund';
});

// The user's wallet SIGNATURE path (useSignTypedData) — a real 65-byte signature shape so
// viem's parseSignature parses it. NO broadcast, nothing an RPC rate limit can touch.
const signTypedDataAsync = vi.fn(async () => `0x${'aa'.repeat(32)}${'bb'.repeat(32)}1b` as `0x${string}`);

// The SESSION signer, submitting through the resilient transport. transferWithAuthorization
// is how the cirBTC (and EURC) legs actually land — signed by the user, sent by the session.
const sessionWallet = {
  writeContract: vi.fn(async (req: { address: `0x${string}`; functionName?: string; args?: readonly unknown[] }) => {
    chain.log.push(`session:${req.address}:${req.functionName ?? '?'}`);
    if (req.functionName === 'transferWithAuthorization') {
      if (chain.armReadFailOnAuth) {
        chain.failNextReads = 3; // the post-mortem getBalance + 2 balanceOf reads storm out
        throw new Error('request limit reached');
      }
      const value = (req.args as readonly unknown[])[2] as bigint; // (from,to,value,...)
      if (req.address === CIRBTC) chain.base += value;
      return '0xauth';
    }
    if (req.functionName === 'mint') {
      chain.nftCount = 1n;
      return '0xmint';
    }
    if (req.functionName === 'setApprovalForAll') {
      chain.operatorApproved = true;
      return '0xoperator';
    }
    if (req.functionName === 'stakeWithSide') return '0xstake';
    if (req.functionName === 'transfer' && req.address === CIRBTC) {
      chain.base = 0n; // the stop() sweep
      return '0xswept';
    }
    return '0xsession';
  }),
  sendTransaction: vi.fn(async (req: { value: bigint }) => {
    chain.log.push('session:native');
    chain.native -= req.value;
    return '0xnative';
  }),
};

const publicClient = {
  getBalance: vi.fn(async () => {
    if (chain.failNextReads > 0) { chain.failNextReads--; throw new Error('request limit reached'); }
    return chain.native;
  }),
  getBlock: vi.fn(async () => ({ timestamp: 1_784_000_000n })),
  readContract: vi.fn(async (req: { address: `0x${string}`; functionName: string; args?: readonly unknown[] }) => {
    if (chain.failNextReads > 0) { chain.failNextReads--; throw new Error('request limit reached'); }
    const who = req.args?.[0] as `0x${string}` | undefined;
    if (req.functionName === 'name') return 'Circle Wrapped Bitcoin';
    if (req.functionName === 'version') return '2';
    if (req.functionName === 'balanceOf' && req.address === CIRBTC) return who === OWNER ? chain.ownerBase : chain.base;
    if (req.functionName === 'balanceOf' && req.address === FACADE) return who === OWNER ? chain.ownerQuote : chain.native / 10n ** 12n;
    if (req.functionName === 'balanceOf' && req.address === NPM_ADDR) return chain.nftCount;
    if (req.functionName === 'getUserStakes') return chain.stakes;
    if (req.functionName === 'previewClaim') return { claimable: false };
    if (req.functionName === 'allowance') return 0n;
    if (req.functionName === 'isApprovedForAll') return chain.operatorApproved;
    if (req.functionName === 'tokenOfOwnerByIndex') return 7n;
    if (req.functionName === 'currentEpoch') return chain.epoch;
    if (req.functionName === 'getUpdateFee') return 0n;
    if (req.functionName === 'positions' || req.functionName === 'slot0') throw new Error(`no ${req.functionName} in fake`); // best-effort reads, caught by the hook
    throw new Error(`unexpected read: ${req.functionName}`);
  }),
  simulateContract: vi.fn(async (req: unknown) => ({ request: req })),
  waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
};

let accountState: { address: `0x${string}`; connector?: { type: string } } = { address: OWNER };
vi.mock('wagmi', () => ({
  useChainId: () => 5042002,
  useSwitchChain: () => ({ switchChainAsync: async () => undefined }),
  useAccount: () => accountState,
  usePublicClient: () => publicClient,
  useWriteContract: () => ({ writeContractAsync }),
  useSignTypedData: () => ({ signTypedDataAsync }),
}));
vi.mock('viem', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, createWalletClient: () => sessionWallet };
});
vi.mock('@/lib/chain', () => ({ ARC_CHAIN_ID: 5042002, arcTestnet: { id: 5042002 }, withGasFloor: (x: unknown) => x }));
vi.mock('@/lib/rpcResilience', () => ({ withRateLimitResilience: (t: unknown) => t }));
vi.mock('@/lib/arcEndpoints', () => ({ ARC_EXTRA_HTTP_RPCS: [] }));
vi.mock('@/lib/env', () => ({ ENV: { NPM_ADDRESS: `0x${'4'.repeat(40)}`, HERMES_URL: 'http://hermes.local' } }));
// STABLE token singletons — the hook keys `useCallback` deps on these, and a fresh object
// per call would churn `refresh`'s identity into an endless effect loop (the real module
// exports module-level constants, so mirror that).
vi.mock('@/lib/tokens', () => {
  const USDC_TOK = { symbol: 'USDC', address: `0x${'2'.repeat(40)}`, decimals: 6 };
  const BTC_TOK = { symbol: 'cirBTC', address: `0x${'3'.repeat(40)}`, decimals: 8 };
  return { quoteToken: () => USDC_TOK, tokenBySymbol: () => BTC_TOK };
});
vi.mock('@/lib/pyth', () => ({
  fetchPythUpdateWithPrice: vi.fn(async () => ({ price18: 110_000n * 10n ** 18n, updateData: ['0x'] })),
  fetchPythCrossUpdateWithPrice: vi.fn(async () => ({ price18: 110_000n * 10n ** 18n, updateData: ['0x'] })),
}));

import { useSessionAgent } from '@/hooks/useSessionAgent';
import type { Market } from '@/lib/markets';

const market = { id: 'm1', feeArena: ARENA, pool: POOL, baseSymbol: 'cirBTC', quoteSymbol: 'USDC', feedId: '0xfeed' } as unknown as Market;
const KEY_SLOT = 'limen-agent-session-key-v1:m1';
// A fixed throwaway test key (never funded anywhere) so the session address is stable.
const TEST_KEY = `0x${'a'.repeat(64)}`;

// baseLeg for a $5 budget at $110k: ceil(5/110000 * 1e8 * 1.03) = 4682 units.
const BASE_LEG_5 = 4682n;

beforeEach(() => {
  chain.native = 0n;
  chain.base = 0n;
  chain.ownerBase = 10n ** 12n;
  chain.ownerQuote = 10n ** 12n;
  chain.nftCount = 0n;
  chain.operatorApproved = false;
  chain.epoch = { epochId: 9n, phase: 1n, entryOpenTime: 0n, entryCloseTime: 0n, settlementTime: 0n, bandBps: 5 };
  chain.stakes = [];
  chain.log = [];
  chain.armReadFailOnAuth = false;
  chain.failNextReads = 0;
  accountState = { address: OWNER };
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe('useSessionAgent start() — one broadcast, the rest by signature', () => {
  it('USDC market: ONE wallet broadcast (native budget+gas), then the cirBTC leg by EIP-3009 signature', async () => {
    const { result } = renderHook(() => useSessionAgent(market));

    await act(async () => {
      await result.current.start(5);
    });

    // The wallet BROADCASTS exactly once — the native-USDC transfer (budget + gas). No
    // second broadcast exists to die on the wallet's RPC.
    expect(writeContractAsync).toHaveBeenCalledTimes(1);
    const nativeLeg = writeContractAsync.mock.calls[0]![0] as { address: string; args: readonly unknown[]; gas?: bigint };
    expect(nativeLeg.address).toBe(FACADE);
    expect(nativeLeg.args[1]).toBe(6_500_000n); // $5 budget + $1.50 gas, 6dp
    expect(nativeLeg.gas).toBe(120_000n); // explicit — skips the wallet's estimation round-trip

    // The cirBTC leg is a SIGNATURE the user makes and the SESSION submits — never a wallet
    // broadcast, so it cannot be rate-limited.
    expect(signTypedDataAsync).toHaveBeenCalledTimes(1);
    const authCall = sessionWallet.writeContract.mock.calls.find(
      (c) => (c[0] as { functionName?: string }).functionName === 'transferWithAuthorization',
    );
    expect(authCall).toBeTruthy();
    const auth = authCall![0] as { address: string; args: readonly unknown[] };
    expect(auth.address).toBe(CIRBTC);
    expect(auth.args[0]).toBe(OWNER); // from = the user
    expect(auth.args[1]).toBe(result.current.address); // to = the session
    expect(auth.args[2]).toBe(BASE_LEG_5); // the base leg's worth
    expect(chain.base).toBe(BASE_LEG_5); // cirBTC actually landed at the session
    expect(result.current.active).toBe(true);

    // And the LP is built RIGHT AT START — outside any entry window — so the first entry
    // is stake-only. (Lazy setup once idled a funded session for two hours: it demanded
    // ≥60s of window while confident odds only ever crossed the floor later than that.)
    const fns = sessionWallet.writeContract.mock.calls.map((c) => (c[0] as { functionName?: string }).functionName);
    expect(fns).toContain('mint');
    expect(fns).toContain('setApprovalForAll'); // arena operator approval pre-done too
    expect(chain.nftCount).toBe(1n);
  });

  it('the single broadcast retries a transient wallet-RPC failure instead of stranding', async () => {
    writeContractAsync.mockRejectedValueOnce(new Error('Internal JSON-RPC error: request limit reached'));
    const { result } = renderHook(() => useSessionAgent(market));

    await act(async () => {
      await result.current.start(5);
    });

    // Two attempts at the ONE native broadcast, both to the facade; then the session runs.
    const targets = writeContractAsync.mock.calls.map((c) => (c[0] as { address: string }).address);
    expect(targets).toEqual([FACADE, FACADE]);
    expect(chain.base).toBe(BASE_LEG_5); // cirBTC leg still completed after the retry
    expect(result.current.active).toBe(true);
  }, 15_000);

  it('never retries a wallet rejection on the broadcast: clean rollback, key forgotten', async () => {
    writeContractAsync.mockRejectedValueOnce(new Error('User rejected the request.'));
    const { result } = renderHook(() => useSessionAgent(market));

    let thrown: Error | undefined;
    await act(async () => {
      await result.current.start(5).catch((e: Error) => {
        thrown = e;
      });
    });

    expect(writeContractAsync).toHaveBeenCalledTimes(1); // a decision, not a glitch
    expect(signTypedDataAsync).not.toHaveBeenCalled(); // never reached the signature step
    expect(thrown?.message).toContain('no funds moved');
    expect(window.localStorage.getItem(KEY_SLOT)).toBeNull(); // nothing to recover — key gone
    expect(result.current.active).toBe(false);
  });

  it('resumes an interrupted funding: gas already seeded → NO broadcast, only the cirBTC signature', async () => {
    // A previous interrupted Start left the native leg (budget + gas) at the session; the
    // cirBTC leg never landed. Pressing Start again must NOT re-broadcast the native leg —
    // it sends only the missing cirBTC authorization.
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.native = 6_500_000n * 10n ** 12n; // the whole native leg already present, 18dp
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    await act(async () => {
      await result.current.start(5);
    });

    expect(writeContractAsync).not.toHaveBeenCalled(); // native leg already there — skipped
    expect(signTypedDataAsync).toHaveBeenCalledTimes(1); // only the cirBTC leg remained
    expect(chain.base).toBe(BASE_LEG_5);
  });

  it('does not touch the pool: no swap router call anywhere in funding or setup', async () => {
    const { result } = renderHook(() => useSessionAgent(market));
    await act(async () => {
      await result.current.start(5);
    });
    // The base leg arrives by authorization and the LP by mint — never a swap. (Buying
    // the base leg from the pool would drain limited liquidity and move the peg.)
    const fns = sessionWallet.writeContract.mock.calls.map((c) => (c[0] as { functionName?: string }).functionName);
    expect(fns).toContain('transferWithAuthorization');
    expect(fns).not.toContain('exactInputSingle');
    expect(fns).not.toContain('exactOutputSingle');
  });

  it('the cirBTC authorization nonce is DETERMINISTIC per leg — a resume reuses it so a duplicate reverts, never double-funds', async () => {
    const nonceOf = () => {
      const call = sessionWallet.writeContract.mock.calls.find(
        (c) => (c[0] as { functionName?: string }).functionName === 'transferWithAuthorization',
      );
      return (call![0] as { args: readonly unknown[] }).args[5]; // (from,to,value,validAfter,validBefore,NONCE,...)
    };
    // Both runs use the SAME session key (so the SAME session address) — the nonce, keyed on
    // (from, session, token, leg), must be byte-identical across a resume so the token's own
    // replay guard (not luck) stops a duplicate pull.
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    const first = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(first.result.current.active).toBe(true));
    await act(async () => {
      await first.result.current.start(5);
    });
    const firstNonce = nonceOf();
    first.unmount();

    sessionWallet.writeContract.mockClear();
    chain.native = 6_500_000n * 10n ** 12n; // gas already seeded → only the cirBTC leg resumes
    chain.base = 0n;
    const second = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(second.result.current.active).toBe(true));
    await act(async () => {
      await second.result.current.start(5);
    });
    expect(nonceOf()).toBe(firstNonce);
  });
});

describe('useSessionAgent start() — per-wallet funding rail', () => {
  it('embedded Circle wallet: NO typed-data signing — the cirBTC leg funds as a plain broadcast', async () => {
    // The Circle MPC wallet cannot produce raw EIP-712 signatures (its connector throws),
    // and it never needed the signature rail: its broadcasts run on Circle's server-side
    // execution API, not a local wallet RPC. Field case: three "unknown RPC error"
    // strandings in a row before this rail split.
    accountState = { address: OWNER, connector: { type: 'embedded' } };
    const { result } = renderHook(() => useSessionAgent(market));

    await act(async () => {
      await result.current.start(5);
    });

    expect(signTypedDataAsync).not.toHaveBeenCalled(); // never even asked
    const targets = writeContractAsync.mock.calls.map((c) => (c[0] as { address: string }).address);
    expect(targets).toEqual([FACADE, CIRBTC]); // native leg, then the base leg as a transfer
    expect(chain.base).toBe(BASE_LEG_5);
    expect(result.current.active).toBe(true);
  });

  it('a wallet whose typed-data SIGNING fails falls back to the broadcast rail in the same Start', async () => {
    signTypedDataAsync.mockRejectedValueOnce(new Error('An unknown RPC error occurred.'));
    const { result } = renderHook(() => useSessionAgent(market));

    await act(async () => {
      await result.current.start(5);
    });

    // Sign attempted once, then the leg landed as a transfer — no stranding, no re-press.
    expect(signTypedDataAsync).toHaveBeenCalledTimes(1);
    const targets = writeContractAsync.mock.calls.map((c) => (c[0] as { address: string }).address);
    expect(targets).toEqual([FACADE, CIRBTC]);
    expect(chain.base).toBe(BASE_LEG_5);
    expect(result.current.active).toBe(true);
  });

  it('a REJECTED signature is a decision: no fallback broadcast, session opens in recovery', async () => {
    signTypedDataAsync.mockRejectedValueOnce(new Error('User rejected the request.'));
    const { result } = renderHook(() => useSessionAgent(market));

    let thrown: Error | undefined;
    await act(async () => {
      await result.current.start(5).catch((e: Error) => {
        thrown = e;
      });
    });

    const targets = writeContractAsync.mock.calls.map((c) => (c[0] as { address: string }).address);
    expect(targets).toEqual([FACADE]); // the native leg only — the base leg was NOT forced through
    expect(thrown?.message).toContain('funding stopped at the base leg');
    expect(result.current.active).toBe(true); // recovery mode — Start resumes, Stop returns
  });

  it('a SUBMIT-stage authorization failure never falls back to a transfer (double-fund guard)', async () => {
    // The signature succeeded and the submit may still be pending in a mempool — a
    // transfer on top of it could land BOTH. The deterministic nonce handles the retry.
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.native = 6_500_000n * 10n ** 12n; // native already seeded — only the base leg runs
    chain.armReadFailOnAuth = true; // the transferWithAuthorization submit throws
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    await act(async () => {
      await result.current.start(5).catch(() => undefined);
    });

    expect(signTypedDataAsync).toHaveBeenCalledTimes(1);
    expect(writeContractAsync).not.toHaveBeenCalled(); // NO fallback transfer broadcast
  });
});

describe('useSessionAgent enterEpoch() — LP setup is epoch-independent', () => {
  it('a session found LP-less at the BUZZER still builds its LP now, then enters from the next epoch', async () => {
    // The exact two-hour-idle wedge: odds cross the floor late (<60s left), the session has
    // no LP yet. The old guard skipped with "not enough entry time left to set up the LP"
    // FOREVER (every epoch replayed it). Now the mint happens regardless of the clock —
    // it is a Uniswap position, nothing about it needs an entry window.
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.native = 6_500_000n * 10n ** 12n;
    chain.base = 4_682n;
    chain.epoch = { ...chain.epoch, entryCloseTime: BigInt(Math.floor(Date.now() / 1000) + 10) }; // 10s left
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    let r: Awaited<ReturnType<typeof result.current.enterEpoch>> | undefined;
    await act(async () => {
      r = await result.current.enterEpoch('RANGE');
    });

    const fns = sessionWallet.writeContract.mock.calls.map((c) => (c[0] as { functionName?: string }).functionName);
    expect(fns).toContain('mint'); // built NOW, not deferred to a next epoch that never came
    expect(chain.nftCount).toBe(1n);
    expect(r).toMatchObject({ ok: false, permanent: true });
    expect((r as { reason: string }).reason).toContain('LP is ready');
  });

  it('with the LP pre-built, an entry is stake-only and lands inside a short window', async () => {
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.native = 6_500_000n * 10n ** 12n;
    chain.base = 0n; // everything sits in the LP
    chain.nftCount = 1n; // LP already minted at session start
    chain.operatorApproved = true; // operator approval pre-done at start too
    chain.epoch = { ...chain.epoch, entryCloseTime: BigInt(Math.floor(Date.now() / 1000) + 20) }; // 20s left — enterable now
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    let r: Awaited<ReturnType<typeof result.current.enterEpoch>> | undefined;
    await act(async () => {
      r = await result.current.enterEpoch('RANGE');
    });

    expect(r).toMatchObject({ ok: true });
    const fns = sessionWallet.writeContract.mock.calls.map((c) => (c[0] as { functionName?: string }).functionName);
    expect(fns).toContain('stakeWithSide');
    expect(fns).not.toContain('mint'); // nothing to set up — the stake is the whole entry
  });
});

describe('useSessionAgent start() — a read failure must never delete the key', () => {
  it('post-mortem read failure after a landed leg keeps the key and opens recovery (no silent strand)', async () => {
    // The field-critical case the audit surfaced: STEP 1 lands native at the session, STEP 2
    // throws, and the post-mortem balance reads THEMSELVES fail (a rate-limit storm — the
    // very thing that failed STEP 2). A read failure must NOT be read as "balance 0" and must
    // NOT delete the only copy of the session key.
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.native = 6_500_000n * 10n ** 12n; // gas already landed at the session
    chain.base = 0n;
    chain.armReadFailOnAuth = true; // the cirBTC submit throws AND storms out the post-mortem reads
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    let thrown: Error | undefined;
    await act(async () => {
      await result.current.start(5).catch((e: Error) => {
        thrown = e;
      });
    });

    // The key SURVIVES — the funds at the session address stay recoverable.
    expect(window.localStorage.getItem(KEY_SLOT)).toBe(TEST_KEY);
    // The error routes to recovery, never to the "no funds moved" rollback lie.
    expect(thrown?.message).toContain('Stop & sweep back');
    expect(thrown?.message).not.toContain('no funds moved');
    // The session is left ACTIVE so Stop/Start can recover it.
    expect(result.current.active).toBe(true);
  });
});

describe('useSessionAgent stop() — gasless-session recovery (legacy sessions)', () => {
  it('tops the signer up from the wallet, then sweeps a session that held tokens but no gas', async () => {
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.base = 360_950n; // 0.0036095 cirBTC, zero native — the stranded shape
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    let r: Awaited<ReturnType<typeof result.current.stop>> | undefined;
    await act(async () => {
      r = await result.current.stop();
    });

    expect(r).toMatchObject({ swept: true });
    expect(r?.moved).toContain('cirBTC');
    const topUp = writeContractAsync.mock.calls[0]![0] as { address: string; args: readonly unknown[] };
    expect(topUp.address).toBe(FACADE);
    expect(topUp.args[1]).toBe(1_500_000n); // $1.50 through the 6dp facade
    expect(chain.log.indexOf(`wallet:${FACADE}`)).toBeLessThan(chain.log.findIndex((l) => l.startsWith(`session:${CIRBTC}`)));
    expect(sessionWallet.sendTransaction).toHaveBeenCalled(); // leftover gas rode home
    expect(window.localStorage.getItem(KEY_SLOT)).toBeNull(); // session closed
  });

  it('declined top-up: fails with the real reason, keeps the key, and never lies about mid-epoch', async () => {
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.base = 360_950n;
    writeContractAsync.mockRejectedValueOnce(new Error('User rejected the request'));
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    let r: Awaited<ReturnType<typeof result.current.stop>> | undefined;
    await act(async () => {
      r = await result.current.stop();
    });

    expect(r?.swept).toBe(false);
    expect(r?.retriable).not.toBe(true); // NOT the self-resolving case — no silent 12s loop
    expect(r?.reason).toContain('top-up');
    expect(r?.reason).toContain('User rejected the request'); // the wallet's own error
    expect(r?.reason).toContain('no stuck pending request'); // wallet-agnostic checklist
    expect(window.localStorage.getItem(KEY_SLOT)).toBe(TEST_KEY); // funds stay recoverable
  });

  it('marks only the staked-LP wait as retriable (it resolves itself at settlement)', async () => {
    window.localStorage.setItem(KEY_SLOT, TEST_KEY);
    chain.native = 2n * 10n ** 18n; // has gas — no top-up involved
    chain.stakes = [{ tokenId: 7n, epochId: 5n, unstaked: false, processed: false, claimed: false, won: false }];
    const { result } = renderHook(() => useSessionAgent(market));
    await vi.waitFor(() => expect(result.current.active).toBe(true));

    let r: Awaited<ReturnType<typeof result.current.stop>> | undefined;
    await act(async () => {
      r = await result.current.stop();
    });

    expect(r).toMatchObject({ swept: false, retriable: true });
    expect(r?.reason).toContain('staked in a live epoch');
    expect(writeContractAsync).not.toHaveBeenCalled();
  });
});
