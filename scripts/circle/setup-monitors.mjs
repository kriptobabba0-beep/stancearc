// scripts/circle/setup-monitors.mjs - idempotently register Circle SCP event monitors for EVERY live
// Fee Arena arena, so the in-app activity feed (/api/circle/activity) can read indexed arena events.
//
// For each arena it: POST /contracts/import (register in Circle's library) then POST /contracts/monitors
// (one per real FeeArenaV3 event signature). Re-running is safe: import 200s, monitors 409 "already
// exists". The arena list is read from frontend/.env.local NEXT_PUBLIC_MARKETS (the same source the app
// uses); if that's unreadable it falls back to the three known live arenas.
//
// SERVER-SIDE ONLY. The Circle API key is read from the gitignored repo-root .env (TEST_API_KEY) and is
// NEVER printed. Run from the repo root:  node scripts/circle/setup-monitors.mjs
//
// Docs: https://developers.circle.com/api-reference/contracts/smart-contract-platform/create-event-monitor

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';
const BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? 'ARC-TESTNET';

// Canonical ABI event signatures (NO spaces; `Side` enum -> uint8) from src/interfaces/IFeeArenaV3.sol.
const EVENT_SIGNATURES = [
  'EpochCreated(uint64,uint64,uint64,uint64,int32)',
  'SettlementPriceSubmitted(uint64,uint256,uint256,uint64,uint64,bytes32)',
  'EmptyWinnerRollover(uint64,uint256,uint256)',
  'EpochSettled(uint64,uint256,uint32,uint256,uint256)',
  'Staked(uint64,address,uint256,uint8,uint256,uint32)',
  'Claimed(uint64,address,uint256,uint256,uint256)',
];

// Fallback arena list (used only if NEXT_PUBLIC_MARKETS can't be read).
const FALLBACK_ARENAS = [
  { id: 'cirbtc', label: 'cirBTC USDC', feeArena: '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f' },
  { id: 'eurc', label: 'EURC USDC', feeArena: '0x56ec33e7e8a9a5B5202cbf64c8F3a45bEE17CC9c' },
];

/** Read a *_API_KEY from the repo-root .env without printing it. */
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

/** Read the arena list from frontend/.env.local NEXT_PUBLIC_MARKETS; fall back to the known arenas. */
function loadArenas() {
  try {
    const envPath = new URL('../../frontend/.env.local', import.meta.url);
    const text = readFileSync(envPath, 'utf8');
    const line = text.split(/\r?\n/).find((l) => l.startsWith('NEXT_PUBLIC_MARKETS='));
    if (!line) return FALLBACK_ARENAS;
    const value = line.slice('NEXT_PUBLIC_MARKETS='.length).trim().replace(/^["']|["']$/g, '');
    const markets = JSON.parse(value);
    const arenas = markets
      // Skip the shelved v2 conviction arena - the app excludes it (selectableMarkets), so the feed
      // never reads it; no point monitoring it.
      .filter((m) => m && typeof m.feeArena === 'string' && m.version !== 'v2')
      .map((m) => ({ id: String(m.id ?? m.feeArena), label: String(m.label ?? m.id ?? 'Fee Arena'), feeArena: m.feeArena }));
    return arenas.length > 0 ? arenas : FALLBACK_ARENAS;
  } catch {
    return FALLBACK_ARENAS;
  }
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

/** Circle requires `description` to be alphanumeric (letters/numbers/spaces) - sanitize the label. */
function alphaNum(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function setupArena(arena) {
  console.log(`\n▶ ${arena.label}  (${arena.feeArena})`);
  const imp = await circleFetch('POST', '/contracts/import', {
    idempotencyKey: randomUUID(),
    name: alphaNum(`FeeArenaV3 ${arena.id}`) || 'FeeArenaV3',
    address: arena.feeArena,
    blockchain: BLOCKCHAIN,
    description: alphaNum(`Fee Arena ${arena.label} live on Arc testnet`),
    refreshVerification: true,
  });
  console.log(`   import -> HTTP ${imp.status}${imp.ok ? '' : '  ' + JSON.stringify(imp.json)}`);

  for (const sig of EVENT_SIGNATURES) {
    const r = await circleFetch('POST', '/contracts/monitors', {
      idempotencyKey: randomUUID(),
      blockchain: BLOCKCHAIN,
      contractAddress: arena.feeArena,
      eventSignature: sig,
    });
    const mark = r.status === 201 ? '＋ created' : r.json?.code === 175302 ? '✓ exists ' : '! ' + JSON.stringify(r.json);
    console.log(`   ${mark}  ${sig}`);
  }
}

async function main() {
  const arenas = loadArenas();
  console.log(`Circle SCP - setting up event monitors on ${BLOCKCHAIN} for ${arenas.length} arena(s)`);
  for (const a of arenas) await setupArena(a);

  console.log('\nAll monitors on the account:');
  const mon = await circleFetch('GET', `/contracts/monitors?blockchain=${BLOCKCHAIN}&pageSize=50`);
  const list = mon.json?.data?.eventMonitors ?? mon.json?.eventMonitors ?? [];
  for (const m of list) console.log(`   ${m.contractAddress}  ${m.isEnabled ? 'on ' : 'off'}  ${m.eventSignature}`);
  console.log(`\nDone. ${list.length} monitor(s) registered${list.length === 0 ? ' (list query returned empty; per-arena results above are authoritative)' : ''}.`);
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
