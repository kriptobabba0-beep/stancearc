'use client';

// hooks/useExecuteWrite.ts — the dual-wallet write abstraction.
//
// useActiveWallet() — the connected address + which kind of wallet (injected MetaMask vs embedded Circle).
// useExecuteWrite() — write({address,abi,functionName,args,value?}) that routes to wagmi (MetaMask) or
//   Circle's contractExecution (embedded; we viem-encode the call to tuple-safe callData). One call site,
//   either wallet — so the same action (approve, swap, claim, …) works for both.

import { useCallback } from 'react';
import { useAccount } from 'wagmi';
import { encodeFunctionData, type Abi } from 'viem';
import { arcTestnet, GAS_FLOOR_WEI, MAX_PRIORITY_FEE_WEI } from '@/lib/chain';
import { useWalletMode } from '@/components/circle/WalletModeProvider';
import { useCircleWallet } from '@/components/circle/CircleWalletProvider';
import { useArcWriteContract } from '@/hooks/useArcWriteContract';

export type WalletKind = 'injected' | 'embedded' | 'none';

/** The active connected address + its kind, based on the chosen wallet mode. */
export function useActiveWallet(): { address?: `0x${string}`; kind: WalletKind } {
  const { mode } = useWalletMode();
  const { address: injected } = useAccount();
  const circle = useCircleWallet();
  if (mode === 'embedded') {
    return circle.address ? { address: circle.address, kind: 'embedded' } : { kind: 'none' };
  }
  return injected ? { address: injected, kind: 'injected' } : { kind: 'none' };
}

export interface WriteArgs {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Native value to send (USDC on Arc), wei/atomic. */
  value?: bigint;
}

export interface WriteResult {
  kind: WalletKind;
  /** Present for the injected path; the embedded path resolves a challenge (poll for the hash separately). */
  hash?: `0x${string}`;
}

export function useExecuteWrite(): { write: (w: WriteArgs) => Promise<WriteResult> } {
  const { mode } = useWalletMode();
  const { writeContractAsync } = useArcWriteContract();
  const circle = useCircleWallet();

  const write = useCallback(
    async (w: WriteArgs): Promise<WriteResult> => {
      if (mode === 'embedded') {
        // Embedded V0 supports value-less calls (approve/swap/claim/transfer). Native msg.value via
        // Circle's `amount` field has unverified unit semantics on Arc (native 18-dp vs the 6-dp facade),
        // so we refuse it here rather than risk sending a wrong amount — wire it explicitly + verified
        // when an arena call (e.g. a payable Pyth-fee stake) actually needs it.
        if (w.value != null && w.value !== 0n) {
          throw new Error('Sending native value is not yet supported for the embedded wallet.');
        }
        // Encode the full calldata client-side (tuple-safe) → Circle signs it with the user's PIN.
        const callData = encodeFunctionData({ abi: w.abi, functionName: w.functionName, args: w.args as unknown[] });
        await circle.executeContract({ contractAddress: w.address, callData });
        return { kind: 'embedded' };
      }
      // Injected (MetaMask) — the existing wagmi path, with the Arc gas floor.
      const hash = await writeContractAsync({
        chainId: arcTestnet.id,
        address: w.address,
        abi: w.abi,
        functionName: w.functionName,
        args: w.args,
        value: w.value,
        maxFeePerGas: GAS_FLOOR_WEI,
        maxPriorityFeePerGas: MAX_PRIORITY_FEE_WEI,
      });
      return { kind: 'injected', hash };
    },
    [mode, writeContractAsync, circle],
  );

  return { write };
}
