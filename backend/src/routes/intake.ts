/**
 * Core ISO 8583 intake orchestrator.
 *
 * The aggregate `payment_log` remains the quick current-state view. M3 audit
 * evidence is append-only in `iso_messages`, `chain_operations`, and
 * `onchain_events`, so authorize/capture/release never overwrite one another.
 */
import { parseIsoMessage, type ParsedIsoFields } from '../iso/parser.js'
import { routeIsoMessage, type IsoAction } from '../iso/router.js'
import { deriveTxId, deriveReversalTxId } from '../mapping/txId.js'
import { normalize, type PaymentMessage } from '../mapping/normalizer.js'
import {
  buildAuthorizeCall,
  buildCaptureCall,
  buildReleaseCall,
  type ContractCallParams,
} from '../mapping/contractMapper.js'
import { submitContractCall, type SubmitResult } from '../relayer/submitter.js'
import { waitForReceipt, type ReceiptResult } from '../relayer/responseHandler.js'
import {
  isDuplicate,
  isDuplicateAction,
  createPaymentLog,
  updatePaymentStatus,
  getPaymentLog,
  getPaymentLogByStan,
  insertIsoMessage,
  insertChainOperation,
  updateChainOperation,
  insertOnchainEvent,
  listChainOperations,
} from '../db/paymentLog.js'
import { classifyError } from '../errors/classifier.js'
import { logger } from '../observability/logger.js'
import {
  isoMessagesReceived,
  isoMessagesRouted,
  isoDuplicates,
  errorClassified,
  txLatency,
} from '../observability/metrics.js'

export interface IntakeResponse {
  txId: string
  action: string
  status: 'approved' | 'declined' | 'pending' | 'duplicate' | 'unsupported'
  isoResponseCode: string
  txHash?: string
  blockNumber?: number
  message?: string
}

const RESPONSE_MTI: Record<string, string> = {
  '0100': '0110',
  '0200': '0210',
  '0400': '0410',
  '0800': '0810',
}

function operationAction(action: IsoAction): string {
  return action === 'authorize_and_capture' ? 'authorize' : action
}

function buildCall(action: IsoAction, txId: `0x${string}`, payment: PaymentMessage | null): ContractCallParams {
  if (action === 'authorize' || action === 'authorize_and_capture') {
    if (!payment) throw new Error('Normalized payment is required for authorization')
    return buildAuthorizeCall(payment)
  }
  if (action === 'capture') return buildCaptureCall(txId)
  if (action === 'release') return buildReleaseCall(txId)
  throw new Error(`No contract call for action ${action}`)
}

async function markSubmitted(operationId: number, result: SubmitResult): Promise<void> {
  await updateChainOperation(operationId, {
    status: 'submitted',
    attempt: result.attempts,
    nonce: result.nonce,
    txHash: result.txHash,
    estimatedGas: result.estimatedGas,
    gasEstimateMs: result.gasEstimateMs,
    submitMs: result.submitMs,
  })
}

async function persistReceipt(
  operationId: number,
  txId: string,
  receipt: ReceiptResult,
): Promise<void> {
  const status =
    receipt.outcome === 'timeout' ? 'pending' :
    receipt.outcome === 'reverted' ? 'failed' :
    'confirmed'

  await updateChainOperation(operationId, {
    status,
    txHash: receipt.txHash,
    blockNumber: receipt.blockNumber ?? undefined,
    revertReason: receipt.revertReason,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    feeWei: receipt.feeWei,
    confirmationMs: receipt.confirmationMs,
  })

  if (!receipt.blockHash || receipt.blockNumber === null) return
  for (const event of receipt.events ?? []) {
    await insertOnchainEvent({
      txId: event.txId || txId,
      eventName: event.eventName,
      blockHash: receipt.blockHash,
      blockNumber: receipt.blockNumber,
      txHash: receipt.txHash,
      logIndex: event.logIndex,
      amount: event.amount,
      tokenAddress: event.tokenAddress,
      userAddress: event.userAddress,
      merchantAddress: event.merchantAddress,
    })
  }
}

/**
 * Process a single raw ISO 8583 JSON message end-to-end.
 * Domain and chain errors resolve to ISO responses; infrastructure-level DB
 * failures are allowed to reach the HTTP/TCP boundary as system failures.
 */
export async function processIsoMessage(rawInput: unknown): Promise<IntakeResponse> {
  const lifecycleStartedAt = performance.now()
  const parseStartedAt = performance.now()
  let parsed: ParsedIsoFields
  try {
    parsed = parseIsoMessage(rawInput)
  } catch (err) {
    txLatency.observe({ phase: 'parse' }, performance.now() - parseStartedAt)
    logger.warn({ err }, 'ISO parse error')
    const rawMti =
      rawInput &&
      typeof rawInput === 'object' &&
      typeof (rawInput as { mti?: unknown }).mti === 'string'
        ? (rawInput as { mti: string }).mti
        : 'unknown'
    const response: IntakeResponse = {
      txId: '',
      action: 'parse_error',
      status: 'declined',
      isoResponseCode: '30',
      message: (err as Error).message,
    }
    await insertIsoMessage({
      txId: '',
      direction: 'request',
      action: 'parse_error',
      mti: rawMti,
      fieldsJson: {},
      isoRaw: rawInput,
    })
    await insertIsoMessage({
      txId: '',
      direction: 'response',
      action: 'parse_error',
      mti: RESPONSE_MTI[rawMti] ?? rawMti,
      fieldsJson: { '039': '30' },
      isoRaw: response,
      responseCode: '30',
    })
    txLatency.observe({ phase: 'total_iso' }, performance.now() - lifecycleStartedAt)
    return response
  }
  txLatency.observe({ phase: 'parse' }, performance.now() - parseStartedAt)

  isoMessagesReceived.inc({ mti: parsed.mti })
  const log = logger.child({ mti: parsed.mti, stan: parsed.stan, rrn: parsed.rrn })
  const routing = routeIsoMessage(parsed)
  isoMessagesRouted.inc({ action: routing.action })
  log.info({ action: routing.action }, 'ISO message routed')

  let requestRecorded = false
  let auditTxId = ''

  const recordRequest = async (txId: string): Promise<void> => {
    if (requestRecorded) return
    auditTxId = txId
    await insertIsoMessage({
      txId,
      direction: 'request',
      action: routing.action,
      mti: parsed.mti,
      fieldsJson: parsed.raw.fields,
      isoRaw: parsed.raw,
    })
    requestRecorded = true
  }

  const finish = async (response: IntakeResponse): Promise<IntakeResponse> => {
    await recordRequest(response.txId || auditTxId)
    await insertIsoMessage({
      txId: response.txId || auditTxId,
      direction: 'response',
      action: response.action,
      mti: RESPONSE_MTI[parsed.mti] ?? parsed.mti,
      fieldsJson: {
        '011': parsed.stan,
        '037': parsed.rrn,
        '039': response.isoResponseCode,
      },
      isoRaw: response,
      responseCode: response.isoResponseCode,
    })
    txLatency.observe({ phase: 'total_iso' }, performance.now() - lifecycleStartedAt)
    return response
  }

  if (routing.action === 'heartbeat') {
    return finish({ txId: '', action: 'heartbeat', status: 'approved', isoResponseCode: '00' })
  }

  if (routing.action === 'unsupported') {
    return finish({
      txId: '',
      action: 'unsupported',
      status: 'unsupported',
      isoResponseCode: '12',
      message: routing.reason,
    })
  }

  let txId: `0x${string}`
  if (routing.action === 'release' || routing.action === 'capture') {
    const lookupStan = parsed.originalStan ?? parsed.stan
    const original = await getPaymentLogByStan(lookupStan, parsed.merchantRef, parsed.terminalId)
    if (original) {
      txId = original.tx_id as `0x${string}`
      log.info({ txId, lookupStan }, `${routing.action}: resolved txId from DB`)
    } else {
      txId = routing.action === 'release' ? deriveReversalTxId(parsed) : deriveTxId(parsed)
      log.warn({ txId, lookupStan }, `${routing.action}: original txId not found in DB`)
    }
  } else {
    txId = deriveTxId(parsed)
  }
  await recordRequest(txId)

  const chainAction = operationAction(routing.action)
  const duplicateOperation = await isDuplicateAction(txId, chainAction)
  const existingOperations = duplicateOperation ? [] : await listChainOperations(txId)
  const legacyDuplicate =
    chainAction === 'authorize' &&
    !duplicateOperation &&
    existingOperations.length === 0 &&
    await isDuplicate(txId)

  if (duplicateOperation || legacyDuplicate) {
    isoDuplicates.inc()
    const existing = await getPaymentLog(txId)
    return finish({
      txId,
      action: routing.action,
      status: 'duplicate',
      isoResponseCode: '94',
      txHash: existing?.tx_hash ?? undefined,
      message: 'Duplicate message – previous submission found',
    })
  }

  let payment: PaymentMessage | null = null
  if (routing.action !== 'capture' && routing.action !== 'release') {
    const lookupStartedAt = performance.now()
    try {
      payment = await normalize(parsed, txId)
      txLatency.observe({ phase: 'db_lookup' }, performance.now() - lookupStartedAt)
    } catch (err) {
      txLatency.observe({ phase: 'db_lookup' }, performance.now() - lookupStartedAt)
      const classified = classifyError(err)
      errorClassified.inc({ code: classified.code })
      if (!(await getPaymentLog(txId))) {
        await createPaymentLog({
          txId,
          mti: parsed.mti,
          stan: parsed.stan,
          rrn: parsed.rrn,
          merchantRef: parsed.merchantRef,
          terminalId: parsed.terminalId,
          cardToken: parsed.cardToken,
          amountDecimal: parsed.amountDecimal,
          currencyAlpha: parsed.currencyAlpha,
          action: routing.action,
          isoRaw: parsed.raw,
        })
      }
      await updatePaymentStatus(txId, 'failed', { error_code: classified.code })
      const failedOperationId = await insertChainOperation({
        txId,
        action: chainAction,
        status: 'failed',
      })
      await updateChainOperation(failedOperationId, { revertReason: classified.message })
      return finish({
        txId,
        action: routing.action,
        status: 'declined',
        isoResponseCode: classified.isoResponseCode,
        message: classified.message,
      })
    }
  }

  if ((routing.action === 'authorize' || routing.action === 'authorize_and_capture') && !(await getPaymentLog(txId))) {
    await createPaymentLog({
      txId,
      mti: parsed.mti,
      stan: parsed.stan,
      rrn: parsed.rrn,
      merchantRef: parsed.merchantRef,
      terminalId: parsed.terminalId,
      cardToken: parsed.cardToken,
      userAddress: payment!.userAddress,
      merchantAddress: payment!.merchantAddress,
      tokenAddress: payment!.tokenAddress,
      amountDecimal: parsed.amountDecimal,
      currencyAlpha: parsed.currencyAlpha,
      action: routing.action,
      isoRaw: parsed.raw,
    })
  }
  if (routing.action === 'authorize' || routing.action === 'authorize_and_capture') {
    await updatePaymentStatus(txId, 'submitted')
  }

  const operationId = await insertChainOperation({ txId, action: chainAction })
  const submitResult = await submitContractCall(buildCall(routing.action, txId, payment), txId)

  if (!submitResult.success) {
    await updateChainOperation(operationId, {
      status: 'failed',
      attempt: submitResult.attempts,
      revertReason: submitResult.classified.message,
      gasEstimateMs: submitResult.gasEstimateMs,
      submitMs: submitResult.submitMs,
    })
    if (chainAction === 'authorize') {
      await updatePaymentStatus(txId, 'failed', {
        error_code: submitResult.classified.code,
        retry_count: submitResult.attempts - 1,
        last_error: `${submitResult.classified.code}${submitResult.retryable ? ':retryable' : ''}`,
      })
    }
    return finish({
      txId,
      action: routing.action,
      status: 'declined',
      isoResponseCode: submitResult.classified.isoResponseCode,
      message: submitResult.classified.message,
    })
  }

  await markSubmitted(operationId, submitResult)
  const authorizeReceipt = await waitForReceipt(
    txId,
    submitResult.txHash,
    chainAction,
    Date.now(),
  )
  await persistReceipt(operationId, txId, authorizeReceipt)

  if (routing.action === 'authorize_and_capture' && authorizeReceipt.outcome === 'authorized') {
    const captureOperationId = await insertChainOperation({ txId, action: 'capture' })
    const captureSubmit = await submitContractCall(buildCaptureCall(txId), `${txId}:capture`)
    if (!captureSubmit.success) {
      await updateChainOperation(captureOperationId, {
        status: 'failed',
        attempt: captureSubmit.attempts,
        revertReason: captureSubmit.classified.message,
        gasEstimateMs: captureSubmit.gasEstimateMs,
        submitMs: captureSubmit.submitMs,
      })
      return finish({
        txId,
        action: routing.action,
        status: 'declined',
        isoResponseCode: captureSubmit.classified.isoResponseCode,
        txHash: authorizeReceipt.txHash,
        blockNumber: authorizeReceipt.blockNumber ?? undefined,
        message: `Authorization confirmed; capture failed: ${captureSubmit.classified.message}`,
      })
    }

    await markSubmitted(captureOperationId, captureSubmit)
    const captureReceipt = await waitForReceipt(
      txId,
      captureSubmit.txHash,
      'capture',
      Date.now(),
    )
    await persistReceipt(captureOperationId, txId, captureReceipt)
    const capturePending = captureReceipt.outcome === 'timeout'
    const captureApproved = captureReceipt.outcome === 'captured'
    return finish({
      txId,
      action: routing.action,
      status: capturePending ? 'pending' : captureApproved ? 'approved' : 'declined',
      isoResponseCode: captureReceipt.isoResponseCode,
      txHash: captureReceipt.txHash,
      blockNumber: captureReceipt.blockNumber ?? undefined,
      message: captureReceipt.revertReason,
    })
  }

  const pending = authorizeReceipt.outcome === 'timeout'
  const approved =
    authorizeReceipt.outcome !== 'reverted' &&
    authorizeReceipt.outcome !== 'timeout'
  return finish({
    txId,
    action: routing.action,
    status: pending ? 'pending' : approved ? 'approved' : 'declined',
    isoResponseCode: authorizeReceipt.isoResponseCode,
    txHash: authorizeReceipt.txHash,
    blockNumber: authorizeReceipt.blockNumber ?? undefined,
    message: authorizeReceipt.revertReason,
  })
}
