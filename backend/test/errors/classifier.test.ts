/**
 * test/errors/classifier.test.ts
 * Unit tests for error classification.
 */
import { classifyError } from '../../src/errors/classifier.js'

describe('classifyError', () => {
  it('classifies nonce too low', () => {
    const err = new Error('nonce too low')
    const result = classifyError(err)
    expect(result.code).toBe('NONCE_CONFLICT')
    expect(result.isoResponseCode).toBe('96')
  })

  it('classifies network / transport error', () => {
    const err = Object.assign(new Error('ECONNREFUSED'), { name: 'FetchError' })
    const result = classifyError(err)
    expect(result.code).toBe('RPC_FAILURE')
  })

  it('classifies paused contract', () => {
    const err = new Error('EnforcedPause: paused')
    const result = classifyError(err)
    expect(result.code).toBe('CONTRACT_PAUSED')
    expect(result.isoResponseCode).toBe('91')
  })

  it('returns UNKNOWN for unrecognised errors', () => {
    const result = classifyError(new Error('some random error'))
    expect(result.code).toBe('UNKNOWN')
    expect(result.isoResponseCode).toBe('05')
  })

  it('handles non-Error objects gracefully', () => {
    expect(() => classifyError(null)).not.toThrow()
    expect(() => classifyError('string error')).not.toThrow()
    expect(() => classifyError(42)).not.toThrow()
  })

  it('maps an unknown merchant to ISO 03', () => {
    const result = classifyError(new Error('No address mapping found for merchant ref: UNKNOWN'))
    expect(result.code).toBe('UNAUTHORIZED_MERCHANT')
    expect(result.isoResponseCode).toBe('03')
  })

  it('maps an unknown card token to ISO 14', () => {
    const result = classifyError(new Error('No address mapping found for card token: UNKNOWN'))
    expect(result.code).toBe('CARD_NOT_MAPPED')
    expect(result.isoResponseCode).toBe('14')
  })

  it('maps a nested Viem insufficient-balance revert to ISO 51', () => {
    const err = {
      shortMessage: 'The contract function "authorize" reverted.',
      cause: {
        shortMessage: 'The contract function "authorize" reverted.',
        cause: {
          errorName: 'InsufficientAvailableBalance',
          raw: '0xadb9e0430000000000000000000000000000000000000000000000000000000000000000',
        },
      },
    }
    const result = classifyError(err)
    expect(result.code).toBe('INSUFFICIENT_FUNDS')
    expect(result.isoResponseCode).toBe('51')
  })

  it('maps a nested Viem HoldExpired revert to ISO 54', () => {
    const err = {
      message: 'Gas estimation failed because execution reverted',
      cause: {
        code: -32000,
        cause: {
          errorName: 'HoldExpired',
          raw: '0x2e27244b0000000000000000000000000000000000000000000000000000000000000000',
        },
      },
    }
    const result = classifyError(err)
    expect(result.code).toBe('EXPIRED_HOLD')
    expect(result.isoResponseCode).toBe('54')
  })

  it('maps nested raw revert data even when errorName is absent', () => {
    const result = classifyError({
      shortMessage: 'The contract function reverted.',
      cause: { raw: '0xe38821550000000000000000000000000000000000000000000000000000000000000000' },
    })
    expect(result.code).toBe('HOLD_NOT_FOUND')
    expect(result.isoResponseCode).toBe('25')
  })
})
