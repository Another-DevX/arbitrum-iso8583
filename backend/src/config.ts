/**
 * config.ts
 * Server configuration loaded from environment variables.
 * Zod validates it at startup; if anything is missing, the process aborts
 * with a clear message before processing any payment messages.
 */
import { z } from 'zod'
import 'dotenv/config'

const ConfigSchema = z.object({
  PORT:     z.coerce.number().default(3100),
  /** TCP port for receiving raw binary ISO 8583 messages */
  TCP_PORT: z.coerce.number().default(5000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // ── Onchain ──────────────────────────────────────────────────────────────
  /** Arbitrum Sepolia RPC(s). Can be a comma-separated list. */
  RPC_URL: z.string()
    .default('https://sepolia-rollup.arbitrum.io/rpc')
    .refine(
      (value) => value.split(',').every((url) => z.string().url().safeParse(url.trim()).success),
      'Must contain one URL or a comma-separated list of URLs',
    ),
  /** ArbitrumSettlementCore UUPS proxy address */
  CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(
    '0xAaE3116210b866f00ccf8dCbD540A6Cc5d070d72',
  ),
  /** Allowed ERC-20 tokens, comma-separated */
  ALLOWED_TOKENS: z.string().default(
    '0xA730eFe70d3f67d08dD4a17a867c95bFe1F33CfA,0xC7f974b3710560D070dEc95288339EfAB683C417',
  ),
  /** Expected public role holders. When omitted in the PoC, the relayer account is expected. */
  ADMIN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  PAUSER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  TOKEN_ADMIN_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  RELAYER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),

  // ── Relayer ───────────────────────────────────────────────────────────────
  /** Relayer wallet private key. The wallet must have RELAYER_ROLE. */
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'Must be a 32-byte hex value'),

  // ── Gas ───────────────────────────────────────────────────────────────────
  /** Per-transaction gas ceiling, in gas units. Defaults to 500k. */
  GAS_LIMIT: z.coerce.number().default(500_000),

  // ── ISO 8583 ──────────────────────────────────────────────────────────────
  /** Hold duration in seconds from authorization */
  HOLD_TTL_SECONDS: z.coerce.number().default(3_600),

  // ── Database ─────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/middleware'),

  // ── Browser clients ─────────────────────────────────────────────────────
  /** Comma-separated allowed browser origins for CORS. Use "*" for public APIs. */
  CORS_ORIGIN: z.string().default('*'),
  /** Enable the browser POS simulator WebSocket bridge at /ws/pos. */
  ENABLE_POS_WS_BRIDGE: z.coerce.boolean().optional(),

  // ── Address mappings ─────────────────────────────────────────────────────
  /** JSON: { "<card token>": "<0xAddress>" } */
  CARD_MAPPING_FILE:     z.string().default('./data/card-mapping.json'),
  /** JSON: { "<merchant reference>": "<0xAddress>" } */
  MERCHANT_MAPPING_FILE: z.string().default('./data/merchant-mapping.json'),
})

export type Config = z.infer<typeof ConfigSchema>

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return result.data
}

export const config: Config = loadConfig()

export function allowedTokens(): string[] {
  return config.ALLOWED_TOKENS.split(',').map((t) => t.trim())
}

export function rpcUrls(): string[] {
  return config.RPC_URL.split(',').map((u) => u.trim()).filter(Boolean)
}
