// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IUnstakeTarget {
    function unstake(uint256 tokenId) external;
}

/// @notice Re-entry probe: on receiving the NFT back during unstake(), tries to call
/// unstake() again. FeeArena's nonReentrant guard must cause the inner call to revert,
/// which (because the mock NPM requires the selector) aborts the whole transfer.
contract MaliciousReceiver {
    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;
    IUnstakeTarget public arena;
    uint256 public reenterTokenId;
    bool public armed;

    function arm(address arena_, uint256 tokenId) external {
        arena = IUnstakeTarget(arena_);
        reenterTokenId = tokenId;
        armed = true;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (armed) {
            armed = false; // single shot
            arena.unstake(reenterTokenId); // expected to revert (ReentrancyGuard)
        }
        return ERC721_RECEIVED;
    }
}
