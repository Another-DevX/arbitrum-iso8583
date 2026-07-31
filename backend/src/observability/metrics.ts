/**
 * Lightweight in-process metrics for the PoC.
 *
 * Counters preserve the existing flat JSON API. Latency summaries are exposed
 * under `latency` and keep a bounded sample per phase so p50/p95/p99 are
 * meaningful for M3 reports without requiring an external Prometheus service.
 */

const _counts: Record<string, number> = {}
const MAX_SAMPLES_PER_PHASE = 10_000

interface LatencySeries {
  count: number
  sum: number
  samples: Array<{ milliseconds: number; observedAt: number }>
}

export interface LatencyStats {
  count: number
  avgMs: number
  minMs: number
  maxMs: number
  p50: number
  p95: number
  p99: number
}

export interface MetricsSnapshot extends Record<string, unknown> {
  capturedAtMs: number
  latency: Record<string, LatencyStats>
  latencyByAction: Record<string, Record<string, LatencyStats>>
  latencyByOutcome: Record<string, Record<string, LatencyStats>>
}

const latencySeries = new Map<string, LatencySeries>()
const latencyByActionSeries = new Map<string, Map<string, LatencySeries>>()
const latencyByOutcomeSeries = new Map<string, Map<string, LatencySeries>>()

function inc(name: string): void {
  _counts[name] = (_counts[name] ?? 0) + 1
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return Math.round(sorted[Math.max(index, 0)])
}

function appendLatency(seriesMap: Map<string, LatencySeries>, phase: string, milliseconds: number, observedAt: number): void {
  const value = Math.max(0, milliseconds)
  const series = seriesMap.get(phase) ?? { count: 0, sum: 0, samples: [] }
  series.count += 1
  series.sum += value
  series.samples.push({ milliseconds: value, observedAt })
  if (series.samples.length > MAX_SAMPLES_PER_PHASE) series.samples.shift()
  seriesMap.set(phase, series)
}

export function observeLatency(
  phase: string,
  milliseconds: number,
  action?: string,
  outcome?: string,
): void {
  const observedAt = Date.now()
  appendLatency(latencySeries, phase, milliseconds, observedAt)
  if (action) {
    const actionSeries = latencyByActionSeries.get(action) ?? new Map<string, LatencySeries>()
    appendLatency(actionSeries, phase, milliseconds, observedAt)
    latencyByActionSeries.set(action, actionSeries)
  }
  if (outcome) {
    const outcomeSeries = latencyByOutcomeSeries.get(outcome) ?? new Map<string, LatencySeries>()
    appendLatency(outcomeSeries, phase, milliseconds, observedAt)
    latencyByOutcomeSeries.set(outcome, outcomeSeries)
  }
}

function summarize(seriesMap: Map<string, LatencySeries>, sinceMs = 0): Record<string, LatencyStats> {
  const result: Record<string, LatencyStats> = {}
  for (const [phase, series] of seriesMap.entries()) {
    const selected = series.samples.filter((sample) => sample.observedAt >= sinceMs)
    if (selected.length === 0) continue
    const sorted = selected.map((sample) => sample.milliseconds).sort((a, b) => a - b)
    result[phase] = {
      count: selected.length,
      avgMs: Math.round(sorted.reduce((sum, value) => sum + value, 0) / selected.length),
      minMs: Math.round(sorted[0] ?? 0),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    }
  }
  return result
}

export function getLatencySummary(sinceMs = 0): Record<string, LatencyStats> {
  return summarize(latencySeries, sinceMs)
}

export function getMetrics(sinceMs = 0): MetricsSnapshot {
  const latencyByAction = Object.fromEntries(
    [...latencyByActionSeries.entries()].map(([action, series]) => [action, summarize(series, sinceMs)]),
  )
  const latencyByOutcome = Object.fromEntries(
    [...latencyByOutcomeSeries.entries()].map(([outcome, series]) => [outcome, summarize(series, sinceMs)]),
  )
  return {
    ..._counts,
    capturedAtMs: Date.now(),
    latency: getLatencySummary(sinceMs),
    latencyByAction,
    latencyByOutcome,
  }
}

type Labels = Record<string, string | number>

export const isoMessagesReceived = { inc: (_labels?: Labels) => inc('iso_messages_received') }
export const isoMessagesRouted   = { inc: (_labels?: Labels) => inc('iso_messages_routed') }
export const isoDuplicates       = { inc: (_labels?: Labels) => inc('iso_duplicates') }
export const txSubmitted         = { inc: (_labels?: Labels) => inc('tx_submitted') }
export const txConfirmed         = { inc: (_labels?: Labels) => inc('tx_confirmed') }
export const errorClassified     = { inc: (_labels?: Labels) => inc('error_classified') }

export const relayerNonce = { set: (_value: number) => {} }
export const txLatency = {
  observe: (labels: { phase: string; action?: string; outcome?: string }, milliseconds: number) =>
    observeLatency(labels.phase, milliseconds, labels.action, labels.outcome),
}

/** Test-only reset used to prevent cross-suite percentile contamination. */
export function _resetMetricsForTests(): void {
  for (const key of Object.keys(_counts)) delete _counts[key]
  latencySeries.clear()
  latencyByActionSeries.clear()
  latencyByOutcomeSeries.clear()
}
