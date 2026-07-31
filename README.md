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

## Railway staging

Railway hosts the staging backend and PostgreSQL service. Configure at least:

```text
RELAYER_PRIVATE_KEY
DATABASE_URL
RPC_URL
CONTRACT_ADDRESS
ALLOWED_TOKENS
CORS_ORIGIN
ENABLE_POS_WS_BRIDGE
ADMIN_ADDRESS
PAUSER_ADDRESS
TOKEN_ADMIN_ADDRESS
RELAYER_ADDRESS
```

Do not commit Railway values or role-holder keys. `RPC_URL` accepts multiple
comma-separated endpoints.

## M3 execution

Run with a funded test environment. The expiry scenario requires the backend to
use `HOLD_TTL_SECONDS<=30`; local Compose defaults to fifteen seconds so normal
captures have enough time to confirm before the expiry scenario runs.

```bash
cd backend
npm ci
npm run m3:gas
npm run m3:scenarios
npm run reconcile
npm run m3:demo -- --port 5001
npm run m3:report
```

`m3:gas` runs the four Foundry lifecycle benchmarks and captures transaction
intrinsic gas, the Arbitrum `NodeInterface` L1 component, the current Sepolia
gas price and a timestamped ETH/USD reference. The report graphs gas and total
estimated cost in wei; it does not graph USD.
`m3:demo` executes the six binary TCP scenarios, exports accounting snapshots,
records receipt evidence, reconciles four evidence planes, and generates
`TECHNICAL_MILESTONE_REPORT_3.md`.

## Verification

```bash
cd backend
npm ci
npm run build
npm test

cd ../ui
npm ci
npm run build

cd ../contracts
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-git
forge test -vv
```

CI repeats these checks with a disposable PostgreSQL 16 service.

## Reports

- [M1 contract report](./TECHNICAL_MILESTONE_REPORT_1.md)
- [M2 middleware report](./TECHNICAL_MILESTONE_REPORT_2.md)
- [M3 PoC technical report](./TECHNICAL_MILESTONE_REPORT_3.md)
- [M3 internal security review](./SECURITY_REVIEW_M3.md)
