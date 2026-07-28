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
  samples: number[]
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
  latency: Record<string, LatencyStats>
}

const latencySeries = new Map<string, LatencySeries>()

function inc(name: string): void {
  _counts[name] = (_counts[name] ?? 0) + 1
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return Math.round(sorted[Math.max(index, 0)])
}

export function observeLatency(phase: string, milliseconds: number): void {
  const value = Math.max(0, milliseconds)
  const series = latencySeries.get(phase) ?? { count: 0, sum: 0, samples: [] }
  series.count += 1
  series.sum += value
  series.samples.push(value)
  if (series.samples.length > MAX_SAMPLES_PER_PHASE) series.samples.shift()
  latencySeries.set(phase, series)
}

export function getLatencySummary(): Record<string, LatencyStats> {
  const result: Record<string, LatencyStats> = {}
  for (const [phase, series] of latencySeries.entries()) {
    const sorted = [...series.samples].sort((a, b) => a - b)
    result[phase] = {
      count: series.count,
      avgMs: Math.round(series.sum / series.count),
      minMs: Math.round(sorted[0] ?? 0),
      maxMs: Math.round(sorted[sorted.length - 1] ?? 0),
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
    }
  }
  return result
}

export function getMetrics(): MetricsSnapshot {
  return { ..._counts, latency: getLatencySummary() }
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
  observe: (labels: { phase: string }, milliseconds: number) =>
    observeLatency(labels.phase, milliseconds),
}

/** Test-only reset used to prevent cross-suite percentile contamination. */
export function _resetMetricsForTests(): void {
  for (const key of Object.keys(_counts)) delete _counts[key]
  latencySeries.clear()
}
