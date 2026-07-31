// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IArbitrumSettlementCore} from "./interfaces/IArbitrumSettlementCore.sol";
import {
    Hold,
    Balance,
    TokenConfig,
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
} from "./interfaces/ISettlementTypes.sol";

contract ArbitrumSettlementCore is
    Initializable,
    IArbitrumSettlementCore,
    AccessControlUpgradeable,
    ReentrancyGuardTransient,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant TOKEN_ADMIN_ROLE = keccak256("TOKEN_ADMIN_ROLE");

    uint256 public constant MAX_BATCH_EXPIRE = 50;

    // -------------------------------------------------------------------------
    // ERC-7201 Namespaced Storage (diamond pattern)
    // -------------------------------------------------------------------------

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.arbitrum_settlement_core")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant STORAGE_LOCATION = 0x3b9a8f68b0a8bfb3eae19be46abaa7e40464ff117ac368e14cbd4d1280755c00;

    /// @custom:storage-location erc7201:openzeppelin.storage.arbitrum_settlement_core
    struct ArbitrumSettlementCoreStorage {
        mapping(address => TokenConfig) tokenConfig;
        mapping(address => mapping(address => Balance)) balances;
        mapping(bytes32 => Hold) holds;
    }

    function _getStorage() private pure returns (ArbitrumSettlementCoreStorage storage s) {
        bytes32 location = STORAGE_LOCATION;
        // Slither: this assembly is the standard ERC-7201 accessor for the fixed
        // application namespace above; it does not accept a caller-controlled slot.
        // slither-disable-next-line assembly
        assembly {
            s.slot := location
        }
    }

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        require(admin != address(0), ZeroAddress());

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(TOKEN_ADMIN_ROLE, admin);
    }

    /// @dev Only DEFAULT_ADMIN can authorize proxy upgrades.
    function _authorizeUpgrade(
        address /*newImplementation*/
    )
        internal
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {}

    // -------------------------------------------------------------------------
    // Token config
    // -------------------------------------------------------------------------

    function configureToken(address token, bool allowed) external onlyRole(TOKEN_ADMIN_ROLE) {
        require(token != address(0), ZeroAddress());

        uint8 decimals = IERC20Metadata(token).decimals();
        _getStorage().tokenConfig[token] = TokenConfig({allowed: allowed, decimals: decimals});

        emit TokenConfigured(token, allowed, decimals);
    }

    // -------------------------------------------------------------------------
    // Deposit / Withdraw
    // -------------------------------------------------------------------------

    function deposit(address token, uint256 amount) external nonReentrant whenNotPaused requireTokenAllowed(token) {
        require(amount != 0, ZeroAmount());

        // Fee-on-transfer guard: measure the actual balance delta and revert if
        // the contract received less than `amount`. This prevents the internal
        // ledger from crediting more tokens than the contract actually holds,
        // which would cause insolvency. Fee-on-transfer tokens are not supported.
        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        // Slither: exact equality is the solvency invariant. Crediting a smaller
        // received amount would make the internal ledger exceed token custody.
        // slither-disable-next-line incorrect-equality
        require(received == amount, FeeOnTransferToken(token, amount, received));

        _getStorage().balances[msg.sender][token].available += amount;

        emit Deposited(msg.sender, token, amount);
    }

    /**
     * @notice Withdraws available balance for a given token.
     * @dev Intentionally does NOT require the token to be currently allowed. This ensures users
     *      can always recover funds even if a token is later disabled via `configureToken`.
     *      The system must never trap user funds behind an admin gate.
     * @param token ERC-20 token address.
     * @param amount Amount to withdraw. Must be <= available balance.
     */
    function withdraw(address token, uint256 amount) external nonReentrant whenNotPaused {
        require(amount != 0, ZeroAmount());

        uint256 available = _getStorage().balances[msg.sender][token].available;
        require(available >= amount, InsufficientAvailableBalance(available, amount));

        _getStorage().balances[msg.sender][token].available = available - amount;
        IERC20(token).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, token, amount);
    }

    // -------------------------------------------------------------------------
    // Authorize / Capture / Release / Expire
    // -------------------------------------------------------------------------

    /**
     * @notice Creates an authorized hold, locking `amount` from `user`'s available balance.
     * @dev Only callable by the RELAYER_ROLE. The relayer is responsible for all off-chain
     *      business logic prior to calling this function, including:
     *      - KYC / AML checks
     *      - Per-user and per-merchant spending limits
     *      - Daily / velocity limits
     *      - Fraud scoring
     *      On-chain, the contract only enforces that the user has sufficient available balance.
     * @param txId       Unique identifier for this payment (must not have been used before).
     * @param user       Address whose funds are being held.
     * @param merchant   Address that will receive funds upon capture.
     * @param token      ERC-20 token to use.
     * @param amount     Amount to lock. Must be > 0 and <= user's available balance.
     * @param expiresAt  Unix timestamp after which capture is no longer valid.
     */
    function authorize(bytes32 txId, address user, address merchant, address token, uint256 amount, uint48 expiresAt)
        external
        onlyRole(RELAYER_ROLE)
        whenNotPaused
        nonReentrant
        requireTokenAllowed(token)
    {
        ArbitrumSettlementCoreStorage storage $ = _getStorage();

        require($.holds[txId].status == HoldStatus.NONE, TxIdAlreadyUsed(txId));
        require(user != address(0), ZeroAddress());
        require(merchant != address(0), ZeroAddress());
        require(amount != 0, ZeroAmount());
        // Slither: expiresAt is a business deadline, not a source of randomness.
        // slither-disable-next-line timestamp
        require(expiresAt > block.timestamp, ExpiresAtInPast(expiresAt, block.timestamp));

        uint256 available = $.balances[user][token].available;
        require(available >= amount, InsufficientAvailableBalance(available, amount));

        $.balances[user][token].available = available - amount;
        $.balances[user][token].locked += amount;

        $.holds[txId] = Hold({
            user: user,
            merchant: merchant,
            token: token,
            amount: amount,
            createdAt: uint48(block.timestamp),
            expiresAt: expiresAt,
            status: HoldStatus.AUTHORIZED
        });

        emit PaymentAuthorized(txId, user, merchant, token, amount, expiresAt);
    }

    /**
     * @notice Captures a hold, immediately transferring funds to the merchant.
     * @dev This is a FINAL settlement — not a contable capture phase. The token transfer
     *      to the merchant is atomic with the state change: if the transfer fails, the
     *      entire transaction reverts and the hold remains AUTHORIZED.
     *
     *      Scope limitations (by design for M1):
     *      - No partial capture: the full hold amount is always captured.
     *      - No incremental capture: a hold can only be captured once.
     *      - No overcapture / tip adjustment: amount is fixed at authorize time.
     *      - No reversals or refunds: once captured, funds are with the merchant.
     *
     *      If future clearing/netting is required, a separate settlement layer
     *      must be introduced; this contract is not designed for that.
     * @param txId Unique identifier of the hold to capture. Must be AUTHORIZED and not expired.
     */
    function capture(bytes32 txId) external onlyRole(RELAYER_ROLE) whenNotPaused nonReentrant requireAuthorized(txId) {
        ArbitrumSettlementCoreStorage storage $ = _getStorage();
        Hold storage hold = $.holds[txId];
        // Slither: block time intentionally enforces the documented hold deadline.
        // slither-disable-next-line timestamp
        require(block.timestamp <= hold.expiresAt, HoldExpired(txId, hold.expiresAt));

        address user = hold.user;
        address merchant = hold.merchant;
        address token = hold.token;
        uint256 amount = hold.amount;

        hold.status = HoldStatus.CAPTURED;
        $.balances[user][token].locked -= amount;

        IERC20(token).safeTransfer(merchant, amount);

        emit PaymentCaptured(txId, user, merchant, token, amount);
    }

    /**
     * @notice Releases a hold, returning locked funds to the user's available balance.
     * @dev Only callable while the hold is AUTHORIZED and NOT yet expired. Once a hold
     *      has passed its `expiresAt` timestamp, only `expire` (or `batchExpire`) can
     *      free the funds — release is intentionally blocked to avoid ambiguity between
     *      the two release paths and to enforce a clear state machine:
     *
     *          AUTHORIZED + not expired → release  (relayer-initiated)
     *          AUTHORIZED + expired     → expire   (permissionless)
     *
     * @param txId Unique identifier of the hold to release. Must be AUTHORIZED and not expired.
     */
    function release(bytes32 txId) external whenNotPaused nonReentrant requireReleaserRole requireAuthorized(txId) {
        ArbitrumSettlementCoreStorage storage $ = _getStorage();
        Hold storage hold = $.holds[txId];
        // Slither: block time intentionally enforces the documented hold deadline.
        // slither-disable-next-line timestamp
        require(block.timestamp <= hold.expiresAt, HoldExpired(txId, hold.expiresAt));

        address user = hold.user;
        address token = hold.token;
        uint256 amount = hold.amount;

        hold.status = HoldStatus.RELEASED;
        $.balances[user][token].locked -= amount;
        $.balances[user][token].available += amount;

        emit PaymentReleased(txId, user, hold.merchant, token, amount);
    }

    /**
     * @notice Expires a single hold that has passed its `expiresAt` timestamp,
     *         returning locked funds to the user's available balance.
     * @dev Intentionally omits `whenNotPaused`. This is by design: even when the system
     *      is paused (e.g. during an incident or upgrade), users must always be able to
     *      recover funds from expired holds. Pause semantics here mean "block new business
     *      operations", not "freeze all state mutations".
     * @param txId Unique identifier of the hold to expire.
     */
    function expire(bytes32 txId) external nonReentrant {
        _expireSingle(txId);
    }

    /**
     * @notice Expires multiple holds in a single transaction.
     * @dev Same pause semantics as `expire`: intentionally omits `whenNotPaused` to
     *      guarantee fund recovery is always available, regardless of system state.
     *      Limited to {MAX_BATCH_EXPIRE} entries per call to bound gas consumption.
     * @param txIds Array of hold identifiers to expire. Max length: {MAX_BATCH_EXPIRE}.
     */
    function batchExpire(bytes32[] calldata txIds) external nonReentrant {
        uint256 len = txIds.length;
        require(len <= MAX_BATCH_EXPIRE, BatchTooLarge(len, MAX_BATCH_EXPIRE));

        for (uint256 i; i < len; ++i) {
            _expireSingle(txIds[i]);
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getBalance(address user, address token) external view returns (uint256 available, uint256 locked) {
        Balance storage balance = _getStorage().balances[user][token];
        return (balance.available, balance.locked);
    }

    function getHold(bytes32 txId) external view returns (Hold memory) {
        return _getStorage().holds[txId];
    }

    function getTokenConfig(address token) external view returns (TokenConfig memory) {
        return _getStorage().tokenConfig[token];
    }

    // -------------------------------------------------------------------------
    // Pause
    // -------------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Internal modifiers
    // -------------------------------------------------------------------------

    modifier requireTokenAllowed(address token) {
        require(_getStorage().tokenConfig[token].allowed, TokenNotAllowed(token));
        _;
    }

    modifier requireReleaserRole() {
        if (!hasRole(RELAYER_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            _checkRole(RELAYER_ROLE);
        }
        _;
    }

    modifier requireAuthorized(bytes32 txId) {
        ArbitrumSettlementCoreStorage storage $ = _getStorage();
        require($.holds[txId].status != HoldStatus.NONE, HoldNotFound(txId));
        require($.holds[txId].status == HoldStatus.AUTHORIZED, InvalidHoldStatus(txId, $.holds[txId].status));
        _;
    }

    function _expireSingle(bytes32 txId) internal requireAuthorized(txId) {
        ArbitrumSettlementCoreStorage storage $ = _getStorage();
        Hold storage h = $.holds[txId];
        // Slither: expiry is permissionless only after this business deadline.
        // slither-disable-next-line timestamp
        require(block.timestamp > h.expiresAt, HoldNotExpired(txId, h.expiresAt));

        address user = h.user;
        address token = h.token;
        uint256 amount = h.amount;

        h.status = HoldStatus.EXPIRED;
        $.balances[user][token].locked -= amount;
        $.balances[user][token].available += amount;

        emit PaymentExpired(txId, user, h.merchant, token, amount);
    }
}
