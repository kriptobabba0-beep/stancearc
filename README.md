# Limen Finance

Opt-in fee settlement for liquidity providers, on Circle's Arc testnet.

Live app: **https://limen.finance**

## What it does

Providing liquidity on an AMM pays you fees, but it pays them passively. Limen lets a
liquidity provider put those fees to work without moving the position.

A provider stakes their Uniswap V3 position into a **fee arena** for one epoch and picks a
side: the price of the market goes UP, goes DOWN, or stays inside a narrow band (RANGE).
The fees the position collects during that epoch become their stake. When the epoch
settles, a Pyth oracle price decides which side was right. The fees staked by the wrong
sides are redistributed to the right ones, in proportion to what each contributed.

Two things follow from that design and both are deliberate:

- The LP position itself is never at risk. Only the fees earned inside the epoch are, and
  only the ones the provider chose to stake.
- Participation is opt in. An LP who ignores the arena keeps their fees exactly as before.

The protocol calls this **Stance**. The rest of the product is what Stance needs to exist:
a concentrated-liquidity DEX to earn the fees, a leaderboard to make the results legible,
and an off-chain keeper to drive the epoch clock.

## Fastest way to evaluate this

The protocol is deployed and running. Nothing has to be built or deployed to see it work.

1. Open **https://limen.finance** and connect any EVM wallet, or sign in with Google or
   email (Circle Programmable Wallets creates one for you).
2. Get testnet USDC from https://faucet.circle.com. USDC is Arc's native gas token, so the
   same balance pays for gas and for trading.
3. **Swap** page: trade cirBTC, USDC or EURC. Quotes come from an on-chain QuoterV2 call,
   so the number shown is the number the pool will fill at.
4. **Pools** page: add liquidity to a pair. You now hold a Uniswap V3 position NFT.
5. **Stance** page: stake that position into the current epoch and pick a side. Epochs run
   about four minutes, so a full round trip is quick. After settlement, claim.
6. **Leaderboard**: every figure there is derived from on-chain events and each address
   links to the block explorer, so any row can be checked independently.

Every contract is verified on https://testnet.arcscan.app, so the source behind each
address can be read directly.

## Deployed addresses (Arc Testnet, chain id 5042002)

| Contract | Address |
| --- | --- |
| UniswapV3Factory | `0x184b90622535b024AD178730f39b75D26EF04826` |
| SwapRouter | `0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9` |
| QuoterV2 | `0xAFCd5e3f8fe76AC40aAD722cD4D909CAb2ef59bF` |
| NonfungiblePositionManager | `0x646E3cCd584b315F235aD269C0893a125D9F38dc` |
| FeeArenaV3 (cirBTC/USDC) | `0xfbc6558ca71fefcbc08b394740a86dc654a8f3e2` |
| FeeArenaV3 (cirBTC/EURC) | `0xC7b0D0dd6D53BAA478BC1389863E2F2eb3EC6570` |
| Pyth price oracle adapter | `0xeC6214cB521D4C7178B8CDEfaEf76e5b021Dde59` |

Pools: cirBTC/USDC `0x969f2e3CB9929b5D50B6A59Cf49CF30870e1658b`,
EURC/USDC `0xB89700608231C5D74b56308D2c96c5F830a5f322`,
cirBTC/EURC `0xEBCc92862e007220A90b407f92E90dAC3A98aD63`. All at the 0.30% fee tier.

Tokens: USDC `0x3600000000000000000000000000000000000000` (6 decimals, also the native gas
token), cirBTC `0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF` (8), EURC
`0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (6).

## Repository layout

```
src/         Solidity contracts. FeeArenaV3 is the live arena; the oracles/ folder holds
             the Pyth adapters; interfaces/ and mocks/ support them.
script/      Foundry deployment and demo scripts.
frontend/    Next.js app (the site at limen.finance). See frontend/README.md.
keeper/      Off-chain services that drive the epoch clock and keep the market alive.
             See keeper/README.md.
scripts/     Operational helper scripts (Node).
.github/     CI: contract tests, frontend and keeper test suites, Slither.
```

## Running it locally

### Frontend

The quickest local setup, because it talks to the already-deployed contracts.

```bash
cd frontend
pnpm install
cp .env.example .env.local     # already filled with the live addresses above
pnpm dev                       # http://localhost:3000
```

Full detail, including the test suite, is in `frontend/README.md`.

### Contracts

Foundry is required (https://getfoundry.sh). The workspace compiles two Solidity
families at once: the Uniswap V3 fork is pinned to 0.7.6 and all first-party code is
^0.8.20, which is why `auto_detect_solc` is on in `foundry.toml`.

```bash
git submodule update --init --recursive
forge build
forge test
```

The suite is 63 files and 364 tests, including invariant runs, and finishes in under a
minute.

`make help` lists the deployment targets. The full protocol flow can be run locally with
no key, no funds and no network:

```bash
make demo-sim      # deploys everything and runs a full epoch in a fresh in-memory EVM
```

`make deploy-sim` simulates the deployment script. It reads `PRIVATE_KEY` from `.env`, so
copy `.env.example` to `.env` first and put any well-formed 32-byte hex value there. The
simulation never broadcasts, so the key is only needed to derive an address.

### Keeper

The keeper is only needed to run your own deployment. The public testnet already has one
running. See `keeper/README.md`.

## Design notes worth reading

**Settlement is oracle-anchored, not pool-anchored.** Epochs settle on a Pyth price, never
on the pool's own price. A thin pool can be pushed around; the settlement cannot.

**The keeper cannot take funds.** Lifecycle calls are the only thing it is authorised for.
`startEpoch`, `endEpoch`, `sweep` and `finalizeSettle` are permissionless by design, so
anyone can push a stuck epoch forward and no single operator can hold the protocol hostage.

**Leaderboard figures are indexed, not recomputed per visitor.** A single writer folds
chain events into a snapshot and publishes a ready-to-serve payload, so every visitor sees
the same standings at the same block height rather than a per-session guess.

## Circle integrations

USDC as the native gas token, EURC as a second quote asset, CCTP for bridging in, Circle
Programmable Wallets for email and Google sign-in, Circle Gateway for deposits, and the
Smart Contract Platform for contract reads. cirBTC is Circle's tokenised BTC on Arc.

## Licence

MIT. See `LICENSE`.
