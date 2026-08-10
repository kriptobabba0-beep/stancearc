# Contracts

Solidity for the fee arena and its price oracles. The DEX itself is an unmodified Uniswap
V3 deployment, so nothing here reimplements swapping or liquidity.

## The idea in one paragraph

A liquidity provider stakes their Uniswap V3 position NFT into the arena for one epoch and
picks a side. The fees the position collects while it is staked become their contribution.
At settlement a Pyth price decides which side was right, and the contributions of the
losing sides are redistributed to the winners in proportion to what each of them
contributed. The position itself is escrowed and returned; only the fees are ever at
stake.

## Files

| File | Role |
| --- | --- |
| `FeeArenaV3.sol` | The live arena. Epoch lifecycle, staking, settlement, claims. |
| `FeeArena.sol` | The first version, kept for reference. |
| `FeeArenaV2*.sol` | A second iteration, split across staking, settlement and types. Not the live product. |
| `oracles/PythPriceOracle*.sol` | Adapters that read a Pyth feed and expose it as a price. |
| `oracles/CompositePythOracle.sol` | Crosses two feeds, used for the EUR-denominated market. |
| `interfaces/` | Interfaces for the arena, the oracle, and the Uniswap pieces it touches. |
| `mocks/` | Test doubles: a settable oracle, WETH9, plain ERC-20s. |

## Epoch lifecycle

```
Idle -> EntryOpen -> Locked -> Settling -> Settled
```

Entry is open for a fixed window, then the epoch locks and no new stakes are accepted.
After the settlement time a price is posted and positions are processed in batches;
winners can then claim. Sides are UP, DOWN and RANGE, where RANGE means the price stayed
inside a band measured in basis points from the entry price.

## Reading the important parts

- `stakeWithSide` is the entry point for a provider. It takes the position, the side, the
  price the provider expects, and a maximum deviation from it. If the real price has moved
  further than that between the click and the block, the call reverts rather than entering
  at a price the provider did not agree to.
- `previewClaim` answers "what would I get" for a single position without a write. It is
  bounded and safe to call from a UI.
- `claim` pays a winner their own contribution back plus a share of the pot, proportional
  to their contribution against the total contribution of all winners.
- Anything that could strand funds has a permissionless escape. `startEpoch`, `endEpoch`,
  `sweep` and `finalizeSettle` can be called by anyone, so a stalled keeper cannot freeze
  the protocol.

## Building and testing

Foundry is required. The workspace compiles two Solidity families in one build: the
Uniswap V3 fork is pinned to 0.7.6 while all first-party code targets ^0.8.20, so
`auto_detect_solc` is enabled and `evm_version` is set to `paris`, the newest target both
families accept.

```bash
git submodule update --init --recursive
forge build
forge test
```

That is 63 test files and 364 tests, invariant suites included.

The whole protocol can be exercised locally with no key, no funds and no network:

```bash
make demo-sim      # deploys everything and runs a full epoch in a fresh in-memory EVM
```

`make deploy-sim` simulates the deployment script instead. It reads `PRIVATE_KEY` from
`.env`, so copy `.env.example` across and put any well-formed 32-byte hex value there; the
simulation never broadcasts, so the key only has to derive an address.

`make help` lists the rest, including the Arc testnet deployment targets.

## A note on the OpenZeppelin versions

Two OpenZeppelin trees are vendored, 3.4 for the 0.7.6 Uniswap code and 4.9 for
first-party code, because both import the same paths at different versions and a single
global remapping cannot serve both. The vendored periphery imports were repointed to an
`@oz3/` prefix; see `remappings.txt`.

## Security

Slither runs in CI (`.github/workflows/slither.yml`) with the configuration in
`slither.config.json`. The contracts have not had an external audit. This is a testnet
deployment and the tokens carry no monetary value.
