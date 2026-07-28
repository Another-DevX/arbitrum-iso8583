/**
 * routes/api.ts
 * Express router: ISO 8583 intake, payment status query, metrics, and
 * admin endpoints for card/merchant address mappings.
 */
import { Router, type Request, type Response } from 'express'
import { processIsoMessage } from './intake.js'
import {
  getPaymentLog,
  listPaymentLogs,
  type PaymentLogRow,
} from '../db/paymentLog.js'
import { getMetrics } from '../observability/metrics.js'
import { logger } from '../observability/logger.js'
import {
  listCardMappings,
  listMerchantMappings,
  upsertCardMapping,
  upsertMerchantMapping,
  deactivateCardMapping,
  deactivateMerchantMapping,
} from '../db/mappings.js'

export const router = Router()

function isoResponseCode(row: PaymentLogRow): string {
  if (row.status === 'confirmed') return '00'
  if (row.status === 'duplicate') return '94'
  if (row.status === 'pending' || row.status === 'submitted') return '96'

  const errorCodes: Record<string, string> = {
    INSUFFICIENT_FUNDS: '51',
    DUPLICATE_AUTHORIZATION: '94',
    INVALID_CAPTURE: '58',
    EXPIRED_HOLD: '54',
    HOLD_NOT_EXPIRED: '58',
    UNAUTHORIZED_MERCHANT: '03',
    CARD_NOT_MAPPED: '14',
    TOKEN_NOT_ALLOWED: '57',
    CONTRACT_PAUSED: '91',
    RPC_FAILURE: '96',
    NONCE_CONFLICT: '96',
    GAS_ESTIMATION_FAILED: '96',
    HOLD_NOT_FOUND: '25',
    UNKNOWN_CONTRACT_REVERT: '05',
    UNKNOWN: '05',
  }
  return row.error_code ? errorCodes[row.error_code] ?? '05' : '05'
}

function serializePayment(row: PaymentLogRow) {
  return {
    txId: row.tx_id,
    mti: row.mti,
    action: row.action,
    status: row.onchain_status ?? row.status,
    isoResponseCode: isoResponseCode(row),
    txHash: row.tx_hash ?? undefined,
    blockNumber: row.block_number ?? undefined,
    errorMessage: row.last_error ?? row.revert_reason ?? undefined,
    createdAt: new Date(row.created_at * 1_000).toISOString(),
    updatedAt: new Date(row.updated_at * 1_000).toISOString(),
  }
}

// ── POST /iso/intake ──────────────────────────────────────────────────────────
/**
 * Accepts a raw ISO 8583 JSON message from the upstream payment stack.
 *
 * Body: { mti: string, fields: Record<string, string> }
 *
 * Response: IntakeResponse (see routes/intake.ts)
 */
router.post('/iso/intake', async (req: Request, res: Response) => {
  const traceId = req.headers['x-trace-id'] as string | undefined ?? crypto.randomUUID()
  const log = logger.child({ traceId, path: '/iso/intake' })

  log.info({ body: req.body }, 'ISO intake request received')

  try {
    const result = await processIsoMessage(req.body)
    const httpStatus = result.status === 'approved' || result.status === 'duplicate' ? 200 : 422

    res.status(httpStatus).json({ traceId, ...result })
  } catch (err) {
    log.error({ err }, 'Unhandled error in ISO intake')
    res.status(500).json({
      traceId,
      txId: '',
      action: 'error',
      status: 'declined',
      isoResponseCode: '96',
      message: 'Internal server error',
    })
  }
})

// ── GET /payments/:txId ───────────────────────────────────────────────────────
router.get('/payments/:txId', async (req: Request, res: Response) => {
  const { txId } = req.params
  const row = await getPaymentLog(txId)
  if (!row) {
    res.status(404).json({ error: 'Payment not found', txId })
    return
  }
  res.json(serializePayment(row))
})

// ── GET /payments ─────────────────────────────────────────────────────────────
router.get('/payments', async (req: Request, res: Response) => {
  const limit  = Math.min(Number(req.query['limit']  ?? 50), 200)
  const offset = Number(req.query['offset'] ?? 0)
  res.json((await listPaymentLogs(limit, offset)).map(serializePayment))
})

// ── GET /metrics ──────────────────────────────────────────────────────────────
router.get('/metrics', (_req: Request, res: Response) => {
  res.json(getMetrics())
})

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() })
})

// ── Admin: card mappings ──────────────────────────────────────────────────────

router.get('/admin/cards', async (_req: Request, res: Response) => {
  res.json(await listCardMappings())
})

router.put('/admin/cards/:token', async (req: Request, res: Response) => {
  const { token } = req.params
  const { eth_address, label } = req.body as { eth_address?: string; label?: string }
  if (!eth_address || !/^0x[0-9a-fA-F]{40}$/.test(eth_address)) {
    res.status(400).json({ error: 'eth_address must be a valid 20-byte hex address' })
    return
  }
  const row = await upsertCardMapping(token, eth_address, label)
  logger.info({ token, eth_address }, 'Card mapping upserted')
  res.json(row)
})

router.delete('/admin/cards/:token', async (req: Request, res: Response) => {
  const ok = await deactivateCardMapping(req.params.token)
  if (!ok) { res.status(404).json({ error: 'Card token not found' }); return }
  logger.info({ token: req.params.token }, 'Card mapping deactivated')
  res.json({ ok: true })
})

// ── Admin: merchant mappings ──────────────────────────────────────────────────

router.get('/admin/merchants', async (_req: Request, res: Response) => {
  res.json(await listMerchantMappings())
})

router.put('/admin/merchants/:ref', async (req: Request, res: Response) => {
  const { ref } = req.params
  const { eth_address, label } = req.body as { eth_address?: string; label?: string }
  if (!eth_address || !/^0x[0-9a-fA-F]{40}$/.test(eth_address)) {
    res.status(400).json({ error: 'eth_address must be a valid 20-byte hex address' })
    return
  }
  const row = await upsertMerchantMapping(ref, eth_address, label)
  logger.info({ ref, eth_address }, 'Merchant mapping upserted')
  res.json(row)
})

router.delete('/admin/merchants/:ref', async (req: Request, res: Response) => {
  const ok = await deactivateMerchantMapping(req.params.ref)
  if (!ok) { res.status(404).json({ error: 'Merchant ref not found' }); return }
  logger.info({ ref: req.params.ref }, 'Merchant mapping deactivated')
  res.json({ ok: true })
})
