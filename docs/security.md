# Security review

## Static analysis (Slither)

Tool: Slither 0.11.6, all 102 default detectors, on a clean Hardhat build of
`contracts/` (test helpers and the reference copy of the original contract are
excluded, see `slither.config.json`). CI runs the same analysis on every push.

| Finding | Where | Assessment | Action |
|---|---|---|---|
| `reentrancy-events`: event emitted after external call | `EscrowSettlement.withdraw` | Low risk: state was already updated before the call, but an observer could see events out of order if the recipient re-entered. | **Fixed**: `Withdrawal` is now emitted before the transfer. |
| `timestamp` (9 functions) | all three contracts | False positive. The flagged `require`s compare status/address fields that share a storage struct with timestamp fields; no logic depends on `block.timestamp`. | None. |
| `low-level-calls` | `EscrowSettlement.withdraw` | Intentional: `call` is the recommended way to send ETH (`transfer`'s 2300-gas stipend breaks contract recipients). The return value is checked, and the state is updated first. | None. |
| `immutable-states`: `admin` could be `immutable` | `SettlementSystem` | Valid gas optimisation. Left unchanged so v1 stays as close as possible to the contract measured on Sepolia; `SettlementSystemOptimized` and `EscrowSettlement` already use `immutable`. | Documented. |

Result on the current code: 11 findings, no high or medium severity, none
requiring a code change beyond the fix above.

## Tested security properties

| Property | Test |
|---|---|
| Only the admin registers parties, confirms deliveries, reclaims tokens | `test/SettlementSystem.test.js`, `test/EscrowSettlement.test.js` |
| Unknown transaction ids cannot mint tokens (bug found in the original) | `rejects unknown transaction ids` |
| A token settles at most once (redeem xor reclaim) | `enforces who may redeem/reclaim…`, `rejects redeeming a reclaimed token` |
| Re-entrant withdrawal is paid exactly once | `a re-entrant buyer is paid exactly once`; it fails if `withdraw` is changed to pay before clearing the balance |
| A failed payout leaves funds claimable | `a failed transfer reverts and leaves the amount claimable` |
| Escrow balance always equals `totalEscrowed + totalOwed` | 200-step randomised sequence |
| The optimised contract behaves identically to v1 | 300-step differential test (`test/Equivalence.test.js`) plus the full v1 suite run against both |

## Known limitations (by design)

- The admin is fully trusted: it can confirm any delivery and reclaim any
  active token. There is no multi-signature, timelock or appeal.
- `EscrowSettlement` holds ETH only; no ERC-20 or INR stablecoin support.
- No formal verification; the properties above are tested, not proven.
