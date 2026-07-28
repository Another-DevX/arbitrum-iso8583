# ArbitrumSettlementCore contracts

Foundry project for the UUPS-upgradeable settlement contract.

## Dependencies

Dependencies are installed locally under ignored `contracts/lib/`:

```bash
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable --no-git
```

## Verification

```bash
forge fmt --check
forge build --sizes
forge test -vv
forge snapshot
```

The suite includes unit, fuzz, invariant, reentrancy, solvency and UUPS
state-preservation tests.

## Deployment

Local or testnet deployment uses `script/Deploy.s.sol`:

```bash
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PK" --broadcast
```

For a controlled M3 deployment with separate role holders:

```bash
export ADMIN_ADDRESS=0x...
export PAUSER_ADDRESS=0x...
export TOKEN_ADMIN_ADDRESS=0x...
export RELAYER_ADDRESS=0x...
export ARBITRUM_SEPOLIA_RPC_URL=https://...
export ARBISCAN_API_KEY=...

forge script script/DeployControlled.s.sol \
  --rpc-url arbitrum-sepolia \
  --private-key "$DEPLOYER_PK" \
  --broadcast
```

The broadcaster is only a bootstrap administrator. The controlled script
configures both mock tokens, grants the final role holders, and removes
bootstrap roles that belong to a different address.

Arbitrum Sepolia broadcast evidence is stored under
`broadcast/Deploy.s.sol/421614/`.
