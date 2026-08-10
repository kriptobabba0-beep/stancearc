// lib/arcEndpoints.ts — additional public Arc-testnet RPC endpoints, straight from Circle's
// own docs (docs.arc.io "Connect to Arc" lists provider mirrors on *.testnet.arc.network
// vanity subdomains, run by Blockdaemon / dRPC / QuickNode; arc-testnet.drpc.org is dRPC's
// same service on its own domain). Each mirror is separate infrastructure with its OWN rate
// limiter, so they are real fallback capacity when the primary answers "request limit
// reached" — not just another name for the same box.
//
// These are APPENDED after whatever NEXT_PUBLIC_RPC_HTTP configures (env keeps priority and
// can also list them explicitly; de-duping handles the overlap). Used by the /api/rpc proxy's
// upstream rotation and by the browser's direct fallback legs.
export const ARC_EXTRA_HTTP_RPCS = [
  'https://rpc.drpc.testnet.arc.network',
  'https://rpc.quicknode.testnet.arc.network',
  'https://rpc.blockdaemon.testnet.arc.network',
  'https://arc-testnet.drpc.org',
] as const;

/** Configured endpoints first, documented mirrors after, de-duped preserving order. */
export function arcHttpEndpoints(configured: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of [...configured, ...ARC_EXTRA_HTTP_RPCS]) {
    const key = u.replace(/\/+$/, '');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
  }
  return out;
}
