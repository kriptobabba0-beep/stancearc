import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('wagmi', () => ({ createConnector: (fn: unknown) => fn }));
vi.mock('@/lib/chain', () => ({ arcTestnet: { id: 5042002 } }));
vi.mock('@/lib/env', () => ({ ENV: { RPC_HTTP: 'http://rpc.test' } }));

import { createEmbeddedProvider, embeddedBridge } from '@/lib/embedded/connector';

const ADDR = '0x3333333333333333333333333333333333333333' as `0x${string}`;

beforeEach(() => {
  embeddedBridge.address = undefined;
  embeddedBridge.sendTransaction = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedded connector provider', () => {
  it('returns the Arc chain id locally', async () => {
    const p = createEmbeddedProvider();
    expect(await p.request({ method: 'eth_chainId' })).toBe('0x4cef52');
  });

  it('reflects the bridge address for eth_accounts', async () => {
    const p = createEmbeddedProvider();
    expect(await p.request({ method: 'eth_accounts' })).toEqual([]);
    embeddedBridge.address = ADDR;
    expect(await p.request({ method: 'eth_requestAccounts' })).toEqual([ADDR]);
  });

  it('routes eth_sendTransaction to the bridge signer and returns the hash', async () => {
    const p = createEmbeddedProvider();
    const send = vi.fn().mockResolvedValue('0xhash');
    embeddedBridge.sendTransaction = send;
    const hash = await p.request({ method: 'eth_sendTransaction', params: [{ to: ADDR, data: '0xdead', value: '0x0' }] });
    expect(hash).toBe('0xhash');
    expect(send).toHaveBeenCalledWith({ to: ADDR, data: '0xdead', value: 0n });
  });

  it('throws on eth_sendTransaction when the wallet is not ready', async () => {
    const p = createEmbeddedProvider();
    await expect(p.request({ method: 'eth_sendTransaction', params: [{ to: ADDR }] })).rejects.toThrow(/not ready/i);
  });

  it('forwards unknown read methods to the Arc RPC', async () => {
    const p = createEmbeddedProvider();
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ result: '0x10' }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await p.request({ method: 'eth_blockNumber', params: [] })).toBe('0x10');
    expect(fetchMock).toHaveBeenCalledWith('http://rpc.test', expect.objectContaining({ method: 'POST' }));
  });

  it('rejects signing methods with a clear message instead of forwarding to the RPC', async () => {
    const p = createEmbeddedProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const method of ['eth_signTypedData_v4', 'eth_signTypedData', 'eth_sign', 'personal_sign']) {
      await expect(p.request({ method, params: [] })).rejects.toThrow(/self-custody wallet/i);
    }
    expect(fetchMock).not.toHaveBeenCalled(); // never leaks a sign request to the public RPC
  });
});
