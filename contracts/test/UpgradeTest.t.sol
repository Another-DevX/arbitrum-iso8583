// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ArbitrumSettlementCore} from "../src/ArbitrumSettlementCore.sol";
import {Hold} from "../src/interfaces/ISettlementTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract ArbitrumSettlementCoreV2 is ArbitrumSettlementCore {
    uint256 public newStorageSlot;

    function version() external pure returns (string memory) {
        return "v2";
    }

    function setNewStorageSlot(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        newStorageSlot = value;
    }
}

contract UpgradeTest is Test {
    ArbitrumSettlementCore internal core;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal user = makeAddr("user");
    address internal merchant = makeAddr("merchant");
    bytes32 internal constant TX_ID = keccak256("upgrade-state-hold");

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);
        ArbitrumSettlementCore implementation = new ArbitrumSettlementCore();
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(implementation), abi.encodeCall(ArbitrumSettlementCore.initialize, (admin)));
        core = ArbitrumSettlementCore(address(proxy));

        vm.startPrank(admin);
        core.grantRole(core.RELAYER_ROLE(), admin);
        core.configureToken(address(token), true);
        vm.stopPrank();

        token.mint(user, 100e6);
        vm.startPrank(user);
        token.approve(address(core), 100e6);
        core.deposit(address(token), 100e6);
        vm.stopPrank();

        vm.prank(admin);
        core.authorize(TX_ID, user, merchant, address(token), 25e6, uint48(block.timestamp + 1 hours));
    }

    function test_upgradePreservesBalancesRolesAndHolds() public {
        ArbitrumSettlementCoreV2 implementationV2 = new ArbitrumSettlementCoreV2();

        vm.prank(admin);
        core.upgradeToAndCall(address(implementationV2), "");

        ArbitrumSettlementCoreV2 upgraded = ArbitrumSettlementCoreV2(address(core));
        (uint256 available, uint256 locked) = upgraded.getBalance(user, address(token));
        Hold memory hold = upgraded.getHold(TX_ID);

        assertEq(upgraded.version(), "v2");
        assertEq(available, 75e6);
        assertEq(locked, 25e6);
        assertEq(hold.amount, 25e6);
        assertTrue(upgraded.hasRole(upgraded.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(upgraded.hasRole(upgraded.RELAYER_ROLE(), admin));

        vm.prank(admin);
        upgraded.setNewStorageSlot(42);
        assertEq(upgraded.newStorageSlot(), 42);
    }

    function test_upgradeRevertsWithoutAdmin() public {
        ArbitrumSettlementCoreV2 implementationV2 = new ArbitrumSettlementCoreV2();
        vm.prank(makeAddr("attacker"));
        vm.expectRevert();
        core.upgradeToAndCall(address(implementationV2), "");
    }
}
