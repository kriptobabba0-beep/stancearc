// abis/uniswapV3Factory.ts - getPool(t0,t1,fee) for pool validation (factory.getPool == POOL).
// Verified against out/UniswapV3Factory.sol/UniswapV3Factory.json (forge build).
export const uniswapV3FactoryAbi = [
  { type: 'function', name: 'getPool', stateMutability: 'view',
    inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }, { name: 'fee', type: 'uint24' }],
    outputs: [{ name: 'pool', type: 'address' }] },
] as const;
