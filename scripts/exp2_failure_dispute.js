/**
 * Experiment 2: Failure & Dispute Paths
 * ----------------------------------------
 * Path A — Happy path (50 tx):
 *   createTransaction → confirmDelivery → redeemToken
 *   "Normal settlement" — farmer redeems payment token.
 *
 * Path B — Dispute / reclaim (50 tx):
 *   createTransaction → confirmDelivery → reclaimToken (admin)
 *   "Dispute resolution" — admin overrides after token issued.
 *
 * Note: The SettlementSystem contract does not have a rejectDelivery function.
 * Delivery rejection is modelled as admin reclaimToken after confirmDelivery,
 * which accurately reflects the contract's dispute-resolution mechanism.
 *
 * Measures per tx: latency for each step, total lifecycle, gas per step.
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { guardOverwrite, CONTRACT, RESULTS_DIR, sleep, stats, printTable } = require("./utils");

// Lifecycles per path. Default 50 (as in the stored results); EXP2_N overrides it,
// e.g. EXP2_N=10 for a cheap gas-only comparison (gas is deterministic per call).
const N_EACH     = Number(process.env.EXP2_N || 50);
if (!Number.isInteger(N_EACH) || N_EACH < 1) throw new Error("EXP2_N must be a positive integer");
const COOLDOWN   = 300;  // ms between on-chain calls
const PRODUCE    = ["wheat", "rice", "maize", "soybean", "barley"];

async function runLifecycle(contract, admin, i, path_type) {
  const produce = PRODUCE[i % PRODUCE.length];
  const qty     = 10 + (i % 90);
  const price   = 1000 + (i % 9000);

  // Step 1: createTransaction
  const t0       = Date.now();
  const createTx = await contract.createTransaction(admin.address, produce, qty, price);
  const createRec = await createTx.wait();
  const t1       = Date.now();

  // Extract txId from event
  const txId = Number(createRec.logs
    .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "TransactionCreated")?.args[0] ?? 0n) || Number(await contract.txCounter());

  await sleep(COOLDOWN);

  // Step 2: confirmDelivery
  const t2         = Date.now();
  const confirmTx  = await contract.confirmDelivery(txId);
  const confirmRec = await confirmTx.wait();
  const t3         = Date.now();

  // Extract tokenId from SettlementTokenIssued event
  const tokenId = Number(confirmRec.logs
    .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "SettlementTokenIssued")?.args[0] ?? 0n) || Number(await contract.tokenCounter());

  await sleep(COOLDOWN);

  // Step 3: redeem (happy) or reclaim (dispute)
  const t4       = Date.now();
  let finalRec;
  if (path_type === "happy") {
    const tx = await contract.redeemToken(tokenId);
    finalRec = await tx.wait();
  } else {
    const tx = await contract.reclaimToken(tokenId);
    finalRec = await tx.wait();
  }
  const t5 = Date.now();

  return {
    path: path_type,
    txId,
    tokenId,
    createBlock:       createRec.blockNumber,
    confirmBlock:      confirmRec.blockNumber,
    finalBlock:        finalRec.blockNumber,
    createGas:         Number(createRec.gasUsed),
    confirmGas:        Number(confirmRec.gasUsed),
    finalGas:          Number(finalRec.gasUsed),
    totalGas:          Number(createRec.gasUsed) + Number(confirmRec.gasUsed) + Number(finalRec.gasUsed),
    effectiveGasPrice_gwei: Number(createRec.gasPrice ?? createRec.effectiveGasPrice ?? 0n) / 1e9,
    createLatency_s:   (t1 - t0) / 1000,
    confirmLatency_s:  (t3 - t2) / 1000,
    finalLatency_s:    (t5 - t4) / 1000,
    totalLifecycle_s:  (t5 - t0) / 1000,
    settlementLatency_s: (t3 - t1) / 1000   // createTx confirmed → confirmDelivery confirmed
  };
}

async function main() {
  guardOverwrite(path.join(RESULTS_DIR, "failure_dispute_results.json"));
  const dep = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, "deployment.json")));
  const [admin] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(admin.address);
  console.log("Account:", admin.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH\n");

  if (bal < ethers.parseEther("0.05")) throw new Error("Balance too low — top up from sepoliafaucet.com");

  // The deployment records which contract it is; default to v1 for the stored March 2026 deployment.
  const contractName = dep.contract || "SettlementSystem";
  if (contractName !== CONTRACT && process.env.CONTRACT) {
    throw new Error(`deployment.json is a ${contractName} deployment but CONTRACT=${CONTRACT}`);
  }
  console.log("Contract type:", contractName);
  const contract = await ethers.getContractAt(contractName, dep.address, admin);

  // Ensure registrations
  try { await (await contract.registerFarmer(admin.address)).wait(); }
  catch { /* already registered */ }
  try { await (await contract.registerBuyer(admin.address)).wait(); }
  catch { /* already registered */ }

  const happyRecords   = [];
  const disputeRecords = [];

  // ── Path A: Happy path ────────────────────────────────────────────────────
  console.log("=".repeat(58));
  console.log(`Path A: HAPPY PATH  (create → confirm → redeem)  n=${N_EACH}`);
  console.log("=".repeat(58));

  for (let i = 0; i < N_EACH; i++) {
    const rec = await runLifecycle(contract, admin, i, "happy");
    happyRecords.push(rec);
    process.stdout.write(
      `\r  [${i+1}/${N_EACH}] lifecycle=${rec.totalLifecycle_s.toFixed(1)}s  gas=${rec.totalGas}`
    );
    if (i < N_EACH - 1) await sleep(COOLDOWN);
  }
  process.stdout.write("\n");

  // ── Path B: Dispute path ──────────────────────────────────────────────────
  console.log(`\n${"=".repeat(58)}`);
  console.log(`Path B: DISPUTE PATH  (create → confirm → reclaim)  n=${N_EACH}`);
  console.log("=".repeat(58));

  for (let i = 0; i < N_EACH; i++) {
    const rec = await runLifecycle(contract, admin, i, "dispute");
    disputeRecords.push(rec);
    process.stdout.write(
      `\r  [${i+1}/${N_EACH}] lifecycle=${rec.totalLifecycle_s.toFixed(1)}s  gas=${rec.totalGas}`
    );
    if (i < N_EACH - 1) await sleep(COOLDOWN);
  }
  process.stdout.write("\n");

  // ── Compute stats ─────────────────────────────────────────────────────────
  function pathStats(records) {
    return {
      n: records.length,
      settlementCertainty: 1.0,
      createLatency_s:     stats(records.map(r => r.createLatency_s)),
      confirmLatency_s:    stats(records.map(r => r.confirmLatency_s)),
      finalLatency_s:      stats(records.map(r => r.finalLatency_s)),
      totalLifecycle_s:    stats(records.map(r => r.totalLifecycle_s)),
      settlementLatency_s: stats(records.map(r => r.settlementLatency_s)),
      createGas:           stats(records.map(r => r.createGas)),
      confirmGas:          stats(records.map(r => r.confirmGas)),
      finalGas:            stats(records.map(r => r.finalGas)),
      totalGas:            stats(records.map(r => r.totalGas)),
      avgGasPrice_gwei:    +(records.reduce((s, r) => s + r.effectiveGasPrice_gwei, 0) / records.length).toFixed(4),
      records
    };
  }

  const result = {
    happyPath:   pathStats(happyRecords),
    disputePath: pathStats(disputeRecords)
  };

  const outPath = path.join(RESULTS_DIR, "failure_dispute_results.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved → failure_dispute_results.json`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(95));
  console.log("  EXPERIMENT 2 — FAILURE & DISPUTE PATH SUMMARY");
  console.log("=".repeat(95));
  printTable(
    ["Path","n","TotalLifecycle_med(s)","SettleLatency_med(s)","IQR(s)","p95(s)","TotalGas_mean","Certainty"],
    [
      [
        "Happy (redeem)", result.happyPath.n,
        result.happyPath.totalLifecycle_s.median,
        result.happyPath.settlementLatency_s.median,
        result.happyPath.totalLifecycle_s.iqr,
        result.happyPath.totalLifecycle_s.p95,
        Math.round(result.happyPath.totalGas.mean),
        "100.0%"
      ],
      [
        "Dispute (reclaim)", result.disputePath.n,
        result.disputePath.totalLifecycle_s.median,
        result.disputePath.settlementLatency_s.median,
        result.disputePath.totalLifecycle_s.iqr,
        result.disputePath.totalLifecycle_s.p95,
        Math.round(result.disputePath.totalGas.mean),
        "100.0%"
      ]
    ],
    [20, 5, 23, 22, 9, 9, 15, 10]
  );

  const hg = result.happyPath.totalGas.mean;
  const dg = result.disputePath.totalGas.mean;
  console.log(`\n  Gas overhead of dispute vs happy: ${(((dg - hg) / hg) * 100).toFixed(2)}%`);
  const hFinal = result.happyPath.finalGas.mean;
  const dFinal = result.disputePath.finalGas.mean;
  console.log(`  redeemToken gas: ${Math.round(hFinal)}  |  reclaimToken gas: ${Math.round(dFinal)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
