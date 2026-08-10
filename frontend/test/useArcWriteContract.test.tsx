// The write hook that puts the wallet on Arc before it signs. Pinning the chain already made a
// wrong-network write impossible — viem refuses instead of signing — but refusing alone leaves the
// user stuck: notice the banner, switch by hand, start over. This makes the click that starts a
// write also the click that fixes the network.
//
// What matters here is the ORDER and the CONDITION: switch first, sign second, and never sign if
// the switch failed or was declined.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/env', () => ({
  ENV: {
    CHAIN_ID: 5042002,
    RPC_HTTP: 'https://rpc.testnet.arc.network',
    RPC_WS: 'wss://rpc.testnet.arc.network',
    EXPLORER_URL: 'https://explorer.testnet.arc.network',
  },
}));

const state = vi.hoisted(() => ({
  chainId: 5042002,
  calls: [] as string[],
  switchImpl: null as null | (() => Promise<unknown>),
  lastWriteArgs: undefined as unknown,
  chainReadThrows: false,
  writeImpl: null as null | (() => Promise<unknown>),
}));

vi.mock('wagmi', () => ({
  // The guard asks the CONNECTOR, because wagmi's cached chainId can disagree with what the
  // provider reports and viem validates against the provider.
  useAccount: () => ({
    connector: {
      getChainId: async () => {
        if (state.chainReadThrows) throw new Error('provider unreachable');
        return state.chainId;
      },
    },
  }),
  useSwitchChain: () => ({
    switchChainAsync: async (a: { chainId: number }) => {
      state.calls.push(`switch:${a.chainId}`);
      if (state.switchImpl) return state.switchImpl();
      state.chainId = a.chainId;
      return { id: a.chainId };
    },
  }),
  useWriteContract: () => ({
    data: undefined,
    isPending: false,
    writeContractAsync: async (args: unknown) => {
      state.calls.push('write');
      state.lastWriteArgs = args;
      if (state.writeImpl) return state.writeImpl();
      return '0xhash';
    },
  }),
}));

import { useArcWriteContract, useEnsureArcChain } from '@/hooks/useArcWriteContract';

const ARC = 5042002;

beforeEach(() => {
  state.chainId = ARC;
  state.calls = [];
  state.switchImpl = null;
  state.lastWriteArgs = undefined;
  state.chainReadThrows = false;
  state.writeImpl = null;
});

describe('useEnsureArcChain', () => {
  it('does nothing when the wallet is already on Arc', async () => {
    const { result } = renderHook(() => useEnsureArcChain());
    await act(async () => result.current());
    expect(state.calls).toEqual([]); // no pointless wallet prompt
  });

  it('switches when the wallet is elsewhere', async () => {
    state.chainId = 1; // Ethereum mainnet — the network that actually cost us
    const { result } = renderHook(() => useEnsureArcChain());
    await act(async () => result.current());
    expect(state.calls).toEqual([`switch:${ARC}`]);
  });
});

describe('useEnsureArcChain - the bug that shipped', () => {
  // wagmi's cached chainId said Arc while MetaMask's per-site network was elsewhere, so the guard
  // skipped the switch and the write failed the assertion for someone genuinely on Arc. Reading the
  // connector is what closes that gap, so the connector is the only source this may consult.
  it('switches when the CONNECTOR reports a different chain', async () => {
    state.chainId = 1;
    const { result } = renderHook(() => useEnsureArcChain());
    await act(async () => result.current());
    expect(state.calls).toEqual([`switch:${ARC}`]);
  });

  it('switches when the connector cannot be read, rather than assuming it is fine', async () => {
    state.chainReadThrows = true;
    const { result } = renderHook(() => useEnsureArcChain());
    await act(async () => result.current());
    expect(state.calls).toEqual([`switch:${ARC}`]);
  });
});

describe('useArcWriteContract', () => {
  it('switches BEFORE signing, never after', async () => {
    state.chainId = 1;
    const { result } = renderHook(() => useArcWriteContract());
    await act(async () => {
      await result.current.writeContractAsync({} as never);
    });
    // Order is the whole point: a write that signs first has already done the damage.
    expect(state.calls).toEqual([`switch:${ARC}`, 'write']);
  });

  it('does not sign when the user declines the switch', async () => {
    state.chainId = 1;
    state.switchImpl = () => Promise.reject(new Error('User rejected the request.'));
    const { result } = renderHook(() => useArcWriteContract());

    await expect(
      act(async () => {
        await result.current.writeContractAsync({} as never);
      }),
    ).rejects.toThrow(/rejected/i);

    expect(state.calls).toEqual([`switch:${ARC}`]); // no 'write'
  });

  it('signs directly when already on Arc', async () => {
    const { result } = renderHook(() => useArcWriteContract());
    await act(async () => {
      await result.current.writeContractAsync({} as never);
    });
    expect(state.calls).toEqual(['write']);
  });

  it('forwards the write arguments to wagmi untouched', async () => {
    state.chainId = 1; // go through the switch path too, so nothing is lost on the way
    const args = { address: '0xabc', functionName: 'approve', args: [1n] };
    const { result } = renderHook(() => useArcWriteContract());
    await act(async () => {
      await result.current.writeContractAsync(args as never);
    });
    // Asserted against what the UNDERLYING wagmi hook received, not against the wrapper.
    expect(state.lastWriteArgs).toEqual(args);
  });
});

// A wallet that has never seen Arc goes through add-then-switch. wagmi keeps the connection's chain
// in its own state and learns the new one from the wallet's chainChanged event, so for a moment its
// cache still says Ethereum while the connector already says Arc — and wagmi refuses the write by
// comparing the two. Users saw that refusal even though the swap then went through.
describe('wagmi catching up after a switch', () => {
  const mismatch = () => {
    const e = new Error(
      "The current chain of the connector (id: 5042002) does not match the connection's chain (id: 1).",
    );
    e.name = 'ConnectorChainMismatchError';
    return e;
  };

  it('retries once when wagmi has not noticed the new chain yet', async () => {
    let attempts = 0;
    state.writeImpl = () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(mismatch());
      return Promise.resolve('0xhash');
    };
    const { result } = renderHook(() => useArcWriteContract());
    await act(async () => {
      await expect(result.current.writeContractAsync({} as never)).resolves.toBe('0xhash');
    });
    expect(attempts).toBe(2);
  });

  it('does not retry a real failure, which could double-send', async () => {
    let attempts = 0;
    state.writeImpl = () => {
      attempts += 1;
      return Promise.reject(new Error('execution reverted: STF'));
    };
    const { result } = renderHook(() => useArcWriteContract());
    await act(async () => {
      await expect(result.current.writeContractAsync({} as never)).rejects.toThrow(/STF/);
    });
    expect(attempts).toBe(1);
  });
});
