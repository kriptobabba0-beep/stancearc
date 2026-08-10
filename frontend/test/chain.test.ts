// chain.test.ts — direct unit test for the REAL withGasFloor helper (no mock of @/lib/chain).
// Every hook test mocks @/lib/chain, so this is the ONLY file that exercises the actual
// implementation. Asserts the 20-gwei Arc gas-floor invariant and that the payable `value`
// (and all other input fields) survive the spread.
import { describe, it, expect, vi } from 'vitest';

// chain.ts imports ENV at module level; mock @/lib/env so the real chain module can load
// without NEXT_PUBLIC_* env vars being present in the test environment.
// NOTE: @/lib/chain itself is NOT mocked — that is the point of this test file.
vi.mock('@/lib/env', () => ({
  ENV: {
    CHAIN_ID: 5042002,
    RPC_HTTP: 'https://rpc.testnet.arc.network',
    RPC_WS: 'wss://rpc.testnet.arc.network',
    EXPLORER_URL: 'https://testnet.arcscan.app',
    MULTICALL3_ADDRESS: '0xcA11bde05977b3631167028862bE2a173976CA11',
  },
}));

// Import the REAL implementations — do NOT mock @/lib/chain in this file.
import { withGasFloor, GAS_FLOOR_WEI, MAX_PRIORITY_FEE_WEI } from '@/lib/chain';

describe('withGasFloor (real implementation — no mock)', () => {
  it('(a) sets maxFeePerGas === GAS_FLOOR_WEI (20 Gwei) and maxPriorityFeePerGas === MAX_PRIORITY_FEE_WEI (1 Gwei)', () => {
    const result = withGasFloor({});
    expect(result.maxFeePerGas).toBe(GAS_FLOOR_WEI);
    expect(result.maxFeePerGas).toBe(20_000_000_000n);
    expect(result.maxPriorityFeePerGas).toBe(MAX_PRIORITY_FEE_WEI);
    expect(result.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  it('(b) payable invariant — value, account, address, functionName, args all survive unchanged', () => {
    const input = {
      value: 5_000_000_000_000_000_000n, // 5 ETH-equivalent in wei
      account: '0x1234567890123456789012345678901234567890' as const,
      address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as const,
      functionName: 'deposit' as const,
      args: [42n, 'hello'] as const,
    };

    const result = withGasFloor(input);

    expect(result.value).toBe(input.value);
    expect(result.account).toBe(input.account);
    expect(result.address).toBe(input.address);
    expect(result.functionName).toBe(input.functionName);
    expect(result.args).toBe(input.args); // same reference — not cloned
  });

  // Was "no extra keys beyond the two fee fields". withGasFloor now also names the chain, because
  // omitting it let wagmi resolve the wallet's current network AND told viem to skip the chain
  // check — which put real approve transactions on Ethereum mainnet. See test/chainPinning.test.ts.
  it('(c) adds only the two fee fields and the chain id', () => {
    const input = {
      value: 1_000n,
      account: '0x0000000000000000000000000000000000000001' as const,
      address: '0x0000000000000000000000000000000000000002' as const,
      functionName: 'deposit' as const,
      args: [] as const,
    };

    const result = withGasFloor(input);

    const inputKeys = new Set(Object.keys(input));
    const resultKeys = new Set(Object.keys(result));
    const expectedKeys = new Set([...inputKeys, 'chainId', 'maxFeePerGas', 'maxPriorityFeePerGas']);

    expect(resultKeys).toEqual(expectedKeys);
  });
});
