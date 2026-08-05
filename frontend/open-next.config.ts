// open-next.config.ts - adapts the Next.js build for Cloudflare Workers via @opennextjs/cloudflare.
// Default config: runs the real Next.js server on a Worker (Node compat), so the App Router app -
// the Circle Programmable-Wallets api/circle/* route handlers, the dynamic next/og OG image, the
// epoch/[id] SSR with live on-chain reads, and every client page - all run unchanged on Cloudflare.
// No incremental-cache override here: the app is request-dynamic (RPC reads, no ISR), so the default
// (no R2 bucket) is sufficient. Add an R2 NEXT_INC_CACHE_R2_BUCKET binding later if ISR is introduced.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';

export default defineCloudflareConfig({});
