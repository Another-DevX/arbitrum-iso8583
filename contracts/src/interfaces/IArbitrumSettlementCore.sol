// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Hold, Balance, TokenConfig} from "./ISettlementTypes.sol";

interface IArbitrumSettlementCore {
    event TokenConfigured(address indexed token, bool allowed, uint8 decimals);
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event PaymentAuthorized(
        bytes32 indexed txId,
        address indexed user,
        address indexed merchant,
        address token,
        uint256 amount,
        uint256 expiresAt
    );
    event PaymentCaptured(
        bytes32 indexed txId, address indexed user, address indexed merchant, address token, uint256 amount
    );
    event PaymentReleased(
        bytes32 indexed txId, address indexed user, address indexed merchant, address token, uint256 amount
    );
    event PaymentExpired(
        bytes32 indexed txId, address indexed user, address indexed merchant, address token, uint256 amount
    );

    function configureToken(address token, bool allowed) external;

    function deposit(address token, uint256 amount) external;

    function withdraw(address token, uint256 amount) external;

    function authorize(bytes32 txId, address user, address merchant, address token, uint256 amount, uint48 expiresAt)
        external;

    function capture(bytes32 txId) external;

    function release(bytes32 txId) external;

    function expire(bytes32 txId) external;

    function batchExpire(bytes32[] calldata txIds) external;

    function getBalance(address user, address token) external view returns (uint256 available, uint256 locked);

    function getHold(bytes32 txId) external view returns (Hold memory);

    function getTokenConfig(address token) external view returns (TokenConfig memory);

    function pause() external;

    function unpause() external;
}
