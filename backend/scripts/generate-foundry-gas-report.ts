import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { SETTLEMENT_ABI } from '../src/relayer/abi.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CONTRACTS_DIR = resolve(REPO_ROOT, 'contracts')
const SNAPSHOT_PATH = resolve(CONTRACTS_DIR, 'snapshots/M3GasBenchmark.json')
const OUTPUT_PATH = resolve(REPO_ROOT, 'contracts/data/foundry-gas-report.json')
const COINBASE_ETH_USD_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'
const NODE_INTERFACE_ADDRESS = '0x00000000000000000000000000000000000000C8' as Address
const NODE_INTERFACE_ABI = [{
  type: 'function',
  name: 'gasEstimateL1Component',
  stateMutability: 'payable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'contractCreation', type: 'bool' },
    { name: 'data', type: 'bytes' },
  ],
  outputs: [
    { name: 'gasEstimateForL1', type: 'uint64' },
    { name: 'baseFee', type: 'uint256' },
    { name: 'l1BaseFeeEstimate', type: 'uint256' },
  ],
}] as const

interface CoinbaseSpotResponse {
  data: {
    amount: string
    currency: string
  }
}

function decimalToScaledInteger(value: string, decimals: number): bigint {
  const [whole, fraction = ''] = value.trim().split('.')
  const padded = `${fraction}${'0'.repeat(decimals)}`.slice(0, decimals)
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(padded || '0')
}

function formatUnits(value: bigint, decimals: number, precision = decimals): string {
  const scale = 10n ** BigInt(decimals)
  const whole = value / scale
  const fraction = (value % scale).toString().padStart(decimals, '0').slice(0, precision)
  return precision === 0 ? whole.toString() : `${whole}.${fraction}`
}

function transactionIntrinsicGas(data: Hex): bigint {
  const bytes = Buffer.from(data.slice(2), 'hex')
  let gas = 21_000n
  for (const byte of bytes) gas += byte === 0 ? 4n : 16n
  return gas
}

function representativeCalldata(action: string, token: Address): Hex {
  const txId = `0x${'11'.repeat(32)}` as Hex
  if (action === 'authorize') {
    return encodeFunctionData({
      abi: SETTLEMENT_ABI,
      functionName: 'authorize',
      args: [
        txId,
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222',
        token,
        100_000_000n,
        Math.floor(Date.now() / 1_000) + 3_600,
      ],
    })
  }
  if (action === 'capture') {
    return encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: 'capture', args: [txId] })
  }
  if (action === 'release') {
    return encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: 'release', args: [txId] })
  }
  if (action === 'expire') {
    return encodeFunctionData({ abi: SETTLEMENT_ABI, functionName: 'expire', args: [txId] })
  }
  throw new Error(`Unsupported gas benchmark action: ${action}`)
}

async function main(): Promise<void> {
  dotenv.config({ path: resolve(REPO_ROOT, 'backend/.env') })
  const rpcUrl = process.env.RPC_URL
  if (!rpcUrl) throw new Error('RPC_URL is required in backend/.env')
  const contract = process.env.CONTRACT_ADDRESS as Address | undefined
  if (!contract) throw new Error('CONTRACT_ADDRESS is required in backend/.env')
  const token = process.env.ALLOWED_TOKENS?.split(',')[0]?.trim() as Address | undefined
  if (!token) throw new Error('ALLOWED_TOKENS must contain at least one token')
  const privateKey = process.env.RELAYER_PRIVATE_KEY as Hex | undefined
  if (!privateKey) throw new Error('RELAYER_PRIVATE_KEY is required in backend/.env')
  const relayer = privateKeyToAccount(privateKey).address

  execFileSync('forge', ['test', '--match-contract', 'M3GasBenchmark'], {
    cwd: CONTRACTS_DIR,
    env: { ...process.env, FORGE_SNAPSHOT_EMIT: 'true' },
    stdio: 'inherit',
  })

  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, string>
  const client = createPublicClient({ transport: http(rpcUrl) })
  const [chainId, blockNumber, gasPrice] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
    client.getGasPrice(),
  ])

  const priceOverride = process.env.ETH_USD_PRICE
  const priceSourceOverride = process.env.ETH_USD_SOURCE
  let ethUsd: string
  let priceSource: string
  if (priceOverride) {
    ethUsd = priceOverride
    priceSource = priceSourceOverride ?? 'ETH_USD_PRICE environment override'
  } else {
    const response = await fetch(COINBASE_ETH_USD_URL)
    if (!response.ok) throw new Error(`Coinbase ETH/USD request failed: ${response.status}`)
    const body = await response.json() as CoinbaseSpotResponse
    ethUsd = body.data.amount
    priceSource = COINBASE_ETH_USD_URL
  }

  const usdPriceMicros = decimalToScaledInteger(ethUsd, 6)
  const actionEntries = await Promise.all(Object.entries(snapshot).map(async ([action, gas]) => {
    const calldata = representativeCalldata(action, token)
    const nodeCall = encodeFunctionData({
      abi: NODE_INTERFACE_ABI,
      functionName: 'gasEstimateL1Component',
      args: [contract, false, calldata],
    })
    const response = await client.call({ account: relayer, to: NODE_INTERFACE_ADDRESS, data: nodeCall })
    if (!response.data) throw new Error(`NodeInterface returned no data for ${action}`)
    const [l1GasEstimate, baseFeeWei, l1BaseFeeEstimateWei] = decodeFunctionResult({
      abi: NODE_INTERFACE_ABI,
      functionName: 'gasEstimateL1Component',
      data: response.data,
    })
    const foundryExecutionGas = BigInt(gas)
    const intrinsicGas = transactionIntrinsicGas(calldata)
    const l2TransactionGas = foundryExecutionGas + intrinsicGas
    const paddedL1GasEstimate = l1GasEstimate * 110n / 100n
    const totalGasEstimate = l2TransactionGas + paddedL1GasEstimate
    const estimatedL2FeeWei = l2TransactionGas * baseFeeWei
    const estimatedL1FeeWei = paddedL1GasEstimate * baseFeeWei
    const estimatedFeeWei = estimatedL2FeeWei + estimatedL1FeeWei
    const estimatedFeeUsdMicros = estimatedFeeWei * usdPriceMicros / (10n ** 18n)
    return [action, {
      gasUsed: foundryExecutionGas.toString(),
      foundryExecutionGas: foundryExecutionGas.toString(),
      calldataBytes: (calldata.length / 2 - 1).toString(),
      intrinsicGas: intrinsicGas.toString(),
      l2TransactionGas: l2TransactionGas.toString(),
      l1GasEstimate: l1GasEstimate.toString(),
      l1GasEstimatePadded: paddedL1GasEstimate.toString(),
      totalGasEstimate: totalGasEstimate.toString(),
      baseFeeWei: baseFeeWei.toString(),
      l1BaseFeeEstimateWei: l1BaseFeeEstimateWei.toString(),
      estimatedL2FeeWei: estimatedL2FeeWei.toString(),
      estimatedL1FeeWei: estimatedL1FeeWei.toString(),
      estimatedFeeWei: estimatedFeeWei.toString(),
      estimatedFeeEth: formatUnits(estimatedFeeWei, 18, 12),
      estimatedFeeUsd: formatUnits(estimatedFeeUsdMicros, 6, 6),
    }]
  }))
  const actions = Object.fromEntries(actionEntries)

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: 'vm.snapshotGasLastCall',
    benchmarkCommand: 'forge test --match-contract M3GasBenchmark',
    foundryVersion: execFileSync('forge', ['--version'], { encoding: 'utf8' }).split('\n')[0],
    snapshotPath: 'contracts/snapshots/M3GasBenchmark.json',
    network: {
      name: 'Arbitrum Sepolia',
      chainId,
      blockNumber: blockNumber.toString(),
      gasPriceWei: gasPrice.toString(),
    },
    ethUsd: {
      price: ethUsd,
      source: priceSource,
      capturedAt: new Date().toISOString(),
    },
    estimateScope: 'Foundry proxy-call execution gas plus transaction intrinsic gas and the Arbitrum NodeInterface L1 component with 10% padding.',
    actions,
  }

  writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Foundry gas report written to ${OUTPUT_PATH}`)
}

main().catch((error) => {
  console.error('Unable to generate Foundry gas report:', error)
  process.exitCode = 1
})
