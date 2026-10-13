/**
 * Experiment 4: Local Network (Hardhat Node as Besu stand-in — not Besu itself;
 * see exp4_besu_inprocess.js for what this does and does not model)
 * -------------------------------------------------------------
 * Runs ALL transactions (no sampling) for batches 100, 500, 1000.
 * No rate limiting needed — local node, ~2s block interval.
 * Measures same metrics as Experiment 1.
 *
 * Run AFTER: npx hardhat node (in a separate terminal, port 8545)
 *        AND: npx hardhat run scripts/deploy_besu.js --network localhost
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR, sleep, stats, printTable } = require("./utils");

const BATCH_SIZES = [100, 500, 1000];
const COOLDOWN    = 50;   // ms — much shorter on local node
const PRODUCE     = ["wheat", "rice", "maize", "soybean", "barley"];

async function main() {
  const depPath = path.join(RESULTS_DIR, "besu_deployment.json");
  if (!fs.existsSync(depPath)) throw new Error("besu_deployment.json not found — run deploy_besu.js first");

  const dep = JSON.parse(fs.readFileSync(depPath));
  const [admin] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(admin.address);
  const network = await ethers.provider.getNetwork();

  console.log("Account:", admin.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH");
  console.log("Network:", network.name, "chainId:", network.chainId.toString());
  console.log("Contract:", dep.address, "\n");

  const contract = await ethers.getContractAt("SettlementSystem", dep.address, admin);

  // Register
  try { await (await contract.registerFarmer(admin.address)).wait(); }
  catch { /* already registered */ }
  try { await (await contract.registerBuyer(admin.address)).wait(); }
  catch { /* already registered */ }
  console.log("Registrations done.\n");

  const allResults = {};

  for (const batchSize of BATCH_SIZES) {
    console.log("=".repeat(58));
    console.log(`Batch ${batchSize}  |  FULL (all ${batchSize} tx on local node)`);
    console.log("=".repeat(58));

    const records = [];
    const batchT0 = Date.now();

    for (let i = 0; i < batchSize; i++) {
      const produce = PRODUCE[i % PRODUCE.length];
      const qty     = 10 + (i % 90);
      const price   = 1000 + (i % 9000);

      // createTransaction
      const tC0      = Date.now();
      const createTx = await contract.createTransaction(admin.address, produce, qty, price);
      const createRec = await createTx.wait();
      const tC1      = Date.now();

      // Extract txId from event
      const txId = Number(createRec.logs
        .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "TransactionCreated")?.args[0] ?? 0n) || Number(await contract.txCounter());

      await sleep(COOLDOWN);

      // confirmDelivery
      const tD0       = Date.now();
      const confirmTx = await contract.confirmDelivery(txId);
      const confirmRec = await confirmTx.wait();
      const tD1       = Date.now();

      records.push({
        i: i + 1,
        txId,
        createBlock:          createRec.blockNumber,
        confirmBlock:         confirmRec.blockNumber,
        blockDelta:           confirmRec.blockNumber - createRec.blockNumber,
        createGasUsed:        Number(createRec.gasUsed),
        confirmGasUsed:       Number(confirmRec.gasUsed),
        effectiveGasPrice_gwei: Number(createRec.gasPrice ?? 0n) / 1e9,
        createLatency_s:      (tC1 - tC0) / 1000,
        confirmLatency_s:     (tD1 - tD0) / 1000,
        settlementLatency_s:  (tD1 - tC1) / 1000,
        totalLatency_s:       (tD1 - tC0) / 1000
      });

      if ((i + 1) % 50 === 0 || i === batchSize - 1) {
        const last = records[records.length - 1];
        process.stdout.write(`\r  [${i+1}/${batchSize}] settle=${last.settlementLatency_s.toFixed(2)}s`);
      }

      if (i < batchSize - 1) await sleep(COOLDOWN);
    }

    const wallMs = Date.now() - batchT0;
    process.stdout.write("\n");

    const settlementStats = stats(records.map(r => r.settlementLatency_s));
    const createStats     = stats(records.map(r => r.createLatency_s));
    const confirmStats    = stats(records.map(r => r.confirmLatency_s));
    const totalStats      = stats(records.map(r => r.totalLatency_s));
    const createGasStats  = stats(records.map(r => r.createGasUsed));
    const confirmGasStats = stats(records.map(r => r.confirmGasUsed));
    const blockDeltaStats = stats(records.map(r => r.blockDelta));

    const result = {
      batchSize,
      sampleSize: batchSize,
      sampled: false,
      network: "hardhat-local (Besu proxy, 2s block interval)",
      records,
      settlementLatency_s:  settlementStats,
      createLatency_s:      createStats,
      confirmLatency_s:     confirmStats,
      totalLatency_s:       totalStats,
      createGas:            createGasStats,
      confirmGas:           confirmGasStats,
      blockDelta:           blockDeltaStats,
      throughput_tps:       +(batchSize / (wallMs / 1000)).toFixed(4),
      settlementCertainty:  1.0,
      wallClockSeconds:     +(wallMs / 1000).toFixed(2)
    };

    allResults[batchSize] = result;

    console.log(`  Settlement latency: mean=${settlementStats.mean}s  median=${settlementStats.median}s  IQR=${settlementStats.iqr}s  p95=${settlementStats.p95}s`);
    console.log(`  Throughput:         ${result.throughput_tps} TPS  (${result.wallClockSeconds}s wall clock)`);
  }

  const outPath = path.join(RESULTS_DIR, "besu_results.json");
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nSaved → besu_results.json`);

  console.log("\n" + "=".repeat(95));
  console.log("  EXPERIMENT 4 — BESU LOCAL (Hardhat Node, 2s block interval)");
  console.log("=".repeat(95));
  printTable(
    ["Batch","n","Settle_mean(s)","Settle_med(s)","IQR(s)","p95(s)","p99(s)","ConfirmGas","TPS","Certainty"],
    Object.values(allResults).map(r => [
      r.batchSize, r.sampleSize,
      r.settlementLatency_s.mean,
      r.settlementLatency_s.median,
      r.settlementLatency_s.iqr,
      r.settlementLatency_s.p95,
      r.settlementLatency_s.p99,
      Math.round(r.confirmGas.mean),
      r.throughput_tps,
      "100.0%"
    ]),
    [8,7,15,14,9,9,9,12,9,10]
  );
}

main().catch(e => { console.error(e); process.exit(1); });
