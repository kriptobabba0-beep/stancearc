// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockWBTC - minimal 8-decimal mintable ERC-20 mirroring real WBTC.
/// @notice The non-USDC base leg double for the BTC/USDC demo market. Mirrors mainnet WBTC's
///         8 decimals so pool price-init / seeding exercises the real decimal mismatch
///         (8-dp base vs 6-dp USDC). Mint is intentionally unguarded (test/demo only), like
///         {TestERC20}. Real broadcasts on Arc would instead use a canonical bridged WBTC.
contract MockWBTC is ERC20 {
    constructor() ERC20("Wrapped BTC", "WBTC") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
