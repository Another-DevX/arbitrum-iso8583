# ISO 8583 → Arbitrum middleware

Node.js/TypeScript service that accepts ISO 8583 messages over binary TCP or
HTTP/JSON and submits settlement operations to `ArbitrumSettlementCore`.

## Runtime flow

```text
TCP frame / HTTP JSON
  → decode and validate
  → deterministic txId and deduplication
  → PostgreSQL card/merchant mapping
  → estimateContractGas
  → relayer submission
  → confirmed Arbitrum receipt
  → ISO response
```

Audit data is split into:

- `payment_log`: current aggregate payment state.
- `iso_messages`: append-only ISO request/response evidence.
- `chain_operations`: every authorize/capture/release/expire attempt.
- `onchain_events`: decoded event evidence identified by block/hash/log index.
- `reconciliation_run`: persisted four-plane reconciliation reports.

## Configuration

Copy `.env.example` to an ignored `.env` for local development. Required:

```env
RELAYER_PRIVATE_KEY=0x...
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/middleware
```

`RPC_URL` can contain comma-separated endpoints. PostgreSQL is the only
supported database; `DB_PATH`/SQLite are not used.

`ADMIN_ADDRESS`, `PAUSER_ADDRESS`, `TOKEN_ADMIN_ADDRESS` and
`RELAYER_ADDRESS` declare the expected public role holders checked by the M3
runner. In the single-operator PoC they default to the address derived from the
relayer key.

## Commands

```bash
npm ci
npm run build
npm test
npm start

npm run m3:scenarios
npm run reconcile
npm run m3:demo
npm run m3:gas
npm run m3:report
```

The test suite requires a PostgreSQL database. Root `docker-compose.yml`
provides a local PostgreSQL 16 instance.

The root `docker-compose.yml` builds this service from `backend/Dockerfile` and
provides its local health check, PostgreSQL dependency and port mappings.

## Interfaces

- `POST /iso/intake`
- `GET /payments` and `GET /payments/:txId`
- `GET /metrics` (`?since=<epoch-ms>` isolates latency to a demo window)
- `GET /health`
- `GET|PUT|DELETE /admin/cards`
- `GET|PUT|DELETE /admin/merchants`
- Raw ISO 8583 TCP on `TCP_PORT`
- Development POS WebSocket bridge on `/ws/pos`

Latency output separates internal phases from POS-facing TCP response time.
`latencyByOutcome` groups complete responses into successful authorization,
successful capture, decline and duplicate categories; the M3 report does not
combine these different paths into a single aggregate request total.

## Supported messages

| MTI | Processing code | Action |
|---|---|---|
| `0100` | any | authorize |
| `0200` | `00xxxx` | capture |
| `0200` | `28xxxx` | authorize + capture |
| `0400` | any | release |
| `0800` | any | heartbeat |

The duplicate response policy is consistent across HTTP and TCP: ISO response
code `94`, without another blockchain submission.
