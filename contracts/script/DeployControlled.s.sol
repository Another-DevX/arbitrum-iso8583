// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ArbitrumSettlementCore} from "../src/ArbitrumSettlementCore.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * @notice Controlled testnet deployment with separate operational role holders.
 *
 * Required environment:
 *   ADMIN_ADDRESS, PAUSER_ADDRESS, TOKEN_ADMIN_ADDRESS, RELAYER_ADDRESS
 *
 * The broadcaster is the temporary bootstrap admin. It configures both test
 * tokens, grants the final roles, then removes its bootstrap roles whenever the
 * configured holder is a different address.
 */
contract DeployControlled is Script {
    uint256 internal constant INITIAL_TEST_MINT = 100_000e6;

    function run() external {
        address finalAdmin = vm.envAddress("ADMIN_ADDRESS");
        address finalPauser = vm.envAddress("PAUSER_ADDRESS");
        address finalTokenAdmin = vm.envAddress("TOKEN_ADMIN_ADDRESS");
        address finalRelayer = vm.envAddress("RELAYER_ADDRESS");
        require(
            finalAdmin != address(0) && finalPauser != address(0) && finalTokenAdmin != address(0)
                && finalRelayer != address(0),
            "role holder cannot be zero"
        );

        vm.startBroadcast();
        address bootstrapAdmin = msg.sender;

        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockERC20 usdt = new MockERC20("Tether USD", "USDT", 6);
        ArbitrumSettlementCore implementation = new ArbitrumSettlementCore();
        bytes memory initData = abi.encodeCall(ArbitrumSettlementCore.initialize, (bootstrapAdmin));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        ArbitrumSettlementCore core = ArbitrumSettlementCore(address(proxy));

        core.configureToken(address(usdc), true);
        core.configureToken(address(usdt), true);
        usdc.mint(bootstrapAdmin, INITIAL_TEST_MINT);
        usdt.mint(bootstrapAdmin, INITIAL_TEST_MINT);

        core.grantRole(core.RELAYER_ROLE(), finalRelayer);
        core.grantRole(core.PAUSER_ROLE(), finalPauser);
        core.grantRole(core.TOKEN_ADMIN_ROLE(), finalTokenAdmin);
        core.grantRole(core.DEFAULT_ADMIN_ROLE(), finalAdmin);

        if (finalRelayer != bootstrapAdmin && core.hasRole(core.RELAYER_ROLE(), bootstrapAdmin)) {
            core.revokeRole(core.RELAYER_ROLE(), bootstrapAdmin);
        }
        if (finalPauser != bootstrapAdmin) {
            core.revokeRole(core.PAUSER_ROLE(), bootstrapAdmin);
        }
        if (finalTokenAdmin != bootstrapAdmin) {
            core.revokeRole(core.TOKEN_ADMIN_ROLE(), bootstrapAdmin);
        }
        if (finalAdmin != bootstrapAdmin) {
            core.revokeRole(core.DEFAULT_ADMIN_ROLE(), bootstrapAdmin);
        }
        vm.stopBroadcast();

        console.log("Implementation :", address(implementation));
        console.log("Proxy          :", address(proxy));
        console.log("Mock USDC      :", address(usdc));
        console.log("Mock USDT      :", address(usdt));
        console.log("Admin          :", finalAdmin);
        console.log("Pauser         :", finalPauser);
        console.log("Token admin    :", finalTokenAdmin);
        console.log("Relayer        :", finalRelayer);
    }
}
