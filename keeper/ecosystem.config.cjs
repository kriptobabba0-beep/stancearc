// Fee Arena Keeper — pm2 ecosystem config (non-Docker alternative to Docker Compose).
//
// Usage (from the keeper/ directory):
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup   # persist across reboots
//   pm2 logs fee-arena-keeper # tail logs
//   pm2 stop fee-arena-keeper
//
// Configuration is loaded from keeper/.env (dotenv is imported by config.ts at boot).
// For file-based key injection set KEEPER_PRIVATE_KEY_FILE in .env pointing to a
// file containing the 0x-prefixed hex key (no shell escaping required, file is trimmed).

module.exports = {
  apps: [
    {
      name: 'fee-arena-keeper',

      // Run via pnpm so corepack/tsx are resolved exactly as in development.
      script: 'pnpm',
      args: 'start',

      // Working directory — adjust if running pm2 from a different cwd.
      cwd: __dirname,

      // Restart policy.
      autorestart: true,
      max_restarts: 20,          // give up after 20 rapid crashes (prevents a crash-loop)
      restart_delay: 5000,       // wait 5 s before each restart attempt
      min_uptime: '10s',         // a process that dies within 10 s counts as a crash

      // Log to files (pm2 rotates them); also visible via `pm2 logs`.
      out_file: './logs/keeper.out.log',
      error_file: './logs/keeper.err.log',
      merge_logs: true,          // stdout + stderr into a single log stream
      log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSSZ',

      // Single instance — the keeper is deliberately single-process (one key, no nonce races).
      instances: 1,
      exec_mode: 'fork',

      // Environment — dotenv inside config.ts loads .env; you can also set vars here.
      env: {
        NODE_ENV: 'production',
      },
    },

    {
      // The price-keeper ARB bot — a SEPARATE process (separate key, separate nonces) that
      // trades the pool toward the live Pyth price. The AMM's real 0.3% fee on each swap
      // funds every pot, so it gets the SAME restart/supervision as the lifecycle keeper.
      name: 'fee-arena-arb',

      // Run via pnpm so corepack/tsx are resolved exactly as in development.
      script: 'pnpm',
      args: 'arb',

      // Working directory — adjust if running pm2 from a different cwd.
      cwd: __dirname,

      // Restart policy (mirrors the keeper app).
      autorestart: true,
      max_restarts: 20,          // give up after 20 rapid crashes (prevents a crash-loop)
      restart_delay: 5000,       // wait 5 s before each restart attempt
      min_uptime: '10s',         // a process that dies within 10 s counts as a crash

      // Log to files (pm2 rotates them); also visible via `pm2 logs`.
      out_file: './logs/arb.out.log',
      error_file: './logs/arb.err.log',
      merge_logs: true,          // stdout + stderr into a single log stream
      log_date_format: 'YYYY-MM-DDTHH:mm:ss.SSSZ',

      // Single instance — the arb bot is deliberately single-process (one key, no nonce races).
      instances: 1,
      exec_mode: 'fork',

      // Environment — dotenv inside config.ts loads .env; you can also set vars here.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
