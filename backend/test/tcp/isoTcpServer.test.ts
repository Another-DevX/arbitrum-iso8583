/**
 * test/tcp/isoTcpServer.test.ts
 *
 * End-to-end TCP integration tests for the ISO 8583 TCP server.
 *
 * A real net.Server is started, and each test connects as a POS terminal would:
 *   encode message → add 2-byte length header → write to TCP socket
 *   → read binary response → decode → assert fields.
 *
 * Only the blockchain layer (submitter / responseHandler / normalizer) is
 * mocked.  Everything else runs for real:
 *   TCP framing  ·  ISO 8583 encode/decode  ·  routing  ·  deduplication
 *
 * TCP_PORT=0 lets the OS pick a free port so this test never conflicts with
 * a running backend server.
 */
import { jest } from '@jest/globals'
import net from 'node:net'

// ── Blockchain mocks (declared before dynamic imports) ───────────────────────

const mockSubmitFn    = jest.fn()
const mockReceiptFn   = jest.fn()
const mockNormalizeFn = jest.fn()

jest.unstable_mockModule('../../src/relayer/submitter', () => ({
  submitContractCall: mockSubmitFn,
}))

jest.unstable_mockModule('../../src/relayer/responseHandler', () => ({
  waitForReceipt: mockReceiptFn,
}))

jest.unstable_mockModule('../../src/mapping/normalizer', () => ({
  normalize:           mockNormalizeFn,
  resolveTokenAddress: jest.fn(),
}))

// ── Dynamic imports (after mocks are registered) ─────────────────────────────

const { createIsoTcpServer }                    = await import('../../src/tcp/isoTcpServer.js')
const { encodeWithLengthHeader, decodeIso8583 } = await import('../../src/iso/codec.js')
const { IsoFramer }                             = await import('../../src/tcp/framing.js')

// ── Shared test data ──────────────────────────────────────────────────────────

const MOCK_PAYMENT = {
  txId:            '0xabc',
  userAddress:     '0x1111111111111111111111111111111111111111',
  merchantAddress: '0x2222222222222222222222222222222222222222',
  tokenAddress:    '0xA730eFe70d3f67d08dD4a17a867c95bFe1F33CfA',
  amountWei:       1_250_000n,
  expiresAt:       Math.floor(Date.now() / 1000) + 3_600,
  isoFields:       null,
}

/** Build a minimal ISO 8583 authorize (or other) request. */
function makeMsg(stan: string, rrn: string, mti = '0100') {
  return {
    mti,
    fields: {
      '002': 'CARD_TOKEN_001',
      '003': '000000',
      '004': '000000001250',
      '007': '0603120000',
      '011': stan,
      '012': '120000',
      '013': '0603',
      '037': rrn,
      '042': 'TERM001',
      '043': 'MERCHANT001    ',
      '049': '840',
    },
  }
}

type DecodedMsg = { mti: string; fields: Record<string, string> }

/**
 * Open a fresh TCP connection, send one framed ISO 8583 message, wait for
 * the server's binary response, decode it, and close the socket.
 */
function sendAndReceive(serverPort: number, msg: ReturnType<typeof makeMsg>): Promise<DecodedMsg> {
  return new Promise((resolve, reject) => {
    const timer  = setTimeout(() => reject(new Error('TCP response timeout')), 5_000)
    const socket = net.createConnection({ host: '127.0.0.1', port: serverPort })
    const framer = new IsoFramer()

    const cleanup = () => {
      clearTimeout(timer)
      socket.destroy()
    }

    socket.on('error', (err) => { cleanup(); reject(err) })

    framer.on('error', (err: Error) => { cleanup(); reject(err) })

    framer.on('message', (body: Buffer) => {
      cleanup()
      try {
        resolve(decodeIso8583(body))
      } catch (err) {
        reject(err)
      }
    })

    socket.on('data', (chunk: Buffer) => framer.push(chunk))

    socket.on('connect', () => {
      socket.write(encodeWithLengthHeader(msg))
    })
  })
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: net.Server
let port: number

beforeAll(async () => {
  // Port 0 → OS assigns a free port, avoiding conflicts with a running backend.
  server = createIsoTcpServer(0)
  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      port = (server.address() as net.AddressInfo).port
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  )
})

beforeEach(() => {
  jest.clearAllMocks()
  mockNormalizeFn.mockResolvedValue(MOCK_PAYMENT)
  mockSubmitFn.mockResolvedValue({ success: true, txHash: '0xtxhash' })
  mockReceiptFn.mockResolvedValue({
    outcome: 'authorized', isoResponseCode: '00', txHash: '0xtxhash', blockNumber: 100,
  })
})

// ── Test suites ───────────────────────────────────────────────────────────────

describe('ISO TCP server – authorize (0100 → 0110)', () => {
  it('responds with MTI 0110 and RC=00 for an approved transaction', async () => {
    const res = await sendAndReceive(port, makeMsg('100001', 'RRN000100001'))
    expect(res.mti).toBe('0110')
    expect(res.fields['039']).toBe('00')
  })

  it('echoes STAN (field 011) and RRN (field 037) back to the client', async () => {
    const res = await sendAndReceive(port, makeMsg('100002', 'RRN000100002'))
    expect(res.fields['011']).toBe('100002')
    expect(res.fields['037']).toBe('RRN000100002')
  })

  it('responds with 0110 and RC=51 when submitter reports insufficient funds', async () => {
    mockSubmitFn.mockResolvedValueOnce({
      success:    false,
      classified: { code: 'INSUFFICIENT_FUNDS', isoResponseCode: '51', message: 'insufficient funds' },
      attempts:   1,
      retryable:  false,
    })
    const res = await sendAndReceive(port, makeMsg('100003', 'RRN000100003'))
    expect(res.mti).toBe('0110')
    expect(res.fields['039']).toBe('51')
  })

  it('responds with 0110 and RC=96 when receipt times out (pending)', async () => {
    mockReceiptFn.mockResolvedValueOnce({
      outcome: 'timeout', isoResponseCode: '96', txHash: '0xtxhash', blockNumber: null,
    })
    const res = await sendAndReceive(port, makeMsg('100004', 'RRN000100004'))
    expect(res.mti).toBe('0110')
    expect(res.fields['039']).toBe('96')
  })
})

describe('ISO TCP server – heartbeat (0800 → 0810)', () => {
  it('responds with MTI 0810 and RC=00 without calling the submitter', async () => {
    const res = await sendAndReceive(port, makeMsg('200001', 'RRN000200001', '0800'))
    expect(res.mti).toBe('0810')
    expect(res.fields['039']).toBe('00')
    expect(mockSubmitFn).not.toHaveBeenCalled()
  })
})

describe('ISO TCP server – framing on persistent connection', () => {
  it('correctly frames two back-to-back messages on the same socket', async () => {
    const [r1, r2] = await new Promise<[DecodedMsg, DecodedMsg]>((resolve, reject) => {
      const timer    = setTimeout(() => reject(new Error('TCP response timeout')), 5_000)
      const socket   = net.createConnection({ host: '127.0.0.1', port })
      const framer   = new IsoFramer()
      const received: DecodedMsg[] = []

      const cleanup = () => { clearTimeout(timer); socket.destroy() }

      socket.on('error', (err) => { cleanup(); reject(err) })
      framer.on('error', (err: Error) => { cleanup(); reject(err) })

      framer.on('message', (body: Buffer) => {
        try {
          received.push(decodeIso8583(body))
        } catch (err) {
          cleanup(); reject(err); return
        }
        if (received.length === 2) {
          cleanup()
          resolve([received[0], received[1]])
        }
      })

      socket.on('data', (chunk: Buffer) => framer.push(chunk))

      socket.on('connect', () => {
        // Write both frames immediately, back-to-back, as a real POS might.
        socket.write(encodeWithLengthHeader(makeMsg('300001', 'RRN000300001')))
        socket.write(encodeWithLengthHeader(makeMsg('300002', 'RRN000300002')))
      })
    })

    expect(r1.mti).toBe('0110')
    expect(r1.fields['011']).toBe('300001')
    expect(r1.fields['037']).toBe('RRN000300001')

    expect(r2.mti).toBe('0110')
    expect(r2.fields['011']).toBe('300002')
    expect(r2.fields['037']).toBe('RRN000300002')
  })
})

describe('ISO TCP server – deduplication over TCP', () => {
  it('returns RC=94 and calls submitter only once on duplicate', async () => {
    const msg = makeMsg('400001', 'RRN000400001')
    const r1  = await sendAndReceive(port, msg)
    const r2  = await sendAndReceive(port, msg)

    expect(r1.mti).toBe('0110')
    expect(r1.fields['039']).toBe('00')
    expect(r2.mti).toBe('0110')
    expect(r2.fields['039']).toBe('94')

    // The critical assertion: the blockchain submitter was only called once.
    expect(mockSubmitFn).toHaveBeenCalledTimes(1)
  })
})
