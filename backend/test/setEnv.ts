/**
 * test/setEnv.ts
 * Sets required environment variables before any src/ modules are imported.
 * Must be the FIRST entry in jest setupFiles.
 */
process.env['NODE_ENV']            = 'test'
process.env['RELAYER_PRIVATE_KEY'] = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
process.env['DATABASE_URL']        = process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5432/middleware'

export {}
