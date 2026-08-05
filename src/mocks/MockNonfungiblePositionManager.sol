// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721ReceiverLike {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/// @notice Minimal test double for the Uniswap V3 NonfungiblePositionManager.
/// Returns the exact 12-field positions() tuple FeeArena reads and a configurable
/// collect() so the §3.1-step-7 fee-baseline reset can be exercised in unit tests.
contract MockNonfungiblePositionManager {
    bytes4 internal constant ERC721_RECEIVED = 0x150b7a02;

    // Default symmetric range for minted positions => tickSpan 12000. Non-zero so the
    // range-normalized contribution metric (liquidity * tickSpan) is non-zero and the
    // per-side ratio-based payout tests stay stable (a UNIFORM span cancels in ratios).
    int24 internal constant DEFAULT_TICK_LOWER = -6000;
    int24 internal constant DEFAULT_TICK_UPPER = 6000;

    /// @notice The uniform tickSpan (= tickUpper - tickLower) of a default-minted position.
    ///         Tests multiply expected liquidity by this to get expected contribution6.
    uint32 public constant DEFAULT_TICK_SPAN = 12000;

    struct Pos {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 owed0; // tokensOwed0 returned by collect (raw token0 units)
        uint128 owed1; // tokensOwed1 returned by collect (raw token1 units)
        bool collectReverts; // simulate a malicious/reverting collect()
    }

    address public immutable factory;
    address public immutable token0Default;
    uint256 public nextId = 1;

    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => Pos) internal _pos;
    mapping(uint256 => uint256) public collectCalls;

    constructor(
        address factory_,
        address /*pool*/
    ) {
        factory = factory_;
        token0Default = address(0);
    }

    function mintTo(address to, address t0, address t1, uint24 fee, uint128 liquidity) external returns (uint256 id) {
        // Mint with the DEFAULT symmetric range (span 12000) so every existing test gets a
        // uniform tickSpan and per-side payout RATIOS are preserved (span cancels).
        id = _mint(to, t0, t1, fee, liquidity, DEFAULT_TICK_LOWER, DEFAULT_TICK_UPPER);
    }

    /// @notice Mint with an EXPLICIT tick range so a test can pin a custom tickSpan
    ///         (= tickUpper - tickLower) for the range-normalization test.
    function mintToWithRange(
        address to,
        address t0,
        address t1,
        uint24 fee,
        uint128 liquidity,
        int24 tickLower,
        int24 tickUpper
    ) external returns (uint256 id) {
        id = _mint(to, t0, t1, fee, liquidity, tickLower, tickUpper);
    }

    function _mint(address to, address t0, address t1, uint24 fee, uint128 liquidity, int24 tickLower, int24 tickUpper)
        internal
        returns (uint256 id)
    {
        id = nextId++;
        ownerOf[id] = to;
        _pos[id] = Pos({
            token0: t0,
            token1: t1,
            fee: fee,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            owed0: 0,
            owed1: 0,
            collectReverts: false
        });
    }

    function setOwed(uint256 id, uint128 owed0_, uint128 owed1_) external {
        _pos[id].owed0 = owed0_;
        _pos[id].owed1 = owed1_;
    }

    function setCollectReverts(uint256 id, bool v) external {
        _pos[id].collectReverts = v;
    }

    function positions(uint256 id)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        Pos memory p = _pos[id];
        return (0, address(0), p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.liquidity, 0, 0, p.owed0, p.owed1);
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    /// @notice Returns the currently-owed amounts (capped at max) and zeroes them, mimicking V3.
    function collect(CollectParams calldata params) external returns (uint256 amount0, uint256 amount1) {
        Pos storage p = _pos[params.tokenId];
        require(!p.collectReverts, "MockNPM: collect revert");
        collectCalls[params.tokenId] += 1;
        amount0 = p.owed0 < params.amount0Max ? p.owed0 : params.amount0Max;
        amount1 = p.owed1 < params.amount1Max ? p.owed1 : params.amount1Max;
        p.owed0 = 0;
        p.owed1 = 0;
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes calldata data) external {
        require(ownerOf[id] == from, "MockNPM: not owner");
        ownerOf[id] = to;
        if (_isContract(to)) {
            bytes4 ret = IERC721ReceiverLike(to).onERC721Received(msg.sender, from, id, data);
            require(ret == ERC721_RECEIVED, "MockNPM: bad receiver");
        }
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "MockNPM: not owner");
        ownerOf[id] = to;
        if (_isContract(to)) {
            bytes4 ret = IERC721ReceiverLike(to).onERC721Received(msg.sender, from, id, "");
            require(ret == ERC721_RECEIVED, "MockNPM: bad receiver");
        }
    }

    function _isContract(address a) internal view returns (bool) {
        return a.code.length > 0;
    }
}
