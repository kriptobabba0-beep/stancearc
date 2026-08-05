#!/usr/bin/env bash
# bootstrap.sh - one-command server setup for the Fee Arena keeper + arb bot.
#
# Run this ON a fresh Ubuntu/Debian server (e.g. a rented VPS), from inside the keeper/
# directory (the folder that contains docker-compose.yml and your filled-in .env):
#
#   cd keeper
#   sudo bash deploy/bootstrap.sh
#
# It is idempotent - re-run it any time to pick up code/.env changes (it rebuilds + restarts).
# What it does:
#   1. verifies .env exists (your secrets + config),
#   2. installs Docker Engine + the compose plugin if they're missing,
#   3. builds + starts BOTH services (keeper + arb) detached, with restart=unless-stopped so
#      they survive crashes AND host reboots,
#   4. prints status + how to watch logs / health.
set -euo pipefail

# --- 0. locate the keeper dir (this script lives in keeper/deploy/) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEEPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$KEEPER_DIR"
echo "==> keeper directory: $KEEPER_DIR"

# --- 1. require .env (the bots refuse to start without RPC + keys + markets config) ---
if [ ! -f .env ]; then
  echo "ERROR: $KEEPER_DIR/.env is missing." >&2
  echo "Copy your local keeper/.env to this server first (see DEPLOY.md), then re-run." >&2
  exit 1
fi
chmod 600 .env || true  # keys live here - restrict to the owner

# --- 2. install Docker + compose plugin if absent ---
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker not found - installing via get.docker.com (Ubuntu/Debian) ..."
  curl -fsSL https://get.docker.com | sh
else
  echo "==> Docker already installed: $(docker --version)"
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' plugin not available. On Ubuntu: sudo apt-get install -y docker-compose-plugin" >&2
  exit 1
fi

# --- 3. build + start both services detached ---
echo "==> building + starting keeper + arb (docker compose up -d --build) ..."
docker compose up -d --build

# --- 4. status + next steps ---
echo
echo "==> running containers:"
docker compose ps
echo
echo "Done. The keeper + arb now run 24/7 and restart on crash or reboot."
echo "  Watch logs:        docker compose logs -f"
echo "  Just the keeper:   docker compose logs -f keeper"
echo "  Health (keeper):   curl -s localhost:\${KEEPER_HTTP_PORT:-9464}/health"
echo "  Stop everything:   docker compose down"
echo "  Update after edit: sudo bash deploy/bootstrap.sh   (re-run; rebuilds + restarts)"
