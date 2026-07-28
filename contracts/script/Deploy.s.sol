// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ArbitrumSettlementCore} from "../src/ArbitrumSettlementCore.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * @title Deploy
 * @notice Deploys ArbitrumSettlementCore + two MockERC20 tokens for local testing.
 *
 * Usage (against a local Anvil node):
 *   anvil
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --account <keystore-account> -vvvv
 *
 * The deployer address receives all roles (Admin, Pauser, TokenAdmin, Relayer)
 * and the initial token mint.
 */
contract Deploy is Script {
    // Initial mint amounts
    uint256 internal constant USDC_MINT = 100_000e6; // 100 000 USDC / USDT (6 decimals)

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        // ── 1. Deploy tokens ────────────────────────────────────────────────
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 usdt = new MockERC20("Tether USD", "USDT", 6);

        // ── 2. Deploy core contract (UUPS upgradeable) ──────────────────────
        ArbitrumSettlementCore impl = new ArbitrumSettlementCore();
        bytes memory initData = abi.encodeCall(ArbitrumSettlementCore.initialize, (deployer));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        ArbitrumSettlementCore core = ArbitrumSettlementCore(address(proxy));

        // ── 3. Grant roles ────────────────────────────────────────────────────
        core.grantRole(core.RELAYER_ROLE(), deployer);

        // ── 4. Configure tokens ───────────────────────────────────────────────
        core.configureToken(address(usdc), true);
        core.configureToken(address(usdt), true);

        // ── 5. Mint tokens to deployer ────────────────────────────────────────
        usdc.mint(deployer, USDC_MINT);
        usdt.mint(deployer, USDC_MINT);

        vm.stopBroadcast();

        // ── Print deployment summary ─────────────────────────────────────────
        console.log("========================================");
        console.log("   ArbitrumSettlementCore - Deployed");
        console.log("========================================");
        console.log("Impl contract  : %s", address(impl));
        console.log("Proxy contract : %s", address(proxy));
        console.log("USDC token    : %s", address(usdc));
        console.log("USDT token    : %s", address(usdt));
        console.log("----------------------------------------");
        console.log("Roles");
        console.log("  Admin / Pauser / TokenAdmin / Relayer : %s", deployer);
        console.log("========================================");
    }
}
