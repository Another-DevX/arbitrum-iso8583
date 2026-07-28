/**
 * Reproducible M3 scenario matrix over the real binary TCP ISO 8583 path.
 *
 * Prerequisites:
 *   - middleware running and connected to PostgreSQL
 *   - configured/funded test wallets
 *   - HOLD_TTL_SECONDS <= 30 for the expired-hold scenario
 */
import 'dotenv/config'
import net from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import type { Address, Hex } from 'viem'
import { arbitrumSepolia } from 'viem/chains'
import { encodeWithLengthHeader, decodeIso8583 } from '../src/iso/codec.js'
import { IsoFramer } from '../src/tcp/framing.js'
import { parseIsoMessage } from '../src/iso/parser.js'
import { deriveTxId } from '../src/mapping/txId.js'
import { config, allowedTokens } from '../src/config.js'
import { TEST_WALLETS, TEST_MERCHANT_MAP } from '../src/config/testWallets.js'
import { SETTLEMENT_ABI } from '../src/relayer/abi.js'
import { account, publicClient, walletClient } from '../src/relayer/wallet.js'
import { decodePaymentEvents } from '../src/relayer/responseHandler.js'
import {
  insertChainOperation,
  updateChainOperation,
  insertOnchainEvent,
  listChainOperations,
} from '../src/db/paymentLog.js'
import { closeDb, runMigrations } from '../src/db/client.js'
import { listCardMappings, listMerchantMappings } from '../src/db/mappings.js'

const ERC20_BALANCE_ABI = [{
  type: 'function',
  name: 'balanceOf',
  stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const

interface IsoMessage {
  mti: string
  fields: Record<string, string>
}

interface IsoResponse {
  mti: string
  fields: Record<string, string>
}

interface AccountingSnapshot {
  available: string
  locked: string
  contractTokenBalance: string
  merchantTokenBalance: string
}

interface HoldSnapshot {
  user: string
  merchant: string
  token: string
  amount: string
  expiresAt: number
  status: number
}

export interface ScenarioResult {
  scenario: string
  passed: boolean
  expectedCode: string
  receivedCode?: string
  durationMs: number
  requests: IsoMessage[]
  responses: IsoResponse[]
  snapshotBefore?: AccountingSnapshot
  snapshotAfter?: AccountingSnapshot
  holdSnapshot?: HoldSnapshot
  error?: string
  artifactPath?: string
}

export interface M3ScenarioRun {
  runAt: string
  network: string
  contract: string
  environment: EnvironmentValidation
  results: ScenarioResult[]
  passed: number
  failed: number
  artifactPath: string
  gasReportPath: string
}

export interface EnvironmentValidation {
  chainId: number
  contractCodePresent: boolean
  relayerAddress: string
  relayerRole: boolean
  paused: boolean
  tokens: Array<{ address: string; allowed: boolean; decimals: number }>
  cardMappings: number
  merchantMappings: number
  availableByCard: Record<string, string>
}

interface ScenarioContext {
  host: string
  port: number
  outputDir: string
  token: Address
  merchant: Address
}

let stanCounter = Math.floor(Date.now() / 1000) % 900_000

function nextStan(): string {
  stanCounter = (stanCounter + 1) % 1_000_000
  return stanCounter.toString().padStart(6, '0')
}

function rrnFor(stan: string, suffix = '00'): string {
  return `${Date.now().toString().slice(-4)}${stan}${suffix}`.slice(-12)
}

function dateFields(): { transmission: string; localDate: string; localTime: string } {
  const now = new Date()
  const pad = (value: number) => value.toString().padStart(2, '0')
  const localDate = `${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const localTime = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return { transmission: `${localDate}${localTime}`, localDate, localTime }
}

function authorization(
  cardToken: string,
  stan: string,
  amount = '000000001000',
  merchantRef = 'MERCHANT001',
): IsoMessage {
  const date = dateFields()
  return {
    mti: '0100',
    fields: {
      '002': cardToken,
      '003': '000000',
      '004': amount,
      '007': date.transmission,
      '011': stan,
      '012': date.localTime,
      '013': date.localDate,
      '037': rrnFor(stan),
      '042': 'TERM_001',
      '043': merchantRef,
      '049': '840',
    },
  }
}

function captureFrom(auth: IsoMessage): IsoMessage {
  const stan = nextStan()
  const date = dateFields()
  return {
    mti: '0200',
    fields: {
      ...auth.fields,
      '003': '000000',
      '007': date.transmission,
      '011': stan,
      '012': date.localTime,
      '013': date.localDate,
      '037': rrnFor(stan, '01'),
      '090': auth.fields['011'],
    },
  }
}

function txIdOf(message: IsoMessage): Hex {
  return deriveTxId(parseIsoMessage(message))
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function validateEnvironment(token: Address): Promise<EnvironmentValidation> {
  const contract = config.CONTRACT_ADDRESS as Address
  const [chainId, bytecode, relayerRoleId, paused, cards, merchants] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBytecode({ address: contract }),
    publicClient.readContract({
      address: contract,
      abi: SETTLEMENT_ABI,
      functionName: 'RELAYER_ROLE',
    }),
    publicClient.readContract({
      address: contract,
      abi: SETTLEMENT_ABI,
      functionName: 'paused',
    }),
    listCardMappings(),
    listMerchantMappings(),
  ])
  const [relayerRole, tokens, balances] = await Promise.all([
    publicClient.readContract({
      address: contract,
      abi: SETTLEMENT_ABI,
      functionName: 'hasRole',
      args: [relayerRoleId, account.address],
    }),
    Promise.all(allowedTokens().map(async (rawAddress) => {
      const address = rawAddress as Address
      const tokenConfig = await publicClient.readContract({
        address: contract,
        abi: SETTLEMENT_ABI,
        functionName: 'getTokenConfig',
        args: [address],
      })
      return {
        address,
        allowed: tokenConfig.allowed,
        decimals: Number(tokenConfig.decimals),
      }
    })),
    Promise.all(TEST_WALLETS.map(async (wallet) => {
      const balance = await publicClient.readContract({
        address: contract,
        abi: SETTLEMENT_ABI,
        functionName: 'getBalance',
        args: [wallet.address, token],
      })
      return [wallet.cardToken, balance[0].toString()] as const
    })),
  ])
  const activeCards = new Map(
    cards.filter((row) => row.active).map((row) => [row.card_token, row.eth_address.toLowerCase()]),
  )
  const activeMerchants = new Map(
    merchants.filter((row) => row.active).map((row) => [row.merchant_ref, row.eth_address.toLowerCase()]),
  )

  assert(chainId === arbitrumSepolia.id, `expected Arbitrum Sepolia ${arbitrumSepolia.id}, got ${chainId}`)
  assert(bytecode !== undefined && bytecode !== '0x', `no contract code at ${contract}`)
  assert(relayerRole, `relayer ${account.address} does not have RELAYER_ROLE`)
  assert(!paused, 'settlement contract is paused')
  assert(tokens.length > 0 && tokens.every((item) => item.allowed), 'one or more configured tokens are not allowed')
  for (const wallet of TEST_WALLETS) {
    assert(
      activeCards.get(wallet.cardToken) === wallet.address.toLowerCase(),
      `card mapping ${wallet.cardToken} is missing or points to the wrong address`,
    )
  }
  assert(
    activeMerchants.get('MERCHANT001') === TEST_MERCHANT_MAP.MERCHANT001.toLowerCase(),
    'MERCHANT001 mapping is missing or points to the wrong address',
  )
  const availableByCard = Object.fromEntries(balances)
  assert(BigInt(availableByCard[TEST_WALLETS[0].cardToken] ?? '0') >= 10_000_000n, 'TOK_TEST_001 needs at least 10 USDC')
  assert(BigInt(availableByCard[TEST_WALLETS[2].cardToken] ?? '0') >= 10_000_000n, 'TOK_TEST_003 needs at least 10 USDC')
  assert(BigInt(availableByCard[TEST_WALLETS[3].cardToken] ?? '0') >= 5_000_000n, 'TOK_TEST_004 needs at least 5 USDC')

  return {
    chainId,
    contractCodePresent: true,
    relayerAddress: account.address,
    relayerRole,
    paused,
    tokens,
    cardMappings: activeCards.size,
    merchantMappings: activeMerchants.size,
    availableByCard,
  }
}

async function sendIso(host: string, port: number, message: IsoMessage): Promise<IsoResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const framer = new IsoFramer()
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for ISO response'))
    }, 150_000)

    const done = () => {
      clearTimeout(timeout)
      socket.destroy()
    }
    socket.once('error', (error) => {
      done()
      reject(error)
    })
    framer.once('error', (error: Error) => {
      done()
      reject(error)
    })
    framer.once('message', (body: Buffer) => {
      try {
        const decoded = decodeIso8583(body)
        done()
        resolve({ mti: decoded.mti, fields: decoded.fields as Record<string, string> })
      } catch (error) {
        done()
        reject(error)
      }
    })
    socket.on('data', (chunk: Buffer) => framer.push(chunk))
    socket.once('connect', () => socket.write(encodeWithLengthHeader(message)))
  })
}

async function snapshot(
  user: Address,
  merchant: Address,
  token: Address,
): Promise<AccountingSnapshot> {
  const contract = config.CONTRACT_ADDRESS as Address
  const [balance, contractBalance, merchantBalance] = await Promise.all([
    publicClient.readContract({
      address: contract,
      abi: SETTLEMENT_ABI,
      functionName: 'getBalance',
      args: [user, token],
    }),
    publicClient.readContract({
      address: token,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [contract],
    }),
    publicClient.readContract({
      address: token,
      abi: ERC20_BALANCE_ABI,
      functionName: 'balanceOf',
      args: [merchant],
    }),
  ])
  return {
    available: balance[0].toString(),
    locked: balance[1].toString(),
    contractTokenBalance: contractBalance.toString(),
    merchantTokenBalance: merchantBalance.toString(),
  }
}

async function snapshotHold(txId: Hex): Promise<HoldSnapshot> {
  const hold = await publicClient.readContract({
    address: config.CONTRACT_ADDRESS as Address,
    abi: SETTLEMENT_ABI,
    functionName: 'getHold',
    args: [txId],
  })
  return {
    user: hold.user,
    merchant: hold.merchant,
    token: hold.token,
    amount: hold.amount.toString(),
    expiresAt: Number(hold.expiresAt),
    status: Number(hold.status),
  }
}

async function recordDirectExpire(txId: Hex): Promise<void> {
  const operationId = await insertChainOperation({ txId, action: 'expire' })
  try {
    const estimateStartedAt = performance.now()
    const rawGas = await publicClient.estimateContractGas({
      address: config.CONTRACT_ADDRESS as Address,
      abi: SETTLEMENT_ABI,
      functionName: 'expire',
      args: [txId],
      account,
    })
    const gasEstimateMs = Math.round(performance.now() - estimateStartedAt)
    const bufferedGas = rawGas * 12n / 10n
    const configuredGasLimit = BigInt(config.GAS_LIMIT)
    const gas = bufferedGas > configuredGasLimit ? configuredGasLimit : bufferedGas
    const submitStartedAt = performance.now()
    const hash = await walletClient.writeContract({
      address: config.CONTRACT_ADDRESS as Address,
      abi: SETTLEMENT_ABI,
      functionName: 'expire',
      args: [txId],
      gas,
    })
    const submitMs = Math.round(performance.now() - submitStartedAt)
    await updateChainOperation(operationId, {
      status: 'submitted',
      txHash: hash,
      estimatedGas: gas,
      gasEstimateMs,
      submitMs,
    })
    const confirmationStartedAt = performance.now()
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 })
    const confirmationMs = Math.round(performance.now() - confirmationStartedAt)
    await updateChainOperation(operationId, {
      status: receipt.status === 'success' ? 'confirmed' : 'failed',
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      feeWei: receipt.gasUsed * receipt.effectiveGasPrice,
      confirmationMs,
    })
    for (const event of decodePaymentEvents(receipt.logs)) {
      await insertOnchainEvent({
        txId,
        eventName: event.eventName,
        blockHash: receipt.blockHash,
        blockNumber: Number(receipt.blockNumber),
        txHash: hash,
        logIndex: event.logIndex,
        amount: event.amount,
        tokenAddress: event.tokenAddress,
        userAddress: event.userAddress,
        merchantAddress: event.merchantAddress,
      })
    }
  } catch (error) {
    await updateChainOperation(operationId, {
      status: 'failed',
      revertReason: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

async function executeScenario(
  context: ScenarioContext,
  name: string,
  expectedCode: string,
  run: (requests: IsoMessage[], responses: IsoResponse[]) => Promise<Partial<ScenarioResult>>,
): Promise<ScenarioResult> {
  const startedAt = performance.now()
  const requests: IsoMessage[] = []
  const responses: IsoResponse[] = []
  let result: ScenarioResult
  try {
    const details = await run(requests, responses)
    result = {
      scenario: name,
      passed: true,
      expectedCode,
      receivedCode: responses[responses.length - 1]?.fields['039'],
      durationMs: Math.round(performance.now() - startedAt),
      requests,
      responses,
      ...details,
    }
  } catch (error) {
    result = {
      scenario: name,
      passed: false,
      expectedCode,
      receivedCode: responses[responses.length - 1]?.fields['039'],
      durationMs: Math.round(performance.now() - startedAt),
      requests,
      responses,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  mkdirSync(context.outputDir, { recursive: true })
  const artifactPath = `${context.outputDir}/m3-scenario-${name}-${Date.now()}.json`
  result.artifactPath = artifactPath
  writeFileSync(artifactPath, JSON.stringify(result, null, 2))
  return result
}

export async function runM3Scenarios(options: {
  host?: string
  port?: number
  outputDir?: string
} = {}): Promise<M3ScenarioRun> {
  await runMigrations()
  const runStartedAtUnix = Math.floor(Date.now() / 1000)
  const context: ScenarioContext = {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? config.TCP_PORT,
    outputDir: options.outputDir ?? 'data',
    token: allowedTokens()[0] as Address,
    merchant: TEST_MERCHANT_MAP.MERCHANT001 as Address,
  }
  const environment = await validateEnvironment(context.token)

  const results: ScenarioResult[] = []

  results.push(await executeScenario(context, 'happy-path', '00', async (requests, responses) => {
    const user = TEST_WALLETS[0]
    const auth = authorization(user.cardToken, nextStan())
    const txId = txIdOf(auth)
    const before = await snapshot(user.address, context.merchant, context.token)
    requests.push(auth)
    const authResponse = await sendIso(context.host, context.port, auth)
    responses.push(authResponse)
    assert(authResponse.fields['039'] === '00', `authorize expected 00, got ${authResponse.fields['039']}`)
    const capture = captureFrom(auth)
    requests.push(capture)
    const captureResponse = await sendIso(context.host, context.port, capture)
    responses.push(captureResponse)
    assert(captureResponse.fields['039'] === '00', `capture expected 00, got ${captureResponse.fields['039']}`)
    const after = await snapshot(user.address, context.merchant, context.token)
    const hold = await snapshotHold(txId)
    assert(hold.status === 2, `hold expected CAPTURED(2), got ${hold.status}`)
    assert(BigInt(after.locked) === BigInt(before.locked), 'locked funds did not return to baseline')
    assert(
      BigInt(before.available) - BigInt(after.available) === 10_000_000n,
      'user available balance did not decrease by exactly 10 USDC',
    )
    assert(
      BigInt(before.contractTokenBalance) - BigInt(after.contractTokenBalance) === 10_000_000n,
      'contract custody did not decrease by exactly 10 USDC',
    )
    assert(
      BigInt(after.merchantTokenBalance) - BigInt(before.merchantTokenBalance) === 10_000_000n,
      'merchant did not receive exactly 10 USDC',
    )
    return { snapshotBefore: before, snapshotAfter: after, holdSnapshot: hold }
  }))

  results.push(await executeScenario(context, 'insufficient-funds', '51', async (requests, responses) => {
    const user = TEST_WALLETS[1]
    const auth = authorization(user.cardToken, nextStan(), '999999999999')
    const before = await snapshot(user.address, context.merchant, context.token)
    requests.push(auth)
    const response = await sendIso(context.host, context.port, auth)
    responses.push(response)
    assert(response.fields['039'] === '51', `expected 51, got ${response.fields['039']}`)
    const after = await snapshot(user.address, context.merchant, context.token)
    assert(JSON.stringify(after) === JSON.stringify(before), 'accounting changed on insufficient funds')
    return { snapshotBefore: before, snapshotAfter: after, holdSnapshot: await snapshotHold(txIdOf(auth)) }
  }))

  results.push(await executeScenario(context, 'duplicate-authorize', '94', async (requests, responses) => {
    const user = TEST_WALLETS[2]
    const auth = authorization(user.cardToken, nextStan(), '000000000500')
    const before = await snapshot(user.address, context.merchant, context.token)
    requests.push(auth, auth)
    const first = await sendIso(context.host, context.port, auth)
    const second = await sendIso(context.host, context.port, auth)
    responses.push(first, second)
    assert(first.fields['039'] === '00', `first authorize expected 00, got ${first.fields['039']}`)
    assert(second.fields['039'] === '94', `duplicate authorize expected 94, got ${second.fields['039']}`)
    const hold = await snapshotHold(txIdOf(auth))
    assert(hold.status === 1, `hold expected AUTHORIZED(1), got ${hold.status}`)
    const after = await snapshot(user.address, context.merchant, context.token)
    assert(
      BigInt(before.available) - BigInt(after.available) === 5_000_000n,
      'duplicate authorization locked an unexpected amount',
    )
    assert(
      BigInt(after.locked) - BigInt(before.locked) === 5_000_000n,
      'authorization did not lock exactly once',
    )
    return { snapshotBefore: before, snapshotAfter: after, holdSnapshot: hold }
  }))

  results.push(await executeScenario(context, 'duplicate-capture', '94', async (requests, responses) => {
    const user = TEST_WALLETS[2]
    const auth = authorization(user.cardToken, nextStan(), '000000000500')
    const txId = txIdOf(auth)
    const before = await snapshot(user.address, context.merchant, context.token)
    requests.push(auth)
    const authResponse = await sendIso(context.host, context.port, auth)
    responses.push(authResponse)
    assert(authResponse.fields['039'] === '00', `authorize expected 00, got ${authResponse.fields['039']}`)
    const capture = captureFrom(auth)
    requests.push(capture, capture)
    const first = await sendIso(context.host, context.port, capture)
    const second = await sendIso(context.host, context.port, capture)
    responses.push(first, second)
    assert(first.fields['039'] === '00', `first capture expected 00, got ${first.fields['039']}`)
    assert(second.fields['039'] === '94', `duplicate capture expected 94, got ${second.fields['039']}`)
    const after = await snapshot(user.address, context.merchant, context.token)
    assert(
      BigInt(after.merchantTokenBalance) - BigInt(before.merchantTokenBalance) === 5_000_000n,
      'duplicate capture moved merchant funds more than once',
    )
    assert(BigInt(after.locked) === BigInt(before.locked), 'captured funds remain locked')
    return { snapshotBefore: before, snapshotAfter: after, holdSnapshot: await snapshotHold(txId) }
  }))

  results.push(await executeScenario(context, 'expired-hold', '54', async (requests, responses) => {
    const user = TEST_WALLETS[3]
    const auth = authorization(user.cardToken, nextStan(), '000000000500')
    const txId = txIdOf(auth)
    const before = await snapshot(user.address, context.merchant, context.token)
    requests.push(auth)
    const authResponse = await sendIso(context.host, context.port, auth)
    responses.push(authResponse)
    assert(authResponse.fields['039'] === '00', `authorize expected 00, got ${authResponse.fields['039']}`)
    const authorizedHold = await snapshotHold(txId)
    const waitMs = Math.max(0, (authorizedHold.expiresAt - Math.floor(Date.now() / 1000) + 1) * 1_000)
    assert(
      waitMs <= 30_000,
      `hold expires in ${Math.ceil(waitMs / 1000)}s; run middleware with HOLD_TTL_SECONDS<=30`,
    )
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
    const capture = captureFrom(auth)
    requests.push(capture)
    const captureResponse = await sendIso(context.host, context.port, capture)
    responses.push(captureResponse)
    assert(captureResponse.fields['039'] === '54', `expired capture expected 54, got ${captureResponse.fields['039']}`)
    await recordDirectExpire(txId)
    const after = await snapshot(user.address, context.merchant, context.token)
    const expiredHold = await snapshotHold(txId)
    assert(expiredHold.status === 4, `hold expected EXPIRED(4), got ${expiredHold.status}`)
    assert(BigInt(after.available) === BigInt(before.available), 'available balance was not restored')
    assert(BigInt(after.locked) === BigInt(before.locked), 'locked balance was not restored')
    return { snapshotBefore: before, snapshotAfter: after, holdSnapshot: expiredHold }
  }))

  results.push(await executeScenario(context, 'invalid-merchant', '03', async (requests, responses) => {
    const user = TEST_WALLETS[1]
    const auth = authorization(user.cardToken, nextStan(), '000000000500', 'UNKNOWN_MERCH')
    const before = await snapshot(user.address, context.merchant, context.token)
    requests.push(auth)
    const response = await sendIso(context.host, context.port, auth)
    responses.push(response)
    assert(response.fields['039'] === '03', `invalid merchant expected 03, got ${response.fields['039']}`)
    const after = await snapshot(user.address, context.merchant, context.token)
    assert(JSON.stringify(after) === JSON.stringify(before), 'accounting changed for invalid merchant')
    return { snapshotBefore: before, snapshotAfter: after, holdSnapshot: await snapshotHold(txIdOf(auth)) }
  }))

  mkdirSync(context.outputDir, { recursive: true })
  const operations = (await listChainOperations())
    .filter((operation) => operation.created_at >= runStartedAtUnix && operation.gas_used !== null)
  const gasByAction: Record<string, {
    count: number
    totalGas: bigint
    minGas: bigint
    maxGas: bigint
    totalFeeWei: bigint
  }> = {}
  for (const operation of operations) {
    const gas = BigInt(operation.gas_used!)
    const fee = BigInt(operation.fee_wei ?? '0')
    const current = gasByAction[operation.action] ?? {
      count: 0,
      totalGas: 0n,
      minGas: gas,
      maxGas: gas,
      totalFeeWei: 0n,
    }
    current.count += 1
    current.totalGas += gas
    current.minGas = gas < current.minGas ? gas : current.minGas
    current.maxGas = gas > current.maxGas ? gas : current.maxGas
    current.totalFeeWei += fee
    gasByAction[operation.action] = current
  }
  const gasReportPath = `${context.outputDir}/m3-gas-report-${Date.now()}.json`
  const gasReport = Object.fromEntries(
    Object.entries(gasByAction).map(([action, item]) => [action, {
      count: item.count,
      averageGas: (item.totalGas / BigInt(item.count)).toString(),
      minGas: item.minGas.toString(),
      maxGas: item.maxGas.toString(),
      totalGas: item.totalGas.toString(),
      totalFeeWei: item.totalFeeWei.toString(),
      averageFeeWei: (item.totalFeeWei / BigInt(item.count)).toString(),
    }]),
  )
  writeFileSync(gasReportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    network: 'Arbitrum Sepolia',
    contract: config.CONTRACT_ADDRESS,
    actions: gasReport,
  }, null, 2))

  const artifactPath = `${context.outputDir}/m3-run-${Date.now()}.json`
  const run: M3ScenarioRun = {
    runAt: new Date().toISOString(),
    network: 'Arbitrum Sepolia',
    contract: config.CONTRACT_ADDRESS,
    environment,
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    artifactPath,
    gasReportPath,
  }
  writeFileSync(artifactPath, JSON.stringify(run, null, 2))
  return run
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string' },
      'output-dir': { type: 'string', default: 'data' },
    },
  })
  try {
    const run = await runM3Scenarios({
      host: values.host,
      port: values.port ? Number(values.port) : undefined,
      outputDir: values['output-dir'],
    })
    console.table(run.results.map((result) => ({
      scenario: result.scenario,
      expected: result.expectedCode,
      received: result.receivedCode ?? '-',
      passed: result.passed,
      durationMs: result.durationMs,
    })))
    console.log(`Artifacts: ${run.artifactPath}`)
    process.exitCode = run.failed === 0 ? 0 : 1
  } finally {
    await closeDb()
  }
}

if (process.argv[1]?.endsWith('m3-scenarios.ts') || process.argv[1]?.endsWith('m3-scenarios.js')) {
  cli().catch((error: unknown) => {
    console.error('M3 scenario runner failed:', error)
    process.exitCode = 2
  })
}
