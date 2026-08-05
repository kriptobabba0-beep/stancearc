# Circle Smart Contract Platform - Fee Arena integration

`contracts-demo.mjs` demonstrates Fee Arena's integration with Circle's **Smart Contract Platform**
("Contracts" product) on **Arc testnet**, against the *same* `FeeArenaV3` contract the live app runs on
(`0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f`).

It makes two real Circle API calls (no SDK - Node built-in `fetch`/`crypto`/`fs` only):

1. **`POST /v1/w3s/contracts/import`** - registers the deployed contract in Circle's contract library.
   (Requires the import scope on your API key/account tier; the script skips gracefully on `403`.)
2. **`POST /v1/w3s/contracts/query`** - **reads live on-chain state through Circle's API** (a
   server-side read; no wallet, no gas): `currentEpochId()`, `USDC()`, `BASE()`, `bandBps()`, `keeper()`.

## Run

```bash
# From the repo root. Reads the Circle API key from the gitignored repo-root .env
# (a line of the form "TEST_API_KEY:<id>:<secret>", i.e. the Circle key pasted verbatim).
node scripts/circle/contracts-demo.mjs
```

Override the target with env vars: `CONTRACT_ADDRESS`, `CIRCLE_BLOCKCHAIN` (default `ARC-TESTNET`),
`CONTRACT_NAME`.

## Example output

```
2) Reading live on-chain state through Circle's API (no wallet, no gas):
   currentEpochId()   1003                                         (current epoch)
   USDC()             0x3600000000000000000000000000000000000000   (USDC (quote))
   BASE()             0xf0c4a4ce82a5746abaad9425360ab04fbba432bf   (cirBTC (base))
   bandBps()          20                                           (band (bps))
   keeper()           0xb964fc0bb9d4226935bb316e602c7e93455f359b   (keeper)
```

## Security

The Circle API key is a **Bearer secret**. It is read from the gitignored repo-root `.env` and is
**never printed**. Do **not** move it into the frontend or any `NEXT_PUBLIC_*` var - it is server-side
only. Rotate the key in the Circle Console after testing if it has been shared.
