/**
 * M3 four-plane reconciliation:
 * ISO messages ↔ chain operations ↔ onchain events ↔ contract state/accounting.
 */
import 'dotenv/config'
import { parseArgs } from 'node:util'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  createPublicClient,
  decodeEventLog,
  type Address,
  type Hex,
} from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { config, allowedTokens } from '../src/config.js'
import { getDb, closeDb, runMigrations } from '../src/db/client.js'
import {
  isoMessages,
  chainOperations,
  reconciliationRun,
  cardMapping,
} from '../src/db/schema.js'
import { SETTLEMENT_ABI } from '../src/relayer/abi.js'
import { rpcTransport } from '../src/relayer/wallet.js'

const ERC20_BALANCE_ABI = [{
  type: 'function',
  name: 'balanceOf',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const

type EventName =
  | 'PaymentAuthorized'
  | 'PaymentCaptured'
  | 'PaymentReleased'
  | 'PaymentExpired'

interface EventRecord {
  txId: string
  eventName: EventName
  txHash: string
  blockHash: string
  blockNumber: number
  logIndex: number
  amount: bigint
  tokenAddress: string
  userAddress: string
  merchantAddress: string
}

interface Mismatch {
  type: string
  txId?: string
  details: Record<string, unknown>
}

interface PlaneResult {
  checked: number
  mismatches: Mismatch[]
}

export interface ReconciliationReport {
  timestamp: string
  blockRange: { from: string; to: string }
  plane1: PlaneResult
  plane2: PlaneResult
  plane3: PlaneResult
  plane4: PlaneResult & { solvencyOk: boolean }
  totalMismatches: number
  reportPath: string
}

export interface ReconciliationOptions {
  fromBlock?: bigint
  toBlock?: bigint
  outputDir?: string
  persist?: boolean
}

function expectedHoldStatus(events: EventRecord[]): number {
  const ordered = [...events].sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber - b.blockNumber,
  )
  const last = ordered[ordered.length - 1]?.eventName
  if (last === 'PaymentAuthorized') return 1
  if (last === 'PaymentCaptured') return 2
  if (last === 'PaymentReleased') return 3
  if (last === 'PaymentExpired') return 4
  return 0
}

function operationEventName(action: string): EventName | null {
  if (action === 'authorize') return 'PaymentAuthorized'
  if (action === 'capture') return 'PaymentCaptured'
  if (action === 'release') return 'PaymentReleased'
  if (action === 'expire') return 'PaymentExpired'
  return null
}

export async function runReconciliation(
  options: ReconciliationOptions = {},
): Promise<ReconciliationReport> {
  await runMigrations()
  const db = getDb()
  const client = createPublicClient({ chain: arbitrumSepolia, transport: rpcTransport() })
  const contract = config.CONTRACT_ADDRESS as Address
  const latestBlock = options.toBlock ?? await client.getBlockNumber()
  const fromBlock = options.fromBlock ?? (latestBlock > 10_000n ? latestBlock - 10_000n : 0n)
  const toBlock = latestBlock

  const logs = await client.getLogs({ address: contract, fromBlock, toBlock })
  const events: EventRecord[] = []

  for (const log of logs) {
    try {
      if (
        log.topics.length === 0 ||
        log.blockNumber === null ||
        log.logIndex === null ||
        log.transactionHash === null ||
        log.blockHash === null
      ) continue
      const decoded = decodeEventLog({
        abi: SETTLEMENT_ABI,
        data: log.data,
        topics: log.topics,
      })
      if (
        decoded.eventName !== 'PaymentAuthorized' &&
        decoded.eventName !== 'PaymentCaptured' &&
        decoded.eventName !== 'PaymentReleased' &&
        decoded.eventName !== 'PaymentExpired'
      ) continue
      const args = decoded.args as {
        txId: string
        amount: bigint
        token: string
        user: string
        merchant: string
      }
      events.push({
        txId: args.txId,
        eventName: decoded.eventName,
        txHash: log.transactionHash,
        blockHash: log.blockHash,
        blockNumber: Number(log.blockNumber),
        logIndex: log.logIndex,
        amount: args.amount,
        tokenAddress: args.token.toLowerCase(),
        userAddress: args.user.toLowerCase(),
        merchantAddress: args.merchant.toLowerCase(),
      })
    } catch {
      // Other proxy/ERC20 events are intentionally ignored.
    }
  }

  const [messageRows, operationRows, cardRows] = await Promise.all([
    db.select().from(isoMessages),
    db.select().from(chainOperations),
    db.select().from(cardMapping),
  ])
  const requestRows = messageRows.filter((row) => row.direction === 'request')
  const operationKeys = new Set(operationRows.map((row) => row.tx_id))
  const requestKeys = new Set(requestRows.map((row) => row.tx_id))

  const plane1Mismatches: Mismatch[] = []
  for (const request of requestRows) {
    if (
      request.action !== 'heartbeat' &&
      request.action !== 'unsupported' &&
      request.action !== 'parse_error' &&
      !operationKeys.has(request.tx_id)
    ) {
      plane1Mismatches.push({
        type: 'iso_without_operation',
        txId: request.tx_id,
        details: { isoMessageId: request.id, action: request.action },
      })
    }
  }
  for (const operation of operationRows.filter((row) =>
    row.status === 'confirmed' && row.action !== 'expire'
  )) {
    if (!requestKeys.has(operation.tx_id)) {
      plane1Mismatches.push({
        type: 'operation_without_iso',
        txId: operation.tx_id,
        details: { operationId: operation.id, action: operation.action },
      })
    }
  }

  const eventsByHash = new Map<string, EventRecord[]>()
  const eventsByTxId = new Map<string, EventRecord[]>()
  for (const event of events) {
    eventsByHash.set(event.txHash, [...(eventsByHash.get(event.txHash) ?? []), event])
    eventsByTxId.set(event.txId, [...(eventsByTxId.get(event.txId) ?? []), event])
  }

  const confirmedInRange = operationRows.filter((row) =>
    row.status === 'confirmed' &&
    row.block_number !== null &&
    BigInt(row.block_number) >= fromBlock &&
    BigInt(row.block_number) <= toBlock,
  )
  const operationHashes = new Set(
    confirmedInRange.flatMap((row) => row.tx_hash ? [row.tx_hash] : []),
  )
  const plane2Mismatches: Mismatch[] = []

  for (const operation of confirmedInRange) {
    const matchingEvents = operation.tx_hash ? eventsByHash.get(operation.tx_hash) ?? [] : []
    const expectedEvent = operationEventName(operation.action)
    if (!operation.tx_hash || matchingEvents.length === 0) {
      plane2Mismatches.push({
        type: 'operation_without_event',
        txId: operation.tx_id,
        details: { operationId: operation.id, txHash: operation.tx_hash },
      })
      continue
    }
    if (expectedEvent && !matchingEvents.some((event) => event.eventName === expectedEvent)) {
      plane2Mismatches.push({
        type: 'wrong_event_type',
        txId: operation.tx_id,
        details: {
          expectedEvent,
          actualEvents: matchingEvents.map((event) => event.eventName),
          txHash: operation.tx_hash,
        },
      })
    }
  }

  for (const event of events) {
    if (!operationHashes.has(event.txHash)) {
      plane2Mismatches.push({
        type: 'event_without_operation',
        txId: event.txId,
        details: { eventName: event.eventName, txHash: event.txHash },
      })
    }
  }

  const plane3Mismatches: Mismatch[] = []
  for (const [txId, txEvents] of eventsByTxId.entries()) {
    const hold = await client.readContract({
      address: contract,
      abi: SETTLEMENT_ABI,
      functionName: 'getHold',
      args: [txId as Hex],
    })
    const expected = expectedHoldStatus(txEvents)
    const actual = Number(hold.status)
    if (actual !== expected) {
      plane3Mismatches.push({
        type: 'event_hold_state_drift',
        txId,
        details: { expectedStatus: expected, actualStatus: actual },
      })
    }

    const authorized = txEvents.find((event) => event.eventName === 'PaymentAuthorized')
    if (authorized && (
      hold.amount !== authorized.amount ||
      hold.token.toLowerCase() !== authorized.tokenAddress ||
      hold.user.toLowerCase() !== authorized.userAddress ||
      hold.merchant.toLowerCase() !== authorized.merchantAddress
    )) {
      plane3Mismatches.push({
        type: 'hold_data_drift',
        txId,
        details: {
          expectedAmount: authorized.amount.toString(),
          actualAmount: hold.amount.toString(),
          expectedToken: authorized.tokenAddress,
          actualToken: hold.token,
        },
      })
    }
  }

  const plane4Mismatches: Mismatch[] = []
  const knownUsers = new Set([
    ...events.map((event) => event.userAddress),
    ...cardRows.filter((row) => row.active).map((row) => row.eth_address.toLowerCase()),
  ])
  for (const rawToken of allowedTokens()) {
    const token = rawToken as Address
    const contractBalance = await client.readContract({
      address: token,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [contract],
    })
    let knownLiabilities = 0n
    for (const user of knownUsers) {
      const balance = await client.readContract({
        address: contract,
        abi: SETTLEMENT_ABI,
        functionName: 'getBalance',
        args: [user as Address, token],
      })
      knownLiabilities += balance[0] + balance[1]
    }
    if (contractBalance < knownLiabilities) {
      plane4Mismatches.push({
        type: 'insolvency',
        details: {
          token,
          contractBalance: contractBalance.toString(),
          knownLiabilities: knownLiabilities.toString(),
        },
      })
    }
  }

  const totalMismatches =
    plane1Mismatches.length +
    plane2Mismatches.length +
    plane3Mismatches.length +
    plane4Mismatches.length
  const outputDir = options.outputDir ?? 'data'
  mkdirSync(outputDir, { recursive: true })
  const reportPath = `${outputDir}/reconciliation-${Date.now()}.json`
  const report: ReconciliationReport = {
    timestamp: new Date().toISOString(),
    blockRange: { from: fromBlock.toString(), to: toBlock.toString() },
    plane1: { checked: requestRows.length + confirmedInRange.length, mismatches: plane1Mismatches },
    plane2: { checked: confirmedInRange.length + events.length, mismatches: plane2Mismatches },
    plane3: { checked: eventsByTxId.size, mismatches: plane3Mismatches },
    plane4: {
      checked: allowedTokens().length,
      solvencyOk: plane4Mismatches.length === 0,
      mismatches: plane4Mismatches,
    },
    totalMismatches,
    reportPath,
  }
  writeFileSync(reportPath, JSON.stringify(report, null, 2))

  if (options.persist !== false) {
    await db.insert(reconciliationRun).values({
      from_block: Number(fromBlock),
      to_block: Number(toBlock),
      total_checked:
        report.plane1.checked + report.plane2.checked + report.plane3.checked + report.plane4.checked,
      mismatches: totalMismatches,
      report: JSON.stringify(report),
    })
  }
  return report
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'from-block': { type: 'string' },
      'to-block': { type: 'string' },
      'output-dir': { type: 'string' },
    },
  })
  try {
    const report = await runReconciliation({
      fromBlock: values['from-block'] ? BigInt(values['from-block']) : undefined,
      toBlock: values['to-block'] ? BigInt(values['to-block']) : undefined,
      outputDir: values['output-dir'],
    })
    console.table({
      'ISO ↔ operations': report.plane1.mismatches.length,
      'operations ↔ events': report.plane2.mismatches.length,
      'events ↔ state': report.plane3.mismatches.length,
      solvency: report.plane4.mismatches.length,
    })
    console.log(`Report: ${report.reportPath}`)
    process.exitCode = report.totalMismatches === 0 ? 0 : 1
  } finally {
    await closeDb()
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  cli().catch((error: unknown) => {
    console.error('Reconciliation error:', error)
    process.exitCode = 2
  })
}
