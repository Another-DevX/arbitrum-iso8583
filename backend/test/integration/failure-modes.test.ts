import { jest } from '@jest/globals'

const mockSubmitFn = jest.fn()
const mockReceiptFn = jest.fn()
const mockNormalizeFn = jest.fn()

jest.unstable_mockModule('../../src/relayer/submitter', () => ({
  submitContractCall: mockSubmitFn,
}))

jest.unstable_mockModule('../../src/relayer/responseHandler', () => ({
  waitForReceipt: mockReceiptFn,
}))

jest.unstable_mockModule('../../src/mapping/normalizer', () => ({
  normalize: mockNormalizeFn,
  resolveTokenAddress: jest.fn(),
}))

const { processIsoMessage } = await import('../../src/routes/intake')
const {
  createPaymentLog,
  listChainOperations,
} = await import('../../src/db/paymentLog')

const PAYMENT = {
  txId: '0xabc',
  userAddress: '0x1111111111111111111111111111111111111111',
  merchantAddress: '0x2222222222222222222222222222222222222222',
  tokenAddress: '0xA730eFe70d3f67d08dD4a17a867c95bFe1F33CfA',
  amountWei: 1_250_000n,
  expiresAt: Math.floor(Date.now() / 1000) + 3_600,
  isoFields: null,
}

function authorize(stan = '810001') {
  return {
    mti: '0100',
    fields: {
      '002': 'CARD_TOKEN_001',
      '003': '000000',
      '004': '000000001250',
      '007': '0728120000',
      '011': stan,
      '012': '120000',
      '013': '0728',
      '037': `FAIL${stan}01`,
      '042': 'TERM001',
      '043': 'MERCHANT001',
      '049': '840',
    },
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockNormalizeFn.mockResolvedValue(PAYMENT)
  mockSubmitFn.mockResolvedValue({
    success: true,
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    attempts: 1,
    nonce: 7,
    estimatedGas: 100_000n,
    gasEstimateMs: 10,
    submitMs: 20,
  })
  mockReceiptFn.mockResolvedValue({
    outcome: 'authorized',
    isoResponseCode: '00',
    txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    blockNumber: 100,
    blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    gasUsed: 90_000n,
    effectiveGasPrice: 1_000_000n,
    feeWei: 90_000_000_000n,
    confirmationMs: 1_000,
    events: [],
  })
})

describe('M3 failure modes', () => {
  it('records an RPC failure before broadcast', async () => {
    mockSubmitFn.mockResolvedValueOnce({
      success: false,
      classified: { code: 'RPC_FAILURE', isoResponseCode: '96', message: 'rpc failure' },
      attempts: 1,
      retryable: true,
      gasEstimateMs: 5,
    })
    const result = await processIsoMessage(authorize('810001'))
    const operations = await listChainOperations(result.txId)
    expect(result.isoResponseCode).toBe('96')
    expect(operations).toHaveLength(1)
    expect(operations[0].status).toBe('failed')
    expect(operations[0].tx_hash).toBeNull()
  })

  it('persists the successful second attempt after a nonce retry', async () => {
    mockSubmitFn.mockResolvedValueOnce({
      success: true,
      txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      attempts: 2,
      nonce: 8,
      estimatedGas: 100_000n,
      gasEstimateMs: 12,
      submitMs: 21,
    })
    const result = await processIsoMessage(authorize('810002'))
    const operations = await listChainOperations(result.txId)
    expect(result.isoResponseCode).toBe('00')
    expect(operations[0].attempt).toBe(2)
    expect(operations[0].nonce).toBe(8)
  })

  it('keeps a timed-out transaction pending for reconciliation', async () => {
    mockReceiptFn.mockResolvedValueOnce({
      outcome: 'timeout',
      isoResponseCode: '96',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      blockNumber: null,
      confirmationMs: 120_000,
      events: [],
    })
    const result = await processIsoMessage(authorize('810003'))
    const operations = await listChainOperations(result.txId)
    expect(result.status).toBe('pending')
    expect(result.isoResponseCode).toBe('96')
    expect(operations[0].status).toBe('pending')
    expect(operations[0].tx_hash).not.toBeNull()
  })

  it('maps an insufficient-funds preflight revert to ISO 51', async () => {
    mockSubmitFn.mockResolvedValueOnce({
      success: false,
      classified: { code: 'INSUFFICIENT_FUNDS', isoResponseCode: '51', message: 'insufficient funds' },
      attempts: 1,
      retryable: false,
      gasEstimateMs: 8,
    })
    const result = await processIsoMessage(authorize('810004'))
    expect(result.isoResponseCode).toBe('51')
    expect((await listChainOperations(result.txId))[0].status).toBe('failed')
  })

  it('records a mined reverted transaction as failed', async () => {
    mockReceiptFn.mockResolvedValueOnce({
      outcome: 'reverted',
      isoResponseCode: '05',
      txHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      blockNumber: 101,
      blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      revertReason: 'execution reverted',
      gasUsed: 75_000n,
      effectiveGasPrice: 1_000_000n,
      feeWei: 75_000_000_000n,
      confirmationMs: 1_200,
      events: [],
    })
    const result = await processIsoMessage(authorize('810007'))
    const operations = await listChainOperations(result.txId)
    expect(result.status).toBe('declined')
    expect(result.isoResponseCode).toBe('05')
    expect(operations[0].status).toBe('failed')
    expect(operations[0].revert_reason).toBe('execution reverted')
  })

  it('declines a duplicate ISO message without a second submission', async () => {
    const message = authorize('810008')
    const first = await processIsoMessage(message)
    const duplicate = await processIsoMessage(message)
    const operations = await listChainOperations(first.txId)
    expect(first.isoResponseCode).toBe('00')
    expect(duplicate.status).toBe('duplicate')
    expect(duplicate.isoResponseCode).toBe('94')
    expect(mockSubmitFn).toHaveBeenCalledTimes(1)
    expect(operations).toHaveLength(1)
  })

  it('maps delayed capture of an expired hold to ISO 54', async () => {
    await createPaymentLog({
      txId: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      mti: '0100',
      stan: '810005',
      rrn: 'FAIL81000501',
      merchantRef: 'MERCHANT001',
      terminalId: 'TERM001',
      cardToken: 'CARD_TOKEN_001',
      amountDecimal: '12.50',
      currencyAlpha: 'USD',
      action: 'authorize',
      isoRaw: authorize('810005'),
    })
    mockSubmitFn.mockResolvedValueOnce({
      success: false,
      classified: { code: 'EXPIRED_HOLD', isoResponseCode: '54', message: 'expired hold' },
      attempts: 1,
      retryable: false,
      gasEstimateMs: 7,
    })
    const capture = {
      ...authorize('810006'),
      mti: '0200',
      fields: { ...authorize('810006').fields, '090': '810005' },
    }
    const result = await processIsoMessage(capture)
    expect(result.txId).toBe('0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
    expect(result.isoResponseCode).toBe('54')
    expect((await listChainOperations(result.txId))[0].status).toBe('failed')
  })
})
