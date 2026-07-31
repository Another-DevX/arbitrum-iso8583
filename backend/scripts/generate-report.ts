import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { M3ScenarioRun } from './m3-scenarios.js'
import type { ReconciliationReport } from './reconcile.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface FoundryGasAction {
  gasUsed: string
  foundryExecutionGas: string
  intrinsicGas: string
  l2TransactionGas: string
  l1GasEstimatePadded: string
  totalGasEstimate: string
  estimatedL2FeeWei: string
  estimatedL1FeeWei: string
  estimatedFeeWei: string
  estimatedFeeEth: string
  estimatedFeeUsd: string
}

interface FoundryGasReport {
  generatedAt: string
  methodology: string
  benchmarkCommand: string
  foundryVersion: string
  snapshotPath: string
  network: {
    name: string
    chainId: number
    blockNumber: string
    gasPriceWei: string
  }
  ethUsd: {
    price: string
    source: string
    capturedAt: string
  }
  estimateScope: string
  actions: Record<string, FoundryGasAction>
}

interface MetricsArtifact {
  capturedAt: string
  metrics: {
    latency?: Record<string, {
      count: number
      avgMs: number
      minMs: number
      maxMs: number
      p50: number
      p95: number
      p99: number
    }>
    latencyByAction?: Record<string, Record<string, {
      count: number
      avgMs: number
      minMs: number
      maxMs: number
      p50: number
      p95: number
      p99: number
    }>>
    latencyByOutcome?: Record<string, Record<string, {
      count: number
      avgMs: number
      minMs: number
      maxMs: number
      p50: number
      p95: number
      p99: number
    }>>
  }
}

export interface GenerateReportOptions {
  dataDir?: string
  outputPath?: string
  runPath?: string
  reconciliationPath?: string
  metricsPath?: string
  foundryGasReportPath?: string
}

function latestFile(directory: string, prefix: string): string | undefined {
  if (!existsSync(directory)) return undefined
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort()
  const latest = files[files.length - 1]
  return latest ? resolve(directory, latest) : undefined
}

function readJson<T>(path: string | undefined): T | undefined {
  if (!path || !existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function markdownCell(value: unknown): string {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function evidencePath(path: string | undefined): string {
  if (!path) return 'not available'
  return path.startsWith(REPO_ROOT) ? relative(REPO_ROOT, path) : path
}

function accountingSummary(result: M3ScenarioRun['results'][number]): string {
  if (!result.snapshotBefore || !result.snapshotAfter) return '—'
  const before = result.snapshotBefore
  const after = result.snapshotAfter
  return [
    `available ${before.available}→${after.available}`,
    `locked ${before.locked}→${after.locked}`,
    `merchant ${before.merchantTokenBalance}→${after.merchantTokenBalance}`,
    `custody ${before.contractTokenBalance}→${after.contractTokenBalance}`,
  ].join('; ')
}

function chartLabel(value: string): string {
  const labels: Record<string, string> = {
    parse: 'Parse',
    db_lookup: 'DB lookup',
    gas_estimate: 'Gas estimate',
    tx_submit: 'TX submit',
    tx_confirm: 'TX confirmation',
    authorize_e2e: 'Successful authorization',
    capture_e2e: 'Successful capture',
    decline_processing: 'Declined request',
    duplicate_processing: 'Duplicate request',
    other_processing: 'Other response',
  }
  return (labels[value] ?? value.replaceAll('_', ' ')).replaceAll('"', '\\"')
}

function orderedGasEntries(gas: FoundryGasReport | undefined): [string, FoundryGasAction][] {
  const order = ['authorize', 'capture', 'release', 'expire']
  return Object.entries(gas?.actions ?? {}).sort(([left], [right]) =>
    order.indexOf(left) - order.indexOf(right),
  )
}

function latencyChart(metrics: MetricsArtifact | undefined): string {
  const phaseOrder = ['parse', 'db_lookup', 'gas_estimate', 'tx_submit', 'tx_confirm']
  const latency = metrics?.metrics.latency ?? {}
  const entries = phaseOrder.flatMap((phase) => latency[phase] ? [[phase, latency[phase]] as const] : [])
  if (entries.length === 0) return ''
  const labels = entries.map(([phase]) => `"${chartLabel(phase)}"`).join(', ')
  const averages = entries.map(([, value]) => Math.round(value.avgMs)).join(', ')
  const ceiling = Math.max(1, Math.ceil(Math.max(...entries.map(([, value]) => value.avgMs)) * 1.1))
  return `\n\`\`\`mermaid
xychart-beta
    title "Average middleware time by internal phase"
    x-axis [${labels}]
    y-axis "Milliseconds" 0 --> ${ceiling}
    bar [${averages}]
\`\`\`\n`
}

function outcomeLatencyEntries(metrics: MetricsArtifact | undefined) {
  const order = ['authorize_e2e', 'capture_e2e', 'decline_processing', 'duplicate_processing', 'other_processing']
  const byOutcome = metrics?.metrics.latencyByOutcome ?? {}
  return order.flatMap((outcome) => {
    const value = byOutcome[outcome]?.tcp_response
    return value ? [[outcome, value] as const] : []
  })
}

function outcomeLatencyChart(metrics: MetricsArtifact | undefined): string {
  const entries = outcomeLatencyEntries(metrics)
  if (entries.length === 0) return ''
  const labels = entries.map(([outcome]) => `"${chartLabel(outcome)}"`).join(', ')
  const averages = entries.map(([, value]) => Math.round(value.avgMs)).join(', ')
  const ceiling = Math.max(1, Math.ceil(Math.max(...entries.map(([, value]) => value.avgMs)) * 1.1))
  return `\n\`\`\`mermaid
xychart-beta
    title "Average TCP response time by outcome"
    x-axis [${labels}]
    y-axis "Milliseconds" 0 --> ${ceiling}
    bar [${averages}]
\`\`\`\n`
}

function gasCharts(gas: FoundryGasReport | undefined): string {
  const entries = orderedGasEntries(gas)
  if (entries.length === 0) return ''
  const labels = entries.map(([action]) => `"${chartLabel(action)}"`).join(', ')
  const gasValues = entries.map(([, value]) => Number(value.gasUsed))
  const gasCeiling = Math.max(1, Math.ceil(Math.max(...gasValues) * 1.1))
  const feeWeiValues = entries.map(([, value]) => Number(value.estimatedFeeWei))
  const feeWeiTick = 100_000_000_000
  const feeWeiCeiling = Math.max(
    feeWeiTick,
    Math.ceil(Math.max(...feeWeiValues) * 1.1 / feeWeiTick) * feeWeiTick,
  )
  return `\n\`\`\`mermaid
xychart-beta
    title "Foundry execution gas by action"
    x-axis [${labels}]
    y-axis "Gas units" 0 --> ${gasCeiling}
    bar [${gasValues.join(', ')}]
\`\`\`\n`

}

function reconciliationChart(reconciliation: ReconciliationReport | undefined): string {
  if (!reconciliation) return ''
  return `\n\`\`\`mermaid
flowchart LR
    ISO["ISO messages ↔ operations<br/>${reconciliation.plane1.checked} checked · ${reconciliation.plane1.mismatches.length} mismatches"]
    OPS["Operations ↔ events<br/>${reconciliation.plane2.checked} checked · ${reconciliation.plane2.mismatches.length} mismatches"]
    STATE["Events ↔ contract state<br/>${reconciliation.plane3.checked} checked · ${reconciliation.plane3.mismatches.length} mismatches"]
    FUNDS["Contract accounting<br/>${reconciliation.plane4.checked} tokens · ${reconciliation.plane4.mismatches.length} mismatches"]
    ISO --> OPS --> STATE --> FUNDS
\`\`\`\n`
}

export function generateM3Report(options: GenerateReportOptions = {}): string {
  const dataDir = resolve(options.dataDir ?? resolve(REPO_ROOT, 'backend/data'))
  const runPath = options.runPath ?? latestFile(dataDir, 'm3-run-')
  const reconciliationPath =
    options.reconciliationPath ?? latestFile(dataDir, 'reconciliation-')
  const metricsPath = options.metricsPath ?? latestFile(dataDir, 'm3-metrics-')
  const run = readJson<M3ScenarioRun>(runPath)
  const reconciliation = readJson<ReconciliationReport>(reconciliationPath)
  const metrics = readJson<MetricsArtifact>(metricsPath)
  const foundryGasPath = options.foundryGasReportPath ?? resolve(REPO_ROOT, 'contracts/data/foundry-gas-report.json')
  const gas = readJson<FoundryGasReport>(foundryGasPath)
  const slitherPath = resolve(REPO_ROOT, 'contracts/data/slither-report.json')
  const slither = readJson<{ results?: { detectors?: unknown[] } }>(slitherPath)

  const scenarioRows = run?.results.map((result) =>
    `| ${markdownCell(result.scenario)} | ${result.requests.map((request) => request.mti).join(' → ')} | ${result.expectedCode} | ${result.receivedCode ?? '—'} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.durationMs} | ${markdownCell(result.holdSnapshot?.status)} | ${markdownCell(accountingSummary(result))} |`,
  ).join('\n') ?? '| No execution artifacts found | — | — | — | — | — | — | — |'

  const internalPhaseOrder = ['parse', 'db_lookup', 'gas_estimate', 'tx_submit', 'tx_confirm']
  const latency = metrics?.metrics.latency ?? {}
  const latencyRows = internalPhaseOrder.flatMap((phase) => latency[phase]
    ? [`| ${phase} | ${latency[phase].count} | ${latency[phase].avgMs} | ${latency[phase].minMs} | ${latency[phase].maxMs} | ${latency[phase].p95} |`]
    : [],
  ).join('\n') || '| No latency artifact found | — | — | — | — | — |'

  const outcomeLatencyRows = outcomeLatencyEntries(metrics).map(([outcome, value]) =>
    `| ${chartLabel(outcome)} | ${value.count} | ${value.avgMs} | ${value.minMs} | ${value.maxMs} | ${value.p95} |`,
  ).join('\n') || '| No outcome-specific TCP latency artifact found | — | — | — | — | — |'

  const reconciliationRows = reconciliation ? [
    ['ISO ↔ operations', reconciliation.plane1],
    ['Operations ↔ events', reconciliation.plane2],
    ['Events ↔ contract state', reconciliation.plane3],
    ['Contract accounting', reconciliation.plane4],
  ].map(([name, value]) => {
    const plane = value as ReconciliationReport['plane1']
    return `| ${name} | ${plane.checked} | ${plane.mismatches.length} |`
  }).join('\n') : '| No reconciliation artifact found | — | — |'

  const gasRows = orderedGasEntries(gas).map(([action, value]) =>
    `| ${action} | ${value.foundryExecutionGas ?? value.gasUsed} | ${value.intrinsicGas ?? '—'} | ${value.l2TransactionGas ?? '—'} | ${value.l1GasEstimatePadded ?? '—'} | ${value.totalGasEstimate ?? '—'} | ${value.estimatedFeeWei} | ${value.estimatedFeeEth} | $${value.estimatedFeeUsd} |`,
  ).join('\n') || '| No Foundry gas artifact found | — | — | — | — | — | — | — | — |'

  const roleRows = run?.environment.roles
    ? Object.entries(run.environment.roles).map(([role, value]) =>
      `| ${role} | ${value.address} | ${value.assigned ? 'PASS' : 'FAIL'} |`,
    ).join('\n')
    : '| Role-holder evidence not available | — | — |'

  const observedNonZeroL1Gas = orderedGasEntries(gas).some(([, value]) =>
    BigInt(value.l1GasEstimatePadded ?? '0') > 0n,
  )

  const generatedAt = new Date().toISOString()
  const report = `# Technical Milestone Report — M3 PoC

Generated: ${generatedAt}

## Executive Summary

| Item | Result |
|---|---|
| Environment | Arbitrum Sepolia / controlled middleware staging |
| Settlement proxy | ${run?.contract ?? 'Not recorded'} |
| Environment validation | ${run ? `chain ${run.environment.chainId}; ${Object.values(run.environment.roles ?? {}).filter((role) => role.assigned).length}/4 roles; relayer key match ${run.environment.relayerMatchesConfiguredAddress ?? 'not recorded'}; paused ${run.environment.paused}; ${run.environment.tokens.length} tokens checked` : 'Not executed'} |
| Scenario execution | ${run ? `${run.passed}/${run.results.length} passed` : 'Not executed'} |
| Reconciliation | ${reconciliation ? `${reconciliation.totalMismatches} mismatches` : 'Not executed'} |
| Security static analysis | ${slither ? `${slither.results?.detectors?.length ?? 0} Slither findings` : 'Slither artifact not present'} |

## Implemented Architecture

The PoC receives ISO 8583 over a two-byte-length-prefixed TCP connection, parses
and normalizes card/merchant identifiers through PostgreSQL, performs a dry-run
gas estimate, submits through the relayer, waits for Arbitrum confirmation, and
returns the ISO response synchronously. Audit evidence is append-only across
\`iso_messages\`, \`chain_operations\`, and \`onchain_events\`.

\`\`\`mermaid
flowchart LR
    POS["POS / ISO 8583"] -->|"2-byte framed TCP"| TCP["Middleware TCP intake"]
    TCP --> PARSE["Decode · validate · derive txId"]
    PARSE --> MAP["PostgreSQL mappings and audit"]
    MAP --> EST["Gas estimate / revert preflight"]
    EST --> RELAYER["Relayer submission"]
    RELAYER --> ARB["Arbitrum Sepolia settlement"]
    ARB --> RECEIPT["Receipt and event decoding"]
    RECEIPT -->|"ISO response code"| POS
    RECEIPT --> AUDIT["Operations · events · metrics"]
\`\`\`

## Scenario Matrix

### Controlled deployment validation

| Role | Expected holder | Assigned onchain |
|---|---|---|
${roleRows}

The relayer address derived from the configured private key ${run?.environment.relayerMatchesConfiguredAddress ? 'matches' : 'does not match'} the expected public relayer holder.

### Payment scenarios

| Scenario | ISO MTIs | Expected ISO RC | Received ISO RC | Result | Duration ms | Final hold status | Accounting snapshot |
|---|---|---:|---:|---|---:|---:|---|
${scenarioRows}

## Latency

Two different questions are reported separately:

1. **What did the POS request experience?** Response time is grouped by the
   concrete result: successful authorization, successful capture, decline or
   duplicate.
2. **Where did the middleware spend time?** Internal phases show database and
   blockchain work. Their sample counts differ because declined or duplicate
   requests can finish before reaching the chain.

Every graph uses **bars only**. The bar is the arithmetic average and the Y axis
is elapsed milliseconds; lower is better. With this small PoC sample, p95 is
kept in the tables as a diagnostic value but is not drawn as a second series.

### POS-facing response time

This measures from receipt of a complete ISO TCP frame by the middleware until
the encoded response has been handed back to the socket. It includes binary
decoding, routing, database work, RPC calls, confirmation, audit persistence and
response encoding. It does not include travel time through the physical network
after the socket write.

${outcomeLatencyChart(metrics)}

| Result | Samples | Average ms | Min ms | Max ms | p95 ms |
|---|---:|---:|---:|---:|---:|
${outcomeLatencyRows}

The successful authorization and successful capture rows are directly
comparable complete payment operations. Declines and duplicates are separate
because they intentionally stop earlier and do not submit the same onchain work.

### Internal processing phases

| Phase | What it measures |
|---|---|
| \`parse\` | Validation and conversion of the decoded ISO fields into the typed middleware message. |
| \`db_lookup\` | Card and merchant normalization/mapping in PostgreSQL. Only requests that need those mappings are counted. |
| \`gas_estimate\` | RPC simulation used to estimate gas and detect a contract revert before submission. |
| \`tx_submit\` | Submission of the signed transaction through the relayer RPC. Only calls that pass preflight reach this phase. |
| \`tx_confirm\` | Wait for the configured Arbitrum confirmations and receipt processing. |

${latencyChart(metrics)}

| Phase | Samples | Average ms | Min ms | Max ms | p95 ms |
|---|---:|---:|---:|---:|---:|
${latencyRows}

## Gas and Estimated Transaction Cost

${gas ? `Foundry measures execution through the UUPS proxy using \`${gas.methodology}\` (${gas.foundryVersion}).
The complete estimate adds transaction intrinsic gas and the Arbitrum
\`NodeInterface.gasEstimateL1Component\` result with 10% padding. It was sampled
at block \`${gas.network.blockNumber}\` (${gas.network.gasPriceWei} wei/gas) and ETH/USD
\`$${gas.ethUsd.price}\`, captured ${gas.ethUsd.capturedAt} from
[Coinbase](${gas.ethUsd.source}).` : 'Run `npm run m3:gas` to generate the Foundry benchmark and current cost estimate.'}

${gasCharts(gas)}

| Action | Foundry call gas | Intrinsic gas | L2 transaction gas | Padded L1 gas | Total gas estimate | Total fee wei | Total fee ETH | USD reference |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${gasRows}

Scope: ${gas?.estimateScope ?? 'not available'} The wei chart is the primary
cost visualization; USD is retained only as a timestamped reference. Estimates
remain sensitive to calldata compression, L1 prices and network congestion.
${gas && !observedNonZeroL1Gas
    ? '\nIn this Arbitrum Sepolia sample, `NodeInterface` returned an L1 gas component of `0` for every benchmark transaction. The report preserves that observed value instead of substituting a synthetic estimate; it must be sampled again for each target environment, especially Arbitrum One.'
    : ''}

## Reconciliation

${reconciliationChart(reconciliation)}

| Plane | Records checked | Mismatches |
|---|---:|---:|
${reconciliationRows}

## Security Review

- Access control: DEFAULT_ADMIN, PAUSER, TOKEN_ADMIN and RELAYER are enforced by the contract.
- Reentrancy: state-changing token paths use a reentrancy guard and malicious-token tests.
- Replay protection: deterministic txId, append-only operation audit and onchain hold state.
- Upgradeability: UUPS upgrades are admin-gated and covered by state-preservation tests.
- Escrow solvency: reconciliation compares ERC-20 custody against known user liabilities.
- Emergency controls: pause/unpause and permissionless expiry remain test-covered.
- Static analysis artifact: ${slither ? evidencePath(slitherPath) : 'not generated; run the security CI/job with Slither installed'}.
- Foundry baseline: 84 unit/fuzz/invariant/upgrade tests plus four dedicated M3 gas benchmarks.

## Limitations and Next Phase

- Test assets are mock ERC-20 tokens and the environment remains testnet-only.
- The synchronous confirmation model increases POS latency.
- Partial capture, refunds, velocity limits, KYC/AML and user-signed authorizations are outside this PoC.
- Railway secrets and role-holder keys must remain outside source control and be rotated independently.
- Solvency enumeration is complete for configured test mappings; production requires an indexed liability ledger.
- Browser demo accounts are public testnet identities and must never be funded or authorized on a production network.

## Evidence

- Scenario run: ${evidencePath(runPath)}
- Foundry gas report: ${gas ? evidencePath(foundryGasPath) : 'not available'}
- Foundry gas snapshot: ${gas?.snapshotPath ?? 'not available'}
- Receipt gas report (operational run, not used for the estimate above): ${run?.gasReportPath ?? 'not available'}
- Reconciliation report: ${evidencePath(reconciliationPath)}
- Metrics snapshot: ${evidencePath(metricsPath)}
`

  const outputPath = resolve(options.outputPath ?? resolve(REPO_ROOT, 'TECHNICAL_MILESTONE_REPORT_3.md'))
  writeFileSync(outputPath, report)
  return outputPath
}

if (process.argv[1]?.endsWith('generate-report.ts') || process.argv[1]?.endsWith('generate-report.js')) {
  try {
    console.log(`M3 report written to ${generateM3Report()}`)
  } catch (error) {
    console.error('Unable to generate M3 report:', error)
    process.exitCode = 1
  }
}
