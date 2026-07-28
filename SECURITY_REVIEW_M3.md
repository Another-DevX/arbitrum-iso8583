# M3 Internal Security Review

Date: 2026-07-28
Scope: settlement contract, UUPS proxy, relayer middleware, ISO replay controls,
escrow accounting and emergency operations.

## Result

No critical or high-severity contract finding was produced by Slither. The
static report contains nine findings: one medium, four low and four
informational. All are reviewed below. Foundry verification completed with 84
passing tests, including four invariant campaigns and two UUPS upgrade tests.

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

## Slither triage

| Finding | Impact | Review |
|---|---|---|
| Strict equality on received deposit amount | Medium | Intentional solvency guard; accepting a smaller delta would over-credit fee-on-transfer tokens. |
| Timestamp comparisons in hold lifecycle | Low | Required business deadlines; miner/sequencer timestamp tolerance is insignificant relative to configured hold TTL. |
| Assembly in ERC-7201 storage accessor | Informational | Required to bind the documented namespaced storage slot; no arbitrary memory access. |
| Unindexed inherited OpenZeppelin events | Informational | Upstream interface/event definitions, not application-controlled settlement events. |

Raw evidence: `contracts/data/slither-report.json`.

## Middleware findings and required controls

- Railway/database/relayer secrets must only be supplied as environment
  variables.
- Admin mapping routes require deployment-layer authentication or an API
  gateway before the environment is exposed outside a controlled network.
- ISO payload logging must use test tokens only; production PAN data requires
  masking, retention controls and PCI-specific handling.
- The relayer remains a trusted actor and can authorize against deposited user
  balances. Production requires user authorization/delegation and spending
  limits.
