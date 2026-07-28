import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { M3ScenarioRun } from './m3-scenarios.js'
import type { ReconciliationReport } from './reconcile.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

interface GasAction {
  count: number
  averageGas: string
  minGas: string
  maxGas: string
  totalGas: string
  totalFeeWei: string
  averageFeeWei: string
}

interface GasReport {
  generatedAt: string
  actions: Record<string, GasAction>
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
  }
}

export interface GenerateReportOptions {
  dataDir?: string
  outputPath?: string
  runPath?: string
  reconciliationPath?: string
  metricsPath?: string
  gasReportPath?: string
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

export function generateM3Report(options: GenerateReportOptions = {}): string {
  const dataDir = resolve(options.dataDir ?? resolve(REPO_ROOT, 'backend/data'))
  const runPath = options.runPath ?? latestFile(dataDir, 'm3-run-')
  const reconciliationPath =
    options.reconciliationPath ?? latestFile(dataDir, 'reconciliation-')
  const metricsPath = options.metricsPath ?? latestFile(dataDir, 'm3-metrics-')
  const run = readJson<M3ScenarioRun>(runPath)
  const reconciliation = readJson<ReconciliationReport>(reconciliationPath)
  const metrics = readJson<MetricsArtifact>(metricsPath)
  const gasPath = options.gasReportPath ?? run?.gasReportPath ?? latestFile(dataDir, 'm3-gas-report-')
  const gas = readJson<GasReport>(gasPath)
  const slitherPath = resolve(REPO_ROOT, 'contracts/data/slither-report.json')
  const slither = readJson<{ results?: { detectors?: unknown[] } }>(slitherPath)

  const scenarioRows = run?.results.map((result) =>
    `| ${markdownCell(result.scenario)} | ${result.requests.map((request) => request.mti).join(' → ')} | ${result.expectedCode} | ${result.receivedCode ?? '—'} | ${result.passed ? 'PASS' : 'FAIL'} | ${result.durationMs} | ${markdownCell(result.holdSnapshot?.status)} | ${markdownCell(accountingSummary(result))} |`,
  ).join('\n') ?? '| No execution artifacts found | — | — | — | — | — | — | — |'

  const latencyRows = Object.entries(metrics?.metrics.latency ?? {}).map(([phase, value]) =>
    `| ${phase} | ${value.count} | ${value.avgMs} | ${value.p50} | ${value.p95} | ${value.p99} | ${value.minMs} | ${value.maxMs} |`,
  ).join('\n') || '| No latency artifact found | — | — | — | — | — | — | — |'

  const reconciliationRows = reconciliation ? [
    ['ISO ↔ operations', reconciliation.plane1],
    ['Operations ↔ events', reconciliation.plane2],
    ['Events ↔ contract state', reconciliation.plane3],
    ['Contract accounting', reconciliation.plane4],
  ].map(([name, value]) => {
    const plane = value as ReconciliationReport['plane1']
    return `| ${name} | ${plane.checked} | ${plane.mismatches.length} |`
  }).join('\n') : '| No reconciliation artifact found | — | — |'

  const gasRows = Object.entries(gas?.actions ?? {}).map(([action, value]) =>
    `| ${action} | ${value.count} | ${value.averageGas} | ${value.minGas} | ${value.maxGas} | ${value.averageFeeWei} | ${value.totalFeeWei} |`,
  ).join('\n') || '| No gas artifact found | — | — | — | — | — | — |'

  const generatedAt = new Date().toISOString()
  const report = `# Technical Milestone Report — M3 PoC

Generated: ${generatedAt}

## Executive Summary

| Item | Result |
|---|---|
| Environment | Arbitrum Sepolia / controlled middleware staging |
| Settlement proxy | ${run?.contract ?? 'Not recorded'} |
| Environment validation | ${run ? `chain ${run.environment.chainId}; relayer role ${run.environment.relayerRole}; paused ${run.environment.paused}; ${run.environment.tokens.length} tokens checked` : 'Not executed'} |
| Scenario execution | ${run ? `${run.passed}/${run.results.length} passed` : 'Not executed'} |
| Reconciliation | ${reconciliation ? `${reconciliation.totalMismatches} mismatches` : 'Not executed'} |
| Security static analysis | ${slither ? `${slither.results?.detectors?.length ?? 0} Slither findings` : 'Slither artifact not present'} |

## Implemented Architecture

The PoC receives ISO 8583 over a two-byte-length-prefixed TCP connection, parses
and normalizes card/merchant identifiers through PostgreSQL, performs a dry-run
gas estimate, submits through the relayer, waits for Arbitrum confirmation, and
returns the ISO response synchronously. Audit evidence is append-only across
\`iso_messages\`, \`chain_operations\`, and \`onchain_events\`.

## Scenario Matrix

| Scenario | ISO MTIs | Expected ISO RC | Received ISO RC | Result | Duration ms | Final hold status | Accounting snapshot |
|---|---|---:|---:|---|---:|---:|---|
${scenarioRows}

## Latency

| Phase | Count | Average ms | p50 | p95 | p99 | Min | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
${latencyRows}

## Gas and Estimated Transaction Cost

Fees are measured from Arbitrum receipts as \`gasUsed × effectiveGasPrice\`.

| Action | Count | Average gas | Min gas | Max gas | Average fee wei | Total fee wei |
|---|---:|---:|---:|---:|---:|---:|
${gasRows}

## Reconciliation

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
- Static analysis artifact: ${slither ? slitherPath : 'not generated; run the security CI/job with Slither installed'}.
- Foundry baseline: 84 unit/fuzz/invariant/upgrade tests and a checked gas snapshot.

## Limitations and Next Phase

- Test assets are mock ERC-20 tokens and the environment remains testnet-only.
- The synchronous confirmation model increases POS latency.
- Partial capture, refunds, velocity limits, KYC/AML and user-signed authorizations are outside this PoC.
- Railway secrets and role-holder keys must remain outside source control and be rotated independently.
- Solvency enumeration is complete for configured test mappings; production requires an indexed liability ledger.
- Browser demo accounts are public testnet identities and must never be funded or authorized on a production network.

## Evidence

- Scenario run: ${runPath ?? 'not available'}
- Gas report: ${gasPath ?? 'not available'}
- Reconciliation report: ${reconciliationPath ?? 'not available'}
- Metrics snapshot: ${metricsPath ?? 'not available'}
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
