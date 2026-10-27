// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {LinqaGame} from "../LinqaGame.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev We etch MockERC20 bytecode onto the canonical Arc-testnet USDC address so
///      LinqaGame's hardcoded `usdc` constant resolves to a working ERC-20.
contract LinqaGameTest is Test {
    // ────────────────────────────────────────────────────────────
    // Constants matching the contract
    // ────────────────────────────────────────────────────────────
    address internal constant USDC_ADDR = 0x3600000000000000000000000000000000000000;

    uint256 internal constant MIN_STAKE = 500_000;
    uint256 internal constant MAX_STAKE = 10_000e6;
    uint256 internal constant WAD       = 1e18;

    // Enough initial liquidity for all tests, including fuzz stakes and full-row reserves.
    uint256 internal constant INITIAL_LIQUIDITY = 500e6;

    // ────────────────────────────────────────────────────────────
    // Test actors
    // ────────────────────────────────────────────────────────────
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob   = makeAddr("bob");
    address internal relayer = makeAddr("relayer");
    uint256 internal constant SESSION_KEY_PRIVATE_KEY = 0xA11CE;

    // ────────────────────────────────────────────────────────────
    // Shared fixtures
    // ────────────────────────────────────────────────────────────
    MockERC20    internal usdc;
    LinqaGame    internal game;

    // Default commit-reveal pair used by most tests.
    bytes32 internal constant SECRET      = bytes32("test_secret_1");
    bytes32 internal          COMMIT_HASH = keccak256(abi.encodePacked(SECRET));

    // ────────────────────────────────────────────────────────────
    // setUp – runs before every test function
    // ────────────────────────────────────────────────────────────
    function setUp() public {
        vm.chainId(5_042_002);

        // 1. Deploy a MockERC20 at a throwaway address.
        MockERC20 mockImpl = new MockERC20("Mock USDC", "mUSDC", 6);

        // 2. Etch its runtime bytecode at the canonical USDC address.
        vm.etch(USDC_ADDR, address(mockImpl).code);
        usdc = MockERC20(USDC_ADDR);

        // 3. Deploy the game (constructor takes usdc + owner).
        game = new LinqaGame(USDC_ADDR, owner);

        // 4. Seed owner with liquidity and add it to the contract.
        usdc.mint(owner, INITIAL_LIQUIDITY);
        vm.startPrank(owner);
        usdc.approve(address(game), INITIAL_LIQUIDITY);
        game.addLiquidity(INITIAL_LIQUIDITY);
        vm.stopPrank();

        // 5. Give alice a comfortable stake budget.
        usdc.mint(alice, MAX_STAKE * 10);
        vm.prank(alice);
        usdc.approve(address(game), type(uint256).max);

        // 6. Give bob a stake budget.
        usdc.mint(bob, MAX_STAKE * 10);
        vm.prank(bob);
        usdc.approve(address(game), type(uint256).max);

    // 7. Start at a non-genesis block for realistic test execution.
        vm.roll(100);
    }

    // ══════════════════════════════════════════════════════════════
    // Helper: compute losing tile the same way the contract does.
    // ══════════════════════════════════════════════════════════════
    function _losingTile(
        bytes32 secret,
        address player,
        uint256 roundId,
        uint8   tileCount
    ) internal view returns (uint8) {
        return uint8(
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
    }

    // ══════════════════════════════════════════════════════════════
    // Helper: start a round for alice and return the roundId.
    // ══════════════════════════════════════════════════════════════
    function _startRound(uint256 stake) internal returns (uint256 roundId) {
        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        roundId = game.activeRound(alice);
    }

    function _relaySignature(
        uint256 roundId,
        uint8 action,
        uint8 tileIndex,
        bytes32 secret,
        bytes32 nextCommitHash,
        uint256 nonce,
        uint256 deadline
    ) internal returns (bytes memory signature) {
        bytes32 domainSeparator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("LinqaGame"),
            keccak256("4"),
            block.chainid,
            address(game)
        ));
        bytes32 structHash = keccak256(abi.encode(
            keccak256("RelayAction(address player,uint256 roundId,uint8 action,uint8 tileIndex,bytes32 secret,bytes32 nextCommitHash,uint256 nonce,uint256 deadline)"),
            alice,
            roundId,
            action,
            tileIndex,
            secret,
            nextCommitHash,
            nonce,
            deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY_PRIVATE_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    // ──────────────────────────────────────────────────────────────
    //  1. MULTIPLIER CALCULATIONS
    // ──────────────────────────────────────────────────────────────

    function test_MultiplierRow0() public view {
        // Row 0: T=4, multiplier = 0.92e18 * 4/3 = 1226666666666666666
        uint256 m = game.getMultiplierAtRow(0);
        // Allow ±2 wei rounding tolerance.
        assertApproxEqAbs(m, 1_226_666_666_666_666_666, 2);
    }

    function test_MultiplierRow1() public view {
        // Row 1: T=2, multiplier_row1 = m_row0 * 2/1
        // = 1226666666666666666 * 2 = 2453333333333333332
        uint256 m = game.getMultiplierAtRow(1);
        assertApproxEqAbs(m, 2_453_333_333_333_333_332, 2);
    }

    function test_MultiplierRow2() public view {
        // Row 2: T=4, multiplier_row2 = m_row1 * 4/3
        // = 2453333333333333332 * 4 / 3 = 3271111111111111109
        uint256 m = game.getMultiplierAtRow(2);
        assertApproxEqAbs(m, 3_271_111_111_111_111_109, 2);
    }

    function test_MultiplierRow3() public view {
        // Row 3: T=3, multiplier_row3 = m_row2 * 3/2
        // = 3271111111111111109 * 3 / 2 = 4906666666666666663
        uint256 m = game.getMultiplierAtRow(3);
        assertApproxEqAbs(m, 4_906_666_666_666_666_663, 2);
    }

    function test_MultiplierMonotonicallyIncreases() public view {
        // Each row's multiplier must be strictly greater than the previous.
        uint256 prev = 0;
        for (uint256 i = 0; i < 8; i++) {
            uint256 m = game.getMultiplierAtRow(i);
            assertGt(m, prev, "multiplier not increasing");
            prev = m;
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  2. ROW TILE COUNTS
    // ──────────────────────────────────────────────────────────────

    function test_RowTileCountsBasePattern() public view {
        uint8[8] memory expected = [4, 2, 4, 3, 4, 4, 5, 6];
        for (uint256 i = 0; i < 8; i++) {
            assertEq(game.getRowTileCount(i), expected[i], "base pattern mismatch");
        }
    }

    function test_RowTileCountsRepeatsAt8() public view {
        // Indices 8–15 must equal indices 0–7.
        for (uint256 i = 0; i < 8; i++) {
            assertEq(
                game.getRowTileCount(i + 8),
                game.getRowTileCount(i),
                "repeat mismatch"
            );
        }
    }

    function test_RowTileCountsRepeatsAt16() public view {
        for (uint256 i = 0; i < 8; i++) {
            assertEq(
                game.getRowTileCount(i + 16),
                game.getRowTileCount(i),
                "second repeat mismatch"
            );
        }
    }

    // ──────────────────────────────────────────────────────────────
    //  3. FULL ROUND: start → safe tile → advance → cashout
    // ──────────────────────────────────────────────────────────────

    function test_FullRound_SafeThenCashOut() public {
        uint256 stake = MIN_STAKE; // 0.50 USDC (6 decimals)

        // Start round.
        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        // Advance one block to exercise a later test block context.
        vm.roll(block.number + 1);

        // Compute the losing tile at current block for row 0 (T=4).
        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);

        // Pick a SAFE tile (anything != losing).
        uint8 safeTile = (losing + 1) % tileCount;

        // Emit expectations for TileSelected.
        // multiplierWAD after row-0 safe = 0.92e18 * 4/3.
        uint256 expectedMult = (uint256(920_000_000_000_000_000) * 4) / 3;

        vm.expectEmit(true, true, false, true, address(game));
        emit LinqaGame.TileSelected(roundId, alice, 0, safeTile, true, losing, expectedMult);

        vm.prank(alice);
        game.selectTile(safeTile, SECRET);

        // rowResultPending should be true now; round still active.
        LinqaGame.Round memory r = game.getActiveRound(alice);
        assertTrue(r.rowResultPending, "rowResultPending should be true after safe tile");
        assertEq(r.rowIndex, 0, "rowIndex still 0 before advance");
        assertEq(r.multiplierWAD, expectedMult, "multiplier after row 0");

        // Advance to row 1 with a new commit.
        bytes32 secret2 = bytes32("test_secret_2");
        bytes32 commit2 = keccak256(abi.encodePacked(secret2));
        vm.prank(alice);
        game.advanceRow(commit2);

        r = game.getActiveRound(alice);
        assertEq(r.rowIndex, 1, "rowIndex should be 1 after advance");
        assertFalse(r.rowResultPending, "rowResultPending should be false after advance");

        // Cash out; payout = stake * multiplierWAD / WAD.
        uint256 expectedPayout = (stake * expectedMult) / WAD;
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(game));
        emit LinqaGame.CashedOut(roundId, alice, expectedPayout, expectedMult);

        vm.prank(alice);
        game.cashOut();

        uint256 aliceAfter = usdc.balanceOf(alice);
        assertEq(aliceAfter - aliceBefore, expectedPayout, "alice did not receive payout");
        assertEq(game.activeRound(alice), 0, "activeRound should be 0 after cashout");
        assertGe(expectedPayout, stake, "payout should be >= stake (multiplier >= 1)");
    }

    // ──────────────────────────────────────────────────────────────
    //  4. FULL ROUND: start → select losing tile → RoundLost
    // ──────────────────────────────────────────────────────────────

    function test_FullRound_LosingTile() public {
        uint256 stake = MIN_STAKE;

        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        vm.roll(block.number + 1);

        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);

        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(game));
        emit LinqaGame.TileSelected(
            roundId, alice, 0, losing, false, losing, 920_000_000_000_000_000
        );
        vm.expectEmit(true, true, false, true, address(game));
        emit LinqaGame.RoundLost(roundId, alice, stake, 0);

        vm.prank(alice);
        game.selectTile(losing, SECRET);

        // Player gets no payout.
        uint256 aliceAfter = usdc.balanceOf(alice);
        assertEq(aliceAfter, aliceBefore, "alice should receive nothing on loss");

        // activeRound cleared.
        assertEq(game.activeRound(alice), 0, "activeRound should be 0 after loss");

        // Round status is Lost.
        LinqaGame.Round memory r = game.getRound(roundId);
        assertEq(uint8(r.status), uint8(LinqaGame.RoundStatus.Lost), "status should be Lost");
    }

    // ──────────────────────────────────────────────────────────────
    //  5. BOARD PROGRESSION — 2 safe rows, rowIndex + multiplier
    // ──────────────────────────────────────────────────────────────

    function test_BoardProgression_TwoSafeRows() public {
        uint256 stake = MIN_STAKE;

        // ── Row 0 ────────────────────────────────────────────────
        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        vm.roll(block.number + 1);

        uint8 tc0 = game.getRowTileCount(0); // 4
        uint8 losing0 = _losingTile(SECRET, alice, roundId, tc0);
        uint8 safe0 = (losing0 + 1) % tc0;

        vm.prank(alice);
        game.selectTile(safe0, SECRET);

        LinqaGame.Round memory r0 = game.getActiveRound(alice);
        assertEq(r0.rowIndex, 0, "rowIndex still 0 before advance");
        assertTrue(r0.rowResultPending);

        uint256 multAfterRow0 = r0.multiplierWAD;
        assertGt(multAfterRow0, game.BASE_MULTIPLIER(), "multiplier grew after row 0");

        // Advance to row 1.
        bytes32 secret1 = bytes32("secret_row1");
        bytes32 commit1 = keccak256(abi.encodePacked(secret1));
        vm.prank(alice);
        game.advanceRow(commit1);

        LinqaGame.Round memory r1 = game.getActiveRound(alice);
        assertEq(r1.rowIndex, 1, "rowIndex should be 1");

        // ── Row 1 ────────────────────────────────────────────────
        vm.roll(block.number + 1);

        uint8 tc1 = game.getRowTileCount(1); // 2
        uint8 losing1 = _losingTile(secret1, alice, roundId, tc1);
        uint8 safe1 = (losing1 + 1) % tc1;

        vm.prank(alice);
        game.selectTile(safe1, secret1);

        LinqaGame.Round memory r2 = game.getActiveRound(alice);
        uint256 multAfterRow1 = r2.multiplierWAD;

        assertGt(multAfterRow1, multAfterRow0, "multiplier grew after row 1");
        assertEq(r2.rowIndex, 1, "rowIndex still 1 before second advance");
    }

    // ──────────────────────────────────────────────────────────────
    //  6. CASH-OUT AMOUNT — precise payout = stake * multiplierWAD / 1e18
    // ──────────────────────────────────────────────────────────────

    function test_CashOutAmountPrecise() public {
        uint256 stake = MIN_STAKE;

        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        vm.roll(block.number + 1);

        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);
        uint8 safeTile = (losing + 1) % tileCount;

        vm.prank(alice);
        game.selectTile(safeTile, SECRET);

        // Advance to be able to cashOut (rowResultPending must be false).
        bytes32 commit2 = keccak256(abi.encodePacked(bytes32("secret2")));
        vm.prank(alice);
        game.advanceRow(commit2);

        LinqaGame.Round memory r = game.getActiveRound(alice);
        uint256 expectedPayout = (stake * r.multiplierWAD) / WAD;

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        game.cashOut();
        uint256 balAfter = usdc.balanceOf(alice);

        assertEq(balAfter - balBefore, expectedPayout, "payout mismatch");
    }

    // ──────────────────────────────────────────────────────────────
    //  7. DUPLICATE TRANSACTION PROTECTION
    // ──────────────────────────────────────────────────────────────

    function test_Revert_AlreadyActiveRound() public {
        vm.prank(alice);
        game.startRound(MIN_STAKE, COMMIT_HASH);

        vm.expectRevert(LinqaGame.AlreadyActiveRound.selector);
        vm.prank(alice);
        game.startRound(MIN_STAKE, COMMIT_HASH);
    }

    // ──────────────────────────────────────────────────────────────
    //  8. INSUFFICIENT STAKE GUARDS
    // ──────────────────────────────────────────────────────────────

    function test_Revert_StakeTooLow() public {
        vm.expectRevert(LinqaGame.StakeTooLow.selector);
        vm.prank(alice);
        game.startRound(MIN_STAKE - 1, COMMIT_HASH);
    }

    function test_Revert_StakeExceedsMax() public {
        vm.expectRevert(LinqaGame.StakeExceedsMax.selector);
        vm.prank(alice);
        game.startRound(MAX_STAKE + 1, COMMIT_HASH);
    }

    // ──────────────────────────────────────────────────────────────
    //  9. INSUFFICIENT CONTRACT LIQUIDITY
    // ──────────────────────────────────────────────────────────────

    function test_Revert_InsufficientLiquidity() public {
        // Drain all available liquidity by having owner remove it.
        uint256 available = game.getAvailableLiquidity();
        vm.prank(owner);
        game.removeLiquidity(available);

        // Now there's not enough for any payout.
        vm.expectRevert(LinqaGame.InsufficientLiquidity.selector);
        vm.prank(alice);
        game.startRound(MIN_STAKE, COMMIT_HASH);
    }

    // ──────────────────────────────────────────────────────────────
    //  10. INVALID TILE INDEX
    // ──────────────────────────────────────────────────────────────

    function test_Revert_InvalidTileIndex() public {
        _startRound(MIN_STAKE);
        vm.roll(block.number + 1);

        // Row 0 has 4 tiles (indices 0–3); index 4 is invalid.
        vm.expectRevert(LinqaGame.InvalidTileIndex.selector);
        vm.prank(alice);
        game.selectTile(4, SECRET);
    }

    // ──────────────────────────────────────────────────────────────
    //  11. COMMIT MISMATCH
    // ──────────────────────────────────────────────────────────────

    function test_Revert_CommitMismatch() public {
        _startRound(MIN_STAKE);
        vm.roll(block.number + 1);

        vm.expectRevert(LinqaGame.CommitMismatch.selector);
        vm.prank(alice);
        game.selectTile(0, bytes32("wrong_secret"));
    }

    // ──────────────────────────────────────────────────────────────
    //  12. REENTRANCY PROTECTION
    //  Attempt cashOut reentrancy via MockERC20's transfer hook.
    // ──────────────────────────────────────────────────────────────

    function test_Revert_Reentrancy_CashOut() public {
        uint256 stake = MIN_STAKE;

        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        vm.roll(block.number + 1);

        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);
        uint8 safeTile = (losing + 1) % tileCount;

        vm.prank(alice);
        game.selectTile(safeTile, SECRET);

        bytes32 commit2 = keccak256(abi.encodePacked(bytes32("secret_adv")));
        vm.prank(alice);
        game.advanceRow(commit2);

        // Encode a cashOut() re-entry attempt as alice.
        bytes memory reentrantData = abi.encodeWithSelector(game.cashOut.selector);

        // Set the reentrancy hook on the USDC mock so the cashOut transfer triggers another cashOut.
        usdc.setReentrantHook(address(game), reentrantData);

        // The second cashOut (inside the hook) must be blocked by ReentrancyGuard.
        vm.expectRevert();
        vm.prank(alice);
        game.cashOut();
    }

    // ──────────────────────────────────────────────────────────────
    //  13. NOT PENDING / RESULT PENDING GUARDS
    // ──────────────────────────────────────────────────────────────

    function test_Revert_AdvanceRow_NotPending() public {
        _startRound(MIN_STAKE);
        // rowResultPending is false right after startRound.
        bytes32 newCommit = keccak256(abi.encodePacked(bytes32("any")));
        vm.expectRevert(LinqaGame.NotPending.selector);
        vm.prank(alice);
        game.advanceRow(newCommit);
    }

    function test_Revert_SelectTile_ResultPending() public {
        uint256 stake = MIN_STAKE;

        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        vm.roll(block.number + 1);

        // Make rowResultPending true by selecting a safe tile first.
        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);
        uint8 safeTile = (losing + 1) % tileCount;

        vm.prank(alice);
        game.selectTile(safeTile, SECRET);

        // rowResultPending is now true — calling selectTile again should revert.
        vm.expectRevert(LinqaGame.ResultPending.selector);
        vm.prank(alice);
        game.selectTile(safeTile, SECRET);
    }

    // ──────────────────────────────────────────────────────────────
    //  14. RESULT PENDING BLOCKS CASH-OUT
    // ──────────────────────────────────────────────────────────────

    function test_Revert_CashOut_ResultPending() public {
        uint256 stake = MIN_STAKE;

        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        vm.roll(block.number + 1);

        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);
        uint8 safeTile = (losing + 1) % tileCount;

        vm.prank(alice);
        game.selectTile(safeTile, SECRET);

        // rowResultPending = true → cashOut must revert.
        vm.expectRevert(LinqaGame.ResultPending.selector);
        vm.prank(alice);
        game.cashOut();
    }

    // ──────────────────────────────────────────────────────────────
    //  15. ZERO-ADDRESS CONSTRUCTOR GUARD
    // ──────────────────────────────────────────────────────────────

    function test_Revert_Constructor_ZeroUsdc() public {
        vm.expectRevert(LinqaGame.ZeroAddress.selector);
        new LinqaGame(address(0), owner);
    }

    function test_Revert_Constructor_ZeroOwner() public {
        // NOTE: OZ's Ownable base constructor fires OwnableInvalidOwner(address(0)) BEFORE
        // our ZeroAddress check in the constructor body — the ZeroAddress guard for _owner
        // is therefore dead code and unreachable. This test documents the actual behaviour;
        // see "Suspected contract bugs" in the test report.
        import_Ownable_OwnableInvalidOwner_selector();
    }

    function test_Revert_Constructor_NonArcTestnet() public {
        vm.chainId(5_042);
        vm.expectRevert(LinqaGame.TestnetOnly.selector);
        new LinqaGame(USDC_ADDR, owner);
    }

    /// @dev Separate function so we can import Ownable cleanly.
    function import_Ownable_OwnableInvalidOwner_selector() internal {
        bytes memory err = abi.encodeWithSelector(
            bytes4(keccak256("OwnableInvalidOwner(address)")),
            address(0)
        );
        vm.expectRevert(err);
        new LinqaGame(USDC_ADDR, address(0));
    }

    // ──────────────────────────────────────────────────────────────
    //  16. REMOVE LIQUIDITY CHECKS RESERVED FUNDS
    // ──────────────────────────────────────────────────────────────

    function test_Revert_RemoveLiquidity_ExceedsAvailable() public {
        // Start an active round to reserve some funds (MIN_STAKE keeps us within INITIAL_LIQUIDITY).
        uint256 stake = MIN_STAKE;
        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);

        // Owner tries to remove the entire contract balance (reserved funds are included → revert).
        uint256 totalBalance = usdc.balanceOf(address(game));

        vm.expectRevert(LinqaGame.InsufficientLiquidity.selector);
        vm.prank(owner);
        game.removeLiquidity(totalBalance);
    }

    function test_RemoveLiquidity_OnlyAvailableAllowed() public {
        // No active rounds — owner can remove up to total balance.
        uint256 available = game.getAvailableLiquidity();
        uint256 ownerBefore = usdc.balanceOf(owner);

        vm.prank(owner);
        game.removeLiquidity(available);

        assertEq(usdc.balanceOf(owner), ownerBefore + available);
        assertEq(game.getAvailableLiquidity(), 0);
    }

    function test_Revert_RemoveLiquidity_NonOwner() public {
        vm.expectRevert();
        vm.prank(alice);
        game.removeLiquidity(1);
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: Deployment & initialisation
    // ──────────────────────────────────────────────────────────────

    function test_DeploymentState() public view {
        assertEq(address(game.usdc()), USDC_ADDR);
        assertEq(game.owner(), owner);
        assertTrue(game.isTestnetSimulation());
        assertEq(game.gameVersion(), 4);
        assertEq(game.reservedFunds(), 0); // setUp adds liquidity before any round.
        // Freshly deployed game (separate from setUp game) checked in constructor tests.
    }

    function test_InitialLiquidityTracked() public view {
        assertEq(game.getAvailableLiquidity(), INITIAL_LIQUIDITY);
    }

    function test_RelayedSafePickAdvancesRowAndCashoutPaysPlayer() public {
        address sessionKey = vm.addr(SESSION_KEY_PRIVATE_KEY);
        bytes32 secret1 = bytes32("session_row_1");
        bytes32 commit1 = keccak256(abi.encodePacked(secret1));
        uint256 deadline = block.timestamp + 4 minutes;

        vm.prank(alice);
        game.startRoundWithSession(MIN_STAKE, COMMIT_HASH, sessionKey);
        uint256 roundId = game.activeRound(alice);
        assertEq(game.sessionKeyForRound(roundId), sessionKey);

        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);
        uint8 safeTile = (losing + 1) % tileCount;
        bytes memory selectSignature = _relaySignature(
            roundId, 1, safeTile, SECRET, commit1, 0, deadline
        );

        vm.prank(relayer);
        game.relaySelectTile(alice, safeTile, SECRET, commit1, 0, deadline, selectSignature);

        LinqaGame.Round memory round = game.getActiveRound(alice);
        assertEq(round.rowIndex, 1, "relayed safe pick advances in one transaction");
        assertFalse(round.rowResultPending, "relayed action leaves the next row ready");
        assertEq(round.commitHash, commit1, "next row commitment is installed atomically");
        assertEq(game.getRelayNonce(roundId), 1);

        vm.expectRevert(LinqaGame.InvalidRelayNonce.selector);
        vm.prank(relayer);
        game.relaySelectTile(alice, safeTile, SECRET, commit1, 0, deadline, selectSignature);

        uint256 aliceBefore = usdc.balanceOf(alice);
        bytes memory cashoutSignature = _relaySignature(
            roundId, 2, 0, bytes32(0), bytes32(0), 1, deadline
        );
        vm.prank(relayer);
        game.relayCashOut(alice, 1, deadline, cashoutSignature);

        assertGt(usdc.balanceOf(alice), aliceBefore, "relayed cashout transfers USDC to the player");
        assertEq(game.activeRound(alice), 0);
        assertEq(game.getRelayNonce(roundId), 2);
    }

    function test_Revert_RelayedActionFromWrongSessionKey() public {
        address sessionKey = vm.addr(SESSION_KEY_PRIVATE_KEY);
        vm.prank(alice);
        game.startRoundWithSession(MIN_STAKE, COMMIT_HASH, sessionKey);
        uint256 roundId = game.activeRound(alice);
        uint256 deadline = block.timestamp + 4 minutes;
        bytes memory signature = _relaySignature(
            roundId, 1, 0, SECRET, bytes32("next_commit"), 0, deadline
        );

        // A modified signature must never authorize the action.
        signature[0] = bytes1(uint8(signature[0]) ^ 0x01);
        vm.expectRevert();
        vm.prank(relayer);
        game.relaySelectTile(alice, 0, SECRET, bytes32("next_commit"), 0, deadline, signature);
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: Fuzz — stake bounds always respected
    // ──────────────────────────────────────────────────────────────

    function testFuzz_StakeBoundsRespected(uint256 stake) public {
        stake = bound(stake, MIN_STAKE, MAX_STAKE);

        uint256 available = game.getAvailableLiquidity();
        // Add enough pool liquidity for this stake's possible full-game payout.
        uint256 maxPayout = game.getMaxMultiplierWAD() * stake / WAD;
        if (maxPayout > available) {
            usdc.mint(owner, maxPayout - available + 1);
            vm.startPrank(owner);
            usdc.approve(address(game), maxPayout - available + 1);
            game.addLiquidity(maxPayout - available + 1);
            vm.stopPrank();
        }

        vm.prank(alice);
        game.startRound(stake, COMMIT_HASH);
        assertEq(game.activeRound(alice), 1); // first round id is 1
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: InvalidCommitHash — zero commit
    // ──────────────────────────────────────────────────────────────

    function test_Revert_InvalidCommitHash_Zero() public {
        vm.expectRevert(LinqaGame.InvalidCommitHash.selector);
        vm.prank(alice);
        game.startRound(MIN_STAKE, bytes32(0));
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: No active round guards
    // ──────────────────────────────────────────────────────────────

    function test_Revert_SelectTile_NoActiveRound() public {
        vm.expectRevert(LinqaGame.NoActiveRound.selector);
        vm.prank(alice);
        game.selectTile(0, SECRET);
    }

    function test_Revert_CashOut_NoActiveRound() public {
        vm.expectRevert(LinqaGame.NoActiveRound.selector);
        vm.prank(alice);
        game.cashOut();
    }

    function test_Revert_AdvanceRow_NoActiveRound() public {
        vm.expectRevert(LinqaGame.NoActiveRound.selector);
        vm.prank(alice);
        game.advanceRow(COMMIT_HASH);
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: RoundStarted event emitted correctly
    // ──────────────────────────────────────────────────────────────

    function test_StartRound_EmitsRoundStarted() public {
        vm.expectEmit(true, true, false, true, address(game));
        emit LinqaGame.RoundStarted(1, alice, MIN_STAKE);
        vm.prank(alice);
        game.startRound(MIN_STAKE, COMMIT_HASH);
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: AddLiquidity event emitted correctly
    // ──────────────────────────────────────────────────────────────

    function test_AddLiquidity_EmitsEvent() public {
        uint256 amount = 100e6;
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(game), amount);
        vm.expectEmit(true, false, false, true, address(game));
        emit LinqaGame.LiquidityAdded(owner, amount);
        game.addLiquidity(amount);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────────────────────
    //  EXTRA: reservedFunds tracks rounds correctly
    // ──────────────────────────────────────────────────────────────

    function test_ReservedFunds_IncreasedOnStart_DecreasedOnLoss() public {
        uint256 reservedBefore = game.getReservedFunds();
        assertEq(reservedBefore, 0);

        vm.prank(alice);
        game.startRound(MIN_STAKE, COMMIT_HASH);
        uint256 roundId = game.activeRound(alice);

        assertGt(game.getReservedFunds(), 0, "reserved should be > 0 after start");

        vm.roll(block.number + 1);
        uint8 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, tileCount);

        vm.prank(alice);
        game.selectTile(losing, SECRET);

        assertEq(game.getReservedFunds(), 0, "reserved should be 0 after round ends");
    }

    function test_ReservedFunds_GrowsBeforeSafeOutcome() public {
        uint256 stake = MIN_STAKE;
        uint256 roundId = _startRound(stake);
        uint256 tileCount = game.getRowTileCount(0);
        uint8 losing = _losingTile(SECRET, alice, roundId, uint8(tileCount));
        uint8 safeTile = uint8((losing + 1) % tileCount);

        vm.prank(alice);
        game.selectTile(safeTile, SECRET);

        uint256 expected = (stake * game.getMultiplierAtRow(0)) / WAD;
        assertEq(game.getReservedFunds(), expected, "reserve must cover the newly reachable payout");
    }

    function test_Revert_SelectTile_WhenPoolCannotBackNextPayout() public {
        uint256 stake = MIN_STAKE;
        _startRound(stake);
        uint256 currentPayout = (stake * game.BASE_MULTIPLIER()) / WAD;
        uint256 nextPayout = (stake * game.getMultiplierAtRow(0)) / WAD;
        uint256 additionalReserve = nextPayout - currentPayout;
        uint256 available = game.getAvailableLiquidity();

        vm.prank(owner);
        game.removeLiquidity(available - (additionalReserve - 1));

        vm.expectRevert(LinqaGame.InsufficientLiquidity.selector);
        vm.prank(alice);
        game.selectTile(0, SECRET);
    }

    // ──────────────────────────────────────────────────────────────
    //  INVARIANT: contract balance always >= reservedFunds
    // ──────────────────────────────────────────────────────────────

    function invariant_BalanceCoversReservedFunds() public view {
        assertGe(
            usdc.balanceOf(address(game)),
            game.getReservedFunds(),
            "balance must cover reserved funds"
        );
    }
}
