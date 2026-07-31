import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { config } from '../src/config.js'
import { publicClient } from '../src/relayer/wallet.js'
import { closeDb } from '../src/db/client.js'
import { runM3Scenarios } from './m3-scenarios.js'
import { runReconciliation } from './reconcile.js'
import { generateM3Report } from './generate-report.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'backend-url': { type: 'string', default: `http://localhost:${config.PORT}` },
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string' },
      'output-dir': { type: 'string', default: 'data' },
    },
  })
  const backendUrl = values['backend-url']!
  const outputDir = values['output-dir']!

  const health = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(5_000) })
  if (!health.ok) {
    throw new Error(`Middleware health check failed: HTTP ${health.status}`)
  }
  const baselineMetricsResponse = await fetch(`${backendUrl}/metrics`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!baselineMetricsResponse.ok) {
    throw new Error(`Metrics baseline request failed: HTTP ${baselineMetricsResponse.status}`)
  }
  const baselineMetrics = await baselineMetricsResponse.json() as { capturedAtMs?: number }
  const metricsSince = baselineMetrics.capturedAtMs ?? Date.now()

  console.log('=== M3 PoC Demo — Arbitrum ISO 8583 ===')
  const fromBlock = await publicClient.getBlockNumber()
  const run = await runM3Scenarios({
    host: values.host,
    port: values.port ? Number(values.port) : undefined,
    outputDir,
  })
  console.table(run.results.map((result) => ({
    scenario: result.scenario,
    expected: result.expectedCode,
    received: result.receivedCode ?? '-',
    passed: result.passed,
    durationMs: result.durationMs,
  })))

  const metricsResponse = await fetch(`${backendUrl}/metrics?since=${metricsSince}`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!metricsResponse.ok) throw new Error(`Metrics request failed: HTTP ${metricsResponse.status}`)
  const metrics = await metricsResponse.json() as Record<string, unknown>
  mkdirSync(outputDir, { recursive: true })
  const metricsPath = `${outputDir}/m3-metrics-${Date.now()}.json`
  writeFileSync(metricsPath, JSON.stringify({ capturedAt: new Date().toISOString(), metrics }, null, 2))
  console.table((metrics['latency'] ?? {}) as Record<string, unknown>)

  const reconciliation = await runReconciliation({
    fromBlock,
    outputDir,
  })
  console.log(`Reconciliation: ${reconciliation.totalMismatches} mismatches`)

  const reportPath = generateM3Report({
    dataDir: outputDir,
    runPath: run.artifactPath,
    metricsPath,
    reconciliationPath: reconciliation.reportPath,
  })
  console.log(`Technical report: ${reportPath}`)
  if (run.failed > 0 || reconciliation.totalMismatches > 0) process.exitCode = 1
}

main()
  .catch((error: unknown) => {
    console.error('M3 demo failed:', error)
    process.exitCode = 2
  })
  .finally(async () => {
    await closeDb()
  })
