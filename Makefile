-include .env

# Encrypted keystore account used to SIGN the cast price-cranks below.
# One-time setup:  make import-key   (imports a THROWAWAY testnet key into ~/.foundry/keystores)
# Using --account keeps the private key OFF the command line (argv) and OUT of the env.
CAST_ACCOUNT ?= fee-arena-demo

.PHONY: help build test fmt import-key \
        deploy-mocks create-pool deploy-arena deploy-demo \
        deploy-all demo-sim deploy-sim \
        set-keeper \
        force-up force-down force-range

help:
	@echo "Fee Arena V0 - make targets"
	@echo "  make build         - forge build (dual-solc 0.7.6 + 0.8.20)"
	@echo "  make test          - run the full forge test suite"
	@echo "  make fmt           - forge fmt"
	@echo ""
	@echo "  -- local simulation (no funds, no key, no --broadcast) --"
	@echo "  make demo-sim      - run the full DemoFlow end-to-end in a fresh in-memory EVM"
	@echo "  make deploy-sim    - run the full Deploy (mocks+V3+pool+arena) in simulation"
	@echo ""
	@echo "  -- one-time signer setup (keystore; keeps the key off argv + env) --"
	@echo "  make import-key    - import a THROWAWAY testnet key as keystore account '$(CAST_ACCOUNT)'"
	@echo ""
	@echo "  -- Arc testnet broadcast (deploy-* read PRIVATE_KEY from .env, scoped to those recipes only) --"
	@echo "  make deploy-mocks  - deploy WETH9 + MockPriceOracle to Arc testnet"
	@echo "  make create-pool   - create+init the WETH/USDC V3 pool"
	@echo "  make deploy-arena  - deploy FeeArena wired with demo timings"
	@echo "  make deploy-demo   - full deploy in ONE script (mocks -> V3 -> pool -> arena)"
	@echo "  make deploy-all    - step-by-step chain: deploy-mocks create-pool deploy-arena"
	@echo ""
	@echo "  -- keeper role wiring (requires KEEPER_ADDRESS + FEE_ARENA_ADDRESS in .env) --"
	@echo "  make set-keeper    - call FeeArena.setKeeper(KEEPER_ADDRESS) on-chain"
	@echo ""
	@echo "  -- price cranks (sign via keystore account '$(CAST_ACCOUNT)'; run 'make import-key' first) --"
	@echo "  make force-up      - MockPriceOracle.setPrice to a +band (UP) preset"
	@echo "  make force-down    - setPrice to a -band (DOWN) preset"
	@echo "  make force-range   - setPrice back to start (RANGE) preset"
	@echo ""
	@echo "  SECURITY: use a THROWAWAY testnet key only. Never run broadcast/force-* on a shared or multi-tenant host."

build:
	forge build

test:
	forge test

fmt:
	forge fmt

# ---- local simulation (the acceptance/verification path; no funds or key required) ----

demo-sim:
	forge script script/DemoFlow.s.sol:DemoFlow -vv

deploy-sim:
	forge script script/Deploy.s.sol:Deploy -vv

# ---- one-time keystore signer setup (key is encrypted at rest; never touches argv or env) ----

import-key:
	cast wallet import $(CAST_ACCOUNT) --interactive

# ---- Arc testnet broadcast ----
# PRIVATE_KEY is exported ONLY to these four recipes (forge script reads it from the env to sign).
# build/test/sim and the force-* cranks NEVER receive the signing key.
deploy-mocks create-pool deploy-arena deploy-demo: export PRIVATE_KEY ARC_RPC_URL

deploy-mocks:
	forge script script/DeployMocks.s.sol:DeployMocks --rpc-url arc_testnet --broadcast -vvvv

create-pool:
	forge script script/CreatePool.s.sol:CreatePool --rpc-url arc_testnet --broadcast -vvvv

deploy-arena:
	forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast -vvvv

# Full deploy in a single script run (deploys V3 fork + pool + arena, or reuses env addrs).
deploy-demo:
	forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast -vvvv

# Step-by-step chain (useful when wiring canonical/pre-deployed V3 addresses via .env).
deploy-all: deploy-mocks create-pool deploy-arena
	@echo "Deploy chain complete. Copy the logged addresses into .env."

# ---- Keeper role wiring ----
# Grant the least-privilege keeper role to KEEPER_ADDRESS on FEE_ARENA_ADDRESS.
# Run AFTER deploy-arena (FEE_ARENA_ADDRESS must be set in .env) and AFTER the keeper
# EOA is provisioned (KEEPER_ADDRESS). Signed via the keystore account (owner key).
# At deploy time the same grant happens automatically when Deploy.s.sol sees KEEPER_ADDRESS.
set-keeper:
	@test -n "$(FEE_ARENA_ADDRESS)" || (echo "ERROR: FEE_ARENA_ADDRESS is not set in .env"; exit 1)
	@test -n "$(KEEPER_ADDRESS)"    || (echo "ERROR: KEEPER_ADDRESS is not set in .env"; exit 1)
	cast send $(FEE_ARENA_ADDRESS) "setKeeper(address)" $(KEEPER_ADDRESS) \
		--rpc-url arc_testnet --account $(CAST_ACCOUNT)

# Force presets: ETH start $3000, band 1.5% -> UP=$3060, DOWN=$2940, RANGE=$3000.
# Signed via the encrypted keystore account (no raw key on the command line). Run 'make import-key' first.
force-up:
	cast send $(ORACLE_ADDRESS) "setPrice(uint256)" 3060000000000000000000 \
		--rpc-url arc_testnet --account $(CAST_ACCOUNT)

force-down:
	cast send $(ORACLE_ADDRESS) "setPrice(uint256)" 2940000000000000000000 \
		--rpc-url arc_testnet --account $(CAST_ACCOUNT)

force-range:
	cast send $(ORACLE_ADDRESS) "setPrice(uint256)" 3000000000000000000000 \
		--rpc-url arc_testnet --account $(CAST_ACCOUNT)
