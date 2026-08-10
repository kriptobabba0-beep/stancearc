// consolidate-cirbtc.mjs — one-off ops tool. Sweeps the idle cirBTC sitting in the 3 staker-bot
// wallets into the ARB (price-keeper) wallet, concentrating the project's scarce cirBTC where it
// actually defends the peg. Run INSIDE the keeper container (it has viem + the keys in env):
//   docker compose cp keeper/scripts/consolidate-cirbtc.mjs keeper:/app/ \
//     && docker compose exec -T keeper node /app/consolidate-cirbtc.mjs
// Keys are read from process.env (never printed). Leaves dust; idempotent (re-running is a no-op once swept).
import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = (process.env.KEEPER_RPC_URLS || 'https://rpc.testnet.arc.network').split(',')[0].trim();
const CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';
const ARB = '0x3cB717f1a19F45D54Eb82f918185eFAbB5108B79';
const chain = defineChain({ id: 5042002, name: 'arc', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
const erc20 = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
const GAS = { maxFeePerGas: 50_000_000_000n, maxPriorityFeePerGas: 50_000_000_000n };
const keys = [
  ['UP', process.env.STAKERBOT_UP_PRIVATE_KEY],
  ['DOWN', process.env.STAKERBOT_DOWN_PRIVATE_KEY],
  ['RANGE', process.env.STAKERBOT_RANGE_PRIVATE_KEY],
].filter(([, k]) => !!k);

for (const [name, k] of keys) {
  try {
    const acct = privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k);
    const bal = await pub.readContract({ address: CIRBTC, abi: erc20, functionName: 'balanceOf', args: [acct.address] });
    if (bal <= 1000n) { console.log(name, acct.address, 'cirBTC', bal.toString(), '-> skip (dust)'); continue; }
    const send = bal - 1000n; // leave a little dust
    const wc = createWalletClient({ account: acct, chain, transport: http(RPC) });
    const tx = await wc.writeContract({ address: CIRBTC, abi: erc20, functionName: 'transfer', args: [ARB, send], ...GAS });
    await pub.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
    console.log(name, acct.address, 'sent', send.toString(), 'cirBTC -> arb; tx', tx);
  } catch (e) {
    console.log(name, 'ERROR', e?.message || String(e));
  }
}
const arbBal = await pub.readContract({ address: CIRBTC, abi: erc20, functionName: 'balanceOf', args: [ARB] });
console.log('ARB cirBTC now:', arbBal.toString());
