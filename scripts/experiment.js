/**
 * SettlementSystem Latency/Throughput Experiment
 * ------------------------------------------------
 * LEGACY: superseded by exp1_sepolia_latency.js (which also measures
 * confirmDelivery). Kept because results.json was produced by it.
 *
 * For each batch size (100, 500, 1000) we submit a SAMPLE_CAP-sized sample of
 * createTransaction calls and measure per-operation latency, gas cost, IQR,
 * throughput, and settlement certainty. Only the sample is measured; nothing
 * is extrapolated to the declared batch size.
 *
 * Why sampling?
 *   Sepolia block time ≈ 12 s.  50 confirmed tx ≈ 10 min, which is already
 *   representative.  Sending 1 000 sequential confirmed tx would take ~3 h and
 *   exhaust Alchemy free-tier limits.
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR } = require("./utils");

// ── Config ────────────────────────────────────────────────────────────────────
const BATCH_SIZES   = [100, 500, 1000];
const SAMPLE_CAP    = 50;          // max on-chain tx per batch
const COOLDOWN_MS   = 300;         // ms between sends
const PRODUCE_TYPES = ["wheat", "rice", "maize", "soybean", "barley"];

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean   = values.reduce((s, v) => s + v, 0) / values.length;
  const q1     = percentile(sorted, 25);
  const q3     = percentile(sorted, 75);
  return {
    mean:   +mean.toFixed(4),
    median: +percentile(sorted, 50).toFixed(4),
    p95:    +percentile(sorted, 95).toFixed(4),
    min:    +sorted[0].toFixed(4),
    max:    +sorted[sorted.length - 1].toFixed(4),
    iqr:    +(q3 - q1).toFixed(4),
    q1:     +q1.toFixed(4),
    q3:     +q3.toFixed(4),
    stddev: +(Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)).toFixed(4)
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const depPath = path.join(RESULTS_DIR, "deployment.json");
  if (!fs.existsSync(depPath)) throw new Error("deployment.json not found — run deploy first");
  const { address } = JSON.parse(fs.readFileSync(depPath));

  const [admin] = await ethers.getSigners();
  console.log("Experimenter account:", admin.address);
  console.log("Contract address:    ", address);

  const contract = await ethers.getContractAt("SettlementSystem", address, admin);

  // Ensure admin is registered as farmer and buyer (idempotent — won't revert if already registered)
  console.log("\nEnsuring registrations...");
  try {
    const t1 = await contract.registerFarmer(admin.address);
    await t1.wait();
    console.log("  Farmer registered.");
  } catch (e) {
    console.log("  Farmer already registered (skipped).");
  }
  try {
    const t2 = await contract.registerBuyer(admin.address);
    await t2.wait();
    console.log("  Buyer registered.");
  } catch (e) {
    console.log("  Buyer already registered (skipped).");
  }

  const allResults = {};

  for (const batchSize of BATCH_SIZES) {
    const sampleSize = Math.min(batchSize, SAMPLE_CAP);
    const isSampled  = sampleSize < batchSize;
    console.log(`\n${"=".repeat(62)}`);
    console.log(`Batch ${batchSize}  |  On-chain sample: ${sampleSize}${isSampled ? `  (sample of ${batchSize}, not extrapolated)` : ""}`);
    console.log("=".repeat(62));

    const latencies_ms = [];
    const gasUsed      = [];

    const batchStart = Date.now();

    for (let i = 0; i < sampleSize; i++) {
      const produce = PRODUCE_TYPES[i % PRODUCE_TYPES.length];
      const qty     = 10 + (i % 90);
      const price   = 1000 + (i % 9000);

      const t0 = Date.now();
      const tx = await contract.createTransaction(admin.address, produce, qty, price);
      const receipt = await tx.wait();
      const t1 = Date.now();

      latencies_ms.push(t1 - t0);
      gasUsed.push(Number(receipt.gasUsed));

      process.stdout.write(`\r  Sent & confirmed: ${i + 1}/${sampleSize}`);

      if (i < sampleSize - 1) await sleep(COOLDOWN_MS);
    }

    const wallMs = Date.now() - batchStart;
    process.stdout.write("\n");

    // Settlement certainty = confirmed / submitted (always 1.0 for sequential)
    const certainty = 1.0;

    // TPS: transactions confirmed per second over the measurement window
    const tps = +(sampleSize / (wallMs / 1000)).toFixed(4);

    const latencyStats = stats(latencies_ms.map((v) => v / 1000));  // → seconds
    const gasStats     = stats(gasUsed);

    const result = {
      batchSize,
      sampleSize,
      sampled:             isSampled,
      latency_s:           latencyStats,
      gas:                 gasStats,
      throughput_tps:      tps,
      settlementCertainty: certainty,
      wallClockSeconds:    +(wallMs / 1000).toFixed(2)
    };

    allResults[batchSize] = result;
    printBatchSummary(result);
  }

  const outPath = path.join(RESULTS_DIR, "results.json");
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults saved → results.json`);
  printSummaryTable(allResults);
}

// ── Output helpers ────────────────────────────────────────────────────────────
function printBatchSummary(r) {
  console.log(`\n  Latency (s):  mean=${r.latency_s.mean}  median=${r.latency_s.median}  IQR=${r.latency_s.iqr}  p95=${r.latency_s.p95}  stddev=${r.latency_s.stddev}`);
  console.log(`  Gas (units):  mean=${Math.round(r.gas.mean)}  median=${Math.round(r.gas.median)}  IQR=${Math.round(r.gas.iqr)}`);
  console.log(`  Throughput:   ${r.throughput_tps} TPS`);
  console.log(`  Certainty:    ${(r.settlementCertainty * 100).toFixed(1)}%`);
  console.log(`  Wall clock:   ${r.wallClockSeconds}s for ${r.sampleSize} tx`);
  if (r.sampled) console.log(`  ⚠  Sampled: ${r.sampleSize} of ${r.batchSize} tx measured (statistics describe the sample only)`);
}

function printSummaryTable(results) {
  const SEP = "=".repeat(100);
  const sep = "-".repeat(100);
  console.log("\n" + SEP);
  console.log("  SETTLEMENT SYSTEM — EXPERIMENT SUMMARY");
  console.log(SEP);
  console.log(
    "  " +
    "Batch".padEnd(7) +
    "n".padEnd(6) +
    "Lat_mean(s)".padEnd(13) +
    "Lat_med(s)".padEnd(12) +
    "IQR(s)".padEnd(10) +
    "p95(s)".padEnd(10) +
    "Stddev(s)".padEnd(11) +
    "Gas_mean".padEnd(11) +
    "TPS".padEnd(9) +
    "Certainty"
  );
  console.log("  " + sep);
  for (const r of Object.values(results)) {
    const tag = r.sampled ? `${r.batchSize}*` : `${r.batchSize}`;
    console.log(
      "  " +
      tag.padEnd(7) +
      String(r.sampleSize).padEnd(6) +
      String(r.latency_s.mean).padEnd(13) +
      String(r.latency_s.median).padEnd(12) +
      String(r.latency_s.iqr).padEnd(10) +
      String(r.latency_s.p95).padEnd(10) +
      String(r.latency_s.stddev).padEnd(11) +
      String(Math.round(r.gas.mean)).padEnd(11) +
      String(r.throughput_tps).padEnd(9) +
      `${(r.settlementCertainty * 100).toFixed(1)}%`
    );
  }
  console.log("  " + sep);
  console.log("  * = sampled (50 tx measured; not extrapolated)");
  console.log(SEP + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
