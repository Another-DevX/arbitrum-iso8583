/**
 * db/client.ts
 * Drizzle ORM client for PostgreSQL (postgresjs driver).
 *
 * getDb() returns the Drizzle instance synchronously (lazy init).
 * runMigrations() must be called once at startup to ensure tables exist.
 * closeDb() drains the connection pool – call on SIGTERM/SIGINT.
 * _resetDbForTests() truncates all tables between tests.
 */
import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'
import { CREATE_TABLES_SQL } from './schema.js'
import { config } from '../config.js'
import { logger } from '../observability/logger.js'

type DrizzleDb = PostgresJsDatabase<typeof schema>

let _sql: ReturnType<typeof postgres> | null = null
let _db:  DrizzleDb | null = null

/** Returns the singleton Drizzle client, creating it on first call. */
export function getDb(): DrizzleDb {
  if (_db) return _db
  _sql = postgres(config.DATABASE_URL, { max: 10 })
  _db  = drizzle(_sql, { schema })
  return _db
}

/**
 * Apply bootstrap DDL (CREATE TABLE IF NOT EXISTS).
 * Call once at server startup before serving any requests.
 */
export async function runMigrations(): Promise<void> {
  const sql = _sql ?? (getDb(), _sql!)
  await sql.unsafe(CREATE_TABLES_SQL)
  logger.info({ url: config.DATABASE_URL.replace(/:.*@/, ':***@') }, 'PostgreSQL tables initialised')
}

/** Drain the connection pool. Call on graceful shutdown. */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end()
    _sql = null
    _db  = null
  }
}

/**
 * Truncate all application tables.
 * Used by tests to get a clean state between runs without reconnecting.
 */
export async function _resetDbForTests(): Promise<void> {
  const db = getDb()
  // Delete in dependency order (no FK constraints, but explicit is safer)
  await db.delete(schema.onchainEvents)
  await db.delete(schema.chainOperations)
  await db.delete(schema.isoMessages)
  await db.delete(schema.reconciliationRun)
  await db.delete(schema.paymentLog)
  await db.delete(schema.cardMapping)
  await db.delete(schema.merchantMapping)
}
