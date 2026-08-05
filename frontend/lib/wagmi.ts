// lib/wagmi.ts - wagmi createConfig: Arc chain (primary) + CCTP source testnets, transports, injected connector, Multicall3 batching.
import { createConfig } from 'wagmi';
import { http, webSocket, fallback } from 'viem';
import { baseSepolia, sepolia, avalancheFuji } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';
import { arcTestnet } from '@/lib/chain';
import { ENV } from '@/lib/env';
import { embeddedConnector } from '@/lib/embedded/connector';
import { arcHttpEndpoints } from '@/lib/arcEndpoints';
import { withRateLimitResilience, RateLimitGate } from '@/lib/rpcResilience';

// Build the Arc transport. Order matters:
//   1. Our own edge RPC proxy (/api/rpc) - read-caching + request-coalescing across ALL
//      visitors, so the public Arc endpoint sees a fraction of the raw traffic and one
//      user's browsing can't trip its "request limit reached" throttle. Browser only
//      (server-side code talks to the origin directly) and on a short timeout so a proxy
//      hiccup falls through fast.
//   2. The configured direct Arc http endpoints - the user's own IP is a SEPARATE limiter
//      budget from the proxy's, so this fallback genuinely helps when the proxy is throttled.
//   3. The websocket, as before.
// The whole chain rides withRateLimitResilience: when everything is limited, requests wait
// out a shared escalating cooldown instead of hammering - no caller ever sees a rate-limit
// error until retries are truly exhausted.
const directArcLegs = [
  // Configured endpoints + Circle-documented provider mirrors (separate limiter budgets).
  // A mirror that rejects browser CORS just fails that leg fast and the chain moves on.
  ...arcHttpEndpoints(ENV.RPC_HTTP_URLS).map((u) => http(u, { batch: { wait: 16 } })), // viem batches eth_call via Multicall3
  webSocket(ENV.RPC_WS),
];
const proxyLeg =
  typeof window !== 'undefined'
    ? [
        http(`${window.location.origin}/api/rpc`, {
          // batchSize stays under the proxy's own MAX_BATCH guard; retryCount 0 because the
          // proxy retries upstreams internally - a proxy failure should fall through fast.
          batch: { wait: 16, batchSize: 100 },
          timeout: 8_000,
          retryCount: 0,
        }),
      ]
    : [];
const arcTransport = withRateLimitResilience(fallback([...proxyLeg, ...directArcLegs]));

// Arc-only typed config: the typings the rest of the app (read/write hooks, getPublicClient) infer
// against. Adding the CCTP source chains to the type union would widen the `chain` union on every
// write/simulate call and break Arc-only inference in existing hooks - so the TYPE stays Arc-only.
const arcOnlyConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected(), embeddedConnector()],
  transports: {
    [arcTestnet.id]: arcTransport,
  },
  batch: { multicall: { batchSize: 1024, wait: 16 } },
  ssr: true,
});

// Runtime config ALSO registers Base Sepolia + Ethereum Sepolia + Avalanche Fuji so the wallet can
// switchChain to a source chain for the burn/deposit leg of cross-chain USDC onboarding (CCTP in
// lib/cctp.ts; Gateway in lib/gateway.ts - Fuji is a Gateway source). The bridge passes an explicit
// `chainId` per write, so these don't need to be in the static type union.
const fullConfig = createConfig({
  chains: [arcTestnet, baseSepolia, sepolia, avalancheFuji],
  connectors: [injected(), embeddedConnector()],
  transports: {
    [arcTestnet.id]: arcTransport,
    // Source-chain RPCs for the approve/burn/deposit leg. viem's defaults are unreliable in the browser
    // (rpc.sepolia.org returns 404 → "HTTP request failed / Failed to fetch"), so use CORS-enabled
    // publicnode endpoints first, with the viem default as a fallback. Receipt polling
    // (waitForTransactionReceipt) goes through these, so they must be reachable.
    // Each source chain gets its OWN rate-limit gate - their limiters are unrelated to Arc's.
    [baseSepolia.id]: withRateLimitResilience(
      fallback([http('https://base-sepolia-rpc.publicnode.com'), http()]),
      new RateLimitGate(),
    ),
    [sepolia.id]: withRateLimitResilience(
      fallback([http('https://ethereum-sepolia-rpc.publicnode.com'), http()]),
      new RateLimitGate(),
    ),
    [avalancheFuji.id]: withRateLimitResilience(
      fallback([http('https://avalanche-fuji-c-chain-rpc.publicnode.com'), http()]),
      new RateLimitGate(),
    ),
  },
  batch: { multicall: { batchSize: 1024, wait: 16 } },
  ssr: true,
});

// Export the runtime (multi-chain) config under the Arc-only TYPE so existing call sites keep their
// precise Arc inference while the wallet can still switch to a source chain at runtime.
export const wagmiConfig = fullConfig as unknown as typeof arcOnlyConfig;

declare module 'wagmi' {
  interface Register {
    config: typeof arcOnlyConfig;
  }
}
