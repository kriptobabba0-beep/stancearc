// app/api/pool-stats/route.ts — the Pool page's 24h volume / fees / sparklines.
//
// The scan behind this is fixed in size: Arc caps eth_getLogs at 10,000 blocks, so a day of
// three pools is about fifty calls no matter how it is written. Running it in every visitor's
// browser meant fifty round trips and roughly nine seconds of waiting per visit. Running it
// here means one small fetch per visitor and one scan a minute for everyone.
//
// Never 500s: a scan that fails while a stale copy exists serves the stale copy, because old
// figures are worth far more to the page than an error is.
import { NextResponse } from 'next/server';
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { ENV } from '@/lib/env';
import { arcTestnet } from '@/lib/chain';
import { arcHttpEndpoints } from '@/lib/arcEndpoints';
import { withRateLimitResilience } from '@/lib/rpcResilience';
import { computePoolFlow } from '@/lib/poolFlow';
import {
  freshnessOf,
  readStored,
  runInBackground,
  writeStored,
  type StoredPoolStats,
} from '@/lib/poolStatsStore';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Matched to the store's own freshness rung, so the edge and KV agree on how old is too old.
const EDGE_CACHE = { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' };

function serverClient(): PublicClient {
  return createPublicClient({
    chain: arcTestnet,
    transport: withRateLimitResilience(fallback(arcHttpEndpoints(ENV.RPC_HTTP_URLS).map((u) => http(u)))),
  }) as unknown as PublicClient;
}

async function scanAndStore(): Promise<StoredPoolStats> {
  const flow = await computePoolFlow(serverClient());
  const stored: StoredPoolStats = { ...flow, generatedAt: Date.now() };
  await writeStored(stored);
  return stored;
}

export async function GET(): Promise<NextResponse> {
  const stored = await readStored();
  const state = freshnessOf(stored, Date.now());

  if (state === 'fresh' && stored) {
    return NextResponse.json({ ...stored, cached: true }, { headers: EDGE_CACHE });
  }

  if (state === 'stale' && stored) {
    // Answer now, refresh behind the visitor, so nobody waits for a scan they did not cause.
    // Where there is no background hook (node dev), the entry simply ages into 'expired' and
    // the next request rescans inline — slower, never wrong.
    const accepted = runInBackground(scanAndStore().catch(() => undefined));
    return NextResponse.json({ ...stored, cached: true, refreshing: accepted }, { headers: EDGE_CACHE });
  }

  try {
    const fresh = await scanAndStore();
    return NextResponse.json({ ...fresh, cached: false }, { headers: EDGE_CACHE });
  } catch (err) {
    if (stored) {
      // Expired but present, and the chain is not answering. Old figures beat no figures.
      return NextResponse.json({ ...stored, cached: true, stale: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const message = err instanceof Error ? err.message : 'pool stats unavailable';
    return NextResponse.json({ error: message }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
