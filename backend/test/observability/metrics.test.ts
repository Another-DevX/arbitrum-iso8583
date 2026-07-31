import {
  _resetMetricsForTests,
  getMetrics,
  observeLatency,
} from '../../src/observability/metrics.js'

describe('latency metrics by action', () => {
  beforeEach(() => _resetMetricsForTests())

  it('keeps aggregate and action-specific latency summaries', () => {
    observeLatency('gas_estimate', 100, 'authorize')
    observeLatency('gas_estimate', 20, 'capture')

    const metrics = getMetrics()
    expect(metrics.latency.gas_estimate).toMatchObject({ count: 2, avgMs: 60 })
    expect(metrics.latencyByAction.authorize?.gas_estimate).toMatchObject({ count: 1, avgMs: 100 })
    expect(metrics.latencyByAction.capture?.gas_estimate).toMatchObject({ count: 1, avgMs: 20 })
  })

  it('separates TCP response time by business outcome', () => {
    observeLatency('tcp_response', 1_200, undefined, 'authorize_e2e')
    observeLatency('tcp_response', 900, undefined, 'capture_e2e')
    observeLatency('tcp_response', 15, undefined, 'duplicate_processing')

    const metrics = getMetrics()
    expect(metrics.latencyByOutcome.authorize_e2e?.tcp_response).toMatchObject({ count: 1, avgMs: 1200 })
    expect(metrics.latencyByOutcome.capture_e2e?.tcp_response).toMatchObject({ count: 1, avgMs: 900 })
    expect(metrics.latencyByOutcome.duplicate_processing?.tcp_response).toMatchObject({ count: 1, avgMs: 15 })
  })

  it('filters samples observed before the requested run window', async () => {
    observeLatency('gas_estimate', 900, 'authorize')
    await new Promise((resolve) => setTimeout(resolve, 2))
    const since = Date.now()
    observeLatency('gas_estimate', 500, 'authorize')

    const metrics = getMetrics(since)
    expect(metrics.latency.gas_estimate).toMatchObject({ count: 1, avgMs: 500 })
    expect(metrics.latencyByAction.authorize?.gas_estimate).toMatchObject({ count: 1, avgMs: 500 })
  })
})
