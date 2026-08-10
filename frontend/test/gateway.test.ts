import { describe, it, expect, vi } from 'vitest';
import {
  GATEWAY_WALLET,
  GATEWAY_MINTER,
  GATEWAY_API_URL,
  ARC_GATEWAY,
  GATEWAY_SOURCES,
  sourceByKey,
  sourceByDomain,
  addressToBytes32,
  randomSalt,
  GATEWAY_DOMAIN,
  buildBurnIntent,
  burnIntentTypedData,
  expectedFee,
  computeMaxFee,
  minTransferValue,
  serializeBurnIntent,
  fetchUnifiedBalances,
  submitTransfer,
  estimateForwarderFee,
  submitForwarderTransfer,
  pollForwarderTransfer,
  fetchExpirationHeight,
  fetchDeposits,
  isPendingDeposit,
  depositProgress,
  formatEta,
  parseUsdc6,
  type GatewaySource,
} from '@/lib/gateway';

const USER = '0x2B2B7f60644f4bc01bD15d38c36fCb2530efA27b' as const;
const base = (): GatewaySource => sourceByKey('baseSepolia')!;
const eth = (): GatewaySource => sourceByKey('ethereumSepolia')!;
const fuji = (): GatewaySource => sourceByKey('avalancheFuji')!;

describe('gateway config', () => {
  it('Arc is domain 26 / chainId 5042002 with the USDC facade + canonical contracts', () => {
    expect(ARC_GATEWAY.domain).toBe(26);
    expect(ARC_GATEWAY.chainId).toBe(5042002);
    expect(ARC_GATEWAY.usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(GATEWAY_WALLET).toBe('0x0077777d7EBA4688BDeF3E311b846F25870A19B9');
    expect(GATEWAY_MINTER).toBe('0x0022222ABE238Cc2C7Bb1f21003F0a260052475B');
    expect(GATEWAY_API_URL).toBe('https://gateway-api-testnet.circle.com/v1');
  });

  it('has the three approved source chains with the verified domains/USDC', () => {
    expect(GATEWAY_SOURCES).toHaveLength(3);
    expect(fuji().domain).toBe(1);
    expect(fuji().chainId).toBe(43113);
    expect(fuji().usdc).toBe('0x5425890298aed601595a70AB815c96711a31Bc65');
    expect(base().domain).toBe(6);
    expect(base().chainId).toBe(84532);
    expect(base().usdc).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(eth().domain).toBe(0);
    expect(eth().chainId).toBe(11155111);
    expect(eth().usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(sourceByDomain(6)!.key).toBe('baseSepolia');
    expect(sourceByDomain(99)).toBeUndefined();
  });
});

describe('addressToBytes32', () => {
  it('left-pads a 20-byte address to a lowercased 32-byte value', () => {
    expect(addressToBytes32('0xAbC0000000000000000000000000000000001234')).toBe(
      '0x000000000000000000000000abc0000000000000000000000000000000001234',
    );
    expect(addressToBytes32(USER)).toHaveLength(66);
  });
});

describe('randomSalt', () => {
  it('returns a 32-byte hex and differs between calls', () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('EIP-712 burn intent typed data', () => {
  const msg = buildBurnIntent({
    source: base(),
    value: 10_000_000n,
    depositor: USER,
    recipient: USER,
    maxBlockHeight: 99n,
    maxFee: 30_000n,
    salt: ('0x' + '11'.repeat(32)) as `0x${string}`,
  });

  it('uses the domain-less domain (name + version ONLY)', () => {
    const td = burnIntentTypedData(msg);
    expect(td.domain).toEqual({ name: 'GatewayWallet', version: '1' });
    expect(Object.keys(td.domain)).toEqual(['name', 'version']); // no chainId / verifyingContract
    expect(GATEWAY_DOMAIN).toEqual({ name: 'GatewayWallet', version: '1' });
    expect(td.primaryType).toBe('BurnIntent');
  });

  it('declares the TransferSpec/BurnIntent types in the canonical order + types', () => {
    const { types } = burnIntentTypedData(msg);
    expect(types.TransferSpec.map((f) => [f.name, f.type])).toEqual([
      ['version', 'uint32'],
      ['sourceDomain', 'uint32'],
      ['destinationDomain', 'uint32'],
      ['sourceContract', 'bytes32'],
      ['destinationContract', 'bytes32'],
      ['sourceToken', 'bytes32'],
      ['destinationToken', 'bytes32'],
      ['sourceDepositor', 'bytes32'],
      ['destinationRecipient', 'bytes32'],
      ['sourceSigner', 'bytes32'],
      ['destinationCaller', 'bytes32'],
      ['value', 'uint256'],
      ['salt', 'bytes32'],
      ['hookData', 'bytes'],
    ]);
    expect(types.BurnIntent.map((f) => [f.name, f.type])).toEqual([
      ['maxBlockHeight', 'uint256'],
      ['maxFee', 'uint256'],
      ['spec', 'TransferSpec'],
    ]);
  });

  it('builds a Base→Arc spec with bytes32-padded fields + Arc destination', () => {
    expect(msg.spec.version).toBe(1);
    expect(msg.spec.sourceDomain).toBe(6);
    expect(msg.spec.destinationDomain).toBe(26);
    expect(msg.spec.sourceContract).toBe(addressToBytes32(GATEWAY_WALLET));
    expect(msg.spec.destinationContract).toBe(addressToBytes32(GATEWAY_MINTER));
    expect(msg.spec.sourceToken).toBe(addressToBytes32(base().usdc));
    expect(msg.spec.destinationToken).toBe(addressToBytes32(ARC_GATEWAY.usdc));
    expect(msg.spec.sourceDepositor).toBe(addressToBytes32(USER));
    expect(msg.spec.destinationRecipient).toBe(addressToBytes32(USER));
    expect(msg.spec.sourceSigner).toBe(addressToBytes32(USER));
    expect(msg.spec.destinationCaller).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(msg.spec.value).toBe(10_000_000n);
    expect(msg.spec.hookData).toBe('0x');
    expect(msg.maxBlockHeight).toBe(99n);
    expect(msg.maxFee).toBe(30_000n);
  });
});

describe('fees', () => {
  it('expectedFee = per-source gas floor + 0.5 bps of value (ceil)', () => {
    expect(expectedFee(eth(), 5_000_000n)).toBe(1_000_250n); // 1_000_000 + ceil(25_000_000/100_000)=250
    expect(expectedFee(fuji(), 1_000_000n)).toBe(20_050n); // 20_000 + 50
  });
  it('computeMaxFee adds 1.5x headroom over expectedFee', () => {
    expect(computeMaxFee(eth(), 5_000_000n)).toBe(1_500_375n); // 1_000_250 + ceil(1_000_250/2)
  });
  it('minTransferValue is 2x the source gas floor', () => {
    expect(minTransferValue(eth())).toBe(2_000_000n);
    expect(minTransferValue(fuji())).toBe(40_000n);
    expect(minTransferValue(base())).toBe(20_000n);
  });
});

describe('parseUsdc6', () => {
  it('parses 6-dp decimal strings into atomic bigint', () => {
    expect(parseUsdc6('2.000000')).toBe(2_000_000n);
    expect(parseUsdc6('2')).toBe(2_000_000n);
    expect(parseUsdc6('0.500000')).toBe(500_000n);
    expect(parseUsdc6('0.000000')).toBe(0n);
    expect(parseUsdc6('123.456789')).toBe(123_456_789n);
  });
});

describe('serializeBurnIntent', () => {
  it('stringifies bigints for the JSON body, keeps hex fields', () => {
    const msg = buildBurnIntent({
      source: base(),
      value: 1_000_000n,
      depositor: USER,
      recipient: USER,
      maxBlockHeight: 43_368_735n,
      maxFee: 20_000n,
      salt: ('0x' + '22'.repeat(32)) as `0x${string}`,
    });
    const s = serializeBurnIntent(msg) as {
      maxBlockHeight: string;
      maxFee: string;
      spec: { value: string; salt: string; hookData: string; destinationDomain: number };
    };
    expect(s.maxBlockHeight).toBe('43368735');
    expect(s.maxFee).toBe('20000');
    expect(s.spec.value).toBe('1000000');
    expect(s.spec.destinationDomain).toBe(26);
    expect(s.spec.salt).toBe('0x' + '22'.repeat(32));
    expect(s.spec.hookData).toBe('0x');
    // must be JSON-serializable (no bigints left)
    expect(() => JSON.stringify(s)).not.toThrow();
  });
});

describe('fetchUnifiedBalances', () => {
  it('POSTs /v1/balances and parses decimal balances into a domain→bigint map', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balances: [{ domain: 6, balance: '2.000000' }, { domain: 0, balance: '0.000000' }] }),
    });
    const out = await fetchUnifiedBalances(
      [{ domain: 6, depositor: USER }, { domain: 0, depositor: USER }],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(out.get(6)).toBe(2_000_000n);
    expect(out.get(0)).toBe(0n);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GATEWAY_API_URL}/balances`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      token: 'USDC',
      sources: [{ domain: 6, depositor: USER }, { domain: 0, depositor: USER }],
    });
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(
      fetchUnifiedBalances([{ domain: 6, depositor: USER }], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('submitTransfer', () => {
  const msg = buildBurnIntent({
    source: base(),
    value: 1_000_000n,
    depositor: USER,
    recipient: USER,
    maxBlockHeight: 43_368_735n,
    maxFee: 20_000n,
    salt: ('0x' + '33'.repeat(32)) as `0x${string}`,
  });

  it('POSTs an array of {burnIntent,signature} and returns the attestation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ attestation: '0xatt', signature: '0xgwsig' }),
    });
    const res = await submitTransfer(msg, '0xusersig', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ attestation: '0xatt', signature: '0xgwsig' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GATEWAY_API_URL}/transfer`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].signature).toBe('0xusersig');
    expect(body[0].burnIntent.spec.value).toBe('1000000');
    expect(body[0].burnIntent.spec.destinationDomain).toBe(26);
  });

  it('throws when the response has no attestation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(
      submitTransfer(msg, '0xusersig', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/no attestation/i);
  });

  it('surfaces Circle’s own 400 message (not just the status)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ success: false, message: 'Invalid signature' }),
    });
    await expect(
      submitTransfer(msg, '0xusersig', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/HTTP 400.*Invalid signature/);
  });

  it('falls back to the bare status when the error body is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    await expect(
      submitTransfer(msg, '0xusersig', { fetchImpl: fetchImpl as unknown as typeof fetch, retries: 0 }),
    ).rejects.toThrow(/HTTP 502/);
  });

  it('retries a transient 503 (Service temporarily unavailable) on the same signature, then succeeds', async () => {
    const r503 = { ok: false, status: 503, json: async () => ({ success: false, message: 'Service temporarily unavailable. Please try again later.' }) };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(r503)
      .mockResolvedValueOnce(r503)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ attestation: '0xatt', signature: '0xgw' }) });
    const res = await submitTransfer(msg, '0xusersig', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });
    expect(res).toEqual({ attestation: '0xatt', signature: '0xgw' });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 2 transient 503s + the success — one signature, no re-sign
  });

  it('does NOT retry a 4xx (terminal — bad fee/signature/balance)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: 'Invalid signature' }) });
    await expect(
      submitTransfer(msg, '0xusersig', { fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 }),
    ).rejects.toThrow(/Invalid signature/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('forwarder path (estimate / submit / poll)', () => {
  const msg = buildBurnIntent({
    source: base(),
    value: 1_000_000n,
    depositor: USER,
    recipient: USER,
    maxBlockHeight: 43_368_735n,
    maxFee: 30_075n,
    salt: ('0x' + '44'.repeat(32)) as `0x${string}`,
  });
  const cast = (f: unknown) => f as unknown as typeof fetch;
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  describe('estimateForwarderFee', () => {
    it('reads the forwarding-adjusted maxFee + maxBlockHeight from the {body:[{burnIntent}]} wrapper', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        ok({ body: [{ burnIntent: { maxFee: '33594', maxBlockHeight: '57118270', spec: {} } }] }),
      );
      const out = await estimateForwarderFee(msg, { fetchImpl: cast(fetchImpl) });
      expect(out).toEqual({ maxFee: 33_594n, maxBlockHeight: 57_118_270n });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${GATEWAY_API_URL}/estimate?enableForwarder=true`);
      const body = JSON.parse((init as RequestInit).body as string);
      expect(Array.isArray(body)).toBe(true); // bare array of UNSIGNED intents
      expect(body[0].signature).toBeUndefined();
      expect(body[0].spec).toBeDefined();
    });
    it('returns null after retrying a persistent 5xx (caller falls back to the manual mint)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      expect(await estimateForwarderFee(msg, { fetchImpl: cast(fetchImpl), retryDelayMs: 0 })).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
    it('returns null when the {body} wrapper is absent (e.g. a non-forwarder bare array)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(ok([{ burnIntent: { maxFee: '30075' } }]));
      expect(await estimateForwarderFee(msg, { fetchImpl: cast(fetchImpl) })).toBeNull();
    });
  });

  describe('submitForwarderTransfer', () => {
    it('POSTs ?enableForwarder=true and returns the transferId (no attestation required)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ transferId: 'abc-123' }) });
      const out = await submitForwarderTransfer(msg, '0xsig', { fetchImpl: cast(fetchImpl) });
      expect(out).toEqual({ transferId: 'abc-123' });
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe(`${GATEWAY_API_URL}/transfer?enableForwarder=true`);
      expect(JSON.parse((init as RequestInit).body as string)[0].signature).toBe('0xsig');
    });
    it('throws when no transferId is returned', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) });
      await expect(submitForwarderTransfer(msg, '0xsig', { fetchImpl: cast(fetchImpl) })).rejects.toThrow(/transferId/i);
    });
    it('rides out a transient 503 on the same signature, then returns the transferId', async () => {
      const r503 = { ok: false, status: 503, json: async () => ({ message: 'Service temporarily unavailable. Please try again later.' }) };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(r503)
        .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ transferId: 'tx-1' }) });
      const out = await submitForwarderTransfer(msg, '0xsig', { fetchImpl: cast(fetchImpl), retryDelayMs: 0 });
      expect(out).toEqual({ transferId: 'tx-1' });
      expect(fetchImpl).toHaveBeenCalledTimes(2); // one retry, one signature
    });
  });

  describe('pollForwarderTransfer', () => {
    it('keeps polling past the transient early 400, then resolves with the mint hash on finalized', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 400 }) // "not available yet"
        .mockResolvedValueOnce(ok({ status: 'pending' }))
        .mockResolvedValueOnce(ok({ status: 'finalized', transactionHash: '0xmint' }));
      const out = await pollForwarderTransfer('id', { fetchImpl: cast(fetchImpl), intervalMs: 0 });
      expect(out).toEqual({ status: 'finalized', transactionHash: '0xmint' });
    });
    it('treats confirmed as done too (ordering is unverified)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'confirmed', transactionHash: '0xc' }));
      const out = await pollForwarderTransfer('id', { fetchImpl: cast(fetchImpl), intervalMs: 0 });
      expect(out.transactionHash).toBe('0xc');
    });
    it('polls again when a terminal status arrives before the hash propagates', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(ok({ status: 'finalized' })) // no hash yet
        .mockResolvedValueOnce(ok({ status: 'finalized', transactionHash: '0xlate' }));
      const out = await pollForwarderTransfer('id', { fetchImpl: cast(fetchImpl), intervalMs: 0 });
      expect(out.transactionHash).toBe('0xlate');
    });
    it('throws the failureReason on failed', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'failed', forwardingDetails: { failureReason: 'mint reverted' } }));
      await expect(pollForwarderTransfer('id', { fetchImpl: cast(fetchImpl), intervalMs: 0 })).rejects.toThrow(/mint reverted/);
    });
    it('throws on expired', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'expired' }));
      await expect(pollForwarderTransfer('id', { fetchImpl: cast(fetchImpl), intervalMs: 0 })).rejects.toThrow(/expired/i);
    });
    it('times out with a still-processing message', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'pending' }));
      await expect(
        pollForwarderTransfer('id', { fetchImpl: cast(fetchImpl), intervalMs: 0, timeoutMs: 8 }),
      ).rejects.toThrow(/still processing/i);
    });
  });
});

describe('fetchDeposits', () => {
  it('POSTs /v1/deposits and parses the deposit list (amounts/heights/timestamps)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'USDC',
        deposits: [
          {
            transactionHash: '0xdead',
            domain: 0,
            amount: '10000000',
            status: 'pending',
            blockHeight: '11097239',
            blockTimestamp: '2026-06-19T22:28:00.000Z',
          },
        ],
      }),
    });
    const out = await fetchDeposits([{ domain: 0, depositor: USER }], { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toHaveLength(1);
    expect(out[0].amount).toBe(10_000_000n);
    expect(out[0].blockHeight).toBe(11_097_239n);
    expect(out[0].status).toBe('pending');
    expect(isPendingDeposit(out[0])).toBe(true);
    expect(out[0].blockTimestampMs).toBe(Date.parse('2026-06-19T22:28:00.000Z'));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GATEWAY_API_URL}/deposits`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      token: 'USDC',
      sources: [{ domain: 0, depositor: USER }],
    });
  });

  it('returns [] when there are no deposits, and marks credited deposits not-pending', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ deposits: [] }) });
    expect(await fetchDeposits([{ domain: 0, depositor: USER }], { fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual([]);
    expect(isPendingDeposit({ status: 'available' } as never)).toBe(false);
  });
});

describe('depositProgress + formatEta', () => {
  it('reports "confirming" with a shrinking ETA inside the window', () => {
    const base = Date.parse('2026-06-19T22:28:00.000Z');
    const p = depositProgress({ blockTimestampMs: base, now: base + 60_000, finalitySeconds: 1140 });
    expect(p.phase).toBe('confirming');
    expect(p.etaSec).toBe(1080); // 1140 - 60
    expect(p.pct).toBeCloseTo(60 / 1140, 5);
  });
  it('caps at 99% and flips to "crediting" once the estimate elapses', () => {
    const base = 1_000_000_000_000;
    const p = depositProgress({ blockTimestampMs: base, now: base + 2_000_000, finalitySeconds: 12 });
    expect(p.phase).toBe('crediting');
    expect(p.pct).toBe(0.99);
    expect(p.etaSec).toBe(0);
  });
  it('formats ETAs', () => {
    expect(formatEta(0)).toBe('any moment');
    expect(formatEta(45)).toBe('~45s');
    expect(formatEta(200)).toBe('~3m 20s');
    expect(formatEta(1020)).toBe('~17m');
    expect(formatEta(3700)).toBe('~1h 1m');
  });
});

describe('fetchExpirationHeight', () => {
  it('reads the source domain burnIntentExpirationHeight from /v1/info', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        domains: [
          { domain: 0, burnIntentExpirationHeight: '11147045' },
          { domain: 6, burnIntentExpirationHeight: '43368735' },
          { domain: 26, burnIntentExpirationHeight: '48968867' },
        ],
      }),
    });
    const h = await fetchExpirationHeight(6, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(h).toBe(43_368_735n);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${GATEWAY_API_URL}/info`);
  });
});
