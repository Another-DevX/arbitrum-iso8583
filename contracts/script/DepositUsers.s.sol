// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IArbitrumSettlementCore} from "../src/interfaces/IArbitrumSettlementCore.sol";

/**
 * @title DepositUsers
 * @notice Step 2/2 of the funding flow.
 *         Performs approve + deposit of USDC and USDT for the 4 test wallets.
 *         Each user has its own startBroadcast(privKey) — a different signer
 *         per block, so forge fetches the nonce from the RPC independently
 *         for each account. No nonce conflicts.
 *
 * Prerequisite: FundUsersMint.s.sol must have been run first.
 *
 * Usage:
 *   forge script script/DepositUsers.s.sol \
 *     --rpc-url arbitrum-sepolia \
 *     --broadcast --slow -vvvv
 *
 * No --private-key required: keys are derived from the mnemonic internally.
 */
contract DepositUsers is Script {
    uint256 internal constant N_USERS = 4;
    uint256 internal constant DEPOSIT_AMT = 1_000e6;

    address internal constant PROXY = 0xAaE3116210b866f00ccf8dCbD540A6Cc5d070d72;
    address internal constant USDC = 0xA730eFe70d3f67d08dD4a17a867c95bFe1F33CfA;
    address internal constant USDT = 0xC7f974b3710560D070dEc95288339EfAB683C417;

    string internal constant TEST_MNEMONIC =
        "bamboo scout soldier devote tooth ugly foot drive lamp upset arrange grape";

    function _available(address user, address token) internal view returns (uint256 av) {
        (av,) = IArbitrumSettlementCore(PROXY).getBalance(user, token);
    }

    function _depositToken(address token, address user, uint256 idx) internal {
        uint256 inContract = _available(user, token);
        if (inContract >= DEPOSIT_AMT) {
            console.log("[%d] skip -- already deposited %d", idx, inContract);
            return;
        }
        uint256 toDeposit = DEPOSIT_AMT - inContract;
        uint256 walletBal = IERC20(token).balanceOf(user);
        require(walletBal >= toDeposit, "insufficient balance -- run FundUsersMint first");

        if (IERC20(token).allowance(user, PROXY) < toDeposit) {
            IERC20(token).approve(PROXY, toDeposit);
        }
        IArbitrumSettlementCore(PROXY).deposit(token, toDeposit);
        console.log("[%d] deposit %d ok", idx, toDeposit);
    }

    function run() external {
        string memory mnemonic = vm.envOr("MNEMONIC", TEST_MNEMONIC);

        console.log("\n==========================================");
        console.log("  DepositUsers");
        console.log("==========================================");

        for (uint256 i = 0; i < N_USERS; i++) {
            uint256 privKey = vm.deriveKey(mnemonic, uint32(i));
            address user = vm.addr(privKey);

            console.log("\n[%d] %s", i, user);

            // Each startBroadcast uses a different account -> forge fetches the
            // nonce from the RPC independently for each one.
            vm.startBroadcast(privKey);

            console.log("[%d] USDC:", i);
            _depositToken(USDC, user, i);

            console.log("[%d] USDT:", i);
            _depositToken(USDT, user, i);

            vm.stopBroadcast();

            console.log("[%d] final balance -- USDC: %d  USDT: %d", i, _available(user, USDC), _available(user, USDT));
        }

        console.log("\n==========================================");
        console.log("  Next: cd ../backend && tsx scripts/seed-card-mapping.ts");
        console.log("==========================================\n");
    }
}
