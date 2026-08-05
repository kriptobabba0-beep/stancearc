// One-shot surgical re-peg. Sells cirBTC into a pool with sqrtPriceLimitX96 pinned at the
// oracle, so the swap walks the price down to the target and STOPS - consuming only what's
// needed, never overshooting. Runs INSIDE the arb container (reads KEEPER_ARB_PRIVATE_KEY
// from env; the key is never printed). MARKET=usdc|eurc picks the pool; EXECUTE=1 sends.
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC = process.env.RPC || 'https://rpc.testnet.arc.network';
const CIRBTC = '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF';
const ROUTER = '0x7fcEF1330B4C21f884D6894f3d6a56036E587aA9';
const MARKETS = {
  usdc: { pool: '0x969f2e3CB9929b5D50B6A59Cf49CF30870e1658b', quote: '0x3600000000000000000000000000000000000000', qd: 6, sym: 'USDC' },
  eurc: { pool: '0xEBCc92862e007220A90b407f92E90dAC3A98aD63', quote: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a', qd: 6, sym: 'EURC' },
};
const which = (process.env.MARKET || 'usdc').toLowerCase();
const M = MARKETS[which];
if (!M) throw new Error(`bad MARKET=${which}`);
const TARGET18 = BigInt(process.env.TARGET18 || '58533522014350000000000'); // USDC-per-cirBTC, 18dp
const EXECUTE = process.env.EXECUTE === '1';
const BD = 8; // cirBTC decimals

const Q96 = 1n << 96n, ONE18 = 10n ** 18n;
function isqrt(x){ if(x<2n) return x; let lo=1n,hi=x; while(lo<hi){const m=(lo+hi+1n)>>1n; if(m*m<=x)lo=m; else hi=m-1n;} return lo; }
// base = token1 in both pools (cirBTC addr > quote addr) => baseIsToken0 = false.
function p18ToSqrt(p18){ const bs=10n**BigInt(BD), qs=10n**BigInt(M.qd); const sp2=(Q96*Q96*bs*ONE18)/(p18*qs); return isqrt(sp2); }
function sqrtToP18(s){ const sp2=s*s, bs=10n**BigInt(BD), qs=10n**BigInt(M.qd); return (Q96*Q96*bs*ONE18)/(sp2*qs); }
function fmt(v,dp){ const d=10n**BigInt(dp); return `${v/d}.${(v%d).toString().padStart(dp,'0').slice(0,8)}`; }

const slot0Abi = [{ type:'function', name:'slot0', stateMutability:'view', inputs:[], outputs:[
  {type:'uint160'},{type:'int24'},{type:'uint16'},{type:'uint16'},{type:'uint16'},{type:'uint8'},{type:'bool'}] }];
const erc20Abi = [{ type:'function', name:'balanceOf', stateMutability:'view', inputs:[{type:'address'}], outputs:[{type:'uint256'}] }];
const routerAbi = [{ type:'function', name:'exactInputSingle', stateMutability:'payable',
  inputs:[{ type:'tuple', components:[
    {name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},
    {name:'recipient',type:'address'},{name:'deadline',type:'uint256'},{name:'amountIn',type:'uint256'},
    {name:'amountOutMinimum',type:'uint256'},{name:'sqrtPriceLimitX96',type:'uint160'}] }],
  outputs:[{type:'uint256'}] }];

const account = privateKeyToAccount(process.env.KEEPER_ARB_PRIVATE_KEY);
const chainId = 5042002;
const chain = defineChain({ id: chainId, name:`arc-${chainId}`, nativeCurrency:{name:'USDC',symbol:'USDC',decimals:18}, rpcUrls:{ default:{ http:[RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 15000 }) });
const wal = createWalletClient({ account, chain, transport: http(RPC, { timeout: 15000 }) });

const slot0 = await pub.readContract({ address: M.pool, abi: slot0Abi, functionName:'slot0' });
const sqrtCur = slot0[0];
const curP18 = sqrtToP18(sqrtCur);
const sqrtTarget = p18ToSqrt(TARGET18);
const cirBal = await pub.readContract({ address: CIRBTC, abi: erc20Abi, functionName:'balanceOf', args:[account.address] });

console.log(JSON.stringify({
  market: which, wallet: account.address, pool: M.pool,
  poolPriceNow: '$'+fmt(curP18,18), target: '$'+fmt(TARGET18,18),
  sqrtCur: sqrtCur.toString(), sqrtTarget: sqrtTarget.toString(),
  cirBTCbalance: fmt(cirBal,8),
  willSell_capped_at_balance: fmt(cirBal,8),
  note: sqrtTarget > sqrtCur ? 'OK: selling cirBTC raises sqrt toward target (price falls)' : 'WARN: target not below current!',
  mode: EXECUTE ? 'EXECUTE' : 'DRY-RUN (nothing sent)',
}, null, 2));

if (!EXECUTE) { console.log('dry-run complete - re-run with EXECUTE=1 to send'); process.exit(0); }
if (sqrtTarget <= sqrtCur) { console.log('ABORT: target sqrt not above current; pool already at/below target'); process.exit(0); }
if (cirBal <= 0n) { console.log('ABORT: wallet holds no cirBTC'); process.exit(0); }

const gwei = 1000000000n;
const hash = await wal.writeContract({
  address: ROUTER, abi: routerAbi, functionName:'exactInputSingle', account, chain,
  maxFeePerGas: 60n*gwei, maxPriorityFeePerGas: 60n*gwei,
  args: [{ tokenIn: CIRBTC, tokenOut: M.quote, fee: 3000, recipient: account.address,
    deadline: BigInt(Math.floor(Date.now()/1000) + 120), amountIn: cirBal,
    amountOutMinimum: 0n, sqrtPriceLimitX96: sqrtTarget }],
});
console.log('sent tx:', hash);
const rcpt = await pub.waitForTransactionReceipt({ hash, timeout: 60000 });
const slot0b = await pub.readContract({ address: M.pool, abi: slot0Abi, functionName:'slot0' });
const afterP18 = sqrtToP18(slot0b[0]);
const cirAfter = await pub.readContract({ address: CIRBTC, abi: erc20Abi, functionName:'balanceOf', args:[account.address] });
console.log(JSON.stringify({
  status: rcpt.status, txHash: hash,
  poolPriceAfter: '$'+fmt(afterP18,18),
  cirBTCspent: fmt(cirBal - cirAfter, 8), cirBTCremaining: fmt(cirAfter,8),
}, null, 2));
