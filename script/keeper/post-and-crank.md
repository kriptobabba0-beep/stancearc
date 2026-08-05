# Keeper recipe - post price & crank an epoch with real Pyth prices

This recipe shows an operator how to start and end a Fee Arena epoch on Arc testnet
using a real signed ETH/USD price update fetched from Hermes (the Pyth off-chain
aggregator).  The same flow is available in the frontend admin console via "Post price
& startEpoch / endEpoch" buttons, which execute it with a browser wallet.

## Prerequisites

- `cast` (Foundry) and `jq` installed.
- Environment variables set:

  | Variable | Value |
  |---|---|
  | `FEE_ARENA` | deployed FeeArena contract address |
  | `PYTH` | `0x2880aB155794e7179c9eE2e38200202908C17B43` (Arc testnet Pyth contract) |
  | `ARC_RPC_URL` | e.g. `https://rpc.testnet.arc.network` |

- A keystore account named `fee-arena-demo` imported once via `make import-key`
  (keeps the private key off `argv` and the shell environment).

## Flow

```bash
# Env: FEE_ARENA, PYTH (=0x2880aB155794e7179c9eE2e38200202908C17B43), ARC_RPC_URL,
# and an imported keystore account (see `make import-key`).
ETH_USD=ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace

# 1. Fetch the latest signed ETH/USD update from Hermes (hex blob).
UPDATE=$(curl -s "https://hermes.pyth.network/v2/updates/price/latest?ids[]=$ETH_USD&encoding=hex" | jq -r '.binary.data[0]')

# 2. Compute the Pyth update fee for that blob.
FEE=$(cast call $PYTH "getUpdateFee(bytes[])(uint256)" "[0x$UPDATE]" --rpc-url $ARC_RPC_URL)

# 3a. Start the epoch (posts the price + pays the fee; excess refunded). Must be after entryClose.
cast send $FEE_ARENA "startEpoch(bytes[])" "[0x$UPDATE]" --value $FEE --rpc-url $ARC_RPC_URL --account fee-arena-demo

# 3b. End the epoch (fetch a FRESH update first so publishTime >= endTime). Must be after endTime.
UPDATE=$(curl -s "https://hermes.pyth.network/v2/updates/price/latest?ids[]=$ETH_USD&encoding=hex" | jq -r '.binary.data[0]')
FEE=$(cast call $PYTH "getUpdateFee(bytes[])(uint256)" "[0x$UPDATE]" --rpc-url $ARC_RPC_URL)
cast send $FEE_ARENA "endEpoch(bytes[])" "[0x$UPDATE]" --value $FEE --rpc-url $ARC_RPC_URL --account fee-arena-demo
```

## Why a fresh update before `endEpoch`?

`PythPriceOracle` uses **capture-pinning**: it requires the Pyth update's `publishTime`
to be at or after the epoch boundary timestamp.  The update fetched for `startEpoch`
will have a `publishTime` near `startTime`; it will be stale by the time `endTime`
arrives, so it would be rejected.  Always re-fetch immediately before calling
`endEpoch`.

## What determines the outcome?

The outcome is the **real ETH/USD market price delta** against a fixed percentage band.
`endEpoch` compares the end price (pinned at `endTime`) to the start price (pinned at
`startTime`):

- `endPrice > startPrice * (1 + band)` → **UP** wins.
- `endPrice < startPrice * (1 - band)` → **DOWN** wins.
- Otherwise → **RANGE** wins.

No admin can override this; the signed Pyth price is the sole source of truth.

## Paying the Pyth update fee

Both `startEpoch` and `endEpoch` are `payable`.  Pass at least the fee returned by
`getUpdateFee`; any excess is refunded to the caller by Pyth.  The `cast call` in step 2
queries the exact fee so you can pass `--value $FEE` with no overpayment.

## Emergency fallback - `emergencySettle`

If the keeper never posts the end price (network outage, lost key, etc.) and the epoch
could not resolve normally, the contract owner can call:

```bash
cast send $FEE_ARENA "emergencySettle(uint64,uint8)" <EPOCH_ID> <RANGE=3> \
  --rpc-url $ARC_RPC_URL --account fee-arena-demo
```

This is a **liveness fallback only**.  Conditions for it to succeed:

- The epoch **never resolved** (i.e. `endEpoch` never succeeded - `settlePrice18 == 0`).
- The current time is past `endTime + GRACE`.
- The contract is **not paused**.

It **pays no one** for that epoch: the supplied side (`resolution`) is a cosmetic label
only - the entire pot is rolled 100% into the next epoch regardless of which side is
passed.  `claim` will revert for that epoch; stakers can still `unstake` their NFTs.
It cannot touch an epoch that already has a determined winner (`settlePrice18 != 0`).

Enum reference: `NONE=0, UP=1, DOWN=2, RANGE=3` - note RANGE is **3**, not 2.

Use it only as a last resort - normal resolution always goes through the real Pyth price.

## After cranking

Continue with the standard sweep + settle + claim flow:

```bash
cast send $FEE_ARENA "sweep(uint256)" 64        --rpc-url $ARC_RPC_URL --account fee-arena-demo
cast send $FEE_ARENA "finalizeSettle()"         --rpc-url $ARC_RPC_URL --account fee-arena-demo
cast send $FEE_ARENA "claim(uint256,uint256)" <EPOCH_ID> <TOKEN_ID> \
  --rpc-url $ARC_RPC_URL --account fee-arena-demo
```
