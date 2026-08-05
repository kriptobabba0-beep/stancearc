'use client';

import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { usePathname } from 'next/navigation';
import { ARC_CHAIN_ID, arcTestnet } from '@/lib/chain';
import { SOURCES } from '@/lib/cctp';
import { Alert } from '@/components/ui/icons';

/** chainIds that are intentionally expected on the /bridge route (Arc + all CCTP source chains). */
const BRIDGE_CHAIN_IDS = new Set([ARC_CHAIN_ID, ...SOURCES.map((s) => s.chainId)]);

export function WrongNetworkBanner() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();
  const pathname = usePathname();

  // Never nag when disconnected.
  if (!isConnected) return null;

  // On the /bridge route the wallet intentionally switches to a CCTP source chain for the burn step -
  // suppress the banner for Arc AND all registered source chains there.
  if (pathname === '/bridge' && BRIDGE_CHAIN_IDS.has(chainId)) return null;

  // On all other routes, only Arc is the correct network - warn for anything else.
  if (pathname !== '/bridge' && chainId === ARC_CHAIN_ID) return null;

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 sm:px-6"
    >
      <span className="flex items-center gap-2">
        <Alert className="h-4 w-4 shrink-0 text-amber-500" />
        Wrong network (chainId {chainId}). Limen Finance runs on {arcTestnet.name} (chainId {ARC_CHAIN_ID}).
      </span>
      <button
        type="button"
        disabled={isPending}
        onClick={() => switchChain({ chainId: ARC_CHAIN_ID })}
        className="inline-flex h-8 cursor-pointer items-center rounded-lg bg-amber-500 px-3 text-[13px] font-medium text-white transition-colors hover:bg-amber-600 focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
      >
        {isPending ? 'Switching…' : `Switch to ${arcTestnet.name}`}
      </button>
    </div>
  );
}
