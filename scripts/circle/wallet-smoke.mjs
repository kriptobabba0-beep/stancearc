// scripts/circle/wallet-smoke.mjs - Circle USER-CONTROLLED Programmable Wallets smoke test (Arc testnet).
//
// De-risks the embedded-wallet architecture BEFORE building: confirms the sandbox API key works and that
// the user-controlled create -> token -> initialize(ARC-TESTNET, EOA) flow returns a challengeId (the
// part docs left ambiguous). The final wallet creation needs the browser Web SDK + a user PIN, so this
// server-side probe stops at the INITIALIZE challenge - that's the load-bearing unknown.
//
// SERVER-SIDE ONLY. Reads TEST_API_KEY from the gitignored repo-root .env and NEVER prints it (or the
// short-lived userToken/encryptionKey). Run from repo root:  node scripts/circle/wallet-smoke.mjs

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';
const BLOCKCHAIN = process.env.CIRCLE_BLOCKCHAIN ?? 'ARC-TESTNET';
const ACCOUNT_TYPE = process.env.CIRCLE_ACCOUNT_TYPE ?? 'EOA';

function loadApiKey() {
  const envPath = new URL('../../.env', import.meta.url);
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const raw = line.match(/^\s*((?:TEST|LIVE)_API_KEY:[^\s]+:[^\s]+)\s*$/);
    if (raw) return raw[1];
    const assign = line.match(/^\s*(?:CIRCLE_API_KEY|TEST_API_KEY|API_KEY)\s*=\s*(.+?)\s*$/);
    if (assign) return assign[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('No Circle API key in repo-root .env (expected a TEST_API_KEY:... line).');
}

const API_KEY = loadApiKey();

async function call(path, { method = 'POST', body, userToken } = {}) {
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    'X-Request-Id': randomUUID(),
    'Content-Type': 'application/json',
  };
  if (userToken) headers['X-User-Token'] = userToken;
  const res = await fetch(`${CIRCLE_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

const redact = (s) => (typeof s === 'string' && s.length > 8 ? `${s.slice(0, 4)}…(${s.length} chars)` : '(none)');

async function main() {
  const userId = randomUUID(); // Circle caps userId at 50 chars; a bare UUID (36) is safe + unique.
  console.log('Circle user-controlled wallet smoke test');
  console.log(`  blockchain: ${BLOCKCHAIN}  accountType: ${ACCOUNT_TYPE}`);
  console.log(`  userId:     ${userId}`);
  console.log('');

  // 1) Create user
  const u = await call('/users', { body: { userId } });
  console.log(`1) POST /users                -> HTTP ${u.status} ${u.ok ? 'OK' : JSON.stringify(u.json)}`);

  // 2) Acquire session token
  const t = await call('/users/token', { body: { userId } });
  const userToken = t.json?.data?.userToken;
  const encryptionKey = t.json?.data?.encryptionKey;
  console.log(
    `2) POST /users/token          -> HTTP ${t.status} ${t.ok ? `OK (userToken ${redact(userToken)}, encryptionKey ${redact(encryptionKey)})` : JSON.stringify(t.json)}`,
  );
  if (!userToken) {
    console.log('   No userToken - stopping.');
    return;
  }

  // 3) Initialize (the load-bearing unknown): does ARC-TESTNET + EOA return a challengeId?
  const init = await call('/user/initialize', {
    userToken,
    body: { idempotencyKey: randomUUID(), accountType: ACCOUNT_TYPE, blockchains: [BLOCKCHAIN] },
  });
  const challengeId = init.json?.data?.challengeId;
  console.log(
    `3) POST /user/initialize      -> HTTP ${init.status} ${init.ok ? `OK (challengeId ${redact(challengeId)})` : JSON.stringify(init.json)}`,
  );

  console.log('');
  if (init.ok && challengeId) {
    console.log('✅ VERDICT: user-controlled + ARC-TESTNET + EOA is accepted and returns an INITIALIZE challengeId.');
    console.log('   (Wallet creation completes client-side via the Web SDK + user PIN - not scriptable here.)');
  } else {
    console.log('⚠️  VERDICT: initialize did NOT return a challengeId - inspect the error body above for the exact required shape.');
  }
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
