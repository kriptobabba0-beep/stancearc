# Limen Finance V0 — Frontend Dashboard

A read-mostly dashboard for the Limen Finance protocol on **Arc Testnet**
(chainId `5042002`). The chain is the single source of truth — there is no
backend or database. The UI polls contract view functions (TanStack Query),
uses `watchContractEvent` only as a refresh optimization, and gates all
actions on on-chain phase, never the local clock.

## Stack
Next.js (App Router) · TypeScript · Tailwind · wagmi v2 · viem v2 · TanStack Query.

## Prerequisites
- Node.js 20+
- pnpm 9+ (via `corepack enable && corepack prepare pnpm@9 --activate`)
- A browser wallet (e.g. MetaMask) for live use
- Native gas token on Arc testnet is **USDC (18 decimals)** — fund the demo
  wallets from the Circle faucet: https://faucet.circle.com

## Setup
```bash
corepack enable
corepack pnpm install
cp .env.example .env.local   # then fill the ADDRESS keys (see "Wiring addresses")
```

## Run
```bash
corepack pnpm dev        # http://localhost:3000 (dev server)
corepack pnpm build      # production build (also the CI gate)
corepack pnpm start      # serve the production build
```

## Test
```bash
corepack pnpm typecheck  # tsc --noEmit
corepack pnpm test       # Vitest: pure-logic + component (RTL) tests
corepack pnpm test:e2e   # Playwright dashboard smoke (builds + serves, mocked RPC)
```

> **Note:** With placeholder addresses from `.env.example` the app builds and
> runs (start/dev), but all contract reads are inert (hooks stay in loading
> state) until `NEXT_PUBLIC_*` keys are pointed at a real deployment.

## Wiring addresses from the contracts Deploy script

### V0 (MockPriceOracle — admin-controlled price)

The V0 Foundry deploy (`script/Deploy.s.sol`) deploys `MockPriceOracle`, the WETH9
test token, the Uniswap V3 fork (factory / NPM / pool / SwapRouter), and `FeeArena`,
printing each deployed address to the console (and to
`broadcast/Deploy.s.sol/5042002/run-latest.json`).

Run from the repo root:
```bash
make deploy-demo
# or: forge script script/Deploy.s.sol --broadcast --rpc-url $RPC_URL ...
```

Then copy the addresses into `frontend/.env.local`:

| Deploy output | `.env.local` key |
|---|---|
| `FeeArena` | `NEXT_PUBLIC_FEE_ARENA_ADDRESS` |
| `MockPriceOracle` | `NEXT_PUBLIC_ORACLE_ADDRESS` |
| `NonfungiblePositionManager` | `NEXT_PUBLIC_NPM_ADDRESS` |
| `UniswapV3Factory` | `NEXT_PUBLIC_FACTORY_ADDRESS` |
| WETH/USDC pool | `NEXT_PUBLIC_POOL_ADDRESS` |
| `SwapRouter` | `NEXT_PUBLIC_SWAP_ROUTER_ADDRESS` |
| WETH9 test token | `NEXT_PUBLIC_WETH_ADDRESS` |

### V1 (PythPriceOracle — trustless ETH/USD resolution)

With `USE_PYTH=true` the Deploy script deploys a `PythPriceOracle` instead of
`MockPriceOracle`.  The oracle printed as `Oracle :` in the deploy output is the
`PythPriceOracle` address; set that as `NEXT_PUBLIC_ORACLE_ADDRESS`.

Additionally set these three V1-specific keys (see `.env.example` for defaults):

| Key | Description |
|---|---|
| `NEXT_PUBLIC_ORACLE_ADDRESS` | `Oracle :` address from the V1 Deploy output |
| `NEXT_PUBLIC_PYTH_ADDRESS` | Pyth contract on Arc testnet (`0x2880aB155794e7179c9eE2e38200202908C17B43`) |
| `NEXT_PUBLIC_PYTH_ETHUSD_ID` | ETH/USD price feed ID (`0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace`) |
| `NEXT_PUBLIC_HERMES_URL` | Hermes off-chain aggregator URL (e.g. `https://hermes.pyth.network`) |

The V1 oracle is immutable and has no admin `setPrice` — outcomes are the real ETH/USD
market.  See `script/keeper/post-and-crank.md` for the keeper flow.

Fixed addresses (already defaulted in `.env.example`, do not change for the
Arc testnet deployment):
- `NEXT_PUBLIC_USDC_ADDRESS=0x3600000000000000000000000000000000000000` (ERC-20 USDC, 6 decimals)
- `NEXT_PUBLIC_MULTICALL3_ADDRESS=0xcA11bde05977b3631167028862bE2a173976CA11`
- `NEXT_PUBLIC_CHAIN_ID=5042002`
- `NEXT_PUBLIC_RPC_HTTP=https://rpc.testnet.arc.network`
- `NEXT_PUBLIC_RPC_WS=wss://rpc.testnet.arc.network`
- `NEXT_PUBLIC_EXPLORER_URL=https://testnet.arcscan.app`
- `NEXT_PUBLIC_FEE_TIER=3000` (0.3% fee tier, optional, defaults to 3000)

`lib/env.ts` validates every key at boot and **hard-fails** the app on a
missing or invalid value. The app also reads `USDC.decimals()` and
`WETH.decimals()` once at boot and hard-fails unless they are `6` and `18`.

## Deploying to Vercel

### Quick start — Vercel native Git integration (recommended)

Vercel's Git integration is the simplest path: it gives automatic preview
deploys per PR and a production deploy on every push to `main` with no
additional secrets or CI tokens.

1. Go to [vercel.com/new](https://vercel.com/new) → **Import Git Repository**.
2. Select this repo.
3. **Set Root Directory = `frontend`** (critical — the Next.js app lives in the
   `frontend/` subdirectory, not the repo root).
4. Vercel auto-detects Next.js; leave Build Command / Output Directory as-is.
5. Add the required environment variables (see table below).
6. Click **Deploy**.

After the first deploy, every PR gets an automatic preview URL and every push
to `main` triggers a production deploy — no CI secrets or workflow changes
needed.

### Required environment variables

Set these in Vercel → Project → Settings → Environment Variables:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | Arc Testnet chain id (`5042002`) |
| `NEXT_PUBLIC_RPC_HTTP` | Comma-separated Arc HTTP RPC URL(s). First is primary; rest are fallbacks. |
| `NEXT_PUBLIC_RPC_WS` | Arc WebSocket RPC URL (optional; falls back to HTTP polling) |
| `NEXT_PUBLIC_EXPLORER_URL` | Block explorer base URL (`https://testnet.arcscan.app`) |
| `NEXT_PUBLIC_FEE_ARENA_ADDRESS` | Deployed FeeArena contract address |
| `NEXT_PUBLIC_ORACLE_ADDRESS` | Deployed oracle contract address |
| `NEXT_PUBLIC_NPM_ADDRESS` | NonfungiblePositionManager address |
| `NEXT_PUBLIC_FACTORY_ADDRESS` | UniswapV3Factory address |
| `NEXT_PUBLIC_POOL_ADDRESS` | WETH/USDC V3 pool address |
| `NEXT_PUBLIC_SWAP_ROUTER_ADDRESS` | SwapRouter address |
| `NEXT_PUBLIC_USDC_ADDRESS` | ERC-20 USDC address (6 decimals) |
| `NEXT_PUBLIC_WETH_ADDRESS` | WETH9 test token address |
| `NEXT_PUBLIC_MULTICALL3_ADDRESS` | Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`) |
| `NEXT_PUBLIC_PYTH_ADDRESS` | Pyth contract on Arc testnet |
| `NEXT_PUBLIC_PYTH_ETHUSD_ID` | Pyth ETH/USD price feed id |
| `NEXT_PUBLIC_HERMES_URL` | Hermes off-chain aggregator URL |
| `NEXT_PUBLIC_MARKETS` | (optional) Multi-market JSON config array — see `.env.example` |
| `NEXT_PUBLIC_SENTRY_DSN` | (optional) Sentry DSN — enables error reporting. App works without it. |

Optional (source-map upload — improves Sentry stack traces, not needed for the app to run):

| Variable | Description |
|---|---|
| `SENTRY_AUTH_TOKEN` | Sentry auth token for source-map upload during build |
| `SENTRY_ORG` | Your Sentry org slug |
| `SENTRY_PROJECT` | Your Sentry project slug |

### Alternative — CI-driven deploy via GitHub Actions

`.github/workflows/deploy-frontend.yml` provides a Vercel CLI deploy on every
push to `main`. It is **gated**: the deploy job is skipped (not failed) when
the Vercel secrets are absent, so CI stays green for contributors without Vercel
configured.

To activate, add three repo secrets (Settings → Secrets and variables → Actions):

| Secret | How to get it |
|---|---|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens |
| `VERCEL_ORG_ID` | `.vercel/project.json` after running `vercel link` locally |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` after running `vercel link` locally |

This is an **alternative** to native Git integration, not a replacement — pick one.

## Money-math discipline
Every on-chain numeric is a `bigint` end to end. No `Number()`/float touches
fee/contribution/payout math. Client projections mirror the contract's
`mulDiv`-floor (`lib/money.ts`); displayed strings are produced only at render
(`lib/format.ts` / `components/MoneyAmount.tsx`). Final payout numbers always
come from `previewClaim()` — any pre-settlement number is labeled "projected,
not final". Winner/share projections are hidden until settlement.

## Routes
- `/` — dashboard: epoch panel, stake-with-side, live status
- `/bridge` — onboard USDC to Arc via Circle CCTP V2 (see below)
- `/claim` — per-epoch claim then unstake (two-step)
- `/admin` — owner-gated demo/admin cranks + activity feed

## Onboarding via CCTP (Bridge USDC to Arc)
`/bridge` brings USDC onto Arc testnet from a source testnet (Base Sepolia,
Ethereum Sepolia) using Circle's Cross-Chain Transfer Protocol **V2**:
1. **Burn** on the source — `approve(USDC → source TokenMessengerV2)` then
   `depositForBurn(amount, destinationDomain=26 (Arc), mintRecipient=bytes32(you), …)`.
2. **Attest** — poll Circle's Iris V2 sandbox API
   (`GET https://iris-api-sandbox.circle.com/v2/messages/{srcDomain}?transactionHash=…`)
   until `status: complete`.
3. **Mint** on Arc — `MessageTransmitterV2.receiveMessage(message, attestation)`.

All CCTP config + off-chain helpers live in `lib/cctp.ts` (addresses/ABIs/Iris
endpoint sourced and cited there). The source chains are added to the wagmi
runtime config so the wallet can `switchChain` for the burn; Arc stays primary.

> **Live bridging requires source-chain testnet USDC.** Get some from
> [Circle's faucet](https://faucet.circle.com) before bridging. The full
> cross-chain round-trip is not exercised by tests (it needs a funded
> source-chain wallet); the off-chain logic is unit-tested in `test/cctp.test.ts`.
