// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title LinqaGame
/// @notice TESTNET_SIMULATION_MODE: commit-reveal randomness using block prevrandao + player secret.
/// @dev This mode is not provably fair and is intended for Arc testnet simulation only.
contract LinqaGame is Ownable, ReentrancyGuard {
    error ZeroAddress();
    error AlreadyActiveRound();
    error NoActiveRound();
    error InvalidTileIndex();
    error InvalidCommitHash();
    error CommitMismatch();
    error ResultPending();
    error NotPending();
    error InsufficientLiquidity();
    error InsufficientContractBalance();
    error RoundNotActive();
    error MainnetDisabled();
    error TestnetOnly();
    error StakeTooLow();
    error StakeExceedsMax();
    error TokenTransferFailed();
    error InvalidSessionKey();
    error InvalidRelaySignature();
    error InvalidRelayNonce();
    error RelayDeadlineExpired();

    uint256 public constant MIN_STAKE = 500_000; // 0.50 USDC (6 decimals)
    uint256 public constant MAX_STAKE = 10_000e6; // 10,000 USDC (6 decimals)
    uint256 public constant WAD = 1e18;
    uint256 public constant BASE_MULTIPLIER = 920000000000000000; // 0.92 WAD; 8% house edge
    uint256 public constant TOTAL_ROWS = 27; // Keeps the configured ladder below the 10,000x cap.
    uint256 public constant GAME_VERSION = 4;
    uint8 private constant RELAY_SELECT_TILE = 1;
    uint8 private constant RELAY_CASH_OUT = 2;
    uint256 private constant RELAY_DEADLINE_WINDOW = 5 minutes;
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant RELAY_ACTION_TYPEHASH = keccak256(
        "RelayAction(address player,uint256 roundId,uint8 action,uint8 tileIndex,bytes32 secret,bytes32 nextCommitHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant NAME_HASH = keccak256("LinqaGame");
    bytes32 private constant VERSION_HASH = keccak256("4");

    // The first 27 rows of the configured [4,2,4,3,4,4,5,6] repeat are playable.
    uint8[27] public rowSequence = [
        4, 2, 4, 3, 4, 4, 5, 6,
        4, 2, 4, 3, 4, 4, 5, 6,
        4, 2, 4, 3, 4, 4, 5, 6,
        4, 2, 4
    ];

    IERC20 public immutable usdc;

    /// @notice TESTNET_SIMULATION_MODE gate. Monetary play is blocked if false.
    bool public isTestnetSimulation;

    uint256 public reservedFunds;

    uint256 private _nextRoundId = 1;

    enum RoundStatus {
        None,
        Active,
        Won,
        Lost
    }

    struct Round {
        uint256 roundId;
        address player;
        uint256 stake;
        uint256 rowIndex;
        uint256 multiplierWAD;
        RoundStatus status;
        bytes32 commitHash;
        bool rowResultPending;
        uint8 losingTile;
        uint8 selectedTile;
        bool wasSafe;
    }

    mapping(uint256 => Round) private rounds;
    mapping(address => uint256) public activeRound;
    mapping(uint256 => uint256) private reservedByRound;
    /// @notice Per-round temporary signer. It can only select tiles or cash out that round.
    mapping(uint256 => address) public sessionKeyForRound;
    mapping(uint256 => uint256) public relayNonceForRound;

    event RoundStarted(uint256 indexed roundId, address indexed player, uint256 stake);
    event TileSelected(
        uint256 indexed roundId,
        address indexed player,
        uint256 rowIndex,
        uint8 tileIndex,
        bool safe,
        uint8 losingTile,
        uint256 newMultiplierWAD
    );
    event CashedOut(uint256 indexed roundId, address indexed player, uint256 payout, uint256 multiplierWAD);
    event RoundLost(uint256 indexed roundId, address indexed player, uint256 stake, uint256 rowIndex);
    event LiquidityAdded(address indexed provider, uint256 amount);
    event LiquidityRemoved(address indexed owner, uint256 amount);
    event SessionKeyRegistered(uint256 indexed roundId, address indexed player, address indexed sessionKey);

    constructor(address _usdc, address _owner) Ownable(_owner) {
        if (block.chainid != 5_042_002) revert TestnetOnly();
        if (_usdc == address(0) || _owner == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        isTestnetSimulation = true;
    }

    function gameVersion() external pure returns (uint256) {
        return GAME_VERSION;
    }

    function startRound(uint256 stakeAmount, bytes32 commitHash) external nonReentrant {
        _startRound(stakeAmount, commitHash, msg.sender);
    }

    /// @notice Starts a staked round and binds a temporary key for gas-sponsored gameplay.
    /// @dev The session key cannot start rounds, approve tokens, or transfer funds outside this round.
    function startRoundWithSession(uint256 stakeAmount, bytes32 commitHash, address sessionKey) external nonReentrant {
        if (sessionKey == address(0)) revert InvalidSessionKey();
        _startRound(stakeAmount, commitHash, sessionKey);
    }

    function _startRound(uint256 stakeAmount, bytes32 commitHash, address sessionKey) internal {
        if (!isTestnetSimulation) revert MainnetDisabled();
        if (activeRound[msg.sender] != 0) revert AlreadyActiveRound();
        if (commitHash == bytes32(0)) revert InvalidCommitHash();
        if (stakeAmount < MIN_STAKE) revert StakeTooLow();
        if (stakeAmount > MAX_STAKE) revert StakeExceedsMax();

        uint256 initialPayout = (stakeAmount * BASE_MULTIPLIER) / WAD;
        uint256 available = _availableLiquidity();
        if (available < initialPayout) revert InsufficientLiquidity();

        uint256 roundId = _nextRoundId;
        _nextRoundId = roundId + 1;

        Round storage r = rounds[roundId];
        r.roundId = roundId;
        r.player = msg.sender;
        r.stake = stakeAmount;
        r.rowIndex = 0;
        r.multiplierWAD = BASE_MULTIPLIER;
        r.status = RoundStatus.Active;
        r.commitHash = commitHash;
        r.rowResultPending = false;
        r.losingTile = 0;
        r.selectedTile = 0;
        r.wasSafe = false;

        activeRound[msg.sender] = roundId;
        sessionKeyForRound[roundId] = sessionKey;
        reservedByRound[roundId] = initialPayout;
        reservedFunds += initialPayout;

        if (!usdc.transferFrom(msg.sender, address(this), stakeAmount)) revert TokenTransferFailed();

        emit RoundStarted(roundId, msg.sender, stakeAmount);
        if (sessionKey != msg.sender) emit SessionKeyRegistered(roundId, msg.sender, sessionKey);
    }

    function selectTile(uint8 tileIndex, bytes32 secret) external nonReentrant {
        uint256 roundId = activeRound[msg.sender];
        if (roundId == 0) revert NoActiveRound();

        _selectTile(msg.sender, roundId, tileIndex, secret, bytes32(0), false);
    }

    /// @notice Relayed tile selection. A round-scoped session key signs the exact action.
    /// @dev Safe picks advance the row atomically, so one relayed transaction completes the pick.
    function relaySelectTile(
        address player,
        uint8 tileIndex,
        bytes32 secret,
        bytes32 nextCommitHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        uint256 roundId = activeRound[player];
        if (roundId == 0) revert NoActiveRound();
        _verifyRelayAction(player, roundId, RELAY_SELECT_TILE, tileIndex, secret, nextCommitHash, nonce, deadline, signature);
        relayNonceForRound[roundId] = nonce + 1;
        _selectTile(player, roundId, tileIndex, secret, nextCommitHash, true);
    }

    function _selectTile(
        address player,
        uint256 roundId,
        uint8 tileIndex,
        bytes32 secret,
        bytes32 nextCommitHash,
        bool advanceAfterSafePick
    ) internal {

        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active) revert RoundNotActive();
        if (r.rowResultPending) revert ResultPending();

        uint8 tileCount = getRowTileCount(r.rowIndex);
        if (tileIndex >= tileCount) revert InvalidTileIndex();

        if (keccak256(abi.encodePacked(secret)) != r.commitHash) revert CommitMismatch();
        if (advanceAfterSafePick && nextCommitHash == bytes32(0)) revert InvalidCommitHash();

        // Reserve the next possible cash-out before revealing the outcome. If the
        // pool cannot cover it, the player can still cash out at the current row.
        uint256 nextMultiplier = (r.multiplierWAD * tileCount) / (tileCount - 1);
        uint256 nextPayout = (r.stake * nextMultiplier) / WAD;
        uint256 currentReservation = reservedByRound[roundId];
        if (nextPayout > currentReservation) {
            uint256 additionalReservation = nextPayout - currentReservation;
            if (_availableLiquidity() < additionalReservation) revert InsufficientLiquidity();
            reservedByRound[roundId] = nextPayout;
            reservedFunds += additionalReservation;
        }

        uint8 losingTile = uint8(
            uint256(
                keccak256(
                    abi.encodePacked(
                        block.prevrandao,
                        secret,
                        player,
                        roundId
                    )
                )
            ) % tileCount
        );

        r.selectedTile = tileIndex;
        r.losingTile = losingTile;

        if (tileIndex == losingTile) {
            r.wasSafe = false;
            r.status = RoundStatus.Lost;
            r.rowResultPending = false;

            _releaseReservation(roundId);
            activeRound[player] = 0;

            emit TileSelected(roundId, player, r.rowIndex, tileIndex, false, losingTile, r.multiplierWAD);
            emit RoundLost(roundId, player, r.stake, r.rowIndex);
            return;
        }

        r.wasSafe = true;
        uint256 newMultiplier = (r.multiplierWAD * tileCount) / (tileCount - 1);
        r.multiplierWAD = newMultiplier;

        if (r.rowIndex + 1 >= TOTAL_ROWS) {
            r.status = RoundStatus.Won;
            r.rowResultPending = false;
        } else if (advanceAfterSafePick) {
            unchecked {
                r.rowIndex += 1;
            }
            r.commitHash = nextCommitHash;
            r.rowResultPending = false;
        } else {
            r.rowResultPending = true;
        }

        // The event records the row that was actually selected, including when the
        // contract atomically moves the round to the next row.
        uint256 selectedRowIndex = advanceAfterSafePick && r.status != RoundStatus.Won ? r.rowIndex - 1 : r.rowIndex;
        emit TileSelected(roundId, player, selectedRowIndex, tileIndex, true, losingTile, newMultiplier);
    }

    function advanceRow(bytes32 newCommitHash) external {
        uint256 roundId = activeRound[msg.sender];
        if (roundId == 0) revert NoActiveRound();
        if (newCommitHash == bytes32(0)) revert InvalidCommitHash();

        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active) revert RoundNotActive();
        if (!r.rowResultPending) revert NotPending();

        unchecked {
            r.rowIndex += 1;
        }
        r.commitHash = newCommitHash;
        r.rowResultPending = false;
    }

    function cashOut() external nonReentrant {
        _cashOut(msg.sender);
    }

    /// @notice Relayed cash out. Payout always goes to the round's original wallet.
    function relayCashOut(
        address player,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external nonReentrant {
        uint256 roundId = activeRound[player];
        if (roundId == 0) revert NoActiveRound();
        _verifyRelayAction(player, roundId, RELAY_CASH_OUT, 0, bytes32(0), bytes32(0), nonce, deadline, signature);
        relayNonceForRound[roundId] = nonce + 1;
        _cashOut(player);
    }

    function _cashOut(address player) internal {
        uint256 roundId = activeRound[player];
        if (roundId == 0) revert NoActiveRound();

        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active && r.status != RoundStatus.Won) revert RoundNotActive();
        if (r.rowResultPending) revert ResultPending();

        uint256 payout = (r.stake * r.multiplierWAD) / WAD;
        if (usdc.balanceOf(address(this)) < payout) revert InsufficientContractBalance();

        r.status = RoundStatus.Won;

        _releaseReservation(roundId);
        activeRound[player] = 0;

        if (!usdc.transfer(player, payout)) revert TokenTransferFailed();

        emit CashedOut(roundId, player, payout, r.multiplierWAD);
    }

    function getRelayNonce(uint256 roundId) external view returns (uint256) {
        return relayNonceForRound[roundId];
    }

    function _verifyRelayAction(
        address player,
        uint256 roundId,
        uint8 action,
        uint8 tileIndex,
        bytes32 secret,
        bytes32 nextCommitHash,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) internal view {
        if (deadline < block.timestamp || deadline > block.timestamp + RELAY_DEADLINE_WINDOW) revert RelayDeadlineExpired();
        if (nonce != relayNonceForRound[roundId]) revert InvalidRelayNonce();
        address sessionKey = sessionKeyForRound[roundId];
        if (sessionKey == address(0)) revert InvalidSessionKey();
        bytes32 domainSeparator = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            NAME_HASH,
            VERSION_HASH,
            block.chainid,
            address(this)
        ));
        bytes32 structHash = keccak256(abi.encode(
            RELAY_ACTION_TYPEHASH,
            player,
            roundId,
            action,
            tileIndex,
            secret,
            nextCommitHash,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        if (ECDSA.recover(digest, signature) != sessionKey) revert InvalidRelaySignature();
    }

    function addLiquidity(uint256 amount) external onlyOwner nonReentrant {
        if (!usdc.transferFrom(msg.sender, address(this), amount)) revert TokenTransferFailed();
        emit LiquidityAdded(msg.sender, amount);
    }

    function removeLiquidity(uint256 amount) external onlyOwner nonReentrant {
        if (_availableLiquidity() < amount) revert InsufficientLiquidity();
        if (!usdc.transfer(owner(), amount)) revert TokenTransferFailed();
        emit LiquidityRemoved(owner(), amount);
    }

    function getActiveRound(address player) external view returns (Round memory) {
        return rounds[activeRound[player]];
    }

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function getRowTileCount(uint256 rowIndex) public pure returns (uint8) {
        uint256 i = rowIndex % 8;
        if (i == 0) return 4;
        if (i == 1) return 2;
        if (i == 2) return 4;
        if (i == 3) return 3;
        if (i == 4) return 4;
        if (i == 5) return 4;
        if (i == 6) return 5;
        return 6;
    }

    function getMultiplierAtRow(uint256 rowIndex) external pure returns (uint256 multiplierWAD) {
        multiplierWAD = BASE_MULTIPLIER;
        for (uint256 i = 0; i <= rowIndex; i++) {
            uint8 tileCount = getRowTileCount(i);
            multiplierWAD = (multiplierWAD * tileCount) / (tileCount - 1);
        }
    }

    function getMaxMultiplierWAD() external pure returns (uint256) {
        return _getMaxMultiplierWAD();
    }

    function getReservedFunds() external view returns (uint256) {
        return reservedFunds;
    }

    function getAvailableLiquidity() external view returns (uint256) {
        return _availableLiquidity();
    }

    function _getMaxMultiplierWAD() internal pure returns (uint256 multiplierWAD) {
        multiplierWAD = BASE_MULTIPLIER;
        for (uint256 i = 0; i < TOTAL_ROWS; i++) {
            uint8 tileCount = getRowTileCount(i);
            multiplierWAD = (multiplierWAD * tileCount) / (tileCount - 1);
        }
    }

    function _availableLiquidity() internal view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance <= reservedFunds) {
            return 0;
        }
        return balance - reservedFunds;
    }

    function _releaseReservation(uint256 roundId) internal {
        uint256 reserved = reservedByRound[roundId];
        if (reserved != 0) {
            reservedByRound[roundId] = 0;
            reservedFunds -= reserved;
        }
    }
}
