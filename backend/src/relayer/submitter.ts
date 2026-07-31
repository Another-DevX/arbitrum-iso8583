/**
 * relayer/submitter.ts
 * Sends a transaction to the contract and returns the txHash.
 *
 * Flow:
 *   1. Estimate gas → if it reverts, return error without spending on-chain gas.
 *   2. Get next local nonce.
 *   3. Send tx with writeContract.
 *   4. If nonce conflict → re-sync and retry once.
 *   5. Any other error → return SubmitError without retries.
 *
 * Why no automatic retry?
 *   For MVP we prefer fast and visible failure. Retries with backoff
 *   add state complexity; if needed in production, a queue in the database
 *   can be added.
 */
import { type Address } from 'viem'
import { config } from '../config.js'
import { logger } from '../observability/logger.js'
import { txSubmitted, errorClassified, txLatency } from '../observability/metrics.js'
import { SETTLEMENT_ABI } from './abi.js'
import { walletClient, publicClient, account, nextNonce, resetNonce } from './wallet.js'
import { classifyError } from '../errors/classifier.js'
import type { ContractCallParams } from '../mapping/contractMapper.js'

export interface SubmitResult {
  success: true
  txHash: `0x${string}`
  attempts: number
  nonce: number
  estimatedGas: bigint
  gasEstimateMs: number
  submitMs: number
}
export interface SubmitError {
  success: false
  classified: ReturnType<typeof classifyError>
  attempts: number
  retryable: boolean
  gasEstimateMs?: number
  submitMs?: number
}
export type SubmitOutcome = SubmitResult | SubmitError

const CONTRACT = config.CONTRACT_ADDRESS as Address

async function estimateCallGas(params: ContractCallParams): Promise<bigint> {
  if (params.functionName === 'authorize') {
    return publicClient.estimateContractGas({
      address: CONTRACT,
      abi: SETTLEMENT_ABI,
      functionName: 'authorize',
      args: params.args,
      account,
    })
  }
  if (params.functionName === 'capture') {
    return publicClient.estimateContractGas({
      address: CONTRACT,
      abi: SETTLEMENT_ABI,
      functionName: 'capture',
      args: params.args,
      account,
    })
  }
  return publicClient.estimateContractGas({
    address: CONTRACT,
    abi: SETTLEMENT_ABI,
    functionName: 'release',
    args: params.args,
    account,
  })
}

async function writeCall(
  params: ContractCallParams,
  nonce: number,
  gas: bigint,
): Promise<`0x${string}`> {
  if (params.functionName === 'authorize') {
    return walletClient.writeContract({
      address: CONTRACT,
      abi: SETTLEMENT_ABI,
      functionName: 'authorize',
      args: params.args,
      nonce,
      gas,
    })
  }
  if (params.functionName === 'capture') {
    return walletClient.writeContract({
      address: CONTRACT,
      abi: SETTLEMENT_ABI,
      functionName: 'capture',
      args: params.args,
      nonce,
      gas,
    })
  }
  return walletClient.writeContract({
    address: CONTRACT,
    abi: SETTLEMENT_ABI,
    functionName: 'release',
    args: params.args,
    nonce,
    gas,
  })
}

export async function submitContractCall(
  params: ContractCallParams,
  txId: string,
  attempt = 1,
): Promise<SubmitOutcome> {
  const log = logger.child({ txId, action: params.functionName, attempt })
  let completedGasEstimateMs: number | undefined
  let submitStartedAt: number | undefined

  try {
    // 1. Gas estimation – detects reverts before spending real gas
    let gas: bigint
    const gasStartedAt = performance.now()
    try {
      const raw = await estimateCallGas(params)
      gas = raw * 12n / 10n  // +20% buffer
      const gasLimit = BigInt(config.GAS_LIMIT)
      if (gas > gasLimit) gas = gasLimit
    } catch (err) {
      const gasEstimateMs = Math.round(performance.now() - gasStartedAt)
      txLatency.observe({ phase: 'gas_estimate', action: params.functionName }, gasEstimateMs)
      const classified = classifyError(err)
      errorClassified.inc()
      log.warn({ classified }, 'Gas estimation failed – the tx would revert')
      return { success: false, classified, attempts: attempt, retryable: false, gasEstimateMs }
    }
    const gasEstimateMs = Math.round(performance.now() - gasStartedAt)
    completedGasEstimateMs = gasEstimateMs
    txLatency.observe({ phase: 'gas_estimate', action: params.functionName }, gasEstimateMs)

    // 2. Local nonce
    const nonce = await nextNonce()
    log.info({ nonce, gas: gas.toString() }, 'Sending transaction')

    // 3. Send
    submitStartedAt = performance.now()
    const txHash = await writeCall(params, nonce, gas)
    const submitMs = Math.round(performance.now() - submitStartedAt)
    txLatency.observe({ phase: 'tx_submit', action: params.functionName }, submitMs)

    txSubmitted.inc()
    log.info({ txHash }, 'Transaction sent')
    return {
      success: true,
      txHash,
      attempts: attempt,
      nonce,
      estimatedGas: gas,
      gasEstimateMs,
      submitMs,
    }

  } catch (err) {
    const submitMs = submitStartedAt === undefined
      ? undefined
      : Math.round(performance.now() - submitStartedAt)
    if (submitMs !== undefined) txLatency.observe({ phase: 'tx_submit', action: params.functionName }, submitMs)
    const classified = classifyError(err)
    errorClassified.inc()

    // Nonce conflict: re-sync and retry once 
    if (classified.code === 'NONCE_CONFLICT' && attempt === 1) {
      await resetNonce()
      log.warn('Nonce conflict – retrying once')
      return submitContractCall(params, txId, 2)
    }

    log.error({ classified }, 'TX Failed')
    return {
      success: false,
      classified,
      attempts: attempt,
      retryable: classified.code === 'RPC_FAILURE' || classified.code === 'NONCE_CONFLICT',
      gasEstimateMs: completedGasEstimateMs,
      submitMs,
    }
  }
}
