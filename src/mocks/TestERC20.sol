// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestERC20 - generic mintable, configurable-decimals ERC-20 for unit tests.
/// @notice Used as the LOCAL USDC double (6 decimals) in unit tests. On fork/deploy the
///         REAL testnet ERC-20 USDC at 0x3600000000000000000000000000000000000000 is used
///         instead (read its decimals(), assert ==6). Mint is intentionally unguarded (test-only).
contract TestERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
