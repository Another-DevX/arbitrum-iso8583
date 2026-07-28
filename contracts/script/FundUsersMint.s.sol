// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArbitrumSettlementCore} from "../src/interfaces/IArbitrumSettlementCore.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";

/**
 * @title FundUsersMint
 * @notice Step 1/2 of the funding flow.
 *         Only the deployer signs — a single broadcast block.
 *         For each test wallet derived from the mnemonic:
 *           - Sends ETH_SEED of ETH if the wallet balance is insufficient
 *           - Mints DEPOSIT_AMT USDC if wallet + contract balance is insufficient
 *           - Mints DEPOSIT_AMT USDT likewise
 *
 * Usage:
 *   forge script script/FundUsersMint.s.sol \
 *     --rpc-url arbitrum-sepolia \
 *     --private-key $DEPLOYER_PK \
 *     --broadcast --slow -vvvv
 *
 * Next step:
 *   forge script script/DepositUsers.s.sol \
 *     --rpc-url arbitrum-sepolia \
 *     --broadcast --slow -vvvv
 */
contract FundUsersMint is Script {
    uint256 internal constant N_USERS = 4;
    uint256 internal constant DEPOSIT_AMT = 1_000e6;
    uint256 internal constant ETH_SEED = 0.005 ether;

    address internal constant PROXY = 0xAaE3116210b866f00ccf8dCbD540A6Cc5d070d72;
    address internal constant USDC = 0xA730eFe70d3f67d08dD4a17a867c95bFe1F33CfA;
    address internal constant USDT = 0xC7f974b3710560D070dEc95288339EfAB683C417;

    string internal constant TEST_MNEMONIC =
        "bamboo scout soldier devote tooth ugly foot drive lamp upset arrange grape";

    string[4] internal CARD_TOKENS = ["TOK_TEST_001", "TOK_TEST_002", "TOK_TEST_003", "TOK_TEST_004"];

    function _contractAvailable(address user, address token) internal view returns (uint256 av) {
        (av,) = IArbitrumSettlementCore(PROXY).getBalance(user, token);
    }

    function run() external {
        string memory mnemonic = vm.envOr("MNEMONIC", TEST_MNEMONIC);

        address[4] memory users;
        for (uint256 i = 0; i < N_USERS; i++) {
            users[i] = vm.addr(vm.deriveKey(mnemonic, uint32(i)));
        }

        // ── Single deployer broadcast block ────────────────────────────────────
        vm.startBroadcast();

        for (uint256 i = 0; i < N_USERS; i++) {
            address u = users[i];

            if (u.balance < ETH_SEED) {
                (bool ok,) = u.call{value: ETH_SEED}("");
                require(ok, "ETH seed failed");
                console.log("[%d] ETH  -> %s", i, u);
            } else {
                console.log("[%d] ETH skip (balance ok)", i);
            }

            uint256 usdcTotal = IERC20(USDC).balanceOf(u) + _contractAvailable(u, USDC);
            if (usdcTotal < DEPOSIT_AMT) {
                MockERC20(USDC).mint(u, DEPOSIT_AMT - usdcTotal);
                console.log("[%d] mint USDC -> %s", i, u);
            } else {
                console.log("[%d] USDC skip (balance ok)", i);
            }

            uint256 usdtTotal = IERC20(USDT).balanceOf(u) + _contractAvailable(u, USDT);
            if (usdtTotal < DEPOSIT_AMT) {
                MockERC20(USDT).mint(u, DEPOSIT_AMT - usdtTotal);
                console.log("[%d] mint USDT -> %s", i, u);
            } else {
                console.log("[%d] USDT skip (balance ok)", i);
            }
        }

        vm.stopBroadcast();

        // ── Write wallet JSON (no broadcast, local write only) ─────────────────
        string memory obj = "wallets";
        string memory json;
        for (uint256 i = 0; i < N_USERS; i++) {
            json = vm.serializeAddress(obj, CARD_TOKENS[i], users[i]);
        }
        vm.createDir("./script/output", true);
        vm.writeJson(json, "./script/output/funded-wallets.json");

        console.log("\nJSON written: script/output/funded-wallets.json");
        console.log("Next step:   bash script/deposit-users.sh\n");
    }
}
