/**
 * db/paymentLog.ts
 * CRUD helpers for the payment_log table using Drizzle ORM (PostgreSQL).
 *
 * All operations are async (postgres-js driver returns Promises).
 */
import { eq, desc, sql, and, inArray } from 'drizzle-orm'
import { getDb } from './client.js'
import { paymentLog, isoMessages, chainOperations, onchainEvents } from './schema.js'

// ── Types ─────────────────────────────────────────────────────────────────────

/** Full row as returned by Drizzle, derived from the schema. */
export type PaymentLogRow = typeof paymentLog.$inferSelect

export type PaymentStatus =
  | 'pending'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'duplicate'
  | 'unsupported'

export interface CreatePaymentLogParams {
  txId:             string
  mti:              string
  stan:             string
  rrn:              string
  merchantRef:      string
  terminalId:       string
  cardToken:        string
  userAddress?:     string
  merchantAddress?: string
  tokenAddress?:    string
  amountDecimal:    string
  currencyAlpha:    string
  action:           string
  isoRaw:           unknown
}

export interface InsertIsoMessageParams {
  txId: string
  direction: 'request' | 'response'
  action: string
  mti: string
  fieldsJson: unknown
  isoRaw: unknown
  responseCode?: string
}

export interface InsertChainOperationParams {
  txId: string
  action: string
  attempt?: number
  nonce?: number
  status?: 'pending' | 'submitted' | 'confirmed' | 'failed'
}

export interface ChainOperationPatch {
  status?: 'pending' | 'submitted' | 'confirmed' | 'failed'
  attempt?: number
  nonce?: number
  txHash?: string
  blockNumber?: number
  revertReason?: string
  estimatedGas?: bigint
  gasUsed?: bigint
  effectiveGasPrice?: bigint
  feeWei?: bigint
  gasEstimateMs?: number
  submitMs?: number
  confirmationMs?: number
}

export interface InsertOnchainEventParams {
  txId: string
  eventName: string
  blockHash: string
  blockNumber: number
  txHash: string
  logIndex: number
  amount?: bigint
  tokenAddress?: string
  userAddress?: string
  merchantAddress?: string
}

// ── payment_log ───────────────────────────────────────────────────────────────

export async function createPaymentLog(params: CreatePaymentLogParams): Promise<void> {
  await getDb().insert(paymentLog).values({
    tx_id:            params.txId,
    mti:              params.mti,
    stan:             params.stan,
    rrn:              params.rrn,
    merchant_ref:     params.merchantRef,
    terminal_id:      params.terminalId,
    card_token:       params.cardToken,
    user_address:     params.userAddress     ?? null,
    merchant_address: params.merchantAddress ?? null,
    token_address:    params.tokenAddress    ?? null,
    amount_decimal:   params.amountDecimal,
    currency_alpha:   params.currencyAlpha,
    action:           params.action,
    iso_raw:          JSON.stringify(params.isoRaw),
  })
}

export async function getPaymentLog(txId: string): Promise<PaymentLogRow | null> {
  const rows = await getDb()
    .select()
    .from(paymentLog)
    .where(eq(paymentLog.tx_id, txId))
    .limit(1)
  return rows[0] ?? null
}

export async function updatePaymentStatus(
  txId:   string,
  status: PaymentStatus,
  extra?: Partial<Pick<PaymentLogRow, 'tx_hash' | 'block_number' | 'onchain_status' | 'revert_reason' | 'retry_count' | 'last_error' | 'error_code' | 'action'>>,
): Promise<void> {
  await getDb()
    .update(paymentLog)
    .set({
      status,
      updated_at:     sql`extract(epoch from now())::integer`,
      ...(extra?.tx_hash        !== undefined && { tx_hash:        extra.tx_hash }),
      ...(extra?.block_number   !== undefined && { block_number:   extra.block_number }),
      ...(extra?.onchain_status !== undefined && { onchain_status: extra.onchain_status }),
      ...(extra?.revert_reason  !== undefined && { revert_reason:  extra.revert_reason }),
      ...(extra?.retry_count    !== undefined && { retry_count:    extra.retry_count }),
      ...(extra?.last_error     !== undefined && { last_error:     extra.last_error }),
      ...(extra?.error_code     !== undefined && { error_code:     extra.error_code }),
      ...(extra?.action         !== undefined && { action:         extra.action }),
    })
    .where(eq(paymentLog.tx_id, txId))
}

export async function listPaymentLogs(limit = 100, offset = 0): Promise<PaymentLogRow[]> {
  return getDb()
    .select()
    .from(paymentLog)
    .orderBy(desc(paymentLog.created_at))
    .limit(limit)
    .offset(offset)
}

/** Return true if a record already exists for this txId (idempotency). */
export async function isDuplicate(txId: string): Promise<boolean> {
  return (await getPaymentLog(txId)) !== null
}

/**
 * Return true if a record already exists for this txId with the given action.
 * Used for capture/release which intentionally share the txId with the
 * original authorize — so we must check (txId + action), not just txId.
 */
export async function isDuplicateAction(txId: string, action: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: chainOperations.id })
    .from(chainOperations)
    .where(
      and(
        eq(chainOperations.tx_id, txId),
        eq(chainOperations.action, action),
        inArray(chainOperations.status, ['pending', 'submitted', 'confirmed']),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Look up an existing authorize/capture payment by the original STAN.
 * Used by reversals to resolve the correct on-chain txId without relying on
 * a matching RRN (reversal messages carry a new RRN, not the original one).
 * Optionally scoped to a specific merchantRef + terminalId for safety.
 */
export async function getPaymentLogByStan(
  stan:        string,
  merchantRef: string,
  terminalId:  string,
): Promise<PaymentLogRow | null> {
  const rows = await getDb()
    .select()
    .from(paymentLog)
    .where(
      and(
        eq(paymentLog.stan,         stan),
        eq(paymentLog.merchant_ref, merchantRef),
        eq(paymentLog.terminal_id,  terminalId),
        inArray(paymentLog.action,  ['authorize', 'authorize_and_capture']),
      ),
    )
    .orderBy(desc(paymentLog.created_at))
    .limit(1)
  return rows[0] ?? null
}

// ── append-only M3 audit log ─────────────────────────────────────────────────

export async function insertIsoMessage(params: InsertIsoMessageParams): Promise<void> {
  await getDb().insert(isoMessages).values({
    tx_id:         params.txId,
    direction:     params.direction,
    action:        params.action,
    mti:           params.mti,
    fields_json:   JSON.stringify(params.fieldsJson),
    iso_raw:       JSON.stringify(params.isoRaw),
    response_code: params.responseCode ?? null,
  })
}

export async function insertChainOperation(params: InsertChainOperationParams): Promise<number> {
  const rows = await getDb()
    .insert(chainOperations)
    .values({
      tx_id:   params.txId,
      action:  params.action,
      attempt: params.attempt ?? 1,
      nonce:   params.nonce ?? null,
      status:  params.status ?? 'pending',
    })
    .returning({ id: chainOperations.id })
  return rows[0].id
}

export async function updateChainOperation(
  id: number,
  patch: ChainOperationPatch,
): Promise<void> {
  await getDb()
    .update(chainOperations)
    .set({
      updated_at:          sql`extract(epoch from now())::integer`,
      ...(patch.status            !== undefined && { status: patch.status }),
      ...(patch.attempt           !== undefined && { attempt: patch.attempt }),
      ...(patch.nonce             !== undefined && { nonce: patch.nonce }),
      ...(patch.txHash            !== undefined && { tx_hash: patch.txHash }),
      ...(patch.blockNumber       !== undefined && { block_number: patch.blockNumber }),
      ...(patch.revertReason      !== undefined && { revert_reason: patch.revertReason }),
      ...(patch.estimatedGas      !== undefined && { estimated_gas: patch.estimatedGas.toString() }),
      ...(patch.gasUsed           !== undefined && { gas_used: patch.gasUsed.toString() }),
      ...(patch.effectiveGasPrice !== undefined && { effective_gas_price: patch.effectiveGasPrice.toString() }),
      ...(patch.feeWei            !== undefined && { fee_wei: patch.feeWei.toString() }),
      ...(patch.gasEstimateMs     !== undefined && { gas_estimate_ms: patch.gasEstimateMs }),
      ...(patch.submitMs          !== undefined && { submit_ms: patch.submitMs }),
      ...(patch.confirmationMs    !== undefined && { confirmation_ms: patch.confirmationMs }),
    })
    .where(eq(chainOperations.id, id))
}

export async function insertOnchainEvent(params: InsertOnchainEventParams): Promise<void> {
  await getDb()
    .insert(onchainEvents)
    .values({
      tx_id:            params.txId,
      event_name:       params.eventName,
      block_hash:       params.blockHash,
      block_number:     params.blockNumber,
      tx_hash:          params.txHash,
      log_index:        params.logIndex,
      amount:           params.amount?.toString() ?? null,
      token_address:    params.tokenAddress ?? null,
      user_address:     params.userAddress ?? null,
      merchant_address: params.merchantAddress ?? null,
    })
    .onConflictDoNothing()
}

export async function listChainOperations(txId?: string) {
  const query = getDb().select().from(chainOperations)
  return txId ? query.where(eq(chainOperations.tx_id, txId)) : query
}

export async function listIsoMessages(txId?: string) {
  const query = getDb().select().from(isoMessages)
  return txId ? query.where(eq(isoMessages.tx_id, txId)) : query
}
