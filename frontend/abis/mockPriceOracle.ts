// abis/mockPriceOracle.ts - IPriceOracle + MockPriceOracle (V0). price18 = 18dp (1e18 == $1).
// Verified against out/MockPriceOracle.sol/MockPriceOracle.json (forge build).
export const mockPriceOracleAbi = [
  { type: 'function', name: 'getPrice', stateMutability: 'view', inputs: [],
    outputs: [{ name: 'price18', type: 'uint256' }, { name: 'updatedAt', type: 'uint256' }] },
  { type: 'function', name: 'update', stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [] },
  { type: 'function', name: 'setPrice', stateMutability: 'nonpayable',
    inputs: [{ name: 'price18', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'event', name: 'PriceSet', inputs: [
    { name: 'price18', type: 'uint256', indexed: false }, { name: 'updatedAt', type: 'uint256', indexed: false } ] },
] as const;
