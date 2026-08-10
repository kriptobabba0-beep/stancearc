import { describe, it, expect } from 'vitest';
import {
  pickPaymentOption,
  buildAuthorization,
  gatewayTypedData,
  buildPaymentHeader,
  type PaymentOption,
} from '@/lib/agent/x402Client';
import { parsePaymentHeader } from '@/lib/agent/x402';

// The buyer side of the copilot's x402 flow: option selection, the EIP-3009 authorization,
// the exact EIP-712 payload the wallet signs, and header interop with our own server parser.

const OPTION: PaymentOption = {
  scheme: 'exact',
  network: 'eip155:5042002',
  asset: '0x3600000000000000000000000000000000000000',
  amount: '10000',
  payTo: `0x${'b'.repeat(40)}`,
  maxTimeoutSeconds: 60,
  extra: { name: 'GatewayWalletBatched', version: '1', verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9' },
};

describe('pickPaymentOption', () => {
  it('selects the Gateway batching option for the chain', () => {
    expect(pickPaymentOption({ accepts: [OPTION] }, 5042002)).toEqual(OPTION);
  });

  it('rejects wrong networks, missing extras, and empty lists', () => {
    expect(pickPaymentOption({ accepts: [OPTION] }, 84532)).toBeNull();
    expect(pickPaymentOption({ accepts: [{ ...OPTION, extra: undefined }] }, 5042002)).toBeNull();
    expect(pickPaymentOption({}, 5042002)).toBeNull();
  });
});

describe('buildAuthorization + gatewayTypedData', () => {
  const NONCE = `0x${'ab'.repeat(32)}` as `0x${string}`;
  const NOW = 1_752_000_000;

  it('builds an authorization valid from 10min ago through the Gateway batch window', () => {
    const auth = buildAuthorization(`0x${'a'.repeat(40)}`, OPTION, { nowSec: NOW, nonce: NONCE });
    expect(auth.validAfter).toBe(String(NOW - 600));
    expect(auth.validBefore).toBe(String(NOW + 7 * 24 * 60 * 60 + 100)); // batch window dominates 60s
    expect(auth.value).toBe('10000');
    expect(auth.to).toBe(OPTION.payTo);
    expect(auth.nonce).toBe(NONCE);
  });

  it('produces the exact EIP-712 payload Circle expects (GatewayWalletBatched/1 domain)', () => {
    const auth = buildAuthorization(`0x${'a'.repeat(40)}`, OPTION, { nowSec: NOW, nonce: NONCE });
    const typed = gatewayTypedData(OPTION, auth);
    expect(typed.domain).toEqual({
      name: 'GatewayWalletBatched',
      version: '1',
      chainId: 5042002,
      verifyingContract: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    });
    expect(typed.primaryType).toBe('TransferWithAuthorization');
    expect(typed.types.TransferWithAuthorization.map((f) => f.name)).toEqual([
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
    ]);
    expect(typed.message.value).toBe(10000n);
    expect(typed.message.validBefore).toBe(BigInt(NOW + 7 * 24 * 60 * 60 + 100));
  });
});

describe('buildPaymentHeader ↔ server parsePaymentHeader interop', () => {
  it('the header the client builds is exactly what the server parses', () => {
    const auth = buildAuthorization(`0x${'a'.repeat(40)}`, OPTION, { nowSec: 1_752_000_000, nonce: `0x${'cd'.repeat(32)}` as `0x${string}` });
    const header = buildPaymentHeader({
      x402Version: 2,
      authorization: auth,
      signature: '0xsig',
      resource: { url: 'https://limen.finance/api/agent/chat', description: 'Limen Copilot message', mimeType: 'text/event-stream' },
      accepted: OPTION,
    });
    const parsed = parsePaymentHeader(header);
    expect(parsed).not.toBeNull();
    expect(parsed!.x402Version).toBe(2);
    expect((parsed!.payload as { authorization: { value: string }; signature: string }).authorization.value).toBe('10000');
    expect((parsed!.payload as { signature: string }).signature).toBe('0xsig');
    expect((parsed as { accepted?: { network: string } }).accepted?.network).toBe('eip155:5042002');
  });
});
