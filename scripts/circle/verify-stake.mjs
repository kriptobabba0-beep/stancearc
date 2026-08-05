// scripts/circle/verify-stake.mjs - verify a recent Staked landed on the arena AND was indexed by
// Circle's SCP event monitor (the same data the in-app activity feed reads). Read-only; key never printed.
//   node scripts/circle/verify-stake.mjs
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const CIRCLE_API = 'https://api.circle.com/v1/w3s';
const ARENA = '0xc1abf142cb736a8f5f0a7d5eae9c93e31d61bb2f';
const STAKED_TOPIC0 = '0x6cd8d0c72c8612fe6544eb79572199e8ca77d2a1d5c5146da7866bfe6ec2c39d';
const SIDE = { 1: 'UP', 2: 'DOWN', 3: 'RANGE' };

function loadApiKey() {
  const text = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const raw = line.match(/^\s*((?:TEST|LIVE)_API_KEY:[^\s]+:[^\s]+)\s*$/);
    if (raw) return raw[1];
    const a = line.match(/^\s*(?:CIRCLE_API_KEY|TEST_API_KEY|API_KEY)\s*=\s*(.+?)\s*$/);
    if (a) return a[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('no key');
}
const KEY = loadApiKey();
const hexToInt = (h) => BigInt(h).toString();

const res = await fetch(`${CIRCLE_API}/contracts/events?contractAddress=${ARENA}&blockchain=ARC-TESTNET&pageSize=50`, {
  headers: { Authorization: `Bearer ${KEY}`, 'X-Request-Id': randomUUID() },
});
const json = await res.json();
const logs = json?.data?.eventLogs ?? json?.eventLogs ?? [];
const stakes = logs.filter((l) => (l.topics?.[0] ?? '').toLowerCase() === STAKED_TOPIC0);

console.log(`Circle SCP indexed ${logs.length} event(s) on the arena; ${stakes.length} are Staked.\n`);
console.log('All Staked events in the window (★ = position #37 / your stake):');
for (const s of stakes) {
  const epochId = hexToInt(s.topics[1]);
  const owner = '0x' + s.topics[2].slice(26);
  const tokenId = hexToInt(s.topics[3]);
  const side = SIDE[Number(BigInt('0x' + s.data.slice(2, 66)))] ?? '?';
  const entry = (Number(BigInt('0x' + s.data.slice(66, 130))) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 });
  const mark = tokenId === '37' ? '★' : ' ';
  console.log(`${mark} epoch #${epochId}  side ${side.padEnd(5)} token #${tokenId.padEnd(4)} owner ${owner}  entry $${entry}  tx ${s.txHash}`);
}
