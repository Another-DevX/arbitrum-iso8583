/**
 * relayer/responseHandler.ts
 * Waits for a transaction receipt and determines the onchain outcome.
 *
 * Event mapping → outcome:
 *   PaymentAuthorized → 'authorized'  (approved)
 *   PaymentCaptured   → 'captured'    (captured)
 *   PaymentReleased   → 'released'    (reversed)
 *   receipt.status === 'reverted' → 'reverted' (declined)
 *   timeout (>2 min) → 'timeout'
 */
import { type Address, decodeEventLog } from 'viem'
import { SETTLEMENT_ABI } from './abi.js'
import { publicClient } from './wallet.js'
import { config } from '../config.js'
import { logger } from '../observability/logger.js'
import { txConfirmed, txLatency } from '../observability/metrics.js'
import { updatePaymentStatus } from '../db/paymentLog.js'
import { classifyError } from '../errors/classifier.js'

export type OnchainOutcome = 'authorized' | 'captured' | 'released' | 'reverted' | 'timeout'

export interface ReceiptResult {
  outcome:         OnchainOutcome
  /** ISO 8583 response code */
  isoResponseCode: string
  txHash:          string
  blockNumber:     number | null
  revertReason?:   string
  blockHash?:      string
  gasUsed?:        bigint
  effectiveGasPrice?: bigint
  feeWei?:         bigint
  confirmationMs?: number
  events:          DecodedPaymentEvent[]
}

export interface DecodedPaymentEvent {
  eventName: 'PaymentAuthorized' | 'PaymentCaptured' | 'PaymentReleased' | 'PaymentExpired'
  txId: string
  logIndex: number
  amount?: bigint
  tokenAddress?: string
  userAddress?: string
  merchantAddress?: string
}

const CONTRACT = config.CONTRACT_ADDRESS as Address

export async function waitForReceipt(
  txId: string,
  txHash: `0x${string}`,
  action: string,
  submittedAt = Date.now(),
): Promise<ReceiptResult> {
  const log = logger.child({ txId, txHash, action })

  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 2,
      timeout: 120_000,  // 2 minutes maximum
    })

    // ── Reverted ───────────────────────────────────────────────────────────
    if (receipt.status === 'reverted') {
      let revertReason = 'unknown revert'
      try { revertReason = await getRevertReason(txHash) } catch { /* ignore */ }

      log.warn({ blockNumber: receipt.blockNumber.toString(), revertReason }, 'Transaction reverted')
      txConfirmed.inc()

      await updatePaymentStatus(txId, 'failed', {
        tx_hash:        txHash,
        block_number:   Number(receipt.blockNumber),
        onchain_status: 'reverted',
        revert_reason:  revertReason,
      })
      const confirmationMs = Math.round(Date.now() - submittedAt)
      txLatency.observe({ phase: 'tx_confirm' }, confirmationMs)
      return {
        outcome: 'reverted',
        isoResponseCode: '05',
        txHash,
        blockNumber: Number(receipt.blockNumber),
        blockHash: receipt.blockHash,
        revertReason,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
        feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
        confirmationMs,
        events: [],
      }
    }

    // ── Successful – read events ──────────────────────────────────────────────
    const events = decodePaymentEvents(receipt.logs)
    const outcome = extractOutcome(events)
    const confirmationMs = Math.round(Date.now() - submittedAt)
    txLatency.observe({ phase: 'tx_confirm' }, confirmationMs)
    log.info({ outcome, blockNumber: receipt.blockNumber.toString(), confirmationMs }, 'Transaction confirmed')
    txConfirmed.inc()

    await updatePaymentStatus(txId, 'confirmed', {
      tx_hash:        txHash,
      block_number:   Number(receipt.blockNumber),
      onchain_status: outcome,
    })
    return {
      outcome,
      isoResponseCode: '00',
      txHash,
      blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
      confirmationMs,
      events,
    }

  } catch (err) {
    const classified = classifyError(err)
    log.error({ err, classified }, 'waitForReceipt failed')

    await updatePaymentStatus(txId, 'pending', {
      tx_hash:        txHash,
      onchain_status: 'timeout',
      revert_reason:  classified.message,
      last_error:     classified.code,
    })
    const confirmationMs = Math.round(Date.now() - submittedAt)
    txLatency.observe({ phase: 'tx_confirm' }, confirmationMs)
    return {
      outcome: 'timeout',
      isoResponseCode: '96',
      txHash,
      blockNumber: null,
      confirmationMs,
      events: [],
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Log = {
  topics: readonly `0x${string}`[]
  data: `0x${string}`
  logIndex?: number | null
}

export function decodePaymentEvents(logs: readonly Log[]): DecodedPaymentEvent[] {
  const events: DecodedPaymentEvent[] = []
  for (const log of logs) {
    try {
      if (log.topics.length === 0) continue
      const topics = [...log.topics] as [`0x${string}`, ...`0x${string}`[]]
      const decoded = decodeEventLog({ abi: SETTLEMENT_ABI, data: log.data, topics })
      if (
        decoded.eventName !== 'PaymentAuthorized' &&
        decoded.eventName !== 'PaymentCaptured' &&
        decoded.eventName !== 'PaymentReleased' &&
        decoded.eventName !== 'PaymentExpired'
      ) continue
      const args = decoded.args as {
        txId?: string
        amount?: bigint
        token?: string
        user?: string
        merchant?: string
      }
      events.push({
        eventName: decoded.eventName,
        txId: args.txId ?? '',
        logIndex: log.logIndex ?? 0,
        amount: args.amount,
        tokenAddress: args.token,
        userAddress: args.user,
        merchantAddress: args.merchant,
      })
    } catch { /* not our event */ }
  }
  return events
}

function extractOutcome(events: DecodedPaymentEvent[]): OnchainOutcome {
  for (const event of events) {
    if (event.eventName === 'PaymentAuthorized') return 'authorized'
    if (event.eventName === 'PaymentCaptured')   return 'captured'
    if (event.eventName === 'PaymentReleased')   return 'released'
  }
  return 'authorized'
}

async function getRevertReason(txHash: `0x${string}`): Promise<string> {
  const tx = await publicClient.getTransaction({ hash: txHash })
  try {
    await publicClient.call({ to: tx.to, data: tx.input, value: tx.value, blockNumber: tx.blockNumber! })
    return 'no revert reason'
  } catch (err: unknown) {
    const e = err as { shortMessage?: string; message?: string }
    return e.shortMessage ?? e.message ?? 'unknown'
  }
}
