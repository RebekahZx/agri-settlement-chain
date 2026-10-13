/**
 * Experiment 5: Concurrent submission on the local chain
 * ------------------------------------------------------
 * Run: npx hardhat run scripts/exp5_local_concurrency.js
 *
 * Experiments 1–4 submit one transaction and wait for it before sending the
 * next, so their TPS figures describe that loop, not chain capacity. This
 * experiment submits a whole batch without waiting (explicit nonces from one
 * account), then waits for all receipts. It runs two phases per batch:
 *   phase 1: N × createTransaction
 *   phase 2: N × confirmDelivery for the ids created in phase 1
 *
 * Measured per phase: wall-clock time from first send until the last
 * transaction is mined, throughput (N / wall time), chain-side duration from
 * block timestamps, number of blocks used, transactions per block and gas per
 * block. All of these are bounded by the local chain's configuration
 * (2 s interval mining in hardhat.config.js and Hardhat's block gas limit), so
 * results characterise this simulated chain, not Besu or Ethereum.
 *
 * Output: results/exp5_concurrency_results.json (or $RESULTS_DIR).
 */

const { ethers, network } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR, stats, printTable, batchSizesFromEnv } = require("./utils");

const BATCH_SIZES = batchSizesFromEnv([100, 500, 1000]);
const PRODUCE     = ["wheat", "rice", "maize", "soybean", "barley"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendAll(buildTx, n, signer) {
  const provider = signer.provider;
  let nonce = await signer.getNonce("pending");
  const startBlock = await provider.getBlock("latest");
  const t0 = Date.now();
  const sent = [];
  for (let i = 0; i < n; i++) sent.push(await buildTx(i, nonce++));
  const tSubmitted = Date.now();

  // All transactions come from one account with consecutive nonces, so once the
  // last one is mined every earlier one is too. Waiting on that single receipt
  // avoids measuring the overhead of n concurrent tx.wait() pollers (an earlier
  // version of this script did, and its wall time was ~20x the block time).
  const last = sent[sent.length - 1].hash;
  while (!(await provider.getTransactionReceipt(last))) await sleep(100);
  const t1 = Date.now();
  const receipts = await Promise.all(sent.map((tx) => provider.getTransactionReceipt(tx.hash)));

  if (receipts.some((r) => r.status !== 1)) throw new Error("A transaction reverted");

  const perBlock = new Map();
  for (const r of receipts) {
    const b = perBlock.get(r.blockNumber) || { txs: 0, gas: 0 };
    b.txs += 1; b.gas += Number(r.gasUsed);
    perBlock.set(r.blockNumber, b);
  }
  const blocks = [...perBlock.values()];
  const lastBlock = await provider.getBlock(Math.max(...perBlock.keys()));
  // Chain-side duration: from the block before submission to the block that
  // included the last transaction (block timestamps, 1 s resolution).
  const chainSeconds = Number(lastBlock.timestamp - startBlock.timestamp);
  return {
    receipts,
    result: {
      n,
      submitSeconds:   +((tSubmitted - t0) / 1000).toFixed(3),
      wallSeconds:     +((t1 - t0) / 1000).toFixed(3),
      throughput_tps:  +(n / ((t1 - t0) / 1000)).toFixed(3),
      chainSeconds,
      chainThroughput_tps: chainSeconds > 0 ? +(n / chainSeconds).toFixed(3) : null,
      blocksUsed:      blocks.length,
      txPerBlock:      stats(blocks.map((b) => b.txs)),
      gasPerBlock:     stats(blocks.map((b) => b.gas)),
      gasPerTx:        stats(receipts.map((r) => Number(r.gasUsed)))
    }
  };
}

async function main() {
  const [admin] = await ethers.getSigners();
  const block = await ethers.provider.getBlock("latest");
  console.log("Network:        ", network.name);
  console.log("Block gas limit:", block.gasLimit.toString());

  const contract = await (await ethers.getContractFactory("SettlementSystem")).deploy();
  await contract.waitForDeployment();
  await (await contract.registerFarmer(admin.address)).wait();
  await (await contract.registerBuyer(admin.address)).wait();

  const all = {
    network: `${network.name} (in-process Hardhat, interval mining per hardhat.config.js)`,
    blockGasLimit: block.gasLimit.toString(),
    generatedAt: new Date().toISOString(),
    batches: {}
  };

  for (const n of BATCH_SIZES) {
    console.log(`\n${"=".repeat(60)}\nBatch ${n}: concurrent submission\n${"=".repeat(60)}`);

    const create = await sendAll(
      (i, nonce) => contract.createTransaction(admin.address, PRODUCE[i % 5], 10 + (i % 90), 1000 + (i % 9000), { nonce }),
      n, admin
    );
    const ids = create.receipts.map((r) => {
      const ev = r.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
                       .find((e) => e && e.name === "TransactionCreated");
      return ev.args[0];
    });

    const confirm = await sendAll(
      (i, nonce) => contract.confirmDelivery(ids[i], { nonce }),
      n, admin
    );

    all.batches[n] = { create: create.result, confirm: confirm.result };
    for (const [phase, r] of [["create", create.result], ["confirm", confirm.result]]) {
      console.log(`  ${phase.padEnd(8)} submit=${r.submitSeconds}s  wall=${r.wallSeconds}s  tps=${r.throughput_tps}  blocks=${r.blocksUsed}  tx/block(max)=${r.txPerBlock.max}`);
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const out = path.join(RESULTS_DIR, "exp5_concurrency_results.json");
  fs.writeFileSync(out, JSON.stringify(all, null, 2));
  console.log(`\nSaved → ${out}`);

  console.log("\n" + "=".repeat(90));
  console.log("  EXPERIMENT 5 — CONCURRENT SUBMISSION (local Hardhat chain)");
  console.log("=".repeat(90));
  printTable(
    ["Batch", "Phase", "Wall(s)", "TPS", "Blocks", "Tx/block max", "Gas/block max"],
    Object.entries(all.batches).flatMap(([n, b]) => [
      [n, "create",  b.create.wallSeconds,  b.create.throughput_tps,  b.create.blocksUsed,  b.create.txPerBlock.max,  b.create.gasPerBlock.max],
      [n, "confirm", b.confirm.wallSeconds, b.confirm.throughput_tps, b.confirm.blocksUsed, b.confirm.txPerBlock.max, b.confirm.gasPerBlock.max]
    ]),
    [7, 9, 9, 9, 8, 14, 15]
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
