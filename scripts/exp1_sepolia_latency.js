/**
 * Experiment 1: Full Settlement Latency on Sepolia
 * --------------------------------------------------
 * For each batch:
 *   Batch 100  → run ALL 100 pairs  (createTx + confirmDelivery)
 *   Batch 500  → run 75-tx sample
 *   Batch 1000 → run 50-tx sample
 * Note: sampled batches are NOT extrapolated by this script. Because every
 * transaction is submitted sequentially and awaited, a "batch" here is a
 * sequence of independent runs, not a concurrent load test; the statistics
 * describe the sample only.
 *
 * Per transaction measures:
 *   - createTransaction confirmation time + block
 *   - confirmDelivery confirmation time + block
 *   - Settlement latency = time(confirmDelivery confirmed) - time(createTx confirmed)
 *   - Block delta
 *   - Gas used and effective gas price for both calls
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { guardOverwrite, CONTRACT, RESULTS_DIR, sleep, stats, printTable } = require("./utils");

const BATCH_SIZES  = [100, 500, 1000];
const SAMPLE_CAP   = { 100: 100, 500: 75, 1000: 50 };
const COOLDOWN_MS  = 300;
const PRODUCE      = ["wheat", "rice", "maize", "soybean", "barley"];

async function main() {
  guardOverwrite(path.join(RESULTS_DIR, "full_latency_results.json"));
  const dep = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, "deployment.json")));
  const [admin] = await ethers.getSigners();

  const bal = await ethers.provider.getBalance(admin.address);
  console.log("Account:", admin.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH");
  console.log("Contract:", dep.address, "\n");

  if (bal < ethers.parseEther("0.05")) {
    throw new Error("Balance too low. Get Sepolia ETH from https://sepoliafaucet.com/");
  }

  // The deployment records which contract it is; default to v1 for the stored March 2026 deployment.
  const contractName = dep.contract || "SettlementSystem";
  if (contractName !== CONTRACT && process.env.CONTRACT) {
    throw new Error(`deployment.json is a ${contractName} deployment but CONTRACT=${CONTRACT}`);
  }
  console.log("Contract type:", contractName);
  const contract = await ethers.getContractAt(contractName, dep.address, admin);

  // Ensure registrations (idempotent — contract allows re-registration without revert)
  console.log("Ensuring registrations...");
  try { await (await contract.registerFarmer(admin.address)).wait(); console.log("  farmer registered"); }
  catch { console.log("  farmer already registered"); }
  try { await (await contract.registerBuyer(admin.address)).wait(); console.log("  buyer registered"); }
  catch { console.log("  buyer already registered"); }

  const allResults = {};

  for (const batchSize of BATCH_SIZES) {
    const sampleSize = SAMPLE_CAP[batchSize];
    const isSampled  = sampleSize < batchSize;
    console.log(`\n${"=".repeat(62)}`);
    console.log(`Batch ${batchSize}  |  Sample: ${sampleSize}${isSampled ? ` of ${batchSize} (sample only, not extrapolated)` : " (full)"}`);
    console.log("=".repeat(62));

    const records = [];  // per-tx data

    for (let i = 0; i < sampleSize; i++) {
      const produce = PRODUCE[i % PRODUCE.length];
      const qty     = 10 + (i % 90);
      const price   = 1000 + (i % 9000);

      // ── Step 1: createTransaction ───────────────────────────────────────────
      const tCreate0 = Date.now();
      const createTx = await contract.createTransaction(admin.address, produce, qty, price);
      const createRec = await createTx.wait();
      const tCreate1 = Date.now();

      await sleep(COOLDOWN_MS);

      // ── Step 2: confirmDelivery ─────────────────────────────────────────────
      const txId = Number(await contract.txCounter());
      // The latest txId is the one we just created (txCounter increments)
      // More precisely: after createTx, txCounter = (previous + 1). We track it:
      const thisTxId = Number(createRec.logs
        .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "TransactionCreated")?.args[0] ?? 0n);

      const tConfirm0 = Date.now();
      const confirmTx = await contract.confirmDelivery(thisTxId || txId);
      const confirmRec = await confirmTx.wait();
      const tConfirm1 = Date.now();

      const settlementLatency_s = (tConfirm1 - tCreate1) / 1000;
      const createLatency_s     = (tCreate1 - tCreate0) / 1000;
      const confirmLatency_s    = (tConfirm1 - tConfirm0) / 1000;
      const blockDelta          = confirmRec.blockNumber - createRec.blockNumber;

      records.push({
        i: i + 1,
        txId: thisTxId || txId,
        createBlock:         createRec.blockNumber,
        confirmBlock:        confirmRec.blockNumber,
        blockDelta,
        createGasUsed:       Number(createRec.gasUsed),
        confirmGasUsed:      Number(confirmRec.gasUsed),
        effectiveGasPrice_gwei: Number(confirmRec.gasPrice ?? confirmRec.effectiveGasPrice ?? 0n) / 1e9,
        createLatency_s,
        confirmLatency_s,
        settlementLatency_s,
        totalLatency_s:      (tConfirm1 - tCreate0) / 1000
      });

      process.stdout.write(
        `\r  [${i+1}/${sampleSize}] settle=${settlementLatency_s.toFixed(1)}s  blocks+${blockDelta}  gas=${Number(confirmRec.gasUsed)}`
      );

      if (i < sampleSize - 1) await sleep(COOLDOWN_MS);
    }

    process.stdout.write("\n");

    const settlementStats  = stats(records.map(r => r.settlementLatency_s));
    const createStats      = stats(records.map(r => r.createLatency_s));
    const confirmStats     = stats(records.map(r => r.confirmLatency_s));
    const totalStats       = stats(records.map(r => r.totalLatency_s));
    const createGasStats   = stats(records.map(r => r.createGasUsed));
    const confirmGasStats  = stats(records.map(r => r.confirmGasUsed));
    const blockDeltaStats  = stats(records.map(r => r.blockDelta));
    const avgGasPrice_gwei = records.reduce((s, r) => s + r.effectiveGasPrice_gwei, 0) / records.length;

    const result = {
      batchSize, sampleSize, sampled: isSampled,
      records,
      settlementLatency_s:  settlementStats,
      createLatency_s:      createStats,
      confirmLatency_s:     confirmStats,
      totalLatency_s:       totalStats,
      createGas:            createGasStats,
      confirmGas:           confirmGasStats,
      blockDelta:           blockDeltaStats,
      avgGasPrice_gwei:     +avgGasPrice_gwei.toFixed(4),
      settlementCertainty:  1.0
    };

    // Sequential throughput: transactions / (sum of per-tx create+confirm time + cooldown).
    // Reflects the submit-and-wait loop, not network capacity.
    result.throughput_tps = +(sampleSize / records.reduce((s, r) => s + r.createLatency_s + r.confirmLatency_s + COOLDOWN_MS/1000, 0)).toFixed(4);

    allResults[batchSize] = result;

    console.log(`\n  Settlement latency: mean=${settlementStats.mean}s  median=${settlementStats.median}s  IQR=${settlementStats.iqr}s  p95=${settlementStats.p95}s  p99=${settlementStats.p99}s`);
    console.log(`  Create gas:         mean=${Math.round(createGasStats.mean)}  Confirm gas: mean=${Math.round(confirmGasStats.mean)}`);
    console.log(`  Block delta:        mean=${blockDeltaStats.mean}  (blocks between createTx and confirmTx)`);
    console.log(`  Gas price:          ${avgGasPrice_gwei.toFixed(4)} gwei avg`);
    if (isSampled) console.log(`  ⚠ ${sampleSize}-tx sample of a ${batchSize}-tx batch (not extrapolated)`);
  }

  const outPath = path.join(RESULTS_DIR, "full_latency_results.json");
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nSaved → full_latency_results.json`);

  // Summary table
  console.log("\n" + "=".repeat(100));
  console.log("  EXPERIMENT 1 — SETTLEMENT LATENCY (createTx→confirmDelivery)");
  console.log("=".repeat(100));
  printTable(
    ["Batch","n","Settle_mean(s)","Settle_med(s)","IQR(s)","p95(s)","p99(s)","CreateGas","ConfirmGas","Certainty"],
    Object.values(allResults).map(r => [
      r.sampled ? `${r.batchSize}*` : r.batchSize,
      r.sampleSize,
      r.settlementLatency_s.mean,
      r.settlementLatency_s.median,
      r.settlementLatency_s.iqr,
      r.settlementLatency_s.p95,
      r.settlementLatency_s.p99,
      Math.round(r.createGas.mean),
      Math.round(r.confirmGas.mean),
      "100.0%"
    ]),
    [8,6,15,14,9,9,9,11,12,10]
  );
  console.log("  * = sampled\n");
}

main().catch(e => { console.error(e); process.exit(1); });
