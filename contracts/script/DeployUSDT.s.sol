// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ArbitrumSettlementCore} from "../src/ArbitrumSettlementCore.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * @title DeployUSDT
 * @notice Deploys a Mock USDT token and configures it on the already-deployed proxy.
 *
 * Usage (Arbitrum Sepolia):
 *   forge script script/DeployUSDT.s.sol \
 *     --rpc-url arbitrum-sepolia \
 *     --private-key $DEPLOYER_PK \
 *     --broadcast \
 *     --verify \
 *     -vvvv
 */
contract DeployUSDT is Script {
    address internal constant PROXY = 0xAaE3116210b866f00ccf8dCbD540A6Cc5d070d72;
    uint256 internal constant USDT_MINT = 100_000e6; // 100 000 USDT (6 decimals)

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        // 1. Deploy mock USDT
        MockERC20 usdt = new MockERC20("Tether USD", "USDT", 6);

        // 2. Register it in the settlement core
        ArbitrumSettlementCore core = ArbitrumSettlementCore(PROXY);
        core.configureToken(address(usdt), true);

        // 3. Mint initial supply to deployer
        usdt.mint(deployer, USDT_MINT);

        vm.stopBroadcast();

        console.log("========================================");
        console.log("   DeployUSDT - Done");
        console.log("========================================");
        console.log("Mock USDT : %s", address(usdt));
        console.log("Proxy     : %s", PROXY);
        console.log("Minted    : 100 000 USDT -> %s", deployer);
        console.log("========================================");
    }
}
