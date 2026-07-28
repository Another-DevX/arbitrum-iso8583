/**
 * backendApi.ts
 * Typed HTTP client for the Settlement Core backend (port 3100).
 * In development, requests default to the Vite dev-server proxy at /api/*.
 * In deployed static builds, set VITE_BACKEND_URL to the backend origin.
 */

import { BACKEND_HTTP_BASE } from './backendConfig'

// ── Types (mirroring backend interfaces) ─────────────────────────────────────

export type IsoAction =
  | 'authorize'
  | 'authorize_and_capture'
  | 'capture'
  | 'release'
  | 'heartbeat'
  | 'unsupported'
  | 'parse_error'
  | 'error'

export type PaymentStatus = 'approved' | 'declined' | 'pending' | 'duplicate' | 'unsupported'

export interface IntakeResponse {
  traceId: string
  txId: string
  action: IsoAction
  status: PaymentStatus
  isoResponseCode: string
  txHash?: string
  blockNumber?: number
  message?: string
}

export interface PaymentLogRow {
  txId: string
  mti: string
  action: string
  status: string
  isoResponseCode: string
  txHash?: string
  blockNumber?: number
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export interface BackendMetrics {
  isoMessagesReceived: Record<string, number>
  isoMessagesRouted:   Record<string, number>
  isoDuplicates:       number
  errorsClassified:    Record<string, number>
  latency: Record<string, {
    count: number
    avgMs: number
    minMs: number
    maxMs: number
    p50: number
    p95: number
    p99: number
  }>
}

export interface HealthResponse {
  status: 'ok'
  ts: string
}

// ── ISO 8583 field helpers ────────────────────────────────────────────────────

/** Canonical ISO 8583 JSON message sent to POST /iso/intake */
export interface IsoMessage {
  mti: string
  fields: Record<string, string>
}

/** Predefined MTIs */
export const MTI = {
  AUTHORIZE:          '0100',
  FINANCIAL:          '0200',
  REVERSAL:           '0400',
  NETWORK_MGMT:       '0800',
} as const

/** Generate a random 6-digit STAN */
export function randomStan(): string {
  return String(Math.floor(Math.random() * 999999)).padStart(6, '0')
}

/** Generate a random 12-char RRN */
export function randomRrn(): string {
  return Array.from({ length: 12 }, () =>
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 36)],
  ).join('')
}

/** Format amount as 12-digit ISO 8583 field (e.g. "1250" → "000000001250") */
export function fmtAmount(major: string | number): string {
  const cents = Math.round(Number(major) * 100)
  return String(cents).padStart(12, '0')
}

/** Current MMDDhhmmss string */
export function nowTransmissionDt(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

/** Build an authorization request (0100) */
export function buildAuthorizeMsg(opts: {
  cardToken:   string
  merchantRef: string
  terminalId:  string
  amount:      string | number
  currency?:   string
}): IsoMessage {
  const stan = randomStan()
  const rrn  = randomRrn()
  return {
    mti: MTI.AUTHORIZE,
    fields: {
      '002': opts.cardToken,
      '003': '000000',
      '004': fmtAmount(opts.amount),
      '007': nowTransmissionDt(),
      '011': stan,
      '012': new Date().toTimeString().slice(0, 8).replace(/:/g, ''),
      '013': nowTransmissionDt().slice(0, 4),
      '037': rrn,
      '042': opts.terminalId,
      '043': opts.merchantRef,
      '049': opts.currency ?? '840',
    },
  }
}

/** Build a capture (financial) request (0200) */
export function buildCaptureMsg(opts: {
  cardToken:   string
  merchantRef: string
  terminalId:  string
  amount:      string | number
  currency?:   string
  originalStan?: string
}): IsoMessage {
  const msg = buildAuthorizeMsg(opts)
  return {
    mti: MTI.FINANCIAL,
    fields: {
      ...msg.fields,
      '003': '000000',
      ...(opts.originalStan ? { '090': opts.originalStan } : {}),
    },
  }
}

/** Build a reversal request (0400) */
export function buildReversalMsg(opts: {
  cardToken:   string
  merchantRef: string
  terminalId:  string
  amount:      string | number
  originalStan: string
  currency?:   string
}): IsoMessage {
  const msg = buildAuthorizeMsg(opts)
  return {
    mti: MTI.REVERSAL,
    fields: {
      ...msg.fields,
      '090': opts.originalStan,
    },
  }
}

/** Build a heartbeat request (0800) */
export function buildHeartbeatMsg(): IsoMessage {
  return {
    mti: MTI.NETWORK_MGMT,
    fields: {
      '007': nowTransmissionDt(),
      '011': randomStan(),
      '037': randomRrn(),
    },
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_HTTP_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Backend ${res.status}: ${body || res.statusText}`)
  }
  return res.json() as Promise<T>
}

// ── API surface ───────────────────────────────────────────────────────────────

export const backendApi = {
  /** Send a raw ISO 8583 JSON message to the backend */
  intake(msg: IsoMessage): Promise<IntakeResponse> {
    return request<IntakeResponse>('/iso/intake', {
      method: 'POST',
      body:   JSON.stringify(msg),
    })
  },

  /** Fetch a single payment by txId */
  getPayment(txId: string): Promise<PaymentLogRow> {
    return request<PaymentLogRow>(`/payments/${encodeURIComponent(txId)}`)
  },

  /** List recent payments (default limit 50) */
  listPayments(limit = 50, offset = 0): Promise<PaymentLogRow[]> {
    return request<PaymentLogRow[]>(`/payments?limit=${limit}&offset=${offset}`)
  },

  /** Get metrics and normalize counters while preserving latency summaries. */
  async getMetrics(): Promise<BackendMetrics> {
    const raw = await request<Record<string, unknown>>('/metrics')
    const numberValue = (key: string): number =>
      typeof raw[key] === 'number' ? raw[key] : 0
    return {
      isoMessagesReceived: { total: numberValue('iso_messages_received') },
      isoMessagesRouted:   { total: numberValue('iso_messages_routed') },
      isoDuplicates:       numberValue('iso_duplicates'),
      errorsClassified:    { total: numberValue('error_classified') },
      latency: (raw['latency'] ?? {}) as BackendMetrics['latency'],
    }
  },

  /** Health check – resolves quickly if backend is up */
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/health')
  },
}
