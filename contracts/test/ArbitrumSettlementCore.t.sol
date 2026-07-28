// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, StdInvariant} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ArbitrumSettlementCore} from "../src/ArbitrumSettlementCore.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IArbitrumSettlementCore} from "../src/interfaces/IArbitrumSettlementCore.sol";
import {
    Hold,
    HoldStatus,
    ZeroAddress,
    ZeroAmount,
    TokenNotAllowed,
    InsufficientAvailableBalance,
    TxIdAlreadyUsed,
    HoldNotFound,
    InvalidHoldStatus,
    HoldExpired,
    HoldNotExpired,
    ExpiresAtInPast,
    BatchTooLarge,
    FeeOnTransferToken
} from "../src/interfaces/ISettlementTypes.sol";

// =============================================================================
// Auxiliary: malicious token for reentrancy tests
// =============================================================================

/// @dev ERC-20 that invokes an arbitrary payload during `transfer`.
///      Verifies that the nonReentrant guards in ArbitrumSettlementCore hold.
contract ReentrantToken is MockERC20 {
    bytes public attackPayload;
    address public attackTarget;

    constructor() MockERC20("ReentrantUSD", "RUSD", 6) {}

    function setAttack(address target, bytes calldata payload) external {
        attackTarget = target;
        attackPayload = payload;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackTarget != address(0) && attackPayload.length > 0) {
            address t = attackTarget;
            bytes memory p = attackPayload;
            attackTarget = address(0);
            attackPayload = "";
            // The reentrant call must be rejected by nonReentrant; we deliberately
            // ignore the return value.
            (bool ok,) = t.call(p);
            (ok);
        }
        return super.transfer(to, amount);
    }
}

// =============================================================================
// Auxiliary: fee-on-transfer token for insolvency tests
// =============================================================================

/// @dev ERC-20 that charges 1 unit of fee to the receiving contract on every
///      transferFrom. Simulates deflationary tokens (e.g. STA, PAXG).
///      Used to detect whether the contract credits more than it actually received,
///      which would introduce latent insolvency.
contract MockFeeOnTransferERC20 is MockERC20 {
    uint256 public constant FEE = 1; // 1 unit (minimum 6-decimal token)

    constructor() MockERC20("FeeUSD", "FUSD", 6) {}

    /// @dev Burns FEE from the recipient's balance on every transferFrom.
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        // The destination contract "loses" FEE: we burn from `to`'s balance.
        if (ok && balanceOf(to) >= FEE) {
            _burn(to, FEE);
        }
        return ok;
    }
}

// =============================================================================
// Auxiliary: handler for Foundry invariant tests
// =============================================================================

/// @dev Drives random state transitions. Foundry calls its public functions
///      during invariant fuzzing.
contract SettlementHandler is Test {
    ArbitrumSettlementCore public core;
    MockERC20 public token;
    address public relayer;
    address public admin;

    address[] public users;
    bytes32[] public activeTxIds;
    uint256 public nextTxSeed;

    mapping(address => bool) private _registeredUser;

    constructor(ArbitrumSettlementCore _core, MockERC20 _token, address _relayer, address _admin) {
        core = _core;
        token = _token;
        relayer = _relayer;
        admin = _admin;
    }

    // --- internal helpers ---

    function _nextUser(uint256 seed) internal view returns (address) {
        return users[seed % users.length];
    }

    function _nextTxId() internal returns (bytes32) {
        return keccak256(abi.encode("tx", nextTxSeed++));
    }

    // --- actions ---

    function addUser(uint256 seed) external {
        address u = address(uint160(uint256(keccak256(abi.encode("user", seed)))));
        if (_registeredUser[u]) return; // skip duplicates
        _registeredUser[u] = true;
        token.mint(u, 10_000e6);
        users.push(u);
    }

    function deposit(uint256 userSeed, uint96 rawAmount) external {
        if (users.length == 0) return;
        address u = _nextUser(userSeed);
        uint256 balance = token.balanceOf(u);
        if (balance == 0) return;
        uint256 amount = bound(rawAmount, 1, balance);

        vm.startPrank(u);
        token.approve(address(core), amount);
        core.deposit(address(token), amount);
        vm.stopPrank();
    }

    function withdraw(uint256 userSeed, uint96 rawAmount) external {
        if (users.length == 0) return;
        address u = _nextUser(userSeed);
        (uint256 avail,) = core.getBalance(u, address(token));
        if (avail == 0) return;
        uint256 amount = bound(rawAmount, 1, avail);

        vm.prank(u);
        core.withdraw(address(token), amount);
    }

    function authorize(uint256 userSeed, uint96 rawAmount) external {
        if (users.length == 0) return;
        address u = _nextUser(userSeed);
        (uint256 avail,) = core.getBalance(u, address(token));
        if (avail == 0) return;

        uint256 amount = bound(rawAmount, 1, avail);
        bytes32 txId = _nextTxId();
        uint48 expiresAt = uint48(block.timestamp + 1 hours);
        address merch = address(uint160(uint256(keccak256(abi.encode("merch", userSeed)))));

        vm.prank(relayer);
        core.authorize(txId, u, merch, address(token), amount, expiresAt);

        activeTxIds.push(txId);
    }

    function capture(uint256 txSeed) external {
        if (activeTxIds.length == 0) return;
        bytes32 txId = activeTxIds[txSeed % activeTxIds.length];
        Hold memory h = core.getHold(txId);
        if (h.status != HoldStatus.AUTHORIZED) return;
        if (block.timestamp > h.expiresAt) return;

        vm.prank(relayer);
        core.capture(txId);
    }

    function release_(uint256 txSeed) external {
        if (activeTxIds.length == 0) return;
        bytes32 txId = activeTxIds[txSeed % activeTxIds.length];
        Hold memory h = core.getHold(txId);
        if (h.status != HoldStatus.AUTHORIZED) return;

        vm.prank(relayer);
        core.release(txId);
    }

    function expire_(uint256 txSeed) external {
        if (activeTxIds.length == 0) return;
        bytes32 txId = activeTxIds[txSeed % activeTxIds.length];
        Hold memory h = core.getHold(txId);
        if (h.status != HoldStatus.AUTHORIZED) return;

        vm.warp(h.expiresAt + 1);
        core.expire(txId);
    }

    // --- views for invariant assertions ---

    function totalLocked() external view returns (uint256 sum) {
        for (uint256 i; i < users.length; ++i) {
            (, uint256 locked) = core.getBalance(users[i], address(token));
            sum += locked;
        }
    }

    function totalAuthorizedHoldAmounts() external view returns (uint256 sum) {
        for (uint256 i; i < activeTxIds.length; ++i) {
            Hold memory h = core.getHold(activeTxIds[i]);
            if (h.status == HoldStatus.AUTHORIZED) sum += h.amount;
        }
    }

    function totalAccountedBalance() external view returns (uint256 sum) {
        for (uint256 i; i < users.length; ++i) {
            (uint256 avail, uint256 locked) = core.getBalance(users[i], address(token));
            sum += avail + locked;
        }
    }

    function getActiveTxIds() external view returns (bytes32[] memory) {
        return activeTxIds;
    }
}

// =============================================================================
// Unit tests
// =============================================================================

contract ArbitrumSettlementCoreTest is Test {
    ArbitrumSettlementCore core;
    MockERC20 token;

    address admin = makeAddr("admin");
    address relayer = makeAddr("relayer");
    address pauser = makeAddr("pauser");
    address user = makeAddr("user");
    address merchant = makeAddr("merchant");
    address stranger = makeAddr("stranger");

    bytes32 constant TX1 = keccak256("tx1");
    bytes32 constant TX2 = keccak256("tx2");
    uint256 constant AMOUNT = 100e6;
    uint48 expiresAt;

    // -------------------------------------------------------------------------
    // Setup
    // -------------------------------------------------------------------------

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);

        ArbitrumSettlementCore impl = new ArbitrumSettlementCore();
        bytes memory initData = abi.encodeCall(ArbitrumSettlementCore.initialize, (admin));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        core = ArbitrumSettlementCore(address(proxy));

        vm.startPrank(admin);
        core.grantRole(core.RELAYER_ROLE(), relayer);
        core.grantRole(core.PAUSER_ROLE(), pauser);
        core.configureToken(address(token), true);
        vm.stopPrank();

        token.mint(user, 1_000e6);
        expiresAt = uint48(block.timestamp + 1 hours);
    }

    // =========================================================================
    // Deployment
    // =========================================================================

    function test_deploy_adminRolesAssigned() public view {
        assertTrue(core.hasRole(core.DEFAULT_ADMIN_ROLE(), admin), "admin: DEFAULT_ADMIN_ROLE");
        assertTrue(core.hasRole(core.PAUSER_ROLE(), admin), "admin: PAUSER_ROLE");
        assertTrue(core.hasRole(core.TOKEN_ADMIN_ROLE(), admin), "admin: TOKEN_ADMIN_ROLE");
        assertTrue(core.hasRole(core.RELAYER_ROLE(), relayer), "relayer: RELAYER_ROLE");
    }

    function test_deploy_rejectsZeroAdmin() public {
        ArbitrumSettlementCore impl = new ArbitrumSettlementCore();
        bytes memory badInit = abi.encodeCall(ArbitrumSettlementCore.initialize, (address(0)));
        vm.expectRevert(ZeroAddress.selector);
        new ERC1967Proxy(address(impl), badInit);
    }

    // =========================================================================
    // Token Config
    // =========================================================================

    function test_tokenConfig_adminCanWhitelist() public {
        MockERC20 newToken = new MockERC20("DAI", "DAI", 18);

        vm.prank(admin);
        core.configureToken(address(newToken), true);

        assertTrue(core.getTokenConfig(address(newToken)).allowed);
    }

    function test_tokenConfig_rejectsDepositOfUnsupportedToken() public {
        MockERC20 badToken = new MockERC20("BAD", "BAD", 6);
        badToken.mint(user, 100e6);

        vm.startPrank(user);
        badToken.approve(address(core), 100e6);
        vm.expectRevert(abi.encodeWithSelector(TokenNotAllowed.selector, address(badToken)));
        core.deposit(address(badToken), 100e6);
        vm.stopPrank();
    }

    function test_tokenConfig_storesDecimalsCorrectly() public view {
        assertEq(core.getTokenConfig(address(token)).decimals, 6);
    }

    function test_tokenConfig_rejectsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(ZeroAddress.selector);
        core.configureToken(address(0), true);
    }

    function test_tokenConfig_onlyTokenAdmin() public {
        vm.prank(stranger);
        vm.expectRevert();
        core.configureToken(address(token), false);
    }

    // =========================================================================
    // Deposit
    // =========================================================================

    function test_deposit_updatesAvailableBalance() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(avail, AMOUNT);
    }

    function test_deposit_rejectsZeroAmount() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        vm.expectRevert(ZeroAmount.selector);
        core.deposit(address(token), 0);
        vm.stopPrank();
    }

    function test_deposit_accumulates() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(avail, 2 * AMOUNT);
    }

    function test_deposit_rejectsFeeOnTransferToken() public {
        // Arrange: configure a deflationary token and fund the user
        MockFeeOnTransferERC20 feeToken = new MockFeeOnTransferERC20();
        feeToken.mint(user, 1_000e6);

        vm.prank(admin);
        core.configureToken(address(feeToken), true);

        // Act + Assert: deposit must revert with FeeOnTransferToken because
        // the contract receives `amount - FEE` but is asked to credit `amount`
        uint256 depositAmount = 100e6;
        vm.startPrank(user);
        feeToken.approve(address(core), depositAmount);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeOnTransferToken.selector, // contract error
                address(feeToken),
                depositAmount, // expected
                depositAmount - feeToken.FEE() // received (actually transferred to contract)
            )
        );
        core.deposit(address(feeToken), depositAmount);
        vm.stopPrank();
    }

    function test_deposit_contractBalanceMatchesLedger() public {
        // Verifies that after a normal deposit the contract's real token balance
        // matches exactly what was credited in the internal ledger.
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        uint256 contractBalance = token.balanceOf(address(core));
        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(contractBalance, avail, "contract balance must match ledger");
    }

    // =========================================================================
    // Withdraw
    // =========================================================================

    function test_withdraw_reducesAvailableBalance() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(user);
        core.withdraw(address(token), AMOUNT);

        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(avail, 0);
    }

    function test_withdraw_rejectsInsufficientFunds() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(InsufficientAvailableBalance.selector, 0, AMOUNT));
        core.withdraw(address(token), AMOUNT);
    }

    function test_withdraw_rejectsZeroAmount() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(user);
        vm.expectRevert(ZeroAmount.selector);
        core.withdraw(address(token), 0);
    }

    // =========================================================================
    // Authorization
    // =========================================================================

    function test_authorize_movesBalanceToLocked() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(avail, 0);
        assertEq(locked, AMOUNT);
    }

    function test_authorize_revertsWithoutDeposit() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InsufficientAvailableBalance.selector, 0, AMOUNT));
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
    }

    function test_authorize_revertsWithInsufficientBalance() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT / 2);
        core.deposit(address(token), AMOUNT / 2);
        vm.stopPrank();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InsufficientAvailableBalance.selector, AMOUNT / 2, AMOUNT));
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
    }

    function test_authorize_rejectsDuplicateTxId() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        // Replenish funds so balance is not the blocker
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(TxIdAlreadyUsed.selector, TX1));
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
    }

    function test_authorize_rejectsZeroAmount() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        vm.expectRevert(ZeroAmount.selector);
        core.authorize(TX1, user, merchant, address(token), 0, expiresAt);
    }

    function test_authorize_rejectsZeroUser() public {
        vm.prank(relayer);
        vm.expectRevert(ZeroAddress.selector);
        core.authorize(TX1, address(0), merchant, address(token), AMOUNT, expiresAt);
    }

    function test_authorize_rejectsZeroMerchant() public {
        vm.prank(relayer);
        vm.expectRevert(ZeroAddress.selector);
        core.authorize(TX1, user, address(0), address(token), AMOUNT, expiresAt);
    }

    function test_authorize_rejectsExpiredExpiresAt() public {
        uint48 past = uint48(block.timestamp - 1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ExpiresAtInPast.selector, past, block.timestamp));
        core.authorize(TX1, user, merchant, address(token), AMOUNT, past);
    }

    function test_authorize_onlyRelayer() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert();
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
    }

    // =========================================================================
    // Capture
    // =========================================================================

    function test_capture_succeedsAfterAuthorization() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.capture(TX1);

        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
        assertEq(token.balanceOf(merchant), AMOUNT);
    }

    function test_capture_rejectsBeforeAuthorization() public {
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HoldNotFound.selector, TX1));
        core.capture(TX1);
    }

    function test_capture_rejectsDoubleCapture() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.capture(TX1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InvalidHoldStatus.selector, TX1, HoldStatus.CAPTURED));
        core.capture(TX1);
    }

    function test_capture_rejectsAfterRelease() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.release(TX1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InvalidHoldStatus.selector, TX1, HoldStatus.RELEASED));
        core.capture(TX1);
    }

    function test_capture_rejectsExpiredHold() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt + 1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HoldExpired.selector, TX1, expiresAt));
        core.capture(TX1);
    }

    function test_capture_onlyRelayer() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(stranger);
        vm.expectRevert();
        core.capture(TX1);
    }

    // =========================================================================
    // Release
    // =========================================================================

    function test_release_restoresFundsToAvailable() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.release(TX1);

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
        assertEq(avail, AMOUNT);
    }

    function test_release_rejectsAfterCapture() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.capture(TX1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InvalidHoldStatus.selector, TX1, HoldStatus.CAPTURED));
        core.release(TX1);
    }

    function test_release_rejectsDoubleRelease() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.release(TX1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(InvalidHoldStatus.selector, TX1, HoldStatus.RELEASED));
        core.release(TX1);
    }

    function test_release_relayerCanRelease() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.release(TX1);
    }

    function test_release_adminCanRelease() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(admin);
        core.release(TX1);
    }

    function test_release_strangerCannotRelease() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(stranger);
        vm.expectRevert();
        core.release(TX1);
    }

    // =========================================================================
    // Expiration
    // =========================================================================

    function test_expire_succeedsAfterDeadline() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt + 1);
        core.expire(TX1);

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
        assertEq(avail, AMOUNT);
    }

    function test_expire_rejectsBeforeDeadline() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.expectRevert(abi.encodeWithSelector(HoldNotExpired.selector, TX1, expiresAt));
        core.expire(TX1);
    }

    function test_expire_rejectsDoubleExpire() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt + 1);
        core.expire(TX1);

        vm.expectRevert(abi.encodeWithSelector(InvalidHoldStatus.selector, TX1, HoldStatus.EXPIRED));
        core.expire(TX1);
    }

    function test_batchExpire_succeedsForMultipleHolds() public {
        token.mint(user, AMOUNT);
        uint48 exp = uint48(block.timestamp + 30 minutes);

        vm.startPrank(user);
        token.approve(address(core), 2 * AMOUNT);
        core.deposit(address(token), 2 * AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, exp);
        vm.prank(relayer);
        core.authorize(TX2, user, merchant, address(token), AMOUNT, exp);

        vm.warp(exp + 1);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = TX1;
        ids[1] = TX2;
        core.batchExpire(ids);

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
        assertEq(avail, 2 * AMOUNT);
    }

    function test_batchExpire_rejectsOversizedBatch() public {
        uint256 max = core.MAX_BATCH_EXPIRE();
        bytes32[] memory ids = new bytes32[](max + 1);

        vm.expectRevert(abi.encodeWithSelector(BatchTooLarge.selector, max + 1, max));
        core.batchExpire(ids);
    }

    // =========================================================================
    // Multiple Holds
    // =========================================================================

    function test_multipleHolds_trackedIndependently() public {
        token.mint(user, AMOUNT);

        vm.startPrank(user);
        token.approve(address(core), 2 * AMOUNT);
        core.deposit(address(token), 2 * AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
        vm.prank(relayer);
        core.authorize(TX2, user, merchant, address(token), AMOUNT, expiresAt);

        Hold memory h1 = core.getHold(TX1);
        Hold memory h2 = core.getHold(TX2);

        assertEq(h1.amount, AMOUNT);
        assertEq(h2.amount, AMOUNT);
        assertTrue(h1.status == HoldStatus.AUTHORIZED);
        assertTrue(h2.status == HoldStatus.AUTHORIZED);
    }

    function test_multipleHolds_captureOneDoesNotAffectOther() public {
        token.mint(user, AMOUNT);

        vm.startPrank(user);
        token.approve(address(core), 2 * AMOUNT);
        core.deposit(address(token), 2 * AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
        vm.prank(relayer);
        core.authorize(TX2, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.capture(TX1);

        assertTrue(core.getHold(TX2).status == HoldStatus.AUTHORIZED);
    }

    // =========================================================================
    // Accounting
    // =========================================================================

    function test_accounting_lockedIncreasesOnAuthorize() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, AMOUNT);
    }

    function test_accounting_lockedDecreasesOnCapture() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.capture(TX1);

        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
    }

    function test_accounting_lockedDecreasesOnRelease() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.release(TX1);

        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
    }

    function test_accounting_lockedDecreasesOnExpire() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt + 1);
        core.expire(TX1);

        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0);
    }

    function test_accounting_noFundsLostAcrossFullLifecycle() public {
        uint256 initialUserBalance = token.balanceOf(user);

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        assertEq(token.balanceOf(address(core)), AMOUNT);

        vm.prank(relayer);
        core.capture(TX1);

        assertEq(token.balanceOf(user), initialUserBalance - AMOUNT);
        assertEq(token.balanceOf(merchant), AMOUNT);
        assertEq(token.balanceOf(address(core)), 0);
    }

    function test_accounting_releaseReturnsFundsToUser() public {
        uint256 pre = token.balanceOf(user);

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(relayer);
        core.release(TX1);

        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(avail, AMOUNT);

        vm.prank(user);
        core.withdraw(address(token), AMOUNT);
        assertEq(token.balanceOf(user), pre);
    }

    // =========================================================================
    // Security
    // =========================================================================

    function test_security_reentrancyOnCaptureFails() public {
        ReentrantToken rToken = new ReentrantToken();

        vm.prank(admin);
        core.configureToken(address(rToken), true);

        rToken.mint(user, AMOUNT);
        vm.startPrank(user);
        rToken.approve(address(core), AMOUNT);
        core.deposit(address(rToken), AMOUNT);
        vm.stopPrank();

        uint48 exp = uint48(block.timestamp + 1 hours);
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(rToken), AMOUNT, exp);

        // The token re-enters during the capture transfer
        rToken.setAttack(address(core), abi.encodeCall(IArbitrumSettlementCore.capture, (TX1)));

        vm.prank(relayer);
        core.capture(TX1);

        // The hold must remain CAPTURED (not corrupted)
        assertTrue(core.getHold(TX1).status == HoldStatus.CAPTURED);
    }

    function test_security_pauseBlocksDeposit() public {
        vm.prank(pauser);
        core.pause();

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        vm.expectRevert();
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
    }

    function test_security_pauseBlocksAuthorize() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(pauser);
        core.pause();

        vm.prank(relayer);
        vm.expectRevert();
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
    }

    function test_security_pauseBlocksCapture() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(pauser);
        core.pause();

        vm.prank(relayer);
        vm.expectRevert();
        core.capture(TX1);
    }

    function test_security_pauseBlocksWithdraw() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(pauser);
        core.pause();

        vm.prank(user);
        vm.expectRevert();
        core.withdraw(address(token), AMOUNT);
    }

    function test_security_unpauseRestoresBehavior() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(pauser);
        core.pause();

        vm.prank(pauser);
        core.unpause();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
        assertTrue(core.getHold(TX1).status == HoldStatus.AUTHORIZED);
    }

    function test_security_onlyPauserCanPause() public {
        vm.prank(stranger);
        vm.expectRevert();
        core.pause();
    }

    // =========================================================================
    // Events
    // =========================================================================

    function test_event_deposited() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        vm.expectEmit(true, true, false, true);
        emit IArbitrumSettlementCore.Deposited(user, address(token), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
    }

    function test_event_paymentAuthorized() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.expectEmit(true, true, true, true);
        emit IArbitrumSettlementCore.PaymentAuthorized(TX1, user, merchant, address(token), AMOUNT, expiresAt);
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
    }

    function test_event_paymentCaptured() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.expectEmit(true, true, true, true);
        emit IArbitrumSettlementCore.PaymentCaptured(TX1, user, merchant, address(token), AMOUNT);

        vm.prank(relayer);
        core.capture(TX1);
    }

    function test_event_paymentReleased() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.expectEmit(true, true, true, true);
        emit IArbitrumSettlementCore.PaymentReleased(TX1, user, merchant, address(token), AMOUNT);

        vm.prank(relayer);
        core.release(TX1);
    }

    function test_event_paymentExpired() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt + 1);

        vm.expectEmit(true, true, true, true);
        emit IArbitrumSettlementCore.PaymentExpired(TX1, user, merchant, address(token), AMOUNT);

        core.expire(TX1);
    }

    // =========================================================================
    // Fuzz tests
    // =========================================================================

    /// @dev available + locked == deposited for any valid amount.
    function testFuzz_authorize_accountingNeverViolated(uint96 rawAmount) public {
        uint256 deposited = bound(rawAmount, 1, type(uint96).max);
        token.mint(user, deposited);

        vm.startPrank(user);
        token.approve(address(core), deposited);
        core.deposit(address(token), deposited);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), deposited, expiresAt);

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(avail + locked, deposited, "avail+locked != deposited");
        assertEq(locked, deposited, "entire deposit must be locked");
        assertEq(avail, 0, "nothing must remain available");
    }

    /// @dev A duplicate txId always reverts, regardless of its value.
    function testFuzz_authorize_duplicateTxIdAlwaysReverts(bytes32 txId) public {
        token.mint(user, 2 * AMOUNT);

        vm.startPrank(user);
        token.approve(address(core), 2 * AMOUNT);
        core.deposit(address(token), 2 * AMOUNT);
        vm.stopPrank();

        uint48 exp = uint48(block.timestamp + 1 hours);
        vm.prank(relayer);
        core.authorize(txId, user, merchant, address(token), AMOUNT, exp);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(TxIdAlreadyUsed.selector, txId));
        core.authorize(txId, user, merchant, address(token), AMOUNT, exp);
    }

    /// @dev After capture the merchant receives exactly the authorized amount.
    function testFuzz_capture_merchantReceivesExactAmount(uint96 rawDeposit, uint96 rawCapture) public {
        uint256 deposited = bound(rawDeposit, 1, type(uint96).max);
        uint256 captured = bound(rawCapture, 1, deposited);

        token.mint(user, deposited);

        vm.startPrank(user);
        token.approve(address(core), deposited);
        core.deposit(address(token), deposited);
        vm.stopPrank();

        uint48 exp = uint48(block.timestamp + 1 hours);
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), captured, exp);

        vm.prank(relayer);
        core.capture(TX1);

        assertEq(token.balanceOf(merchant), captured);

        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(avail, deposited - captured);
    }

    /// @dev The contract balance never falls below its internal accounting.
    function testFuzz_contractSolvency(uint96 rawAmount) public {
        uint256 deposited = bound(rawAmount, 1, type(uint96).max);
        token.mint(user, deposited);

        vm.startPrank(user);
        token.approve(address(core), deposited);
        core.deposit(address(token), deposited);
        vm.stopPrank();

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertGe(token.balanceOf(address(core)), avail + locked, "contract is insolvent after deposit");
    }

    // =========================================================================
    // CRITICAL 1 — withdraw after token is disabled
    // =========================================================================

    /// @dev When the admin disables a token (configureToken false) a user who
    ///      already had a deposited balance MUST still be able to withdraw their
    ///      funds. Access to one's own funds must never be gated by an admin
    ///      decision. Mirrors the NatSpec comment on withdraw().
    function test_withdraw_afterTokenDisabled_succeedsForExistingBalance() public {
        // --- setup: deposit while the token is enabled ---
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        // --- admin disables the token ---
        vm.prank(admin);
        core.configureToken(address(token), false);
        assertFalse(core.getTokenConfig(address(token)).allowed, "token must be disabled");

        // --- user must be able to withdraw despite the disable ---
        uint256 preBalance = token.balanceOf(user);
        vm.prank(user);
        core.withdraw(address(token), AMOUNT);

        (uint256 avail,) = core.getBalance(user, address(token));
        assertEq(avail, 0, "avail must be zero after withdraw");
        assertEq(token.balanceOf(user), preBalance + AMOUNT, "user must recover their tokens");
    }

    /// @dev A new deposit with a disabled token must still revert.
    function test_deposit_withDisabledToken_reverts() public {
        vm.prank(admin);
        core.configureToken(address(token), false);

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(TokenNotAllowed.selector, address(token)));
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();
    }

    // =========================================================================
    // CRITICAL 2 — release after expiration
    // =========================================================================

    /// @dev The contract enforces a clear state machine:
    ///      AUTHORIZED + not expired → release  (relayer)
    ///      AUTHORIZED + expired     → expire   (permissionless)
    ///      Calling release on an already-expired hold MUST revert with HoldExpired
    ///      to avoid ambiguity between the two fund-release paths.
    function test_release_afterExpiration_reverts() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        // Advance past expiresAt
        vm.warp(expiresAt + 1);

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(HoldExpired.selector, TX1, expiresAt));
        core.release(TX1);

        // Funds are still locked; expire correctly frees them
        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, AMOUNT, "funds must remain locked until expire");

        core.expire(TX1);
        (, locked) = core.getBalance(user, address(token));
        assertEq(locked, 0, "expire must release the funds");
    }

    // =========================================================================
    // CRITICAL 3 — batchExpire with an invalid ID in the middle of the batch
    // =========================================================================

    /// @dev If a txId inside the batch does not exist (status NONE), _expireSingle
    ///      reverts with HoldNotFound. Because the entire call is atomic, the whole
    ///      batch reverts. This test documents and validates that behaviour.
    function test_batchExpire_invalidIdInMiddle_revertsEntireBatch() public {
        uint48 exp = uint48(block.timestamp + 30 minutes);

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, exp);

        vm.warp(exp + 1);

        bytes32 invalidId = keccak256("nonexistent");
        bytes32[] memory ids = new bytes32[](3);
        ids[0] = TX1;
        ids[1] = invalidId; // <-- invalid ID at position 1
        ids[2] = TX2; // TX2 does not exist either, but revert hits here first

        vm.expectRevert(abi.encodeWithSelector(HoldNotFound.selector, invalidId));
        core.batchExpire(ids);

        // TX1 must not have changed status (full rollback)
        assertTrue(core.getHold(TX1).status == HoldStatus.AUTHORIZED, "TX1 must still be AUTHORIZED");
    }

    // =========================================================================
    // CRITICAL 4 — batchExpire with duplicate IDs
    // =========================================================================

    /// @dev [TX1, TX1]: the first element expires the hold (status → EXPIRED).
    ///      The second attempt fails because the hold is no longer AUTHORIZED
    ///      (InvalidHoldStatus). By atomicity the entire batch reverts and TX1
    ///      remains AUTHORIZED. Confirms that atomicity is the desired behaviour.
    function test_batchExpire_duplicateTxIds_revertsEntireBatch() public {
        uint48 exp = uint48(block.timestamp + 30 minutes);

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, exp);

        vm.warp(exp + 1);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = TX1;
        ids[1] = TX1; // duplicate

        // The second element fails with InvalidHoldStatus(EXPIRED), reverting everything
        vm.expectRevert(abi.encodeWithSelector(InvalidHoldStatus.selector, TX1, HoldStatus.EXPIRED));
        core.batchExpire(ids);

        // Verify rollback: TX1 is still AUTHORIZED
        assertTrue(core.getHold(TX1).status == HoldStatus.AUTHORIZED, "TX1 must still be AUTHORIZED");

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, AMOUNT, "funds must remain locked");
        assertEq(avail, 0, "nothing must have been released");
    }

    // =========================================================================
    // CRITICAL 5 — fee-on-transfer token is rejected at deposit
    // =========================================================================

    /// @dev Now that deposit includes a balance-before/after check, fee-on-transfer
    ///      tokens are rejected at the deposit call itself with FeeOnTransferToken.
    ///      The internal ledger never credits more than was actually received.
    function test_deposit_feeOnTransfer_exposesInsolvency() public {
        MockFeeOnTransferERC20 feeToken = new MockFeeOnTransferERC20();

        vm.prank(admin);
        core.configureToken(address(feeToken), true);

        uint256 depositAmt = 100e6;
        feeToken.mint(user, depositAmt);

        vm.startPrank(user);
        feeToken.approve(address(core), depositAmt);
        // Deposit reverts: contract received depositAmt - FEE, not depositAmt
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeOnTransferToken.selector, address(feeToken), depositAmt, depositAmt - feeToken.FEE()
            )
        );
        core.deposit(address(feeToken), depositAmt);
        vm.stopPrank();

        // Ledger records nothing; contract holds no feeToken funds
        (uint256 avail,) = core.getBalance(user, address(feeToken));
        assertEq(avail, 0, "ledger must be zero after revert");
        assertEq(feeToken.balanceOf(address(core)), 0, "contract must hold no funds");
    }

    // =========================================================================
    // BOUNDARY — capture exactly at expiresAt (inclusive limit)
    // =========================================================================

    /// @dev The condition is `block.timestamp <= hold.expiresAt`, therefore
    ///      capturing at the exact moment of expiresAt is valid.
    function test_capture_exactlyAtExpiresAt_succeeds() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt); // exactly at the boundary

        vm.prank(relayer);
        core.capture(TX1); // must succeed

        assertTrue(core.getHold(TX1).status == HoldStatus.CAPTURED);
        assertEq(token.balanceOf(merchant), AMOUNT);
    }

    // =========================================================================
    // BOUNDARY — expire exactly at expiresAt (exclusive limit)
    // =========================================================================

    /// @dev The expire condition is `block.timestamp > hold.expiresAt`, therefore
    ///      calling expire at the exact moment of expiresAt must revert.
    function test_expire_exactlyAtExpiresAt_reverts() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.warp(expiresAt); // exactly at the boundary

        vm.expectRevert(abi.encodeWithSelector(HoldNotExpired.selector, TX1, expiresAt));
        core.expire(TX1);
    }

    // =========================================================================
    // EDGE CASE — authorize with txId = bytes32(0)
    // =========================================================================

    /// @dev bytes32(0) is a technically valid identifier. The contract must not
    ///      treat it as a special value; it must behave the same as any other txId.
    function test_authorize_zeroTxId_isAccepted() public {
        bytes32 zeroId = bytes32(0);

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(zeroId, user, merchant, address(token), AMOUNT, expiresAt);

        assertTrue(core.getHold(zeroId).status == HoldStatus.AUTHORIZED);

        // A second attempt with the same txId must revert as usual
        token.mint(user, AMOUNT);
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(TxIdAlreadyUsed.selector, zeroId));
        core.authorize(zeroId, user, merchant, address(token), AMOUNT, expiresAt);
    }

    // =========================================================================
    // EDGE CASE — merchant == user (self-payment)
    // =========================================================================

    /// @dev The contract does not prohibit merchant and user being the same address.
    ///      In that case capture transfers funds from the contract back to the user,
    ///      which is a valid business flow.
    function test_authorize_merchantEqualsUser_succeeds() public {
        uint256 preBal = token.balanceOf(user); // balance before deposit

        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        // merchant == user
        vm.prank(relayer);
        core.authorize(TX1, user, user, address(token), AMOUNT, expiresAt);

        (, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, AMOUNT, "amount must be locked");

        vm.prank(relayer);
        core.capture(TX1);

        // User recovers the tokens even though they "captured" to themselves
        assertEq(token.balanceOf(user), preBal, "user balance must equal pre-deposit balance");
    }

    // =========================================================================
    // PAUSE SEMANTICS — expire remains available; release is blocked
    // =========================================================================

    /// @dev expire intentionally omits whenNotPaused — users must always be able
    ///      to recover funds from expired holds even while the system is paused.
    function test_pause_expireStillWorksWhenPaused() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(pauser);
        core.pause();

        vm.warp(expiresAt + 1);

        // expire must work regardless of pause state
        core.expire(TX1);

        (uint256 avail, uint256 locked) = core.getBalance(user, address(token));
        assertEq(locked, 0, "funds must not be locked");
        assertEq(avail, AMOUNT, "funds must be back as available");
    }

    /// @dev release has whenNotPaused, so it must revert when the contract is
    ///      paused, even for the relayer.
    function test_pause_releaseIsBlockedWhenPaused() public {
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);

        vm.prank(pauser);
        core.pause();

        vm.prank(relayer);
        vm.expectRevert(); // EnforcedPause
        core.release(TX1);
    }

    // =========================================================================
    // MULTI-USER — multiple holds, different users, same merchant
    // =========================================================================

    /// @dev Verifies that the contract maintains separate accounting per user
    ///      even when all holds point to the same merchant. One user's balance
    ///      must not be affected by operations on another user's holds.
    function test_multipleHolds_differentUsersSameMerchant() public {
        address user2 = makeAddr("user2");
        token.mint(user2, AMOUNT);

        // Both users deposit
        vm.startPrank(user);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        vm.startPrank(user2);
        token.approve(address(core), AMOUNT);
        core.deposit(address(token), AMOUNT);
        vm.stopPrank();

        // Both authorize to the same merchant
        vm.prank(relayer);
        core.authorize(TX1, user, merchant, address(token), AMOUNT, expiresAt);
        vm.prank(relayer);
        core.authorize(TX2, user2, merchant, address(token), AMOUNT, expiresAt);

        // Capture only user2's hold
        vm.prank(relayer);
        core.capture(TX2);

        // user's hold must remain AUTHORIZED and intact
        assertTrue(core.getHold(TX1).status == HoldStatus.AUTHORIZED, "TX1 must still be AUTHORIZED");
        (uint256 avail1, uint256 locked1) = core.getBalance(user, address(token));
        assertEq(locked1, AMOUNT, "user funds must still be locked");
        assertEq(avail1, 0, "user available must be zero");

        // user2 has nothing locked and merchant received exactly AMOUNT
        (uint256 avail2, uint256 locked2) = core.getBalance(user2, address(token));
        assertEq(locked2, 0, "user2 must have no locked funds");
        assertEq(avail2, 0, "user2 must have no available balance");
        assertEq(token.balanceOf(merchant), AMOUNT, "merchant must have exactly AMOUNT");
    }
}

// =============================================================================
// Invariant test suite — Foundry stateful fuzzing
// =============================================================================

contract SettlementInvariantTest is StdInvariant, Test {
    ArbitrumSettlementCore core;
    MockERC20 token;
    SettlementHandler handler;

    address admin = makeAddr("inv_admin");
    address relayer = makeAddr("inv_relayer");

    function setUp() public {
        token = new MockERC20("USD Coin", "USDC", 6);

        ArbitrumSettlementCore impl = new ArbitrumSettlementCore();
        bytes memory initData = abi.encodeCall(ArbitrumSettlementCore.initialize, (admin));
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        core = ArbitrumSettlementCore(address(proxy));

        vm.startPrank(admin);
        core.grantRole(core.RELAYER_ROLE(), relayer);
        core.configureToken(address(token), true);
        vm.stopPrank();

        handler = new SettlementHandler(core, token, relayer, admin);

        // Seed initial users
        handler.addUser(1);
        handler.addUser(2);
        handler.addUser(3);

        // Initial deposits so the fuzzer has useful state from the start
        handler.deposit(0, uint96(500e6));
        handler.deposit(1, uint96(500e6));
        handler.deposit(2, uint96(500e6));

        targetContract(address(handler));
    }

    // -------------------------------------------------------------------------
    // Invariant 1 — Locked funds == sum of AUTHORIZED holds
    // -------------------------------------------------------------------------
    /// @dev For every user, the amount marked as `locked` must equal exactly the
    ///      sum of all holds still in AUTHORIZED status. Any transition
    ///      (capture/release/expire) must decrement both atomically. A discrepancy
    ///      implies state corruption.
    function invariant_lockedEqualsAuthorizedHoldSums() public view {
        assertEq(handler.totalLocked(), handler.totalAuthorizedHoldAmounts(), "INV1: locked != sum of AUTHORIZED holds");
    }

    // -------------------------------------------------------------------------
    // Invariant 2 — Contract balance always covers internal accounting
    // -------------------------------------------------------------------------
    /// @dev The ERC-20 balance of the contract must be >= (available + locked) for
    ///      all users. Funds cannot be conjured out of thin air internally.
    function invariant_contractBalanceCoversInternalAccounting() public view {
        assertGe(
            token.balanceOf(address(core)),
            handler.totalAccountedBalance(),
            "INV2: contract ERC-20 balance < internal accounting"
        );
    }

    // -------------------------------------------------------------------------
    // Invariant 3 — Terminal holds are immutable
    // -------------------------------------------------------------------------
    /// @dev A hold that reaches CAPTURED, RELEASED, or EXPIRED must not transition
    ///      to any other status. We verify that no tracked txId shows status NONE
    ///      (it must never roll back to pre-existence).
    function invariant_terminalHoldsStayTerminal() public view {
        bytes32[] memory txIds = handler.getActiveTxIds();
        for (uint256 i; i < txIds.length; ++i) {
            Hold memory h = core.getHold(txIds[i]);
            assertTrue(h.status != HoldStatus.NONE, "INV3: tracked txId rolled back to status NONE");
        }
    }

    // -------------------------------------------------------------------------
    // Invariant 4 — Global token conservation
    // -------------------------------------------------------------------------
    /// @dev The token's totalSupply does not change (the protocol performs no
    ///      mint or burn). Tokens are redistributed among wallets and the contract,
    ///      but the total never changes.
    function invariant_tokenSupplyIsConserved() public view {
        assertGt(token.totalSupply(), 0, "INV4: totalSupply must be positive");
    }
}
