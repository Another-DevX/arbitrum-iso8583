# Arbitrum ISO 8583 Settlement PoC

ISO 8583 middleware and an Arbitrum settlement contract for the payment
lifecycle:

```text
ISO 0100 authorize → onchain authorize → ISO 0200 capture → onchain capture
```

The repository contains:

- `contracts/`: UUPS-upgradeable Solidity settlement contract and Foundry tests.
- `backend/`: binary TCP/HTTP ISO 8583 middleware, PostgreSQL audit log and relayer.
- `ui/`: React operator dashboard and POS simulator.
- `backend/scripts/m3-demo.ts`: reproducible M3 scenario, accounting, gas and reconciliation runner.

## Arbitrum Sepolia deployment

| Component | Address |
|---|---|
| Network | Arbitrum Sepolia (`421614`) |
| Settlement proxy | `0xAaE3116210b866f00ccf8dCbD540A6Cc5d070d72` |
| Implementation | `0x655d759764122E84B8cA0B156eE320B2D9Bd50B3` |
| Mock USDC | `0xA730eFe70d3f67d08dD4a17a867c95bFe1F33CfA` |
| Mock USDT | `0xC7f974b3710560D070dEc95288339EfAB683C417` |

These are testnet-only mock assets.

## Local development

Prerequisites: Docker Compose and a testnet relayer key holding
`RELAYER_ROLE`. Real values must be kept in an ignored `backend/.env` or
exported into the shell; the repository only contains
`backend/.env.example`.

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and set RELAYER_PRIVATE_KEY.
./start.sh
```

The stack exposes:

- UI: `http://localhost:5173`
- HTTP API: `http://localhost:3100`
- ISO 8583 TCP: `localhost:5001`
- PostgreSQL: `localhost:5432`

Docker Compose is the reproducible development environment. Arbitrum Sepolia
remains the chain; it does not deploy a replacement Anvil contract.

## Reproducing the M3 verification

These are the exact test groups represented in the M3 report. Commands are run
from the repository root unless a command explicitly changes directory.

### 1. Prerequisites and testnet configuration

Install Node.js 20+, Docker Compose, Foundry and Python 3.11+. Then create the
ignored local configuration:

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env` and set `RPC_URL`, `CONTRACT_ADDRESS`, `ALLOWED_TOKENS`,
`RELAYER_PRIVATE_KEY` and the four public role-holder addresses. The relayer
must be funded on Arbitrum Sepolia and hold `RELAYER_ROLE`. Keep
`HOLD_TTL_SECONDS=15` for the reproducible expiry scenario. Never put a real
private key in a tracked file.

Install the locked JavaScript dependencies and, when `contracts/lib` has not
already been populated, the Foundry dependencies:

```bash
npm ci --prefix backend
npm ci --prefix ui
cd contracts
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-git
cd ..
```

### 2. Start the controlled environment

```bash
docker compose up -d --build
docker compose ps
curl --fail http://localhost:3100/health
```

Expected endpoints are UI `5173`, HTTP `3100`, ISO TCP `5001` and PostgreSQL
`5432`. The health response must contain `"status":"ok"`.

### 3. Backend tests using an isolated database

The Jest setup truncates its target tables. **Do not run it against the
`middleware` demo database.** Create a dedicated database, point only this test
process at it, and remove that database after the run:

```bash
docker compose exec -T postgres createdb -U postgres m3_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/m3_test npm --prefix backend test
docker compose exec -T postgres dropdb -U postgres m3_test
```

The current baseline is 12 suites and 83 tests passing. Also verify both
TypeScript applications:

```bash
npm --prefix backend run build
npm --prefix ui run build
```

### 4. Contract and Slither tests

```bash
cd contracts
forge test
cd ..
```

The current Foundry baseline is 88 tests passing: unit, fuzz, invariant,
upgrade and four gas benchmarks.

Run Slither in an isolated Python environment so it does not modify the global
Python installation:

```bash
python3 -m venv /tmp/m3-slither-venv
/tmp/m3-slither-venv/bin/pip install slither-analyzer
SLITHER_OUTPUT_DIR=$(mktemp -d /tmp/m3-slither.XXXXXX)
cd contracts
/tmp/m3-slither-venv/bin/slither . \
  --config-file slither.config.json \
  --json "$SLITHER_OUTPUT_DIR/report.json"
cd ..
jq '{success, detectorCount: (.results.detectors | length)}' \
  "$SLITHER_OUTPUT_DIR/report.json"
```

Expected result: `success: true` and `detectorCount: 0`.

### 5. Gas report

```bash
npm --prefix backend run m3:gas
```

This reruns the four Foundry gas benchmarks and writes
`contracts/data/foundry-gas-report.json`. It also samples Arbitrum Sepolia gas,
the `NodeInterface` L1 component and a timestamped ETH/USD reference. The report
graphs gas and estimated transaction cost in wei; USD is tabular only.

### 6. Complete TCP demo and reconciliation

This step sends transactions to Arbitrum Sepolia and therefore changes testnet
state. Ensure the configured test accounts have sufficient deposited mock-token
balances. Run only this command; it already executes the six scenarios,
captures the current metrics window, reconciles all four evidence planes and
regenerates the technical report:

```bash
npm --prefix backend run m3:demo -- --port 5001
```

Expected summary:

- Six of six scenarios pass.
- Reconciliation reports zero mismatches.
- The generated latency section has authorization, capture, decline and
  duplicate TCP timings from this run only.

Generated evidence:

- `backend/data/m3-run-<timestamp>.json`
- `backend/data/m3-metrics-<timestamp>.json`
- `backend/data/m3-gas-report-<timestamp>.json`
- `backend/data/reconciliation-<timestamp>.json`
- `contracts/data/foundry-gas-report.json`
- `contracts/data/slither-report.json`
- `TECHNICAL_MILESTONE_REPORT_3.md`

CI repeats the backend, UI, Foundry and Slither checks with a disposable
PostgreSQL 16 service. The live testnet demo is intentionally run manually.

## Reports

- [M1 contract report](./TECHNICAL_MILESTONE_REPORT_1.md)
- [M2 middleware report](./TECHNICAL_MILESTONE_REPORT_2.md)
- [M3 PoC technical report](./TECHNICAL_MILESTONE_REPORT_3.md)
- [M3 internal security review](./SECURITY_REVIEW_M3.md)
