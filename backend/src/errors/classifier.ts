/**
 * errors/classifier.ts
 * Classifies payment-related errors into well-known error codes that map
 * directly to ISO 8583 response codes used by the payment stack.
 *
 * Contract revert selectors are derived from the ISettlementTypes.sol errors.
 */

export type ErrorCode =
  | 'INSUFFICIENT_FUNDS'        // user balance too low
  | 'DUPLICATE_AUTHORIZATION'   // txId already used onchain
  | 'INVALID_CAPTURE'           // hold not in AUTHORIZED state
  | 'EXPIRED_HOLD'              // capture attempted after expiresAt
  | 'HOLD_NOT_EXPIRED'          // expire called before expiresAt
  | 'UNAUTHORIZED_MERCHANT'     // merchant address not found / zero
  | 'CARD_NOT_MAPPED'           // card token has no active address mapping
  | 'TOKEN_NOT_ALLOWED'         // token not configured on the contract
  | 'CONTRACT_PAUSED'           // contract is paused
  | 'RPC_FAILURE'               // transport / network error
  | 'NONCE_CONFLICT'            // nonce too low / already known
  | 'GAS_ESTIMATION_FAILED'     // out-of-gas or revert during estimation
  | 'HOLD_NOT_FOUND'            // txId does not exist
  | 'UNKNOWN_CONTRACT_REVERT'   // unrecognised revert reason
  | 'UNKNOWN'                   // catch-all

export interface ClassifiedError {
  code: ErrorCode
  /** ISO 8583 response code that the payment stack should receive */
  isoResponseCode: string
  /** Human-readable message for internal logs */
  message: string
  /** Original raw error */
  cause?: unknown
}

// ── Known Solidity 4-byte error selectors ─────────────────────────────────────
// Verificados con: node -e "const {keccak256,toBytes}=require('viem'); console.log(keccak256(toBytes('<sig>')).slice(0,10))"
const SELECTOR_MAP: Record<string, ErrorCode> = {
  '0xadb9e043': 'INSUFFICIENT_FUNDS',          // InsufficientAvailableBalance(uint256,uint256)
  '0xf4e6a85a': 'DUPLICATE_AUTHORIZATION',     // TxIdAlreadyUsed(bytes32)
  '0x076675a9': 'INVALID_CAPTURE',             // InvalidHoldStatus(bytes32,uint8)
  '0x2e27244b': 'EXPIRED_HOLD',               // HoldExpired(bytes32,uint256)
  '0xc6cef671': 'HOLD_NOT_EXPIRED',            // HoldNotExpired(bytes32,uint256)
  '0xe3882155': 'HOLD_NOT_FOUND',              // HoldNotFound(bytes32)
  '0x94403b70': 'TOKEN_NOT_ALLOWED',           // TokenNotAllowed(address)
  '0x825ab413': 'UNKNOWN_CONTRACT_REVERT',     // FeeOnTransferToken(address,uint256,uint256)
  '0xd92e233d': 'UNKNOWN_CONTRACT_REVERT',     // ZeroAddress()
  '0x1f2a2005': 'UNKNOWN_CONTRACT_REVERT',     // ZeroAmount()
  '0x9eda8fcc': 'UNKNOWN_CONTRACT_REVERT',     // ExpiresAtInPast(uint256,uint256)
  '0xbb1cb70b': 'UNKNOWN_CONTRACT_REVERT',     // BatchTooLarge(uint256,uint256)
}

// ── ISO 8583 response code mapping ───────────────────────────────────────────
const ISO_RESPONSE_CODE: Record<ErrorCode, string> = {
  INSUFFICIENT_FUNDS:        '51', // Insufficient funds
  DUPLICATE_AUTHORIZATION:   '94', // Duplicate transmission
  INVALID_CAPTURE:           '58', // Transaction not permitted
  EXPIRED_HOLD:              '54', // Expired card / transaction
  HOLD_NOT_EXPIRED:          '58', // Transaction not permitted
  UNAUTHORIZED_MERCHANT:     '03', // Invalid merchant
  CARD_NOT_MAPPED:           '14', // Invalid card number/token
  TOKEN_NOT_ALLOWED:         '57', // Transaction not permitted to cardholder
  CONTRACT_PAUSED:           '91', // Issuer or switch is inoperative
  RPC_FAILURE:               '96', // System malfunction
  NONCE_CONFLICT:            '96', // System malfunction
  GAS_ESTIMATION_FAILED:     '96', // System malfunction
  HOLD_NOT_FOUND:            '25', // Unable to locate record on file
  UNKNOWN_CONTRACT_REVERT:   '05', // Do not honour
  UNKNOWN:                   '05', // Do not honour
}

// ── Classifier ────────────────────────────────────────────────────────────────

function extractSelector(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null
  const msg: string =
    (err as { shortMessage?: string; message?: string }).shortMessage ??
    (err as { message?: string }).message ??
    ''
  const match = msg.match(/0x[0-9a-fA-F]{8}/)
  return match ? match[0].toLowerCase() : null
}

function isRpcError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; name?: string; message?: string }
  if (e.name === 'TransportHttpError' || e.name === 'FetchError') return true
  if (typeof e.code === 'number' && (e.code === -32000 || e.code >= 500)) return true
  return /network|timeout|ECONNREFUSED|ETIMEDOUT/i.test(e.message ?? '')
}

function isNonceError(err: unknown): boolean {
  const msg: string =
    ((err as { message?: string })?.message ?? '').toLowerCase()
  return msg.includes('nonce too low') || msg.includes('already known')
}

function isPausedError(err: unknown): boolean {
  const msg: string =
    ((err as { message?: string })?.message ?? '').toLowerCase()
  return msg.includes('enforced pause') || msg.includes('paused')
}

export function classifyError(err: unknown): ClassifiedError {
  // 1. Nonce
  if (isNonceError(err)) {
    return make('NONCE_CONFLICT', err)
  }

  // 2. RPC / network
  if (isRpcError(err)) {
    return make('RPC_FAILURE', err)
  }

  // 3. Contract paused
  if (isPausedError(err)) {
    return make('CONTRACT_PAUSED', err)
  }

  // 4. Solidity custom error selector
  const selector = extractSelector(err)
  if (selector && SELECTOR_MAP[selector]) {
    return make(SELECTOR_MAP[selector], err)
  }

  // 5. Mapping failures raised by the normalizer before any chain submission
  const msg = ((err as { message?: string })?.message ?? '').toLowerCase()
  if (msg.includes('merchant ref')) {
    return make('UNAUTHORIZED_MERCHANT', err)
  }
  if (msg.includes('card token')) {
    return make('CARD_NOT_MAPPED', err)
  }

  // 6. Gas estimation failure
  if (msg.includes('gas') && (msg.includes('revert') || msg.includes('failed'))) {
    return make('GAS_ESTIMATION_FAILED', err)
  }

  return make('UNKNOWN', err)
}

function make(code: ErrorCode, cause?: unknown): ClassifiedError {
  return {
    code,
    isoResponseCode: ISO_RESPONSE_CODE[code],
    message: code.replace(/_/g, ' ').toLowerCase(),
    cause,
  }
}
