/**
 * Experiment 4: Local Network (Hardhat in-process, 2s block interval)
 * Run: npx hardhat run scripts/exp4_besu_inprocess.js
 * (uses --network hardhat automatically, which uses the config block interval)
 *
 * Deploys the contract and runs all 3 batches in the same process.
 *
 * What this is: a single in-process Hardhat node with 2-second interval mining,
 * used as a stand-in for a permissioned (Besu/Quorum-style) chain.
 * What it shares with such a chain: the same EVM bytecode, so gas units match.
 * What it does NOT model: Besu itself, multi-node BFT consensus (IBFT/QBFT),
 * network latency between validators, or real node load. Measured settlement
 * latency here is dominated by the configured 2 s block interval, and TPS by
 * the sequential submit-and-wait loop, so neither is a Besu performance claim.
 * Zero gas price is an assumption about private-network configuration.
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR, sleep, stats, printTable, batchSizesFromEnv } = require("./utils");

const BATCH_SIZES = batchSizesFromEnv([100, 500, 1000]);
const COOLDOWN    = 10;   // ms — minimal on local node
const PRODUCE     = ["wheat", "rice", "maize", "soybean", "barley"];

async function main() {
  const [admin] = await ethers.getSigners();
  const network  = await ethers.provider.getNetwork();
  const bal      = await ethers.provider.getBalance(admin.address);

  console.log("Network:    ", network.name, `(chainId ${network.chainId})`);
  console.log("Account:    ", admin.address);
  console.log("Balance:    ", ethers.formatEther(bal), "ETH");

  // ── Deploy ──────────────────────────────────────────────────────────────────
  console.log("\nDeploying SettlementSystem...");
  const Factory  = await ethers.getContractFactory("SettlementSystem");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  const address  = await contract.getAddress();
  console.log("Deployed at:", address);

  // Register admin as farmer + buyer
  await (await contract.registerFarmer(admin.address)).wait();
  await (await contract.registerBuyer(admin.address)).wait();
  console.log("Registrations done.\n");

  // Save deployment info
  fs.writeFileSync(
    path.join(RESULTS_DIR, "besu_deployment.json"),
    JSON.stringify({ address, deployer: admin.address, network: "hardhat-inprocess (2s interval mining; Besu stand-in, not Besu)", deployedAt: new Date().toISOString() }, null, 2)
  );

  const allResults = {};

  for (const batchSize of BATCH_SIZES) {
    console.log("=".repeat(60));
    console.log(`Batch ${batchSize}  |  FULL ${batchSize} tx  (Hardhat/Besu local)`);
    console.log("=".repeat(60));

    const records   = [];
    const batchT0   = Date.now();

    for (let i = 0; i < batchSize; i++) {
      const produce = PRODUCE[i % PRODUCE.length];
      const qty     = 10 + (i % 90);
      const price   = 1000 + (i % 9000);

      // createTransaction
      const tC0       = Date.now();
      const createTx  = await contract.createTransaction(admin.address, produce, qty, price);
      const createRec = await createTx.wait();
      const tC1       = Date.now();

      // Extract txId from event log
      const txId = Number(
        createRec.logs
          .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
          .find(e => e?.name === "TransactionCreated")?.args[0] ?? 0n
      ) || Number(await contract.txCounter());

      await sleep(COOLDOWN);

      // confirmDelivery
      const tD0        = Date.now();
      const confirmTx  = await contract.confirmDelivery(txId);
      const confirmRec = await confirmTx.wait();
      const tD1        = Date.now();

      records.push({
        i: i + 1,
        txId,
        createBlock:         createRec.blockNumber,
        confirmBlock:        confirmRec.blockNumber,
        blockDelta:          confirmRec.blockNumber - createRec.blockNumber,
        createGasUsed:       Number(createRec.gasUsed),
        confirmGasUsed:      Number(confirmRec.gasUsed),
        effectiveGasPrice_gwei: Number(createRec.gasPrice ?? 0n) / 1e9,
        createLatency_s:     (tC1 - tC0) / 1000,
        confirmLatency_s:    (tD1 - tD0) / 1000,
        settlementLatency_s: (tD1 - tC1) / 1000,
        totalLatency_s:      (tD1 - tC0) / 1000
      });

      if ((i + 1) % 50 === 0 || i === batchSize - 1) {
        const last = records[records.length - 1];
        process.stdout.write(`\r  [${i+1}/${batchSize}] settle=${last.settlementLatency_s.toFixed(3)}s  blocks+${last.blockDelta}`);
      }

      if (i < batchSize - 1) await sleep(COOLDOWN);
    }

    const wallMs = Date.now() - batchT0;
    process.stdout.write("\n");

    const settleStat  = stats(records.map(r => r.settlementLatency_s));
    const createStat  = stats(records.map(r => r.createLatency_s));
    const confirmStat = stats(records.map(r => r.confirmLatency_s));
    const totalStat   = stats(records.map(r => r.totalLatency_s));
    const cGas        = stats(records.map(r => r.createGasUsed));
    const dGas        = stats(records.map(r => r.confirmGasUsed));
    const bDelta      = stats(records.map(r => r.blockDelta));

    const result = {
      batchSize,
      sampleSize: batchSize,
      sampled: false,
      network: "hardhat-inprocess (2s interval mining; Besu stand-in, not Besu)",
      records,
      settlementLatency_s:  settleStat,
      createLatency_s:      createStat,
      confirmLatency_s:     confirmStat,
      totalLatency_s:       totalStat,
      createGas:            cGas,
      confirmGas:           dGas,
      blockDelta:           bDelta,
      throughput_tps:       +(batchSize / (wallMs / 1000)).toFixed(4),
      settlementCertainty:  1.0,
      wallClockSeconds:     +(wallMs / 1000).toFixed(2)
    };

    allResults[batchSize] = result;
    console.log(`  Settlement latency: mean=${settleStat.mean}s  median=${settleStat.median}s  IQR=${settleStat.iqr}s  p95=${settleStat.p95}s  p99=${settleStat.p99}s`);
    console.log(`  Throughput: ${result.throughput_tps} TPS  (wall: ${result.wallClockSeconds}s)\n`);
  }

  const outPath = path.join(RESULTS_DIR, "besu_results.json");
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log("Saved → besu_results.json");

  console.log("\n" + "=".repeat(100));
  console.log("  EXPERIMENT 4 — LOCAL NODE (Hardhat 2s block interval / Besu proxy)");
  console.log("=".repeat(100));
  printTable(
    ["Batch","n","Settle_mean(s)","Settle_med(s)","IQR(s)","p95(s)","p99(s)","CreateGas","ConfirmGas","TPS"],
    Object.values(allResults).map(r => [
      r.batchSize, r.sampleSize,
      r.settlementLatency_s.mean,
      r.settlementLatency_s.median,
      r.settlementLatency_s.iqr,
      r.settlementLatency_s.p95,
      r.settlementLatency_s.p99,
      Math.round(r.createGas.mean),
      Math.round(r.confirmGas.mean),
      r.throughput_tps
    ]),
    [8,7,15,14,9,9,9,11,12,9]
  );
}

main().catch(e => { console.error(e); process.exit(1); });
