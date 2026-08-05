// abis/uniswapV3Pool.ts - token0/token1/fee for Arena-pool validation + wethIsToken0 ordering, PLUS
// slot0 (sqrtPriceX96/tick) + liquidity for the live exact-input swap quote (lib/swapQuote.ts reads
// the pool's current sqrt-price + full-range liquidity to preview the output client-side).
// Verified against out/UniswapV3Pool.sol/UniswapV3Pool.json (forge build).
export const uniswapV3PoolAbi = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'fee', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint24' }] },
  // slot0() - the swap form reads sqrtPriceX96 (Q64.96 spot) for the quote; the rest of the tuple is
  // decoded positionally by viem and unused here.
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [], outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' },
    { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ] },
  // liquidity() - the pool's current in-range (full-range, constant) active liquidity L for the quote.
  { type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint128' }] },
] as const;
