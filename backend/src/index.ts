/**
 * index.ts
 * Application entry point.
 * Initialises the database, starts the Express server, and begins the retry
 * worker loop.
 */
import express from 'express'
import { config } from './config.js'
import { getDb, runMigrations, closeDb } from './db/client.js'
import { seedMappings } from './db/mappings.js'
import { router } from './routes/api.js'
import { logger } from './observability/logger.js'
import { syncNonce, relayerAddress } from './relayer/wallet.js'
import { createIsoTcpServer } from './tcp/isoTcpServer.js'
import { attachPosSimBridge } from './tcp/posSimBridge.js'

async function bootstrap() {
  // ── 1. Database ────────────────────────────────────────────────────────────
  await runMigrations()
  await seedMappings()
  // ── 2. Relayer nonce ───────────────────────────────────────────────────────
  if (config.NODE_ENV !== 'test') {
    await syncNonce()
    logger.info({ address: relayerAddress() }, 'Relayer wallet ready')
  }

  // ── 3. ISO 8583 TCP server ────────────────────────────────────────────
  const tcpServer = config.NODE_ENV !== 'test' ? createIsoTcpServer() : null

  // ── 4. HTTP server ──────────────────────────────────────────────────
  const app = express()

  const allowedOrigins = config.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean)
  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin
    const allowAll = allowedOrigins.includes('*')
    const allowedOrigin = allowAll ? '*' : allowedOrigins.find((origin) => origin === requestOrigin)

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin)
      res.setHeader('Vary', 'Origin')
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  })

  app.use(express.json({ limit: '1mb' }))

  // Request logger middleware
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming request')
    next()
  })

  app.use('/', router)

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, contract: config.CONTRACT_ADDRESS },
      'ISO 8583 middleware started',
    )
  })

  // ── 5. POS simulator WebSocket bridge (DEVELOPMENT / TESTING ONLY) ────────
  //
  //  In production, real POS terminals connect directly via raw TCP (TCP_PORT).
  //  Browsers cannot open raw TCP sockets, so in non-production environments we
  //  attach a WebSocket bridge at ws://…/ws/pos that forwards binary ISO 8583
  //  frames to and from the isoTcpServer over a loopback TCP connection.
  //
  //  Flow:   Browser → WebSocket /ws/pos → posSimBridge → TCP:TCP_PORT → isoTcpServer
  //
  //  By default the bridge is mounted outside production. Production deployments
  //  can opt in for demos by setting ENABLE_POS_WS_BRIDGE=true.
  const posWsBridgeEnabled = config.ENABLE_POS_WS_BRIDGE ?? config.NODE_ENV !== 'production'
  if (posWsBridgeEnabled) {
    attachPosSimBridge(server)
  } else {
    logger.info('POS simulator WebSocket bridge disabled')
  }

  // ── 6. Graceful shutdown ───────────────────────────────────────────────
  const shutdown = () => {
    server.close()
    tcpServer?.close()
    closeDb().finally(() => process.exit(0))
  }

  process.on('SIGTERM', () => { logger.info('SIGTERM received – shutting down gracefully'); shutdown() })
  process.on('SIGINT',  () => { logger.info('SIGINT received – shutting down');             shutdown() })
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err)
  process.exit(1)
})
