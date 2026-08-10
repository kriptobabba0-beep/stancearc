# Limen Finance keeper

The off-chain services that keep the protocol moving. None of them can move user funds;
they exist to drive a clock and to keep a testnet market from going quiet.

You do not need to run any of this to evaluate the protocol. The public deployment already
has it running. This is here for anyone standing up their own instance.

## Requirements

- Node 20 or newer, pnpm 9 (`pnpm@9.6.0`), or Docker for the compose setup
- An RPC endpoint for the target chain
- A funded signer key

## Running it

```bash
pnpm install
cp .env.example .env     # fill in RPC + key
pnpm start               # the epoch keeper
```

`.env.example` documents every value. The keeper fails fast at boot if a required one is
missing, rather than starting and failing on the first write.

Docker compose runs the full set:

```bash
docker compose up -d
```

## The services

| Service | What it does |
| --- | --- |
| `keeper` | Drives the epoch lifecycle: create, open entry, settle, finalize. |
| `arb` | Price keeper. Trades the pool back toward the Pyth reference when it drifts. |
| `swapbot` | Round-trip trader. Generates fee flow without moving the peg. |
| `stakerbot` | Three wallets (UP, DOWN, RANGE) that mint an LP position and stake it each epoch, so the arena is never empty. |
| `gas-watchdog` | Tops the keeper's gas balance from a reserve. |
| `leaderboard-indexer` | The single writer behind the leaderboard. Folds chain events into a snapshot and publishes a ready-to-serve payload. |

The `-eurc` variants are the same services pointed at the cirBTC/EURC market.

## Scripts

```bash
pnpm start        # epoch keeper
pnpm arb          # price keeper
pnpm swapbot      # round-trip trader
pnpm stakerbot    # LP staking bots
pnpm test         # test suite (vitest)
pnpm typecheck    # tsc --noEmit
```

## Notes on a few deliberate choices

**The keeper key is restricted.** On a production deployment the contract owner sets a
separate keeper address via `setKeeper`. That key can run the lifecycle and nothing else:
it cannot pause, cannot rotate the keeper, cannot move funds. The owner key stays cold.

**The lifecycle is permissionless where it matters.** `startEpoch`, `endEpoch`, `sweep`
and `finalizeSettle` can be called by anyone. If the keeper stops, the protocol does not.

**Failure is bounded, not fatal.** A bad RPC window never kills the loop. The cursor stays
where it is and the same range is retried on the next pass, so a provider hiccup costs a
few seconds rather than an outage. Multiple RPC endpoints can be listed and are rotated on
error.

**The indexer is a single writer by design.** Leaderboard standings are computed once and
published, so every visitor reads the same numbers at the same block height. Computing
them per request would give two visitors two different answers and cost a chain scan each.

**Spending is capped.** The trading bots hold hard floors on their reserves and a sticky
spend cap, so a misconfiguration cannot drain a wallet.

## Testing

```bash
pnpm test
```

The suite covers the pure decision logic of each bot, the epoch state machine, the
leaderboard indexing engine, and the config loaders, all with injected clocks and scripted
RPC responses so nothing touches a real network.
