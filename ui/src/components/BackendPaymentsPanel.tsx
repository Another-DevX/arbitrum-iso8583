/**
 * BackendPaymentsPanel.tsx
 * Live view of the payment log stored in PostgreSQL by the backend.
 * Polls every 4 seconds and shows the latest entries with on-chain links.
 */
import { useEffect, useRef, useState } from 'react'
import { backendApi, type PaymentLogRow, type BackendMetrics } from '../lib/backendApi'
import { useAppStore } from '../store'

const POLL_INTERVAL_MS = 4_000
const ARBISCAN = 'https://sepolia.arbiscan.io'

function statusChip(status: string) {
  const map: Record<string, string> = {
    authorized:  'bg-indigo-900/50 text-indigo-300 border-indigo-700',
    captured:    'bg-emerald-900/50 text-emerald-300 border-emerald-700',
    released:    'bg-amber-900/50 text-amber-300 border-amber-700',
    expired:     'bg-slate-800 text-slate-500 border-slate-700',
    failed:      'bg-red-900/50 text-red-300 border-red-700',
    pending:     'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  }
  return `px-2 py-0.5 rounded border text-[10px] font-mono ${
    map[status.toLowerCase()] ?? 'bg-slate-800 text-slate-400 border-slate-700'
  }`
}

function actionBadge(action: string) {
  const map: Record<string, string> = {
    authorize:            'text-indigo-400',
    authorize_and_capture:'text-purple-400',
    capture:              'text-emerald-400',
    release:              'text-amber-400',
    heartbeat:            'text-slate-500',
  }
  return map[action] ?? 'text-slate-400'
}

interface MetricRow {
  label: string
  value: string | number
  color?: string
}

export function BackendPaymentsPanel() {
  const { backendPayments, setBackendPayments, backendHealthy, setBackendHealthy } = useAppStore()
  const [metrics, setMetrics] = useState<BackendMetrics | null>(null)
  const [lastPollMs, setLastPollMs] = useState<number | null>(null)
  const [limit, setLimit] = useState(20)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = async () => {
    const t0 = performance.now()
    try {
      const [rows, m] = await Promise.all([
        backendApi.listPayments(limit),
        backendApi.getMetrics(),
      ])
      setBackendPayments(rows)
      setMetrics(m)
      setBackendHealthy(true)
      setLastPollMs(Math.round(performance.now() - t0))
    } catch {
      setBackendHealthy(false)
      setLastPollMs(null)
    }
  }

  useEffect(() => {
    poll()
    pollRef.current = setInterval(poll, POLL_INTERVAL_MS)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [limit])

  // ── Metrics rows ────────────────────────────────────────────
  const metricRows: MetricRow[] = metrics
    ? [
        {
          label: 'Received (by MTI)',
          value: Object.entries(metrics.isoMessagesReceived)
            .map(([k, v]) => `${k}:${v}`)
            .join('  ') || '–',
        },
        {
          label: 'Routed (by action)',
          value: Object.entries(metrics.isoMessagesRouted)
            .map(([k, v]) => `${k}:${v}`)
            .join('  ') || '–',
        },
        { label: 'Duplicates skipped', value: metrics.isoDuplicates, color: 'text-amber-300' },
        {
          label: 'Errors classified',
          value: Object.entries(metrics.errorsClassified)
            .map(([k, v]) => `${k}:${v}`)
            .join('  ') || '0',
          color: 'text-red-300',
        },
      ]
    : []

  return (
    <div className="space-y-4">

      {/* ── Metrics summary ─────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold text-white">Backend Metrics</span>
          <div className="ml-auto flex items-center gap-2">
            {backendHealthy === null && (
              <span className="text-[11px] text-slate-500 animate-pulse">Connecting…</span>
            )}
            {backendHealthy === true && (
              <span className="text-[11px] text-green-400">
                ● Live {lastPollMs != null ? `(${lastPollMs}ms)` : ''}
              </span>
            )}
            {backendHealthy === false && (
              <span className="text-[11px] text-red-400 animate-pulse">
                ✗ Backend offline — is the server running?
              </span>
            )}
            <button
              onClick={poll}
              className="btn btn-ghost text-[11px] py-0.5 px-2"
            >
              ↺ Refresh
            </button>
          </div>
        </div>

        {metrics && (
          <div className="card-body">
            <div className="grid grid-cols-2 gap-3">
              {metricRows.map(row => (
                <div key={row.label} className="bg-slate-900/60 rounded p-2.5 border border-white/5">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-1">{row.label}</p>
                  <p className={`text-[11px] font-mono break-all ${row.color ?? 'text-slate-300'}`}>
                    {row.value}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {backendHealthy === false && (
          <div className="card-body">
            <p className="text-[11px] text-slate-500">
              Start the backend with{' '}
              <code className="font-mono text-slate-300 bg-slate-800 px-1 rounded">
                cd backend && npm run dev
              </code>
            </p>
          </div>
        )}
      </div>

      {/* ── Payment log ─────────────────────────────────────────── */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold text-white">Payment Log</span>
          <div className="ml-auto flex items-center gap-2">
            <select
              className="text-[11px] bg-slate-800 border border-slate-700 rounded px-2 py-1 text-slate-300"
              value={limit}
              onChange={e => setLimit(Number(e.target.value))}
            >
              {[10, 20, 50, 100].map(n => (
                <option key={n} value={n}>Last {n}</option>
              ))}
            </select>
            <span className="text-[11px] text-slate-500">{backendPayments.length} rows</span>
          </div>
        </div>

        {backendPayments.length === 0 ? (
          <div className="card-body">
            <p className="text-[12px] text-slate-600">
              {backendHealthy === false
                ? 'Backend offline'
                : 'No payment records yet. Send an ISO 8583 message from the ISO Sim tab.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/5 max-h-[480px] overflow-y-auto">
            {backendPayments.map(row => (
              <div
                key={row.txId}
                className="px-4 py-2.5 hover:bg-white/[0.02] space-y-1"
              >
                {/* Row header */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-slate-600 text-[10px] font-mono shrink-0">
                    {new Date(row.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="font-mono text-[11px] text-slate-400 shrink-0">
                    MTI <span className="text-white">{row.mti}</span>
                  </span>
                  <span className={`${actionBadge(row.action)} text-[11px] font-semibold`}>
                    {row.action}
                  </span>
                  <span className={statusChip(row.status)}>{row.status}</span>
                  <span className="text-slate-600 text-[10px] font-mono ml-auto shrink-0">
                    RC:{row.isoResponseCode}
                  </span>
                </div>

                {/* txId */}
                <div className="text-[10px] font-mono text-slate-500 break-all">
                  id: <span className="text-slate-400">{row.txId}</span>
                </div>

                {/* on-chain hash */}
                {row.txHash && (
                  <div className="text-[10px] font-mono flex gap-1 flex-wrap">
                    <span className="text-slate-500">hash:</span>
                    <a
                      href={`${ARBISCAN}/tx/${row.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-400 hover:text-indigo-300 hover:underline"
                    >
                      {row.txHash.slice(0, 14)}…{row.txHash.slice(-8)} ↗
                    </a>
                    {row.blockNumber && (
                      <span className="text-slate-600">block {row.blockNumber}</span>
                    )}
                  </div>
                )}

                {/* Error */}
                {row.errorMessage && (
                  <p className="text-red-400 text-[10px] font-mono break-all">{row.errorMessage}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
