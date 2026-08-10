# Fee Arena Keeper

An off-chain service that runs the Fee Arena **epoch lifecycle autonomously**, per
market, so epochs start and settle with no human in the loop.

Each tick it reads each market's current epoch, runs a pure decision function, and
executes **at most one** lifecycle action, then waits for the receipt before moving on.

## The lifecycle it drives

Per market (each market = its own `FeeArena` + Pyth feed):

```
createEpoch → openEntry → startEpoch(priceData) → endEpoch(priceData)
            → sweep(maxCount)… → finalizeSettle → (repeat)
```

The decision is a single pure function (`src/decide.ts`):

| State                                                              | Action     |
|--------------------------------------------------------------------|------------|
| `paused()` (any phase)                                             | `NONE`     |
| `currentEpochId === 0` (never created)                             | `CREATE`   |
| phase `Idle` (created, entry not opened)                           | `OPEN`     |
| phase `EntryOpen`, `now > entryCloseTime + maxStartDelay`          | `STUCK`    |
| phase `EntryOpen`, `entryCloseTime <= now <= +maxStartDelay`       | `START`    |
| phase `EntryOpen`, before `entryCloseTime`                         | `NONE`     |
| phase `Running`, `settlePrice18 == 0`, `now >= endTime`            | `END`      |
| phase `Running`, `settlePrice18 == 0`, before `endTime`            | `NONE`     |
| phase `Running`, resolved, `sweepCursor < stakedCount`             | `SWEEP`    |
| phase `Running`, resolved, `sweepCursor == stakedCount`            | `FINALIZE` |
| phase `Settled`                                                    | `CREATE`   |

**`STUCK`** is a terminal no-tx signal: the bounded start window was missed
(`now > entryCloseTime + maxStartDelay`), so `startEpoch` would revert
`StartDelayExceeded` on every tick. The keeper sends **no transaction**, logs the wedge
loudly, and the loop backs the market off — only the owner's `emergencySettle` can clear
it (see the runbook below). **`paused()`** short-circuits every phase to `NONE` so the
keeper never fires a guaranteed-revert crank while the contract is halted.

The external `PhaseView` collapses the internal 6-phase machine, so internal
`Running` / `Resolved` / `Swept` all surface as `Running`; the keeper distinguishes
them via `settlePrice18` (0 before `endEpoch`, set after) and `sweepCursor` vs
`stakedCount`. An empty epoch (`stakedCount == 0`) is resolved with `0 == 0`, so it
skips `SWEEP` straight to `FINALIZE`.

**`startEpoch` / `endEpoch`** each fetch a *fresh* signed Pyth update from Hermes and
pay the exact `Pyth.getUpdateFee` as the tx `value` (Pyth refunds any excess). A fresh
update is required before `endEpoch` so the update's `publishTime` is at/after the
epoch boundary (capture-pinning — see `../script/keeper/post-and-crank.md`).

**`sweep`** runs one `SWEEP_BATCH` batch per tick; successive ticks advance the cursor
until `cursor == stakedCount`, after which the decision yields `FINALIZE`.

Every write sets `maxFeePerGas` to the Arc gas floor (`GAS_FLOOR_GWEI`, default 20).
One action per market per tick + awaiting the receipt keeps the single keeper key
**nonce-safe** (no overlapping in-flight txs).

## v2 (pinned) markets

A market is **v1** by default. Add `"version":"v2"` (or the alias `"pinned":true`) to a
`KEEPER_MARKETS` entry to drive a **`FeeArenaV2`** arena. **v1 markets are unchanged** —
the version is per-market, so a mixed `KEEPER_MARKETS` runs v1 and v2 arenas side by side.

```jsonc
// a v2 market entry (subsidyPerEpoch is OPTIONAL — raw USDC, 6-dp)
{"id":"cirbtc","label":"cirBTC / USDC","arena":"0xAEB3…5C68",
 "feedId":"0xe62d…5b43","version":"v2","subsidyPerEpoch":"150000000"}
```

**What's different — the settle path only.** v2 changes **nothing** in
`createEpoch`/`openEntry`/`sweep`/`finalizeSettle`. It differs **only** at
`startEpoch`/`endEpoch`: the contract no longer trusts the cranker to choose the print. It
**pins** the posted Hermes blob's `publishTime` into a tight window chosen *by the
contract* — `startEpoch`: `[startTime, startTime + settleWindow]`; `endEpoch`:
`[endTime, endTime + settleWindow]` — via `getPinnedPrice → parsePriceFeedUpdates`, which
**reverts** (`PriceFeedNotFoundWithinRange`) unless the blob lands in the window.
`settleWindow` is owner-set (**default ~12 s**, hard-capped at 60 s). The on-chain
`startEpoch`/`endEpoch` **signature is unchanged** (`bytes[]`) — the keeper does **not**
pass min/max; the contract derives them from the epoch + `settleWindow`. The keeper auto-
detects the version, reads `settleWindow` from the arena, and posts a fresh blob (whose
`publishTime ≈ now`) **only while the wall clock sits inside the window**.

### ⚠️ The 12 s-window timing caveat

The pin window is **tight (~12 s)**, so timing is the whole game:

- **Poll faster than the window.** At the normal `POLL_INTERVAL_MS=15000` a single poll
  could step clean **over** the entire 12 s window and never post → the epoch **wedges**
  (only the owner's `emergencySettle` clears it). So **whenever ≥1 market is `v2`** the loop
  polls at `min(POLL_INTERVAL_MS, KEEPER_V2_POLL_INTERVAL_MS)` (default **4 s**), giving
  **~2–3 attempts across a 12 s window**. Lower it for a smaller `settleWindow`.
- **Attempt window, not the hard end.** A fresh blob's `publishTime ≈ now`, and a little
  time passes between fetching it and the tx mining. So the keeper only **ATTEMPTs** in
  `[endpointTime, endpointTime + settleWindow − KEEPER_V2_WINDOW_MARGIN_SEC]` (default
  margin **2 s** ⇒ ~10 s of attemptable runway). The pure gate is `decidePinnedWindow`
  (`src/decideV2.ts`):
  - **`WAIT`** — before the endpoint: no-op success, re-check on the next fast tick.
  - **`ATTEMPT`** — inside the safe window: fetch a fresh blob + post. An out-of-window
    revert (blob raced past the tail) is treated like any mined-revert → the tick fails and
    retries next tick with a **fresher** blob.
  - **`MISSED`** — past the safe tail: **no tx**, recorded as a **failure** so the breaker
    backs off and a **repeatedly-missed** window trips the `WEDGED` alert (a human/owner
    `emergencySettle` then clears it — see the runbook).

### Optional per-epoch subsidy (`fundSubsidy`)

v2 supports injecting **external value** into the pot so staking is **+EV**. Set a
per-market `subsidyPerEpoch` (or the global `KEEPER_V2_SUBSIDY_PER_EPOCH`), in **raw USDC
units** (6-dp; `150000000` = 150 USDC). When set **and** an owner key
(`KEEPER_OWNER_PRIVATE_KEY`) is configured, the keeper calls the **owner-only**
`fundSubsidy(epochId, amount)` **once per epoch** while the epoch's `phase < Resolved`:

- **Idempotent on-chain** — it reads the epoch's already-committed `subsidyUSDC` and only
  tops up the **remaining** amount toward the target, so a restart never double-funds and a
  partial prior fund is completed.
- **Capped** — clamped to the arena's `maxSubsidyPerEpoch` (150 USDC on the deployed v2
  arena). A configured value above the cap funds only up to the cap.
- **Self-approves** — issues a USDC `approve` to the arena first when the allowance is short.
- **Best-effort** — a subsidy hiccup is logged (`keeper.subsidy.*`), never wedges the
  lifecycle crank. **Off** when `subsidyPerEpoch`/the global is unset/0, or no owner key.
- The owner key is used **solely** for `fundSubsidy` (+ the wedge `emergencySettle`) — never
  for a normal lifecycle crank, which always signs with the restricted keeper key.

> Setting `subsidyPerEpoch` on a **v1** market is a hard config error (v1 has no
> `fundSubsidy`) — use `"version":"v2"` or remove it.

### Key separation (keeper / arb / conviction keys are distinct)

Three roles, **three different keys** — never share one:

- **Keeper key** (`KEEPER_PRIVATE_KEY`) — drives the lifecycle. It is the restricted
  least-privilege role and **cannot stake / take a position** in any epoch (it only cranks).
- **Arb key** (`KEEPER_ARB_PRIVATE_KEY`) — a **separate process** (`pnpm arb`) with its own
  wallet that trades the pool. Distinct so the two never collide on nonces.
- **Conviction / staking key** — the wallet that actually **stakes** in epochs. This is a
  **player** wallet, entirely separate from the keeper and arb keys.
- **Owner key** (`KEEPER_OWNER_PRIVATE_KEY`, optional) — used **only** for `fundSubsidy` and
  the wedge `emergencySettle`. **Mainnet:** keep it cold (see the recovery section).

Mixing these is a footgun: the keeper key staking would let the cranker take a position
(breaking the trust model), and sharing the arb key with the keeper would cause nonce races.

## Configure & run

```bash
corepack pnpm install      # or: pnpm install
cp .env.example .env       # then fill in the values
corepack pnpm start        # tsx src/index.ts — runs the poll loop
```

Other scripts:

```bash
corepack pnpm test         # vitest (decide + hermes + keeper)
corepack pnpm typecheck    # tsc --noEmit
```

### Environment (`.env`)

| Var                         | Required | Default                      | Notes |
|-----------------------------|----------|------------------------------|-------|
| `KEEPER_RPC_URL`            | yes¹     | —                            | Arc RPC; chainId auto-detected. |
| `KEEPER_RPC_URLS`           | no¹      | —                            | Comma-separated http(s) RPCs → viem `fallback([...])`. |
| `KEEPER_PRIVATE_KEY`        | yes²     | —                            | Inline 0x hex key (testnet / simple deployments). |
| `KEEPER_PRIVATE_KEY_FILE`   | yes²     | —                            | Path to a file containing the hex key (Docker secrets / secret managers). |
| `KEEPER_OWNER_PRIVATE_KEY`  | no       | — (recovery off)             | **Testnet only.** Owner key for wedge auto-recovery (`emergencySettle`). Unset ⇒ unchanged detect→STUCK behavior. See *Optional wedge auto-recovery*. |
| `PYTH_ADDRESS`              | yes      | —                            | Pyth pull-oracle contract. |
| `KEEPER_MARKETS`            | yes      | —                            | JSON `[{id,label,arena,feedId[,version\|pinned][,subsidyPerEpoch]}]`. `version` is `v1` (default) or `v2`; see *v2 (pinned) markets*. |
| `HERMES_URL`                | no       | `https://hermes.pyth.network`| Signed-update source. |
| `POLL_INTERVAL_MS`          | no       | `15000`                      | Per-tick interval. |
| `KEEPER_V2_POLL_INTERVAL_MS`| no       | `4000`                       | **v2 only.** Effective poll cadence whenever ≥1 market is `v2` (loop polls at `min(POLL_INTERVAL_MS, this)`). Must stay well under `settleWindow` (~12 s) or a poll could skip the whole pin window. |
| `KEEPER_V2_WINDOW_MARGIN_SEC`| no      | `2`                          | **v2 only.** Seconds shaved off the **tail** of the pin window so a fresh blob + fetch→mine latency still lands in-window. `0` = attempt up to the hard end. |
| `KEEPER_V2_SUBSIDY_PER_EPOCH`| no      | — (off)                      | **v2 only.** Global default per-epoch subsidy (raw USDC, 6-dp; `150000000` = 150 USDC). Requires `KEEPER_OWNER_PRIVATE_KEY`; clamped to the arena's `maxSubsidyPerEpoch`. Per-market `subsidyPerEpoch` overrides it. Never applies to `v1`. |
| `SWEEP_BATCH`               | no       | `50`                         | Positions per `sweep()`. |
| `GAS_FLOOR_GWEI`            | no       | `20`                         | `maxFeePerGas` floor. |
| `HERMES_TIMEOUT_MS`         | no       | `8000`                       | Abort a hung Hermes fetch so it can't wedge the loop. |
| `LOW_BALANCE_WEI`           | no       | `5e17` (0.5 native)          | Warn when the signer balance drops below this. |
| `BASE_BACKOFF_MS`           | no       | `5000`                       | First backoff step for a failing market (doubles). |
| `MAX_BACKOFF_MS`            | no       | `300000`                     | Cap on the backoff window. |
| `WEDGED_ALERT_THRESHOLD`    | no       | `5`                          | Consecutive failures before a loud WEDGED alert. |
| `KEEPER_HTTP_PORT`          | no       | `0` (off)                    | >0 starts the `/health` + `/metrics` server. |
| `KEEPER_HTTP_HOST`          | no       | `127.0.0.1`                  | Bind host for the health/metrics server. |
| `STALL_FACTOR`              | no       | `3`                          | DEGRADED if no tick within `STALL_FACTOR × POLL_INTERVAL_MS`. |
| `ALERT_WEBHOOK_URL`         | no       | — (off)                      | http(s) webhook for alerts (WEDGED / low balance). Unset ⇒ log-only. See *Alerting*. |
| `ALERT_HEARTBEAT_URL`       | no       | — (off)                      | http(s) dead-man's-switch ping URL (e.g. Healthchecks.io). Unset ⇒ no ping. |
| `ALERT_DEDUPE_WINDOW_MS`    | no       | `900000` (15 min)            | Suppress a repeat of the **same** alert key inside this window. |
| `ALERT_HEARTBEAT_INTERVAL_MS`| no      | `300000` (5 min)             | Minimum spacing between heartbeat pings. |
| `ALERT_TIMEOUT_MS`          | no       | `5000`                       | Abort a hung webhook POST so alerting can't wedge the loop. |

¹ Provide **either** `KEEPER_RPC_URL` (single) **or** `KEEPER_RPC_URLS` (comma-separated
list) — or both. With both set, the single URL is appended to the list (de-duped) so it's
never dropped. The list is wired into a viem `fallback([...])` transport (each `http(url,
{ timeout: 10_000 })`), so one RPC outage rotates to the next instead of stalling the
keeper; the first URL is used to probe the chainId.

² Set **exactly one** of `KEEPER_PRIVATE_KEY` or `KEEPER_PRIVATE_KEY_FILE` — both set
or neither set is a hard startup error.

### Reliability: backoff, balance, timeouts

- **Per-market circuit breaker.** A failing/`STUCK`/mined-but-reverted tick increments a
  per-market failure counter and skips the market for
  `min(BASE_BACKOFF_MS · 2^(failures-1), MAX_BACKOFF_MS)`; the next success resets it. A
  persistently broken market therefore can't be retried at full poll rate forever.
- **Wedged alert.** After `WEDGED_ALERT_THRESHOLD` consecutive failures the loop emits one
  loud `ALERT market=<id> WEDGED — operator action needed` line.
- **Revert detection.** Every crank's receipt `status` is inspected; a mined-but-reverted
  tx (`StartDelayExceeded` / `*PriceTooOld` / paused / stale price) is treated as a
  **failure**, not silently re-sent.
- **Low-balance warning.** Once per tick the signer's native balance is logged; below
  `LOW_BALANCE_WEI` a distinct `WARN low keeper balance` line fires (the keeper keeps
  running — it only warns).
- **Hermes timeout.** Each price fetch aborts after `HERMES_TIMEOUT_MS`, so a hung Hermes
  fails that one tick instead of blocking the whole sequential market loop.
- **Multi-RPC fallback.** Set `KEEPER_RPC_URLS` to a comma-separated list; the keeper uses
  a viem `fallback([...])` transport so a single RPC outage rotates to the next endpoint
  instead of stalling the loop.

### Observability: health, metrics & heartbeat

- **Heartbeat.** Each completed poll pass emits a `keeper.heartbeat` JSON line
  (`{msg, lastTickTs, ticks, markets:[…]}`). Alert on its **absence** (no heartbeat for
  > a few poll intervals) to catch a dead/hung process even without the HTTP endpoint.
- **`/health` (optional, off by default).** Set `KEEPER_HTTP_PORT` to start a `node:http`
  server (bound to `KEEPER_HTTP_HOST`, default loopback). `GET /health` returns
  `{ ok, lastTickTs, ageMs, stalled, markets:[{id, lastAction, lastActionTs,
  consecutiveFailures, wedged}] }` with HTTP **200** when healthy and **503** when
  **DEGRADED**. Degraded ⇔ any market is `wedged` **OR** the loop is stalled
  (`now − lastTickTs > STALL_FACTOR × POLL_INTERVAL_MS`). Wire it to an uptime monitor or
  a k8s liveness probe.
- **`/metrics` (same server).** `GET /metrics` returns Prometheus text exposition:
  counters `keeper_ticks_total`, `keeper_actions_total{action}`,
  `keeper_failures_total{market}`, `keeper_reverts_total`; gauges `keeper_balance_wei`,
  `keeper_market_wedged{market}`, `keeper_last_tick_timestamp`.
- The server binds to `127.0.0.1` by default (loopback only) and is closed on
  `SIGINT`/`SIGTERM`. The health/degraded math is a pure function (`computeHealth`,
  `src/health.ts`) — unit-tested without a socket.

### Alerting (dead-man's-switch)

By default the keeper only **logs** `ALERT … WEDGED` / `WARN low balance` — nothing reaches
a human. Set the alert URLs to actually get paged. Both channels are **OFF unless set**, so
the default is the unchanged log-only behavior. The same env vars drive **both** the
lifecycle keeper (`pnpm start`) and the arb bot (`pnpm arb`).

- **`ALERT_WEBHOOK_URL` — push alerts.** When set, the keeper POSTs a compact JSON body
  (`{ text, severity, key, title, ts, … }`) to this URL on:
  - **market WEDGED** — a market crossed `WEDGED_ALERT_THRESHOLD` consecutive failures
    (this **is** the repeated-failures trigger; `key="wedged:<id>"`, severity `critical`);
  - **low signer balance** — the native balance dropped below `LOW_BALANCE_WEI`
    (`key="lowbal:<addr>"`, severity `warn`).

  The body is **webhook-agnostic**: the single `text` line is what a Slack/Discord incoming
  webhook renders, a Telegram-bot `sendMessage` proxy forwards, or a generic log sink stores;
  the structured fields ride alongside for richer receivers.

- **`ALERT_HEARTBEAT_URL` — the dead-man's-switch.** When set, each completed poll pass pings
  this URL (rate-limited to `ALERT_HEARTBEAT_INTERVAL_MS`). Point it at a
  [Healthchecks.io](https://healthchecks.io)-style monitor (or any cron-monitor): the monitor
  alerts on the **absence** of the ping, so a dead/hung process that **cannot send its own
  WEDGED alert** is still caught externally. This is the failure mode the in-process alert
  can never cover.

- **Deduped / rate-limited.** The same alert `key` is re-sent at most once per
  `ALERT_DEDUPE_WINDOW_MS` (default 15 min), so a persistently wedged market doesn't spam the
  webhook every tick. A **failed** delivery does **not** arm the cooldown — a transient
  webhook outage is retried on the next tick.

- **Non-blocking + crash-safe.** Every dispatch is fire-and-forget and bounded by
  `ALERT_TIMEOUT_MS`; a rejecting/timed-out/non-2xx webhook is **swallowed and logged**
  (`alert.delivery.error` / `alert.delivery.failed`) and can **never** throw out of the crank
  loop. The dedupe/rate-limit decision is a pure function (`shouldDispatch`, `src/alert.ts`)
  unit-tested with a mocked `fetch` — no socket.

> The alert URLs may embed a token (Slack/Telegram/Healthchecks). They are **never logged**;
> the `keeper.start` / `arb.start` line reports only **whether** each channel is wired. Keep
> them out of version control alongside the keys.

## Operating & Security

### Which key to use — NEVER the owner key in production

- **Testnet:** the contract **owner** key is fine — it can do everything.
- **Mainnet / any real-value environment: NEVER use the owner/multisig key here.** Use
  the **restricted keeper key** set via `FeeArena.setKeeper(addr)`. That key is
  least-privilege: it can only drive the lifecycle (`createEpoch` + `openEntry`). It
  cannot pause, run the emergency settle, rotate the keeper, or move funds. Keep the
  owner key cold. (`startEpoch` / `endEpoch` / `sweep` / `finalizeSettle` are
  permissionless on the contract, so the restricted keeper can still post prices, sweep,
  and finalize.)

### Key handling — `KEEPER_PRIVATE_KEY` vs `KEEPER_PRIVATE_KEY_FILE`

Set **exactly one**:

- **`KEEPER_PRIVATE_KEY`** — inline 0x hex. Fine for local/testnet; keep the `.env` off
  version control.
- **`KEEPER_PRIVATE_KEY_FILE`** — path to a file that contains the hex key (trimmed before
  validation). Use this when:
  - A Docker secret is mounted at a path (e.g. `/run/secrets/keeper_key`) — the key never
    appears in the process environment.
  - A secret manager (Vault, AWS Secrets Manager, GCP Secret Manager) writes the key to a
    tmpfs path at container start.
  - A bare-metal systemd deployment stores the key in a `chmod 400` file and references it
    via `EnvironmentFile`-adjacent mounting.

**Mainnet note:** full KMS / encrypted-keystore / HSM support (cloud KMS, Foundry
`--account` keystores) is a documented mainnet hardening item — the file source covers the
common "secret injected as a mounted file" pattern today. Do **not** commit the plaintext
key to version control or paste it in `docker-compose.yml` env blocks.

### If the keeper key is compromised

- The owner **rotates it instantly**: `FeeArena.setKeeper(newAddr)` (or
  `setKeeper(address(0))` to fully halt keeper-only cranks). Because the keeper is a
  least-privilege role, a compromised key can be revoked without touching funds or the
  owner key.

### Wedged-epoch runbook

A missed start window surfaces as the `STUCK` action and an
`ALERT market=<id> WEDGED` log line; a market that keeps reverting trips the same alert
after `WEDGED_ALERT_THRESHOLD` failures. By default the keeper cannot self-heal these — it
will only back off. The operator clears them with the owner key:

1. Confirm the epoch is wedged (start window missed, or a persistent revert) from the
   `ALERT … WEDGED` / `STUCK` logs.
2. Wait until `endTime + GRACE`, then call owner `emergencySettle(epochId, range)` — see
   `../script/keeper/post-and-crank.md` "Emergency fallback".
3. If the cause is a compromised/buggy keeper, also rotate via `setKeeper(newAddr)`.

> **The real fix is uptime, not the owner key.** A wedge only happens when the keeper is
> down across a start/settle window — so run it as a durable, auto-restarting service (see
> **Process** below: `docker compose` `restart: unless-stopped`, the pm2 `autorestart`, or
> the systemd `Restart=always` unit). Those survive host reboots and crashes, which is what
> prevents the wedge in the first place.

### Optional wedge auto-recovery — `KEEPER_OWNER_PRIVATE_KEY` (testnet convenience)

For an **unattended testnet** where you can't guarantee uptime (e.g. the keeper runs on a
PC that gets shut down overnight), the keeper can self-heal a wedge if you give it the
**owner** key via the optional `KEEPER_OWNER_PRIVATE_KEY` env var:

- **Unset (default):** behavior is **unchanged** — a wedge is detected, logged, and
  surfaced as `STUCK` / `ALERT … WEDGED` for a human to clear. Nothing else happens.
- **Set:** when the keeper detects a **genuinely wedged** epoch — the same condition it
  flags as `STUCK`: an unresolved (`settlePrice18 == 0`) `EntryOpen` epoch whose start
  window has irrecoverably lapsed — **and** the on-chain `GRACE` window has elapsed
  (`now > endTime + GRACE`, 600 s), it calls `emergencySettle(epochId, RANGE)` with a
  **separate owner wallet**, logs `RECOVERED market=<id> … txHash=…`, and resumes normal
  cranking on the next tick (the cleared epoch → `Settled` → `createEpoch`).

Safety properties (all enforced in code + covered by tests):

- The owner key is used **solely** for `emergencySettle`. Every normal crank
  (`createEpoch` / `openEntry` / `startEpoch` / `endEpoch` / `sweep` / `finalizeSettle`)
  still signs with the restricted **keeper** key.
- Recovery is **impossible to trigger on a healthy epoch** — it's gated on the exact
  `STUCK` wedge signal **and** re-checks the contract's own `emergencySettle`
  preconditions (`settlePrice18 == 0`, phase `EntryOpen`/`Running`), so a resolved or
  normal epoch is never touched.
- It **respects `GRACE`**: before `endTime + GRACE` it logs and backs off (per-market
  backoff) instead of spamming a tx that would revert `GraceNotElapsed`.

> **MAINNET CAVEAT:** an always-loaded hot owner key is a **testnet** operational
> convenience only. On mainnet, keep the owner key **cold** and run `emergencySettle`
> **manually / via multisig** — do **not** set `KEEPER_OWNER_PRIVATE_KEY` in production.

### Trust model

A malicious or buggy keeper can **only grief epoch liveness** — e.g. withhold
`openEntry`/`createEpoch`, or stall the lifecycle. It can **never bias outcomes, capture
a favourable price, or move funds** (price capture is oracle-driven and bounded by the
start window; payouts are deterministic), and it is **owner-revocable** at any time via
`setKeeper`.

### Process (supervision artifacts)

Run as a **long-lived process** with auto-restart. Three production-ready options are
committed in this directory:

| Artifact | Method | Notes |
|---|---|---|
| `Dockerfile` + `docker-compose.yml` | Docker / Docker Compose | Preferred; `restart: unless-stopped`, HEALTHCHECK. |
| `ecosystem.config.cjs` | pm2 | Non-Docker; `autorestart: true`, 20-restart cap. |
| `deploy/fee-arena-keeper.service` | systemd | Bare-metal Linux; `Restart=always`. |

**Docker Compose (recommended):**

```bash
cp .env.example .env   # fill in the values (or set KEEPER_PRIVATE_KEY_FILE for secrets)
docker compose up -d   # builds the image and starts the keeper
docker compose logs -f # tail logs
```

**pm2:**

```bash
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup   # persist across reboots
pm2 logs fee-arena-keeper
```

**systemd:**

```bash
sudo cp deploy/fee-arena-keeper.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fee-arena-keeper
sudo journalctl -fu fee-arena-keeper
```

Fund the signer with native gas (every crank + Pyth update fee for start/end — watch for
`WARN low keeper balance`). Logs are one JSON object per line — easy to ship to a log
aggregator. The loop never throws out of a tick; per-market failures are logged, backed
off, and retried.

---

## Operational runbooks

Operator-facing procedures for running the keeper unattended. The keeper is the **sole
driver** of a live financial protocol — if it stalls or runs dry, epochs freeze and the
on-chain `emergencySettle` (owner-only) is the backstop. Goal: keep it running, **detect**
failures, and have a documented recovery path.

### Deploy + run

1. **Provision a signer.**
   - *Testnet:* the contract **owner** key is fine.
   - *Mainnet / real value:* **NEVER the owner key.** Mint a dedicated keeper EOA and grant
     it the role on-chain: owner calls `FeeArena.setKeeper(<keeperAddr>)` on **each** arena
     (ETH + BTC). The keeper role is least-privilege (lifecycle only; cannot pause, settle
     the emergency fallback, rotate the keeper, or move funds). Source the key from a
     **KMS/HSM or an encrypted keystore** unlocked at process start — not a plaintext
     `.env`. Keep the owner key cold.
2. **Fund the signer** with native gas (every crank) + a little extra for Pyth update fees
   (start/end). Keep it above `LOW_BALANCE_WEI` (default 0.5 native ≈ ~50 cranks).
3. **Configure** `.env` from `.env.example`: `KEEPER_RPC_URL` **or** `KEEPER_RPC_URLS`
   (2–3 endpoints recommended for fallback), `KEEPER_PRIVATE_KEY`, `PYTH_ADDRESS`,
   `KEEPER_MARKETS` (the live arenas), and — to expose health — `KEEPER_HTTP_PORT`
   (e.g. `9464`) + `STALL_FACTOR`.
4. **Run under a process manager** so it restarts on crash/reboot (supervision artifacts
   are committed — see the "Process" section above and the source files):
   - **Docker Compose (recommended):** `docker compose up -d` (uses `Dockerfile` +
     `docker-compose.yml`; `restart: unless-stopped`; HEALTHCHECK on `/health`).
     For secret injection set `KEEPER_PRIVATE_KEY_FILE` in `.env` and mount the key file.
   - **pm2:** `pm2 start ecosystem.config.cjs` then `pm2 save && pm2 startup`.
     Configured with `autorestart: true`, `max_restarts: 20`, `restart_delay: 5000`.
   - **systemd:** `sudo cp deploy/fee-arena-keeper.service /etc/systemd/system/` then
     `sudo systemctl enable --now fee-arena-keeper`. `Restart=always`, `RestartSec=5`,
     `EnvironmentFile` pointing to `.env`, non-root `User=keeper`.
   - **Liveness probe:** `GET /health` (expects 200; 503 = degraded → restart/alert).
     Set `KEEPER_HTTP_PORT` (e.g. `9464`) to enable the server.
5. **Confirm startup:** look for the `keeper.start` line (signer, chainId, markets, rpcUrls),
   then a recurring `keeper.heartbeat` each poll pass. If `KEEPER_HTTP_PORT` is set,
   `curl localhost:<port>/health` should return `200 {"ok":true,...}`.

### Monitor

Logs are one JSON object per line. Alert on these **exact** patterns:

| Signal | Match | Meaning / action |
|--------|-------|------------------|
| **Wedged market** | log line containing `ALERT market=<id> WEDGED` | A market crossed `WEDGED_ALERT_THRESHOLD` consecutive failures (or hit a missed start window). → **Recover** below. |
| **Low balance** | `WARN low keeper balance` | Signer below `LOW_BALANCE_WEI`. → top up before it runs dry. |
| **No heartbeat** | **absence** of `keeper.heartbeat` for > a few poll intervals | Process dead/hung. → restart (it self-recovers). |

Plus the endpoints (when `KEEPER_HTTP_PORT` is set):

- **`GET /health`** → **200** healthy, **503** degraded (any `wedged` market **or** stalled
  loop). Use as a k8s liveness probe / uptime-monitor target.
- **`GET /metrics`** → Prometheus: `keeper_ticks_total`, `keeper_actions_total{action}`,
  `keeper_failures_total{market}`, `keeper_reverts_total`, `keeper_balance_wei`,
  `keeper_market_wedged{market}`, `keeper_last_tick_timestamp`. Suggested alerts:
  `keeper_market_wedged > 0`, `rate(keeper_failures_total[10m]) > 0`, `keeper_balance_wei`
  below your floor, and `time() - keeper_last_tick_timestamp/1000 >` a few intervals.

### Recover

- **Wedged epoch** (missed start window → `STUCK`, or persistent reverts → `WEDGED`):
  by default the keeper only backs off and the owner clears it manually — confirm from the
  `ALERT … WEDGED` / `STUCK` logs, wait until `endTime + GRACE`, then call owner
  `emergencySettle(epochId, range)` (see `../script/keeper/post-and-crank.md` "Emergency
  fallback"). If a buggy/compromised keeper caused it, also rotate (below). **On testnet**,
  set `KEEPER_OWNER_PRIVATE_KEY` to have the keeper auto-run `emergencySettle` once
  `endTime + GRACE` passes (logs `RECOVERED market=<id> … txHash=…`) — see *Optional wedge
  auto-recovery* above. The durable fix is uptime (run it as an auto-restarting service).
- **Dead/stalled keeper** (no heartbeat, `/health` 503-stalled): just **restart** the
  process — the keeper is **stateless across restarts** and re-derives every market's
  position from chain state, resuming the lifecycle automatically. No manual catch-up.
- **Compromised keeper key:** owner rotates instantly — `FeeArena.setKeeper(<newAddr>)`
  (or `setKeeper(address(0))` to fully halt keeper-only cranks). Because the role is
  least-privilege and owner-revocable, no funds or the owner key are exposed. Then point
  the keeper process at the new key and restart.
- **Low balance:** top up the signer's native balance; the `WARN` clears on the next tick
  (the keeper never stops for low balance — it only warns).
- **RPC outage:** with `KEEPER_RPC_URLS` set, the `fallback([...])` transport rotates to
  the next endpoint automatically — no action needed. With a single RPC, point
  `KEEPER_RPC_URL` at a healthy endpoint and restart.

### Emergency

- **`pause()`** (owner): halts new stakes and short-circuits the keeper to `NONE` in every
  phase (the payable/settlement cranks revert under `whenNotPaused`, so the keeper takes no
  action while paused). Use to freeze the protocol during an incident. `unpause()` resumes
  normal lifecycle driving.
- **Emergency settle escape hatch:** for any epoch the keeper can't advance (wedged start
  window, or a halt that leaves an in-flight epoch), the owner settles it directly via
  `emergencySettle(epochId, range)` after `endTime + GRACE`. This is the **only** backstop
  if the keeper is down — keep the owner key available (cold, but reachable) and the
  procedure (`../script/keeper/post-and-crank.md`) on hand.
