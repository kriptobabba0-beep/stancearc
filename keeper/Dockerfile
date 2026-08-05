# Fee Arena Keeper - Docker image
# Build from the keeper/ directory:
#   docker build -t fee-arena-keeper .
# Or use docker-compose.yml for a fully-configured service.

FROM node:20-slim AS base

# Enable corepack so pnpm is available at BUILD time (root). NOTE: pnpm/corepack are used
# only to install deps during build - the container does NOT run pnpm at runtime (see CMD),
# so the non-root user never needs a writable corepack cache.
RUN corepack enable

WORKDIR /app

# --- dependency layer (cache-friendly: only reinstalled when lockfile changes) ---
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: fail if lockfile is out of sync (CI safety).
# --prod=false: keep devDeps (tsx, typescript) so `pnpm start` works.
RUN pnpm install --frozen-lockfile --prod=false

# --- source layer ---
COPY src/ ./src/
COPY tsconfig.json ./
# The gas-watchdog (the keeper's automatic gas self-heal) ships in the SAME image so the
# `gas-watchdog` compose service starts from a fresh `docker compose up -d` with no extra setup.
COPY gasWatchdog.mjs ./

# Run as a non-root user for least-privilege execution. Give it a real home (some tools
# expect $HOME to exist + be writable) and own /app so the runtime can read/execute deps.
RUN groupadd --system keeper \
 && useradd --system --gid keeper --create-home keeper \
 && chown -R keeper:keeper /app
USER keeper
ENV HOME=/home/keeper

# The keeper HTTP health/metrics server. The app default (KEEPER_HTTP_PORT=0) is OFF,
# so the image turns it ON at 9464 to match the HEALTHCHECK + EXPOSE below. Override via
# env/compose (.env) for a different port; set to 0 to disable (then drop the probe).
ENV KEEPER_HTTP_PORT=9464
EXPOSE 9464

# Liveness probe: hit /health via Node's built-in fetch - node:20-slim ships NO wget/curl.
# Exit 0 on 2xx (healthy), 1 on 503/connection-refused (unhealthy) -> orchestrator sees
# starting -> healthy / unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KEEPER_HTTP_PORT||9464)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run tsx DIRECTLY (deps were installed during build) - no pnpm/corepack at runtime, so the
# non-root user needs no writable package-manager cache and there's no boot-time download.
CMD ["/app/node_modules/.bin/tsx", "src/index.ts"]
