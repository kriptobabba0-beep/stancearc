import { describe, it, expect, vi } from 'vitest';
import { encodeAbiParameters, toEventSelector } from 'viem';
import {
  ARC,
  SOURCES,
  sourceByKey,
  toBytes32,
  ZERO_BYTES32,
  buildDepositForBurnArgs,
  messageFromReceipt,
  pollAttestation,
  quoteMaxFee,
  IRIS_API_URL,
  FINALITY_FAST,
} from '@/lib/cctp';

const ADDR = '0xAbC0000000000000000000000000000000001234' as const;

describe('cctp config', () => {
  it('Arc is domain 26 with the verified contracts + chainId', () => {
    expect(ARC.domain).toBe(26);
    expect(ARC.chainId).toBe(5042002);
    expect(ARC.tokenMessengerV2).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(ARC.messageTransmitterV2).toBe('0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275');
    expect(ARC.usdc).toBe('0x3600000000000000000000000000000000000000');
  });

  it('source chains: Base Sepolia (d6) and Ethereum Sepolia (d0) with researched USDC', () => {
    const base = sourceByKey('baseSepolia')!;
    const eth = sourceByKey('ethereumSepolia')!;
    expect(base.domain).toBe(6);
    expect(base.chainId).toBe(84532);
    expect(base.usdc).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(eth.domain).toBe(0);
    expect(eth.chainId).toBe(11155111);
    expect(eth.usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    // Deterministic V2 contracts shared across testnets.
    expect(base.tokenMessengerV2).toBe(ARC.tokenMessengerV2);
    expect(eth.messageTransmitterV2).toBe(ARC.messageTransmitterV2);
    expect(SOURCES).toHaveLength(2);
  });
});

describe('toBytes32', () => {
  it('left-pads a 20-byte address to a 32-byte value (lowercased)', () => {
    expect(toBytes32(ADDR)).toBe(
      '0x000000000000000000000000abc0000000000000000000000000000000001234',
    );
    expect(toBytes32(ADDR)).toHaveLength(66); // 0x + 64 hex
  });

  it('round-trips the zero address to ZERO_BYTES32', () => {
    expect(toBytes32('0x0000000000000000000000000000000000000000')).toBe(ZERO_BYTES32);
  });

  it('throws on a malformed address', () => {
    expect(() => toBytes32('0x1234' as `0x${string}`)).toThrow();
  });
});

describe('buildDepositForBurnArgs', () => {
  it('pins destinationDomain to 26 (Arc) and places the mintRecipient correctly', () => {
    const mintRecipient = toBytes32(ADDR);
    const args = buildDepositForBurnArgs({
      amount: 1_000_000n,
      mintRecipient,
      burnToken: SOURCES[0].usdc,
      maxFee: 0n,
      minFinalityThreshold: 1000,
    });
    // [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold]
    expect(args[0]).toBe(1_000_000n);
    expect(args[1]).toBe(26);
    expect(args[2]).toBe(mintRecipient);
    expect(args[3]).toBe(SOURCES[0].usdc);
    expect(args[4]).toBe(ZERO_BYTES32); // default empty destinationCaller
    expect(args[5]).toBe(0n);
    expect(args[6]).toBe(1000);
  });

  it('honors an explicit destinationCaller', () => {
    const caller = toBytes32(ADDR);
    const args = buildDepositForBurnArgs({
      amount: 5n,
      mintRecipient: ZERO_BYTES32,
      burnToken: SOURCES[1].usdc,
      maxFee: 7n,
      minFinalityThreshold: 2000,
      destinationCaller: caller,
    });
    expect(args[4]).toBe(caller);
    expect(args[6]).toBe(2000);
  });
});

describe('messageFromReceipt', () => {
  const MESSAGE = '0xdeadbeefcafe' as `0x${string}`;

  // MessageSent(bytes message): single non-indexed bytes param -> topic0 = selector, message ABI-encoded in data.
  const MESSAGE_SENT_TOPIC = toEventSelector('MessageSent(bytes)');
  function messageSentLog(message: `0x${string}`) {
    const data = encodeAbiParameters([{ name: 'message', type: 'bytes' }], [message]);
    return { data, topics: [MESSAGE_SENT_TOPIC] as `0x${string}`[] };
  }

  it('extracts the message bytes from a MessageSent log', () => {
    const { data, topics } = messageSentLog(MESSAGE);
    const logs = [{ data, topics, address: ARC.messageTransmitterV2 }] as any;
    expect(messageFromReceipt(logs)).toBe(MESSAGE);
  });

  it('skips unrelated logs and finds the MessageSent one', () => {
    const { data, topics } = messageSentLog(MESSAGE);
    const unrelated = {
      data: '0x' as const,
      topics: [toEventSelector('Transfer(address,address,uint256)')],
      address: SOURCES[0].usdc,
    };
    const logs = [unrelated, { data, topics, address: ARC.messageTransmitterV2 }] as any;
    expect(messageFromReceipt(logs)).toBe(MESSAGE);
  });

  it('throws when no MessageSent log is present', () => {
    const logs = [{ data: '0x', topics: ['0x' + '00'.repeat(32)] }] as any;
    expect(() => messageFromReceipt(logs)).toThrow(/MessageSent/);
  });
});

describe('pollAttestation', () => {
  const TX = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
  const noSleep = () => Promise.resolve();

  it('resolves once Iris reports status=complete (pending -> complete)', async () => {
    const fetchImpl = vi
      .fn()
      // 1st: 404 not-yet-indexed
      .mockResolvedValueOnce({ status: 404, ok: false })
      // 2nd: pending
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ messages: [{ status: 'pending_confirmations' }] }),
      })
      // 3rd: complete
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          messages: [{ status: 'complete', message: '0x01', attestation: '0x02' }],
        }),
      });

    const statuses: string[] = [];
    const result = await pollAttestation(0, TX, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      intervalMs: 1,
      timeoutMs: 10_000,
      onStatus: (s) => statuses.push(s),
    });

    expect(result).toEqual({ message: '0x01', attestation: '0x02' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // URL is the V2 messages endpoint by source domain + tx hash.
    expect((fetchImpl.mock.calls[0][0] as string)).toBe(
      `${IRIS_API_URL}/v2/messages/0?transactionHash=${TX}`,
    );
    expect(statuses).toContain('pending');
    expect(statuses).toContain('pending_confirmations');
    expect(statuses).toContain('complete');
  });

  it('rejects on a non-404 HTTP error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 500, ok: false });
    await expect(
      pollAttestation(6, TX, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
        intervalMs: 1,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('rejects on timeout when never complete', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 404, ok: false });
    await expect(
      pollAttestation(0, TX, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
        intervalMs: 1000,
        timeoutMs: 100, // budget < interval -> single attempt then timeout
      }),
    ).rejects.toThrow(/Timed out/);
  });
});

describe('quoteMaxFee', () => {
  const amount = 1_000_000n; // 1 USDC in 6-dp atomic units

  function makeFetch(entries: { finalityThreshold: number; minimumFee: number }[]) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => entries,
    }) as unknown as typeof fetch;
  }

  it('picks the Fast tier (finalityThreshold <= 1000) and ceil-divides the fee', async () => {
    // 50 BPS minimum fee on the Fast tier; standard tier at 0 BPS should be ignored.
    const fetchImpl = makeFetch([
      { finalityThreshold: 2000, minimumFee: 0 },  // Standard tier — must be ignored
      { finalityThreshold: 1000, minimumFee: 50 }, // Fast tier (FINALITY_FAST)
    ]);
    const result = await quoteMaxFee(6, 26, amount, { fetchImpl });
    // ceil(1_000_000 * 50 / 10000) = ceil(5000) = 5000n
    expect(result).toBe(5000n);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${IRIS_API_URL}/v2/burn/USDC/fees/6/26`,
    );
  });

  it('picks a Fast tier with finalityThreshold < 1000', async () => {
    // Some responses may have a threshold below 1000 but still within the Fast range.
    const fetchImpl = makeFetch([{ finalityThreshold: 500, minimumFee: 30 }]);
    const result = await quoteMaxFee(0, 26, amount, { fetchImpl });
    // ceil(1_000_000 * 30 / 10000) = ceil(3000) = 3000n
    expect(result).toBe(3000n);
  });

  it('rounds UP (ceil) so maxFee is never below the minimum', async () => {
    // 1 BPS on 7 USDC atomic units: 7 * 1 / 10000 = 0.0007 -> ceil = 1n
    const fetchImpl = makeFetch([{ finalityThreshold: 1000, minimumFee: 1 }]);
    const result = await quoteMaxFee(6, 26, 7n, { fetchImpl });
    expect(result).toBe(1n);
  });

  it('ceil is exact when the division is even (no rounding needed)', async () => {
    // 100 BPS on 10_000 atomic units: 10_000 * 100 / 10000 = 100 exactly
    const fetchImpl = makeFetch([{ finalityThreshold: 1000, minimumFee: 100 }]);
    const result = await quoteMaxFee(6, 26, 10_000n, { fetchImpl });
    expect(result).toBe(100n);
  });

  it('uses the FINALITY_FAST constant as the Fast-tier boundary (boundary value)', async () => {
    // Confirm the boundary: an entry at exactly FINALITY_FAST (1000) is included.
    expect(FINALITY_FAST).toBe(1000);
    const fetchImpl = makeFetch([{ finalityThreshold: FINALITY_FAST, minimumFee: 10 }]);
    const result = await quoteMaxFee(6, 26, 1_000_000n, { fetchImpl });
    // ceil(1_000_000 * 10 / 10000) = 1000
    expect(result).toBe(1000n);
  });

  it('handles a FRACTIONAL minimumFee (Iris returns 1.3 bps) without throwing BigInt(1.3)', async () => {
    // The live Base Sepolia → Arc Fast tier now quotes minimumFee: 1.3 (bps). Pre-fix `BigInt(1.3)`
    // threw "The number 1.3 cannot be converted to a BigInt", breaking every burn. maxFee = ceil(amount × 1.3 / 10000).
    const fetchImpl = makeFetch([{ finalityThreshold: 1000, minimumFee: 1.3 }]);
    const result = await quoteMaxFee(6, 26, 1_000_000n, { fetchImpl });
    expect(result).toBe(130n); // ceil(1_000_000 × 1.3 / 10000) = ceil(130) = 130
  });

  it('still rounds a fractional fee UP so maxFee is never below the minimum', async () => {
    // 1.3 bps on 1 USDC + 1 unit: 1_000_001 × 1.3 / 10000 = 130.00013 → ceil = 131.
    const fetchImpl = makeFetch([{ finalityThreshold: 1000, minimumFee: 1.3 }]);
    expect(await quoteMaxFee(6, 26, 1_000_001n, { fetchImpl })).toBe(131n);
  });

  it('throws when no Fast-tier entry is present', async () => {
    const fetchImpl = makeFetch([{ finalityThreshold: 2000, minimumFee: 0 }]);
    await expect(quoteMaxFee(6, 26, amount, { fetchImpl })).rejects.toThrow(/Fast-tier/);
  });

  it('throws on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    await expect(quoteMaxFee(6, 26, amount, { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it('handles the wrapped { data: [...] } response shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ finalityThreshold: 1000, minimumFee: 20 }] }),
    }) as unknown as typeof fetch;
    const result = await quoteMaxFee(6, 26, 1_000_000n, { fetchImpl });
    // ceil(1_000_000 * 20 / 10000) = 2000
    expect(result).toBe(2000n);
  });
});
