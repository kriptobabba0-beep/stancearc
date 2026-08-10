# Limen Finance frontend

The Next.js app served at https://limen.finance.

## Requirements

- Node 20 or newer
- pnpm 9 (the repo pins `pnpm@9.6.0`)

## Running it

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Open http://localhost:3000.

`.env.example` already carries the live Arc testnet addresses, so a fresh clone runs
against the deployed protocol without deploying anything. Every value is validated at
boot by `lib/env.ts`, and the app refuses to start on a missing or malformed key rather
than failing later with a confusing read.

Two things about the environment are worth knowing:

- `NEXT_PUBLIC_RPC_HTTP` takes a comma-separated list. The first is primary and the rest
  are fallbacks, so one provider outage does not take the app down.
- `NEXT_PUBLIC_CHAIN_ID` must be `5042002`. The app asserts it and stops otherwise. Every
  wallet write is pinned to that chain id explicitly, so a wallet sitting on another
  network cannot end up signing there by accident.

## Scripts

```bash
pnpm dev          # development server
pnpm build        # production build
pnpm test         # unit and component tests (vitest)
pnpm typecheck    # tsc --noEmit
pnpm lint         # next lint
```

The test suite is the fastest way to see what the app is expected to do. It covers the
swap quoting path, the Stance entry and claim flows, the leaderboard indexing engine, the
RPC proxy's failover behaviour, and the route composition.

## What is where

```
app/                 Routes. /swap, /pool, /stance, /agent, /leaderboard, /bridge,
                     /wallet, plus the API routes under app/api.
components/          UI. arena/ holds the Stance flow, leaderboard/ the standings board,
                     campaign/ the campaign pages, ui/ the primitives.
hooks/               Chain reads and writes. useSwap, useArcWriteContract,
                     useExactQuote, useSessionAgent and friends.
lib/                 Pure logic with no React. env validation, pool and market registries,
                     price maths, the leaderboard indexing engine, the RPC proxy.
abis/                Typed contract ABIs, generated from the compiled artifacts rather
                     than hand-written.
test/                The suites above.
```

## Notes on a few deliberate choices

**Reads go through `/api/rpc` first.** Arc's public RPC rate-limits per client, so N
visitors polling the same global values means N times the same request. The proxy caches
identical reads at the edge and coalesces concurrent misses into one upstream call, then
the browser's own fallback chain takes over if the proxy cannot answer. A node that
declines a call (out of gas, timeout) is retried on another endpoint; a revert is passed
straight through, because a revert is the answer and every node returns the same one.

**Quotes are exact, not estimated.** `QuoterV2` walks the ticks the swap would actually
cross. An approximation from `slot0` alone drifts on a concentrated pool, which is
exactly where a user notices.

**The leaderboard is served, not computed.** The page fetches one JSON payload that a
single writer publishes. It does not scan the chain in the browser.

**Wallet writes carry an explicit chain id.** Without it, a wallet whose selected network
differs from the app's would sign on the wrong chain. Every write goes through
`useArcWriteContract`, which checks the connector's chain and switches before signing.

## Deployment

The site runs on Cloudflare Workers via OpenNext. `pnpm cf:build` produces the bundle and
`pnpm cf:deploy` publishes it; in practice deployment is driven by the Git build
integration, and `.github/workflows/deploy-frontend.yml` documents the pipeline.
