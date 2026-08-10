// abis/nonfungiblePositionManager.ts — NPM surface used by the dashboard: positions(), collect(),
// decreaseLiquidity() + multicall() (withdraw / remove-liquidity), mint() (provide-liquidity / on-ramp),
// safeTransferFrom (4-arg, stake) + 3-arg, factory(), ERC721Enumerable. Verified against
// out/NonfungiblePositionManager.sol/NonfungiblePositionManager.json (forge build).
export const nonfungiblePositionManagerAbi = [
  // mint(MintParams) — open a new V3 position. payable (native is never sent for ERC20/ERC20 pools).
  { type: 'function', name: 'mint', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' }, { name: 'amount0Desired', type: 'uint256' },
      { name: 'amount1Desired', type: 'uint256' }, { name: 'amount0Min', type: 'uint256' },
      { name: 'amount1Min', type: 'uint256' }, { name: 'recipient', type: 'address' },
      { name: 'deadline', type: 'uint256' } ] }],
    outputs: [
      { name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' },
      { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' } ] },
  { type: 'function', name: 'positions', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' }, { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' } ] },
  { type: 'function', name: 'collect', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' },
      { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' } ] }],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  // decreaseLiquidity(DecreaseLiquidityParams) — burn `liquidity` from a position, crediting the
  // withdrawn token0/token1 to the position's tokensOwed (still INSIDE the NPM until collect()).
  { type: 'function', name: 'decreaseLiquidity', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' },
      { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' },
      { name: 'deadline', type: 'uint256' } ] }],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  // multicall(bytes[]) — atomically batch encoded NPM calls in one tx (decreaseLiquidity + collect).
  { type: 'function', name: 'multicall', stateMutability: 'payable',
    inputs: [{ name: 'data', type: 'bytes[]' }],
    outputs: [{ name: 'results', type: 'bytes[]' }] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
    inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' }, { name: 'data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'safeTransferFrom', stateMutability: 'nonpayable',
    inputs: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' }], outputs: [] },
  // ERC-721 OPERATOR APPROVAL. Required by the v2 stake: FeeArenaV2.stakeWithConviction has the ARENA
  // call NPM.safeTransferFrom(msg.sender, arena, tokenId, ...) (the arena PULLS the NFT — unlike v1
  // where the user pushes it), so the arena must be an approved operator first or the pull reverts with
  // "ERC721: transfer caller is not owner nor approved". setApprovalForAll (operator approval) persists
  // across stakes; per-token approve() is cleared when the NFT enters escrow, forcing re-approval each time.
  { type: 'function', name: 'setApprovalForAll', stateMutability: 'nonpayable',
    inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'operator', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'tokenOfOwnerByIndex', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }] },
  { type: 'event', name: 'Transfer', inputs: [
    { name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true } ] },
] as const;
