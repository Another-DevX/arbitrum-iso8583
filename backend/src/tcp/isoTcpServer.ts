/**
 * tcp/isoTcpServer.ts
 * Raw ISO 8583 TCP server.
 *
 * Pipeline per message:
 *   raw TCP bytes
 *     → IsoFramer  (reassemble stream into complete frames)
 *     → decodeIso8583  (binary → { mti, fields })
 *     → processIsoMessage  (HTTP-intake pipeline)
 *     → buildIsoApprovedResponse / buildIsoDeclineResponse
 *     → socket.write
 *
 * The processIsoMessage function handles parse → route → deduplicate →
 * normalise → map → submit → receipt end-to-end.  The TCP server is only
 * responsible for the binary encoding layer.
 */
import net from 'node:net'
import { config } from '../config.js'
import { logger } from '../observability/logger.js'
import { IsoFramer } from './framing.js'
import { decodeIso8583 } from '../iso/codec.js'
import type { RawIsoMessage } from '../iso/fields.js'
import { processIsoMessage } from '../routes/intake.js'
import {
  buildIsoApprovedResponse,
  buildIsoDeclineResponse,
  buildFallbackDeclineResponse,
  RC,
} from '../iso/response.js'
import { parseIsoMessage } from '../iso/parser.js'
import { txLatency } from '../observability/metrics.js'

function latencyOutcome(result: Awaited<ReturnType<typeof processIsoMessage>>): string {
  if (result.status === 'duplicate') return 'duplicate_processing'
  if (result.status === 'declined') return 'decline_processing'
  if (result.status === 'approved' && result.action === 'authorize') return 'authorize_e2e'
  if (result.status === 'approved' && result.action === 'capture') return 'capture_e2e'
  return 'other_processing'
}

// ── Connection handler ────────────────────────────────────────────────────────

function handleConnection(socket: net.Socket): void {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`
  const connLog = logger.child({ remote })
  connLog.info('ISO TCP connection established')

  const framer = new IsoFramer()

  // ── Framing errors (malformed length header) ─────────────────────────────
  framer.on('error', (err: Error) => {
    connLog.warn({ err: err.message }, 'ISO framing error – closing connection')
    socket.destroy()
  })

  // ── Complete ISO 8583 message received ───────────────────────────────────
  framer.on('message', async (body: Buffer) => {
    const responseStartedAt = performance.now()
    const mti = body.length >= 4 ? body.subarray(0, 4).toString('ascii') : 'XXXX'
    const msgLog = connLog.child({ mti })

    // 1. Binary decode → { mti, fields }
    let rawIso: RawIsoMessage
    try {
      rawIso = decodeIso8583(body)
      msgLog.debug({ fields: Object.keys(rawIso.fields) }, 'ISO decoded')
    } catch (err) {
      msgLog.warn({ err }, 'ISO 8583 decode error')
      // Cannot echo STAN/RRN because we couldn't parse – use fallback
      socket.write(buildFallbackDeclineResponse(mti, RC.INVALID_TRANSACTION), (writeError) => {
        if (!writeError) {
          txLatency.observe(
            { phase: 'tcp_response', outcome: 'decline_processing' },
            performance.now() - responseStartedAt,
          )
        }
      })
      return
    }

    // 2. Parse into typed fields (needed to echo STAN/RRN in error responses)
    let parsed: ReturnType<typeof parseIsoMessage> | null = null
    try {
      parsed = parseIsoMessage(rawIso)
    } catch {
      // Parsing failed but we have rawIso – still try processIsoMessage;
      // if that also fails it will return a decline response.
    }

    // 3. Full pipeline: route → deduplicate → normalise → submit → receipt
    const result = await processIsoMessage(rawIso)
    msgLog.info({ txId: result.txId, status: result.status, rc: result.isoResponseCode }, 'ISO processed')

    // 4. Build binary response
    let response: Buffer

    if (result.status === 'approved') {
      if (parsed) {
        response = buildIsoApprovedResponse(parsed)
      } else {
        // Shouldn't happen: approved implies parse succeeded
        response = buildFallbackDeclineResponse(mti, RC.APPROVED)
      }
    } else {
      // declined, unsupported, pending, parse_error
      if (parsed) {
        response = buildIsoDeclineResponse(parsed, result.isoResponseCode)
      } else {
        response = buildFallbackDeclineResponse(mti, result.isoResponseCode || RC.INVALID_TRANSACTION)
      }
    }

    // 5. Write response
    if (!socket.destroyed) {
      socket.write(response, (err) => {
        if (err) {
          msgLog.warn({ err }, 'Error writing ISO response to socket')
          return
        }
        txLatency.observe(
          { phase: 'tcp_response', outcome: latencyOutcome(result) },
          performance.now() - responseStartedAt,
        )
      })
    }
  })

  // ── Feed raw TCP data through framer ─────────────────────────────────────
  socket.on('data', (chunk: Buffer) => {
    framer.push(chunk)
  })

  socket.on('error', (err) => {
    connLog.warn({ err: err.message }, 'ISO TCP socket error')
  })

  socket.on('close', () => {
    connLog.info('ISO TCP connection closed')
    framer.reset()
  })

  // Keep the socket alive longer than the 120-second receipt wait so a valid
  // transaction is not disconnected while Arbitrum confirmations are pending.
  socket.setTimeout(150_000)
  socket.on('timeout', () => {
    connLog.info('ISO TCP socket idle timeout – closing')
    socket.destroy()
  })
}

// ── Server factory ────────────────────────────────────────────────────────────

/**
 * Create and bind the ISO 8583 TCP server.
 * Returns the net.Server instance so the caller can close it on shutdown.
 *
 * @param listenPort - Optional port override. Defaults to config.TCP_PORT.
 *   Pass 0 to let the OS assign a free port (useful in tests).
 */
export function createIsoTcpServer(listenPort?: number): net.Server {
  const server = net.createServer({ allowHalfOpen: false }, handleConnection)

  server.on('error', (err) => {
    logger.error({ err }, 'ISO TCP server error')
  })

  const port = listenPort ?? config.TCP_PORT
  server.listen(port, () => {
    logger.info({ port }, 'ISO 8583 TCP server listening')
  })

  return server
}
