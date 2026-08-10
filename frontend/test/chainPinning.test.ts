// Every wallet write must name the chain it belongs to.
//
// On 2026-08-05 a swap approve was signed on Ethereum MAINNET while the app was pointed at Arc.
// The cause is subtle and silent: wagmi's writeContract destructures `chainId` from its parameters,
// resolves the connector client with `parameters.chainId ?? connection.chainId`, and calls viem with
// `chain: chainId ? { id: chainId } : null` — where `chain: null` means "skip the chain check". A
// viem simulateContract request carries `chain`, not `chainId`, so passing it straight through left
// BOTH the client and the assertion on whatever network the wallet happened to be on.
//
// Nothing errored. The target was an Arc token address, which holds no code on mainnet, and calling
// a codeless address succeeds silently and emits no logs — so the simulation passed, the write
// "succeeded", real gas was spent, and nothing happened.
//
// Two tests: withGasFloor pins the chain, and no wallet write can skip it.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BaseError, ChainMismatchError } from 'viem';

// lib/chain reads NEXT_PUBLIC_* at load and hard-fails without them; these tests want the REAL
// withGasFloor, so the env is stubbed rather than the module.
vi.mock('@/lib/env', () => ({
  ENV: {
    CHAIN_ID: 5042002,
    RPC_HTTP: 'https://rpc.testnet.arc.network',
    RPC_WS: 'wss://rpc.testnet.arc.network',
    EXPLORER_URL: 'https://explorer.testnet.arc.network',
  },
}));

import { withGasFloor, ARC_CHAIN_ID, GAS_FLOOR_WEI } from '@/lib/chain';
import { friendlyError } from '@/lib/errors';

describe('withGasFloor', () => {
  it('pins Arc on a simulateContract request, which carries `chain` but never `chainId`', () => {
    const simulated = { address: '0xabc', abi: [], functionName: 'approve', chain: { id: 999 } };
    const out = withGasFloor(simulated);
    expect(out.chainId).toBe(ARC_CHAIN_ID);
    expect(out.maxFeePerGas).toBe(GAS_FLOOR_WEI);
  });

  it('keeps an explicit chainId, so deliberately cross-chain callers are untouched', () => {
    expect(withGasFloor({ chainId: 84532, address: '0xabc' }).chainId).toBe(84532);
  });
});

describe('wrong-network copy', () => {
  it('tells the user what to do instead of quoting chain ids', () => {
    const err = new BaseError('Chain mismatch', {
      cause: new ChainMismatchError({
        chain: { id: ARC_CHAIN_ID, name: 'Arc Testnet' } as never,
        currentChainId: 1,
      }),
    });
    const msg = friendlyError(err);
    expect(msg).toMatch(/wrong network/i);
    expect(msg).toMatch(/Arc Testnet/);
  });
});

// ── the guard ───────────────────────────────────────────────────────────────────────────
// A future write path must not be able to skip the pin. Each call has to either route through
// withGasFloor (which pins Arc) or name a chainId itself (the bridge/gateway flows, which target
// CCTP source chains on purpose).

const SRC_DIRS = ['hooks', 'components', 'app'];
const WRITE_CALLS = /\b(writeContractAsync|sendTransactionAsync|writeContract|sendTransaction)\s*\(/g;
// `usePublicClient()` with no argument returns a client for whatever chain the WALLET is on. Every
// preflight then runs there: the allowance read, the simulate, the receipt wait. On a wrong network
// that reads a codeless address, viem throws "returned no data", and the user gets a stack trace
// about a missing `allowance` function instead of being told to switch networks.
const UNPINNED_CLIENT = /\busePublicClient\(\s*\)/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p);
  }
  return out;
}

/** Strip comments so prose describing a write pattern isn't mistaken for a call. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('no wallet write may skip the chain pin', () => {
  it('every write call names its chain, directly or through withGasFloor', () => {
    const offenders: string[] = [];

    for (const dir of SRC_DIRS) {
      for (const file of walk(dir)) {
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const m of src.matchAll(WRITE_CALLS)) {
          // The argument list is what has to carry the chain. Reading a bounded window past the
          // call keeps this a lint, not a parser — long enough for the real call shapes in here.
          const arg = src.slice(m.index ?? 0, (m.index ?? 0) + 600);
          if (arg.includes('withGasFloor') || arg.includes('chainId')) continue;
          const line = src.slice(0, m.index ?? 0).split('\n').length;
          offenders.push(`${file}:${line} — ${m[1]}(...) names no chain`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('no read client may follow the wallet', () => {
  it('every usePublicClient names a chain', () => {
    const offenders: string[] = [];
    for (const dir of SRC_DIRS) {
      for (const file of walk(dir)) {
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const m of src.matchAll(UNPINNED_CLIENT)) {
          const line = src.slice(0, m.index ?? 0).split('\n').length;
          offenders.push(`${file}:${line} — usePublicClient() follows the wallet's chain`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

// The bridge and gateway surfaces move the wallet to CCTP source chains on purpose. Forcing Arc
// there would break the flow they exist to implement, so they must keep the plain wagmi hook.
describe('cross-chain surfaces keep their own network', () => {
  it('bridge and gateway do not use the Arc-forcing write hook', () => {
    for (const file of ['components/BridgeUSDC.tsx', 'components/GatewayBridge.tsx']) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} must not force Arc`).not.toContain('useArcWriteContract');
    }
  });

  it('every Arc write surface DOES use it', () => {
    const arcSurfaces = [
      'hooks/useSwap.ts',
      'hooks/useStakeWithSide.ts',
      'hooks/useClaim.ts',
      'hooks/useMintPosition.ts',
      'hooks/useCollectFees.ts',
      'hooks/useRemoveLiquidity.ts',
      'hooks/useUnstake.ts',
      'hooks/useTokenApproval.ts',
      'components/agent/ActionCard.tsx',
      'components/agent/PayCard.tsx',
    ];
    for (const file of arcSurfaces) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} still uses the raw wagmi write hook`).toContain('useArcWriteContract');
      expect(src, `${file} must not also use the raw hook`).not.toMatch(/\buseWriteContract\(\)/);
    }
  });
});
