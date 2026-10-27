// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LinqaGame} from "../LinqaGame.sol";

/// @notice Guarded Arc Testnet deployment for the current LinqaGame source.
///
/// Required environment:
///   LINQA_DEPLOYER                 address matching the Foundry --account/--sender
///   LINQA_INITIAL_LIQUIDITY_RAW    optional initial liquidity in ERC-20 USDC base units (6 decimals); 0 deploys without seeding
///   LINQA_GAS_RESERVE_RAW          USDC base units to leave in the deployer wallet for gas
///   LINQA_DEPLOYMENT_ACK           must equal ARC_TESTNET_ONLY
///
/// This intentionally deploys a new, immutable game contract. It does not touch the old v1
/// deployment and does not change the frontend's VITE_LINQA_CONTRACT_ADDRESS.
contract DeployLinqaGame is Script {
    uint256 internal constant ARC_TESTNET_CHAIN_ID = 5_042_002;
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant EXPECTED_MIN_STAKE = 500_000; // 0.50 USDC (6 decimals)
    uint256 internal constant EXPECTED_MAX_STAKE = 10_000_000_000; // 10,000 USDC (6 decimals)
    uint256 internal constant EXPECTED_TOTAL_ROWS = 27;
    uint256 internal constant EXPECTED_MAX_MULTIPLIER_WAD = 9_410_174_497_789_971_033_344;

    function run() external returns (LinqaGame game) {
        require(block.chainid == ARC_TESTNET_CHAIN_ID, "Refusing non-Arc-Testnet deployment");
        require(
            keccak256(bytes(vm.envString("LINQA_DEPLOYMENT_ACK")))
                == keccak256(bytes("ARC_TESTNET_ONLY")),
            "Set LINQA_DEPLOYMENT_ACK=ARC_TESTNET_ONLY to confirm"
        );

        address deployer = vm.envAddress("LINQA_DEPLOYER");
        uint256 initialLiquidity = vm.envUint("LINQA_INITIAL_LIQUIDITY_RAW");
        uint256 gasReserve = vm.envUint("LINQA_GAS_RESERVE_RAW");
        require(deployer != address(0), "Deployer cannot be zero");
        require(gasReserve > 0, "Keep a separate USDC gas reserve");

        IERC20 usdc = IERC20(ARC_TESTNET_USDC);
        require(
            usdc.balanceOf(deployer) >= initialLiquidity + gasReserve,
            "Deployer needs liquidity plus gas reserve"
        );

        vm.startBroadcast(deployer);
        game = new LinqaGame(ARC_TESTNET_USDC, deployer);
        require(game.gameVersion() == 4, "Unexpected game version");
        require(game.owner() == deployer, "Unexpected owner");
        require(game.usdc() == IERC20(ARC_TESTNET_USDC), "Unexpected USDC address");
        require(game.isTestnetSimulation(), "Testnet simulation must be enabled");
        require(game.MIN_STAKE() == EXPECTED_MIN_STAKE, "Minimum stake mismatch");
        require(game.MAX_STAKE() == EXPECTED_MAX_STAKE, "Maximum stake mismatch");
        require(game.TOTAL_ROWS() == EXPECTED_TOTAL_ROWS, "Row count mismatch");
        require(game.getMaxMultiplierWAD() == EXPECTED_MAX_MULTIPLIER_WAD, "Payout ladder mismatch");
        uint8[27] memory expectedRows = [
            uint8(4), 2, 4, 3, 4, 4, 5, 6, 4, 2, 4, 3, 4, 4, 5, 6, 4, 2, 4, 3, 4, 4, 5, 6, 4, 2, 4
        ];
        for (uint256 i = 0; i < EXPECTED_TOTAL_ROWS; i++) {
            require(game.getRowTileCount(i) == expectedRows[i], "Tile row sequence mismatch");
        }

        if (initialLiquidity > 0) {
            require(usdc.approve(address(game), initialLiquidity), "USDC approval failed");
            game.addLiquidity(initialLiquidity);
        }
        require(game.getAvailableLiquidity() == initialLiquidity, "Liquidity post-check failed");
        vm.stopBroadcast();

        console2.log("LinqaGame v4 deployed on Arc Testnet:", address(game));
        console2.log("Owner:", deployer);
        console2.log("Initial liquidity (USDC base units):", initialLiquidity);
        console2.log("Verify the address and source on the Arc Testnet explorer before frontend use.");
        console2.log("Testnet simulation only; block.prevrandao is not safe randomness for real-value play.");
    }
}
