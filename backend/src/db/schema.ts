/**
 * db/schema.ts
 * Drizzle ORM table definitions for PostgreSQL.
 *
 * Properties use snake_case to stay consistent with column names.
 * CREATE_TABLES_SQL is still used at startup via runMigrations() to avoid
 * requiring drizzle-kit CLI in production.
 */
import { pgTable, serial, text, integer, boolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ── payment_log ───────────────────────────────────────────────────────────────

export const paymentLog = pgTable('payment_log', {
  id:               serial('id').primaryKey(),
  tx_id:            text('tx_id').notNull().unique(),
  mti:              text('mti').notNull(),
  stan:             text('stan').notNull(),
  rrn:              text('rrn').notNull(),
  merchant_ref:     text('merchant_ref').notNull(),
  terminal_id:      text('terminal_id').notNull(),
  card_token:       text('card_token').notNull(),
  user_address:     text('user_address'),
  merchant_address: text('merchant_address'),
  token_address:    text('token_address'),
  amount_decimal:   text('amount_decimal').notNull(),
  currency_alpha:   text('currency_alpha').notNull(),
  action:           text('action').notNull(),
  status:           text('status').notNull().default('pending'),
  tx_hash:          text('tx_hash'),
  block_number:     integer('block_number'),
  onchain_status:   text('onchain_status'),
  revert_reason:    text('revert_reason'),
  retry_count:      integer('retry_count').notNull().default(0),
  last_error:       text('last_error'),
  iso_raw:          text('iso_raw').notNull(),
  error_code:       text('error_code'),
  created_at:       integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
  updated_at:       integer('updated_at').notNull().default(sql`extract(epoch from now())::integer`),
})

// ── reconciliation_run ────────────────────────────────────────────────────────

export const reconciliationRun = pgTable('reconciliation_run', {
  id:            serial('id').primaryKey(),
  from_block:    integer('from_block').notNull(),
  to_block:      integer('to_block').notNull(),
  total_checked: integer('total_checked').notNull(),
  mismatches:    integer('mismatches').notNull(),
  report:        text('report').notNull(),
  created_at:    integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
})

// ── append-only M3 audit tables ──────────────────────────────────────────────

export const isoMessages = pgTable('iso_messages', {
  id:            serial('id').primaryKey(),
  tx_id:         text('tx_id').notNull(),
  direction:     text('direction').notNull(),
  action:        text('action').notNull(),
  mti:           text('mti').notNull(),
  fields_json:   text('fields_json').notNull(),
  iso_raw:       text('iso_raw').notNull(),
  response_code: text('response_code'),
  created_at:    integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
})

export const chainOperations = pgTable('chain_operations', {
  id:                  serial('id').primaryKey(),
  tx_id:               text('tx_id').notNull(),
  action:              text('action').notNull(),
  attempt:             integer('attempt').notNull().default(1),
  nonce:               integer('nonce'),
  tx_hash:             text('tx_hash'),
  status:              text('status').notNull().default('pending'),
  revert_reason:       text('revert_reason'),
  block_number:        integer('block_number'),
  estimated_gas:       text('estimated_gas'),
  gas_used:            text('gas_used'),
  effective_gas_price: text('effective_gas_price'),
  fee_wei:             text('fee_wei'),
  gas_estimate_ms:     integer('gas_estimate_ms'),
  submit_ms:           integer('submit_ms'),
  confirmation_ms:     integer('confirmation_ms'),
  created_at:          integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
  updated_at:          integer('updated_at').notNull().default(sql`extract(epoch from now())::integer`),
})

export const onchainEvents = pgTable('onchain_events', {
  id:               serial('id').primaryKey(),
  tx_id:            text('tx_id').notNull(),
  event_name:       text('event_name').notNull(),
  block_hash:       text('block_hash').notNull(),
  block_number:     integer('block_number').notNull(),
  tx_hash:          text('tx_hash').notNull(),
  log_index:        integer('log_index').notNull(),
  amount:           text('amount'),
  token_address:    text('token_address'),
  user_address:     text('user_address'),
  merchant_address: text('merchant_address'),
  created_at:       integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
})

// ── card_mapping ──────────────────────────────────────────────────────────────

export const cardMapping = pgTable('card_mapping', {
  id:          serial('id').primaryKey(),
  card_token:  text('card_token').notNull().unique(),
  eth_address: text('eth_address').notNull(),
  label:       text('label'),
  active:      boolean('active').notNull().default(true),
  created_at:  integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
  updated_at:  integer('updated_at').notNull().default(sql`extract(epoch from now())::integer`),
})

// ── merchant_mapping ──────────────────────────────────────────────────────────

export const merchantMapping = pgTable('merchant_mapping', {
  id:           serial('id').primaryKey(),
  merchant_ref: text('merchant_ref').notNull().unique(),
  eth_address:  text('eth_address').notNull(),
  label:        text('label'),
  active:       boolean('active').notNull().default(true),
  created_at:   integer('created_at').notNull().default(sql`extract(epoch from now())::integer`),
  updated_at:   integer('updated_at').notNull().default(sql`extract(epoch from now())::integer`),
})

// ── Bootstrap DDL ─────────────────────────────────────────────────────────────
// Executed at startup via runMigrations() to create tables if they do not exist.

export const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS payment_log (
  id               SERIAL  PRIMARY KEY,
  tx_id            TEXT    NOT NULL UNIQUE,
  mti              TEXT    NOT NULL,
  stan             TEXT    NOT NULL,
  rrn              TEXT    NOT NULL,
  merchant_ref     TEXT    NOT NULL,
  terminal_id      TEXT    NOT NULL,
  card_token       TEXT    NOT NULL,
  user_address     TEXT,
  merchant_address TEXT,
  token_address    TEXT,
  amount_decimal   TEXT    NOT NULL,
  currency_alpha   TEXT    NOT NULL,
  action           TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending',
  tx_hash          TEXT,
  block_number     INTEGER,
  onchain_status   TEXT,
  revert_reason    TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  iso_raw          TEXT    NOT NULL,
  error_code       TEXT,
  created_at       INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at       INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS reconciliation_run (
  id            SERIAL  PRIMARY KEY,
  from_block    INTEGER NOT NULL,
  to_block      INTEGER NOT NULL,
  total_checked INTEGER NOT NULL,
  mismatches    INTEGER NOT NULL,
  report        TEXT    NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS iso_messages (
  id            SERIAL  PRIMARY KEY,
  tx_id         TEXT    NOT NULL,
  direction     TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  mti           TEXT    NOT NULL,
  fields_json   TEXT    NOT NULL,
  iso_raw       TEXT    NOT NULL,
  response_code TEXT,
  created_at    INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS chain_operations (
  id                  SERIAL  PRIMARY KEY,
  tx_id               TEXT    NOT NULL,
  action              TEXT    NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  nonce               INTEGER,
  tx_hash             TEXT,
  status              TEXT    NOT NULL DEFAULT 'pending',
  revert_reason       TEXT,
  block_number        INTEGER,
  estimated_gas       TEXT,
  gas_used            TEXT,
  effective_gas_price TEXT,
  fee_wei             TEXT,
  gas_estimate_ms     INTEGER,
  submit_ms           INTEGER,
  confirmation_ms     INTEGER,
  created_at          INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at          INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS onchain_events (
  id               SERIAL  PRIMARY KEY,
  tx_id            TEXT    NOT NULL,
  event_name       TEXT    NOT NULL,
  block_hash       TEXT    NOT NULL,
  block_number     INTEGER NOT NULL,
  tx_hash          TEXT    NOT NULL,
  log_index        INTEGER NOT NULL,
  amount           TEXT,
  token_address    TEXT,
  user_address     TEXT,
  merchant_address TEXT,
  created_at       INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  UNIQUE (block_hash, tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS idx_payment_log_tx_id   ON payment_log(tx_id);
CREATE INDEX IF NOT EXISTS idx_payment_log_rrn     ON payment_log(rrn);
CREATE INDEX IF NOT EXISTS idx_payment_log_stan    ON payment_log(stan);
CREATE INDEX IF NOT EXISTS idx_payment_log_status  ON payment_log(status);
CREATE INDEX IF NOT EXISTS idx_payment_log_created ON payment_log(created_at);
CREATE INDEX IF NOT EXISTS idx_iso_messages_tx_id ON iso_messages(tx_id);
CREATE INDEX IF NOT EXISTS idx_iso_messages_created ON iso_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_chain_operations_tx_action ON chain_operations(tx_id, action);
CREATE INDEX IF NOT EXISTS idx_chain_operations_hash ON chain_operations(tx_hash);
CREATE INDEX IF NOT EXISTS idx_chain_operations_status ON chain_operations(status);
CREATE INDEX IF NOT EXISTS idx_onchain_events_tx_id ON onchain_events(tx_id);
CREATE INDEX IF NOT EXISTS idx_onchain_events_hash ON onchain_events(tx_hash);

CREATE TABLE IF NOT EXISTS card_mapping (
  id          SERIAL  PRIMARY KEY,
  card_token  TEXT    NOT NULL UNIQUE,
  eth_address TEXT    NOT NULL,
  label       TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at  INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE TABLE IF NOT EXISTS merchant_mapping (
  id           SERIAL  PRIMARY KEY,
  merchant_ref TEXT    NOT NULL UNIQUE,
  eth_address  TEXT    NOT NULL,
  label        TEXT,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER,
  updated_at   INTEGER NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::INTEGER
);

CREATE INDEX IF NOT EXISTS idx_card_mapping_token    ON card_mapping(card_token);
CREATE INDEX IF NOT EXISTS idx_merchant_mapping_ref  ON merchant_mapping(merchant_ref);
`
