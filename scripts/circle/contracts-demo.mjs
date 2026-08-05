// scripts/circle/contracts-demo.mjs - Circle Smart Contract Platform (SCP) integration demo.
//
// Proves Fee Arena uses Circle's "Contracts" product on ARC TESTNET against the SAME FeeArenaV3
// contract the live app runs on. Two real API calls, no SDK (Node built-in fetch/crypto/fs only):
//   1. POST /v1/w3s/contracts/import  - register the deployed FeeArenaV3 in Circle's contract library
//   2. POST /v1/w3s/contracts/query   - READ live on-chain state (currentEpochId / USDC / band / keeper)
//      through Circle's API (a server-side read; needs only the API key, no wallet, no gas).
//
// SERVER-SIDE ONLY. The Circle API key is a Bearer secret - it is read from the gitignored repo-root
// .env (TEST_API_KEY) and is NEVER printed. Do NOT move this key into the frontend / NEXT_PUBLIC_*.
//
// Run from the repo root:  node scripts/circle/contracts-demo.mjs
// Override target:         CONTRACT_ADDRESS=0x... CIRCLE_BLOCKCHAIN=ARC-TESTNET node scripts/circle/contracts-demo.mjs
//
// Docs: https://developers.circle.com/api-reference/contracts/smart-contract-platform/import-contract
//       https://developers.circle.com/api-reference/contracts/smart-contract-platform/query-contract

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';

// The live FeeArenaV3 (entry-anchored arena) on Arc testnet - the contract the production app uses.
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS ?? '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f';
const BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? 'ARC-TESTNET';
const CONTRACT_NAME = process.env.CONTRACT_NAME ?? 'FeeArenaV3';

/** Read TEST_API_KEY from the repo-root .env without printing it. */
function loadApiKey() {
  // .env lives two levels up from scripts/circle/.
  const envPath = new URL('../../.env', import.meta.url);
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`Could not read ${envPath.pathname}. Add TEST_API_KEY=... to the repo-root .env.`);
  }
  for (const line of text.split(/\r?\n/)) {
    // Circle sandbox/live keys are formatted "TEST_API_KEY:<id>:<secret>" / "LIVE_API_KEY:<id>:<secret>"
    // and may be pasted verbatim on their own line - the WHOLE line is the key.
    const raw = line.match(/^\s*((?:TEST|LIVE)_API_KEY:[^\s]+:[^\s]+)\s*$/);
    if (raw) return raw[1];
    // Or as a normal assignment: TEST_API_KEY=... / CIRCLE_API_KEY=...
    const assign = line.match(/^\s*(?:CIRCLE_API_KEY|TEST_API_KEY|API_KEY)\s*=\s*(.+?)\s*$/);
    if (assign) return assign[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('No Circle API key found in the repo-root .env (expected a TEST_API_KEY:... line).');
}

const API_KEY = loadApiKey();

/** POST a Circle SCP endpoint with Bearer auth + an idempotent request id. Throws on non-2xx. */
async function circlePost(path, body) {
  const res = await fetch(`${CIRCLE_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'X-Request-Id': randomUUID(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Circle errors carry { code, message }. Never echo the key; only the API's own message.
    throw new Error(`Circle ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Import the deployed contract into Circle's contract library (idempotent by idempotencyKey). */
async function importContract() {
  const out = await circlePost('/contracts/import', {
    idempotencyKey: randomUUID(),
    name: CONTRACT_NAME,
    address: CONTRACT_ADDRESS,
    blockchain: BLOCKCHAIN,
    // Circle validates `description` as alphanumeric (letters/numbers/spaces) - no punctuation, dashes, or parens.
    description: 'Fee Arena entry anchored arena FeeArenaV3 live on Arc testnet',
    refreshVerification: true,
  });
  const c = out?.data?.contract ?? out?.data ?? out;
  return c;
}

/** Read a no-arg view function on the contract via Circle's query API. Returns the raw value. */
async function queryView(signature) {
  const out = await circlePost('/contracts/query', {
    address: CONTRACT_ADDRESS,
    blockchain: BLOCKCHAIN,
    abiFunctionSignature: signature,
    abiParameters: [],
  });
  const data = out?.data ?? out;
  // Circle returns decoded outputValues (preferred) + raw outputData (a 32-byte hex word per output).
  const values = data?.outputValues ?? data?.outputData ?? data;
  return Array.isArray(values) ? values[0] : values;
}

/** Decode a single 32-byte ABI word (or a Circle outputValues entry) to a human value by type. */
function decode(raw, type) {
  if (raw === undefined || raw === null) return '(none)';
  const s = String(raw);
  if (!s.startsWith('0x')) return s; // Circle already decoded it
  const hex = s.slice(2).padStart(64, '0');
  if (type === 'address') return '0x' + hex.slice(24);
  // numeric types (uintN/intN) - these getters are all small + non-negative.
  return BigInt('0x' + hex).toString();
}

async function main() {
  console.log('Circle Smart Contract Platform - Fee Arena demo');
  console.log(`  blockchain: ${BLOCKCHAIN}`);
  console.log(`  contract:   ${CONTRACT_NAME} @ ${CONTRACT_ADDRESS}`);
  console.log('');

  console.log('1) Importing the deployed contract into Circle\'s contract library...');
  try {
    const c = await importContract();
    console.log('   imported:', JSON.stringify(c));
  } catch (e) {
    // Import may be 403 if the API key/account tier doesn't have the import scope enabled - it is a
    // permissions setting in the Circle Console, not a code error. The READ demo below does NOT need
    // it (query works by blockchain + address alone), so surface the note and continue.
    console.log('   import skipped:', e instanceof Error ? e.message : String(e));
    console.log('   (enable contract import for this key in the Circle Console if you want this step; the read below is the core demo.)');
  }
  console.log('');

  console.log('2) Reading live on-chain state through Circle\'s API (no wallet, no gas):');
  const READS = [
    { sig: 'currentEpochId()', type: 'uint64', label: 'current epoch' },
    { sig: 'USDC()', type: 'address', label: 'USDC (quote)' },
    { sig: 'BASE()', type: 'address', label: 'cirBTC (base)' },
    { sig: 'bandBps()', type: 'int32', label: 'band (bps)' },
    { sig: 'keeper()', type: 'address', label: 'keeper' },
  ];
  for (const r of READS) {
    try {
      const v = await queryView(r.sig);
      console.log(`   ${r.sig.padEnd(18)} ${decode(v, r.type).padEnd(44)} (${r.label})`);
    } catch (e) {
      console.log(`   ${r.sig.padEnd(18)} ! ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log('');
  console.log('Done. This read the SAME FeeArenaV3 the live app uses, via Circle\'s Smart Contract Platform.');
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
