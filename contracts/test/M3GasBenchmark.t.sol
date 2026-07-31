// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ArbitrumSettlementCore} from "../src/ArbitrumSettlementCore.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @notice Reproducible execution-gas benchmark for the M3 payment lifecycle.
/// @dev Each measured action is the last external call before Foundry records it.
///      The authorize benchmark uses a fresh user/hold; the other transitions use
///      the authorized hold prepared in setUp. The resulting snapshot is written
///      to snapshots/M3GasBenchmark.json.
contract M3GasBenchmark is Test {
    ArbitrumSettlementCore private core;
    MockERC20 private token;

    address private admin = makeAddr("gas-admin");
    address private relayer = makeAddr("gas-relayer");
    address private user = makeAddr("gas-user");
    address private freshUser = makeAddr("gas-fresh-user");
    address private merchant = makeAddr("gas-merchant");

    bytes32 private constant EXISTING_HOLD = keccak256("m3-gas-existing-hold");
    bytes32 private constant FRESH_HOLD = keccak256("m3-gas-fresh-hold");
    uint256 private constant AMOUNT = 100e6;
    uint48 private expiresAt;

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);

        ArbitrumSettlementCore implementation = new ArbitrumSettlementCore();
        bytes memory initData = abi.encodeCall(ArbitrumSettlementCore.initialize, (admin));
        core = ArbitrumSettlementCore(address(new ERC1967Proxy(address(implementation), initData)));

        vm.startPrank(admin);
        core.grantRole(core.RELAYER_ROLE(), relayer);
        core.configureToken(address(token), true);
        vm.stopPrank();

        _deposit(user);
        _deposit(freshUser);

        expiresAt = uint48(block.timestamp + 1 hours);
        vm.prank(relayer);
        core.authorize(EXISTING_HOLD, user, merchant, address(token), AMOUNT, expiresAt);
    }

    function testGas_authorize() public {
        vm.prank(relayer);
        core.authorize(FRESH_HOLD, freshUser, merchant, address(token), AMOUNT, expiresAt);
        uint256 gasUsed = vm.snapshotGasLastCall("M3GasBenchmark", "authorize");
        assertGt(gasUsed, 0);
    }

    function testGas_capture() public {
        vm.prank(relayer);
        core.capture(EXISTING_HOLD);
        uint256 gasUsed = vm.snapshotGasLastCall("M3GasBenchmark", "capture");
        assertGt(gasUsed, 0);
    }

    function testGas_release() public {
        vm.prank(relayer);
        core.release(EXISTING_HOLD);
        uint256 gasUsed = vm.snapshotGasLastCall("M3GasBenchmark", "release");
        assertGt(gasUsed, 0);
    }

    function testGas_expire() public {
        vm.warp(uint256(expiresAt) + 1);
        core.expire(EXISTING_HOLD);
        uint256 gasUsed = vm.snapshotGasLastCall("M3GasBenchmark", "expire");
        assertGt(gasUsed, 0);
    }

    function _deposit(address account) private {
        token.mint(account, AMOUNT);
        vm.startPrank(account);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
    }
}
