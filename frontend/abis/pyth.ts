// abis/pyth.ts - minimal IPyth surface used by the admin post-price cranks + the
// read-only oracle card. `getUpdateFee` prices a signed Hermes update; the value is
// paid alongside FeeArena.startEpoch/endEpoch (which forward it to Pyth). `getPriceUnsafe`
// reads the last on-chain price for the live display (price/conf are int64/uint64, expo
// is int32, publishTime is uint256 - all decode to bigint).
export const pythAbi = [
  { type: 'function', name: 'getUpdateFee', stateMutability: 'view',
    inputs: [{ name: 'updateData', type: 'bytes[]' }],
    outputs: [{ name: 'feeAmount', type: 'uint256' }] },
  { type: 'function', name: 'getPriceUnsafe', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [
      { name: 'price', type: 'int64' },
      { name: 'conf', type: 'uint64' },
      { name: 'expo', type: 'int32' },
      { name: 'publishTime', type: 'uint256' },
    ] },
] as const;
