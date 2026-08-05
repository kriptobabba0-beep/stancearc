// scripts/circle/verify-activity-key.mjs - does the FRONTEND server key read Circle SCP event logs?
//
// The /api/circle/activity route uses CIRCLE_SCP_API_KEY ?? CIRCLE_API_KEY to GET /contracts/events.
// This checks each key present in frontend/.env.local (and the root .env SCP key) against the live
// endpoint and prints ONLY the HTTP status + event count per key - never the key itself. If the
// frontend's CIRCLE_API_KEY returns 403, set CIRCLE_SCP_API_KEY to the SCP key in Vercel + .env.local.
//
// Run from the repo root:  node scripts/circle/verify-activity-key.mjs

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';
const BLOCKCHAIN = 'ARC-TESTNET';
const ARENA = '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f';

/** Pull KEY=VALUE (and bare TEST_API_KEY:... lines) from a dotenv file; returns a {name: value} map. */
function readEnv(path, names) {
  const out = {};
  let text;
  try {
    text = readFileSync(new URL(path, import.meta.url), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const bare = line.match(/^\s*((?:TEST|LIVE)_API_KEY:[^\s]+:[^\s]+)\s*$/);
    if (bare) out['ROOT_TEST_API_KEY'] = bare[1];
    for (const n of names) {
      const m = line.match(new RegExp(`^\\s*${n}\\s*=\\s*(.+?)\\s*$`));
      if (m) out[n] = m[1].replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

async function check(label, key) {
  if (!key) {
    console.log(`  ${label.padEnd(20)} (absent)`);
    return;
  }
  const url = `${CIRCLE_API}/contracts/events?contractAddress=${ARENA}&blockchain=${BLOCKCHAIN}&pageSize=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, 'X-Request-Id': randomUUID() } });
  const json = await res.json().catch(() => ({}));
  const n = (json?.data?.eventLogs ?? json?.eventLogs ?? []).length;
  const note = res.ok ? `OK - ${n} event(s) readable` : `HTTP ${res.status}: ${json?.message ?? 'error'}`;
  console.log(`  ${label.padEnd(20)} ${note}`);
}

const keys = {
  ...readEnv('../../.env', ['CIRCLE_API_KEY', 'CIRCLE_SCP_API_KEY']),
  ...readEnv('../../frontend/.env.local', ['CIRCLE_API_KEY', 'CIRCLE_SCP_API_KEY']),
};

console.log('Can each configured key read Circle SCP /contracts/events on Arc? (keys never printed)\n');
await check('frontend CIRCLE_API_KEY', keys.CIRCLE_API_KEY);
await check('CIRCLE_SCP_API_KEY', keys.CIRCLE_SCP_API_KEY);
await check('root SCP key', keys.ROOT_TEST_API_KEY);
console.log('\nThe route uses CIRCLE_SCP_API_KEY ?? CIRCLE_API_KEY. If the frontend key 403s, set');
console.log('CIRCLE_SCP_API_KEY (server-only) to a key that returns OK above, in Vercel + frontend/.env.local.');
