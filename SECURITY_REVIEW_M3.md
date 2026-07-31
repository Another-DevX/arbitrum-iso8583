# M3 Internal Security Review

Date: 2026-07-31
Scope: settlement contract, UUPS proxy, relayer middleware, ISO replay controls,
escrow accounting and emergency operations.

## Result

Slither 0.11.6 reports zero unsuppressed findings across the application
contracts. The six application warnings from the previous run were reviewed and
suppressed at the exact intentional statements with inline rationale; inherited
OpenZeppelin findings are excluded as dependencies. Foundry verification now
includes 84 unit/fuzz/invariant/upgrade tests and four dedicated gas benchmarks.

## Access control

- `authorize` and `capture` require `RELAYER_ROLE`.
- Token configuration requires `TOKEN_ADMIN_ROLE`.
- Pause/unpause require `PAUSER_ROLE`.
- UUPS upgrades require `DEFAULT_ADMIN_ROLE`.
- Release accepts relayer or admin; expiry remains permissionless after its
  deadline to preserve fund recovery.
- Unauthorized upgrade is covered by `UpgradeTest.t.sol`.

Operational requirement: staging must use separate admin, pauser, token-admin
and relayer accounts. Historical testnet keys present in earlier PoC artifacts
must be treated as public and must not secure an M3 controlled deployment.
Embedded RPC/API credentials were removed from active Foundry and middleware
configuration; provider keys are now injected through environment variables.

## Reentrancy and external tokens

Deposit, withdraw, authorize, capture, release and expire use a reentrancy
guard where external calls or balance transitions require it. The malicious
token callback test passes. `SafeERC20` is used for transfers.

## Replay and idempotency

- Onchain `txId` is terminal once a hold is created.
- Middleware deduplication now checks append-only `chain_operations`.
- Failed preflight/submission operations do not permanently block a safe retry.
- Duplicate authorize/capture returns ISO `94` consistently on HTTP and TCP.
- Authorization and capture retain independent audit rows and transaction
  hashes.

## Upgradeability

- The implementation constructor disables initializers.
- `_authorizeUpgrade` is admin-gated.
- ERC-7201 namespaced application storage is used.
- Upgrade tests verify balances, locked funds, holds and roles survive a V1→V2
  upgrade.

## Escrow solvency

- Fee-on-transfer deposits are rejected by measuring the actual custody delta.
- Foundry invariants verify contract custody covers internal accounting and
  locked balances equal authorized holds.
- M3 reconciliation compares token custody with liabilities for configured
  test users.

## Emergency controls

Pause blocks new deposits, withdrawals, authorizations, captures and releases.
Expired holds can still be recovered while paused. This is intentional and
covered by tests.

## Slither resolution

| Previous finding | Resolution |
|---|---|
| Strict equality on received deposit amount | Retained as the required solvency invariant and locally suppressed with rationale; accepting a smaller delta would over-credit fee-on-transfer tokens. |
| Timestamp comparisons in hold lifecycle | Retained as explicit business deadlines and locally suppressed at authorize, capture, release and expire. They are not randomness or price inputs. |
| Assembly in ERC-7201 storage accessor | Retained as the fixed namespaced-storage accessor and locally suppressed; the slot is constant and not caller-controlled. |
| Unindexed inherited OpenZeppelin events | Removed from project findings with `exclude_dependencies`; those upstream event declarations are not application-controlled. |

Raw evidence: `contracts/data/slither-report.json` (`success: true`, zero
detectors). CI now writes a fresh artifact and fails if an unsuppressed finding
regresses, instead of accepting the previously committed JSON file.

Current reproducible output:

```text
$ slither . --config-file slither.config.json --json <temporary-output.json>
. analyzed (24 contracts with 102 detectors), 0 result(s) found
```

## Middleware findings and required controls

- Database and relayer secrets must only be supplied through the ignored local
  `backend/.env` file or process environment variables.
- Admin mapping routes require deployment-layer authentication or an API
  gateway before the environment is exposed outside a controlled network.
- ISO payload logging must use test tokens only; production PAN data requires
  masking, retention controls and PCI-specific handling.
- The relayer remains a trusted actor and can authorize against deposited user
  balances. Production requires user authorization/delegation and spending
  limits.
