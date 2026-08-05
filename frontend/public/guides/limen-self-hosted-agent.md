# Run your own Limen agent, 24/7 - the complete beginner guide

This guide walks you through running your **own autonomous Limen agent**: a small program
that watches Limen Finance epochs around the clock and enters positions for you - using
**your own money, in your own Circle Agent Wallet, under rules you set**. No prior
experience with command lines, wallets, or coding is assumed. Budget about 30 minutes.

---

## What you are about to set up (in plain words)

- **The agent** is a program you run on your own computer (or any server). It is the exact
  same program that powers Limen's in-house agent.
- **Its money** lives in a **Circle Agent Wallet** - a special wallet created by Circle
  where transactions need BOTH your login session AND Circle's co-signature (this is
  called 2-of-2 MPC). Limen never sees or controls this wallet. The executor key on your
  machine only ever holds small, mandate-capped amounts - the treasury itself always
  needs Circle's co-signature to move.
- **Its rules** are your *mandate*: which views it may take (UP / DOWN / RANGE), how
  confident the odds must be before it acts, the most it may spend per entry, and an
  expiry date after which it refuses to act at all.
- **What it does, each epoch**: checks the market -> estimates the odds -> if your rules are
  satisfied, draws *just enough* money from your Agent Wallet -> enters the epoch -> your
  position and any fee share come back to your wallet. Then it waits for the next epoch.

> **Do I need to add liquidity to the pool first?** No - the agent handles this itself.
> On its first run it checks whether its wallet owns an LP (liquidity) position, and if it
> doesn't, it automatically creates one using the budget you gave it. Entering a Stance
> epoch requires an LP position, and the agent takes care of that whole step. The same LP
> position is then reused epoch after epoch.

> **This is Arc TESTNET.** Everything uses test funds from a faucet. Nothing here is real
> money, which makes it the perfect place to try an autonomous agent.

---

## Step 0 - Install the two tools you need (one time)

1. **Node.js** (version 18 or newer) - the runtime that runs the agent.
   - Download from https://nodejs.org (choose "LTS") and install it like any app.
   - Check it worked: open a terminal (Windows: press Start, type `cmd`; Mac: open
     Terminal) and type `node -v`. You should see something like `v20.x.x`.
2. **Git** - used to download the Limen code.
   - Download from https://git-scm.com/downloads and install with the defaults.
   - Check: `git --version` in the terminal.

---

## Step 1 - Create your Circle Agent Wallet

In your terminal, run these one at a time:

```
npm install -g @circle-fin/cli
```

This installs Circle's official command-line tool.

```
circle wallet login your@email.com --type agent --init
```

Replace `your@email.com` with your real email. Circle sends you a **one-time code** and
the command prints a **request id**. Now confirm the login:

```
circle wallet login --request <the-request-id> --otp <the-code-from-your-email>
```

You are now logged in on this computer. **The session lasts 7 days** - after that the
agent can still sign its own transactions, but drawing fresh budget from your Agent Wallet
pauses until you log in again (one command, same as above). A weekly re-login keeps a
long-running agent fully autonomous. Create the
wallet:

```
circle wallet create
```

This provisions your Agent Wallet across Circle's supported networks, including
**Arc Testnet**. To see your wallet's address at any time:

```
circle wallet list --chain ARC-TESTNET --type agent
```

Copy the Arc Testnet address (it starts with `0x...`) - you will need it twice below.

---

## Step 2 - Fund the wallet (test money)

The agent needs two things in its Agent Wallet:

1. **USDC** - this is both its entry budget and gas (on Arc, gas IS USDC). The CLI has a
   built-in faucet - one command drops 20 test USDC straight into the wallet:

   ```
   circle wallet fund --address <your-agent-wallet-address> --chain ARC-TESTNET
   ```

   Run it twice if you want more headroom.
2. **A little cirBTC** - the other half of the LP position it will create. The same
   faucet page provides cirBTC on Arc Testnet. Even 0.001 cirBTC is enough.

> Why both tokens? A Limen LP position is a pair (cirBTC + USDC). The agent creates its
> position once using a small amount of each, then reuses it every epoch.

---

## Step 3 - Download the Limen code

```
git clone https://github.com/kriptobabba0-beep/fee-arena.git limen
cd limen/keeper
npm install
```

This downloads the project and installs the agent's dependencies (a few minutes).

---

## Step 4 - Configure your agent

1. Go to **limen.finance/agent** in your browser.
2. In the **Autopilot** panel, set your mandate: which views to allow, the odds floor,
   and your budget cap per entry.
3. In the **Self-hosted** section, press **"Copy my agent config"**.
4. In the `limen/keeper` folder, create a file named exactly `.env` and paste what you
   copied into it. (Any text editor works - Notepad is fine. Make sure the file is not
   saved as `.env.txt`.)
5. The pasted config has **two placeholders you must fill in**:

   - `LIMEN_AGENT_WALLET_ADDRESS=` -> your Agent Wallet's Arc Testnet address from Step 1.
   - `LIMEN_AGENT_PRIVATE_KEY=` -> a **fresh throwaway key** for the agent's on-chain
     executor. Generate one safely with this command:

     ```
     node -e "console.log('0x'+require('crypto').randomBytes(32).toString('hex'))"
     ```

     Paste the printed value after the `=`. **Never use the key of a wallet you care
     about.** This executor key starts empty - the agent funds it from your Agent Wallet,
     capped by your mandate, exactly when needed.

> **What the mandate enforces, mechanically:** the agent will never take a view you
> disallowed, never act below your odds floor, never draw more than one budget-cap per
> entry from your Agent Wallet, never enter the same epoch twice, and it stops forever
> when the expiry passes (7 days from when you copied the config - copy a fresh config to
> renew).

---

## Step 5 - Run it

From the `limen/keeper` folder:

```
npx tsx src/agent.ts
```

You will see log lines like these:

- `agent.start` - your configuration, echoed back.
- `agent.decision ... "act":false, "reason":"..."` - it checked and chose NOT to enter, with
  the reason (entry closed, odds below your floor, already entered, and so on). This is
  most lines, and that is healthy.
- `agent.funding.request` / `agent.funding.landed` - it drew funds from your Agent Wallet
  (you will see these on the first run, and rarely after).
- `agent.mint` - first run only: it created its LP position.
- `agent.stake` - it entered an epoch, with the side and the transaction hash.

**To stop it:** press `Ctrl-C` in the terminal. Nothing else is needed - no positions are
lost; anything staked settles normally and returns to the wallet.

**To keep it running after you close the terminal** (optional, for a server): use any
process keeper, e.g. `npm install -g pm2` then `pm2 start "npx tsx src/agent.ts" --name limen-agent`.

---

## Checking on your agent

- **Fee shares & positions:** open limen.finance with the agent's executor address, or ask
  the in-app copilot "what can this wallet claim?" - or simply watch the `agent.stake`
  transaction hashes on https://testnet.arcscan.app.
- **Wallet balance:** `circle wallet list --chain ARC-TESTNET --type agent` any time.
- **Every decision is in the log** - the agent explains each "no". The audit trail is the
  product.

---

## Frequently asked questions

**Is my money safe from Limen?** Limen never has your keys. The Agent Wallet needs your
Circle login session to move anything, and the executor key exists only on your machine.

**What is the most it can lose?** Only what you put in the Agent Wallet - and per epoch,
at most the fees at stake for one entry. In Limen, a view that does not qualify forfeits
that epoch's *fees only*; the LP principal itself is never staked or taken. (The LP
position still carries normal market-price and impermanent-loss risk, exactly as it would
outside Stance.)

**Can I change the rules later?** Yes - edit the numbers in `.env` (or copy a fresh
config from the site) and restart the agent. Restarting is always safe.

**It says "insufficient gas - fund the agent wallet..."** - your Agent Wallet has run out
of USDC. Top it up from the faucet; the agent recovers by itself on the next check.

**It proposes nothing for hours.** On the cirBTC/EURC market, epochs last 12 hours - one
decision per epoch is normal. The cirBTC/USDC market decides every ~4 minutes.

---

*Estimates, not financial advice. Arc testnet - test funds only. The agent is a
statistical estimator operating strictly inside your mandate.*
