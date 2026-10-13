# On-chain settlement for farmer–buyer produce trades: design, measurement and gas optimisation

Shrinivas Anavekar · Technical report · October 2026

## 1. Problem

Smallholder farmers selling produce to buyers depend on the buyer, or an
intermediary, to record the agreement and release payment after delivery.
Disputes are resolved off the record. This project asks what a shared,
tamper-evident ledger of the settlement lifecycle costs in latency and gas,
compared with a conventional API and with Indian bank-transfer fees, and how
far that cost can be reduced.

## 2. System

The lifecycle has four steps: a registered buyer **creates** an agreement, an
admin **confirms delivery** (which issues a settlement token), and the token is
then either **redeemed** by the farmer or **reclaimed** by the admin in a dispute.

Three contracts implement it:

| Contract | Purpose |
|---|---|
| `SettlementSystem` (v1) | Status records only; the contract measured on Sepolia (plus input validation added later) |
| `SettlementSystemOptimized` | Same behaviour, packed storage (§4) |
| `EscrowSettlement` (v2) | Holds the buyer's ETH and pays out by outcome; adds cancel/refund and pull-pattern withdrawals |

A single trusted admin confirms deliveries and resolves disputes in all three.

## 3. Latency and cost (stored measurements, March 2026)

| Setting | Interval measured | n | Median | IQR |
|---|---|---|---|---|
| Ethereum Sepolia | createTx confirmed → confirmDelivery confirmed | 100 | 12.02 s | 11.48–12.57 s |
| Local Hardhat chain, 2 s blocks | same | 100 | 2.01 s | 2.009–2.014 s |
| In-memory REST API | full create → confirm → redeem request cycle | 100 | 2.0 ms | — |

![Settlement latency](figures/settlement_latency.png)

On Sepolia the median is about one block time (~12 s), but the tail is long:
p95 is 36.1 s and the maximum is 48.7 s, consistent with occasionally missing
the next block. On the local chain, latency simply equals the configured block
interval. A full settlement lifecycle (create + confirm + redeem) uses about
399k gas. At the Sepolia gas price recorded at the time, that is about ₹4.05;
since testnet gas prices are not mainnet prices, the figure is illustrative.

## 4. Gas optimisation

**Diagnosis.** Writing a new storage slot costs about 22.1k gas. v1 stores each
agreement in 7 slots, and `confirmDelivery` copies four of those fields into a
new 4-slot token. The contract's cost is therefore dominated by fresh storage
writes, not by computation.

**Changes** (`SettlementSystemOptimized`):

1. Pack the agreement into 4 slots: `[farmer | agreedAt | confirmed]`,
   `[buyer | confirmedAt]`, `[quantity | price]` (uint128 each, bounds-checked)
   and `[produceType]`.
2. Store a token as a single slot `[txId | status]`, reading the other fields
   from its agreement. Token issue time equals delivery confirmation time,
   since both are set in the same call.
3. Make `admin` immutable.

The external interface (functions, events, revert messages and view return
types) is unchanged, so the experiment scripts run against it as is.

**Equivalence.** The full v1 unit-test suite passes against both contracts. In
addition, a differential test sends 300 random calls, including invalid ones,
to both. They agree on every success or revert, every revert message, and all
final state.

**Measurement method.** Gas is deterministic for a given contract, input and
EVM version, so it can be measured locally. To validate this, the *original*
deployed source was measured locally under the same workload as the Sepolia
experiments. All four functions matched the stored Sepolia means within 0.04%.

| Function | v1 (gas) | Optimised (gas) | Change |
|---|---|---|---|
| createTransaction | 172,479 | 123,545 | −28.4% |
| confirmDelivery | 194,149 | 65,136 | −66.5% |
| redeemToken | 32,786 | 32,993 | +0.6% |
| reclaimToken | 30,067 | 27,997 | −6.9% |
| **Lifecycle (create + confirm + redeem)** | **399,414** | **221,674** | **−44.5%** |
| Deployment | 1,121,885 | 1,032,250 | −8.0% |

![Gas per function](figures/gas_per_function.png)

`redeemToken` becomes slightly more expensive, because it now reads the farmer
from the agreement record instead of from the token. That is the trade-off for
not duplicating data at confirmation time.

## 5. Correctness and security

- **Bug found and fixed.** In the deployed contract, `confirmDelivery` accepted
  any transaction id. For an unknown id it issued an ACTIVE token for
  `address(0)` with amount 0. A regression test fails on the original source
  and passes on the fixed one.
- **Escrow safety.** Payouts are pull-based, and state is updated before the
  transfer. The tests verify that:
  - a re-entrant recipient is paid exactly once (and this test fails if the
    order is reversed);
  - a failed payout leaves the funds claimable;
  - over a randomised 200-step sequence, the contract's balance always equals
    escrowed plus owed funds.
- **Static analysis.** Slither (102 detectors) reports 11 findings, none high
  or medium severity. One (event emitted after an external call) was fixed;
  the rest are triaged in `security.md`. Slither runs in CI.

## 6. Threats to validity

- **Exp 4 is a single Hardhat node with interval mining, not Besu.** It does
  not model multi-validator BFT consensus or network latency.
- **The Sepolia and local latency experiments submit transactions
  sequentially.** Their throughput reflects that loop, not chain capacity.
  Exp 5 adds concurrent submission, but has no stored results yet.
- **The REST and blockchain latencies measure different intervals,** so they
  are an order-of-magnitude comparison.
- **Sample sizes are 50–100 per configuration,** from one account, over one
  period. Sepolia conditions vary over time.
- **Gas results assume the EVM version used** (local Hardhat, `osaka`). The
  validation against Sepolia covers that assumption for the original contract.
- **The escrow and optimised contracts have not been deployed to a public
  network.**

## 7. Future work

1. Deploy `SettlementSystemOptimized` and `EscrowSettlement` to Sepolia and
   repeat Exp 1–2.
2. Replace the Exp 4 stand-in with a 4-validator Besu QBFT network.
3. Replace the single admin with multi-party delivery attestation (for
   example 2-of-3 buyer, farmer and inspector) and a dispute timelock.
4. Settle in an INR-pegged stablecoin and measure end-to-end cost against
   UPI and NEFT.

## Reproducing

`npm ci && npm test` runs all tests. `npx hardhat run scripts/gas_comparison.js`
regenerates §4, and `python scripts/plot_results.py` regenerates the figures.
The stored data is in `results/`.
