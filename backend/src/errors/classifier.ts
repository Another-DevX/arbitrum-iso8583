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

const ERROR_NAME_MAP: Record<string, ErrorCode> = {
  InsufficientAvailableBalance: 'INSUFFICIENT_FUNDS',
  TxIdAlreadyUsed: 'DUPLICATE_AUTHORIZATION',
  InvalidHoldStatus: 'INVALID_CAPTURE',
  HoldExpired: 'EXPIRED_HOLD',
  HoldNotExpired: 'HOLD_NOT_EXPIRED',
  HoldNotFound: 'HOLD_NOT_FOUND',
  TokenNotAllowed: 'TOKEN_NOT_ALLOWED',
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

interface ErrorLike {
  cause?: unknown
  code?: number
  name?: string
  errorName?: string
  raw?: string
  data?: string
  shortMessage?: string
  message?: string
  details?: string
  metaMessages?: unknown
}

/**
 * Viem wraps decoded contract reverts in two or more `cause` levels. Walking
 * only the top-level message loses `errorName` and raw revert data, turning
 * expected payment declines into the generic ISO 96 response.
 */
function errorChain(err: unknown): ErrorLike[] {
  const chain: ErrorLike[] = []
  const seen = new Set<object>()
  let current = err

  for (let depth = 0; depth < 12 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    const item = current as ErrorLike
    chain.push(item)
    current = item.cause
  }
  return chain
}

function errorText(err: unknown): string {
  return errorChain(err)
    .flatMap((item) => [
      item.shortMessage,
      item.message,
      item.details,
      ...(Array.isArray(item.metaMessages) ? item.metaMessages : []),
    ])
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

function extractContractError(err: unknown): ErrorCode | null {
  for (const item of errorChain(err)) {
    if (item.errorName && ERROR_NAME_MAP[item.errorName]) {
      return ERROR_NAME_MAP[item.errorName]
    }

    const candidates = [item.raw, item.data, item.shortMessage, item.message, item.details]
    for (const value of candidates) {
      if (typeof value !== 'string') continue
      const selector = value.match(/0x[0-9a-fA-F]{8}/)?.[0].toLowerCase()
      if (selector && SELECTOR_MAP[selector]) return SELECTOR_MAP[selector]
    }
  }
  return null
}

function isRpcError(err: unknown): boolean {
  for (const item of errorChain(err)) {
    if (item.name === 'TransportHttpError' || item.name === 'FetchError') return true
    if (typeof item.code === 'number' && item.code >= 500) return true
  }
  return /network|timeout|ECONNREFUSED|ETIMEDOUT/i.test(errorText(err))
}

function isNonceError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase()
  return msg.includes('nonce too low') || msg.includes('already known')
}

function isPausedError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase()
  return msg.includes('enforced pause') || msg.includes('paused')
}

export function classifyError(err: unknown): ClassifiedError {
  // 1. Nonce
  if (isNonceError(err)) {
    return make('NONCE_CONFLICT', err)
  }

  // 2. Contract paused
  if (isPausedError(err)) {
    return make('CONTRACT_PAUSED', err)
  }

  // 3. Decoded Solidity custom error name or selector. This must run before
  // RPC classification because providers often attach JSON-RPC codes to a
  // perfectly valid contract revert.
  const contractError = extractContractError(err)
  if (contractError) {
    return make(contractError, err)
  }

  // 4. Mapping failures raised by the normalizer before any chain submission
  const msg = errorText(err).toLowerCase()
  if (msg.includes('merchant ref')) {
    return make('UNAUTHORIZED_MERCHANT', err)
  }
  if (msg.includes('card token')) {
    return make('CARD_NOT_MAPPED', err)
  }

  // 5. RPC / network
  if (isRpcError(err)) {
    return make('RPC_FAILURE', err)
  }

  // 6. Undecoded gas estimation failure
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
