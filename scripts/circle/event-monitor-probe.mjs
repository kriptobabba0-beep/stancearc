// scripts/circle/event-monitor-probe.mjs - Phase 0(b) probe for Circle SCP Event Monitoring on Arc.
//
// Proves (or disproves) end-to-end event monitoring of the LIVE FeeArenaV3 on ARC-TESTNET via Circle's
// Smart Contract Platform - WITHOUT a webhook endpoint (uses the historical event-log pull as the proof,
// which is also our documented fallback if webhook push doesn't fire on Arc):
//   1. POST /v1/w3s/contracts/import          - ensure the arena is in Circle's library (idempotent)
//   2. POST /v1/w3s/contracts/monitors        - create a monitor per real event signature
//   3. GET  /v1/w3s/contracts/monitors        - list monitors (confirm they registered on ARC-TESTNET)
//   4. GET  /v1/w3s/contracts/events          - list any event logs Circle has indexed so far
//
// SERVER-SIDE ONLY. The Circle API key is read from the gitignored repo-root .env (TEST_API_KEY) and is
// NEVER printed. Run from the repo root:  node scripts/circle/event-monitor-probe.mjs
//
// Docs: https://developers.circle.com/api-reference/contracts/smart-contract-platform/create-event-monitor

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';
const BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? 'ARC-TESTNET';

// The live cirBTC/USDC arena (FeeArenaV3) - the contract the production app uses.
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS ?? '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f';

// Canonical ABI event signatures (NO spaces; `Side` enum -> uint8) copied from src/interfaces/IFeeArenaV3.sol.
// The first three fire EVERY epoch via the keeper even with zero stakers (fastest end-to-end proof); the last
// three are the player-facing feed events.
const EVENT_SIGNATURES = [
  'EpochCreated(uint64,uint64,uint64,uint64,int32)',
  'SettlementPriceSubmitted(uint64,uint256,uint256,uint64,uint64,bytes32)',
  'EmptyWinnerRollover(uint64,uint256,uint256)',
  'EpochSettled(uint64,uint256,uint32,uint256,uint256)',
  'Staked(uint64,address,uint256,uint8,uint256,uint32)',
  'Claimed(uint64,address,uint256,uint256,uint256)',
];

/** Read TEST_API_KEY from the repo-root .env without printing it. */
function loadApiKey() {
  const envPath = new URL('../../.env', import.meta.url);
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`Could not read ${envPath.pathname}. Add TEST_API_KEY=... to the repo-root .env.`);
  }
  for (const line of text.split(/\r?\n/)) {
    const raw = line.match(/^\s*((?:TEST|LIVE)_API_KEY:[^\s]+:[^\s]+)\s*$/);
    if (raw) return raw[1];
    const assign = line.match(/^\s*(?:CIRCLE_API_KEY|TEST_API_KEY|API_KEY)\s*=\s*(.+?)\s*$/);
    if (assign) return assign[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('No Circle API key found in the repo-root .env (expected a TEST_API_KEY:... line).');
}

const API_KEY = loadApiKey();

async function circleFetch(method, path, body) {
  const res = await fetch(`${CIRCLE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-Request-Id': randomUUID(),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/** Poll mode: watch /contracts/events until at least one Arc log is indexed (proves push/pull works on Arc). */
async function poll() {
  const MAX_MS = 30 * 60 * 1000; // give the keeper up to ~30 min to emit a per-epoch event
  const STEP_MS = 30 * 1000;
  const deadline = Date.now() + MAX_MS;
  console.log(`Polling /contracts/events for ${CONTRACT_ADDRESS} on ${BLOCKCHAIN} (up to 30 min)...`);
  for (let i = 0; Date.now() < deadline; i++) {
    const ev = await circleFetch(
      'GET',
      `/contracts/events?contractAddress=${CONTRACT_ADDRESS}&blockchain=${BLOCKCHAIN}&pageSize=20`,
    );
    const logs = ev.json?.data?.eventLogs ?? ev.json?.eventLogs ?? [];
    if (logs.length > 0) {
      console.log(`\n✅ INDEXED ${logs.length} event log(s) on ${BLOCKCHAIN} - Circle SCP monitoring works on Arc:`);
      console.log(JSON.stringify(logs, null, 2));
      return;
    }
    process.stdout.write(`  [${i}] no logs yet (HTTP ${ev.status})\n`);
    await new Promise((r) => setTimeout(r, STEP_MS));
  }
  console.log('\n⏱  Timed out with no indexed logs. Monitors are enabled; either no per-epoch event fired in the');
  console.log('   window, or Arc push indexing lags. Re-run `node scripts/circle/event-monitor-probe.mjs poll`.');
}

async function main() {
  if (process.argv.includes('poll')) {
    await poll();
    return;
  }
  console.log('Circle SCP Event Monitoring - Fee Arena Phase 0(b) probe');
  console.log(`  blockchain: ${BLOCKCHAIN}`);
  console.log(`  contract:   FeeArenaV3 @ ${CONTRACT_ADDRESS}`);
  console.log('');

  console.log('1) Ensuring the contract is imported (idempotent)...');
  const imp = await circleFetch('POST', '/contracts/import', {
    idempotencyKey: randomUUID(),
    name: 'FeeArenaV3',
    address: CONTRACT_ADDRESS,
    blockchain: BLOCKCHAIN,
    description: 'Fee Arena entry anchored arena FeeArenaV3 live on Arc testnet',
    refreshVerification: true,
  });
  console.log(`   import -> HTTP ${imp.status}`, imp.ok ? '(ok)' : JSON.stringify(imp.json));
  console.log('');

  console.log('2) Creating an event monitor per signature...');
  for (const sig of EVENT_SIGNATURES) {
    const r = await circleFetch('POST', '/contracts/monitors', {
      idempotencyKey: randomUUID(),
      blockchain: BLOCKCHAIN,
      contractAddress: CONTRACT_ADDRESS,
      eventSignature: sig,
    });
    console.log(`   ${r.status}  ${sig}`);
    if (!r.ok) console.log(`        -> ${JSON.stringify(r.json)}`);
    else console.log(`        -> ${JSON.stringify(r.json?.data ?? r.json)}`);
  }
  console.log('');

  console.log('3) Listing event monitors...');
  const mon = await circleFetch('GET', `/contracts/monitors?blockchain=${BLOCKCHAIN}&pageSize=50`);
  console.log(`   list monitors -> HTTP ${mon.status}`);
  console.log('   ', JSON.stringify(mon.json?.data ?? mon.json));
  console.log('');

  console.log('4) Listing indexed event logs (history)...');
  const ev = await circleFetch(
    'GET',
    `/contracts/events?contractAddress=${CONTRACT_ADDRESS}&blockchain=${BLOCKCHAIN}&pageSize=20`,
  );
  console.log(`   list events -> HTTP ${ev.status}`);
  console.log('   ', JSON.stringify(ev.json?.data ?? ev.json));
  console.log('');
  console.log('Done. (If monitors registered, event logs will populate as the keeper emits EpochSettled.)');
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
