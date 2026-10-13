/**
 * Experiment 3: REST API Baseline
 * Runs 100, 500, 1000 full lifecycle requests against an in-memory Express server.
 * Server is embedded in the same process to avoid spawn/port timing issues.
 * Each lifecycle = POST /transaction → POST /confirm/:txId → POST /redeem/:tokenId
 */

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const { RESULTS_DIR, stats, printTable, batchSizesFromEnv } = require("./utils");
const { createApp } = require("../src/rest_server");

const PORT        = Number(process.env.REST_PORT || 3001);
const BATCH_SIZES = batchSizesFromEnv([100, 500, 1000]);

// The server under test is the same app as src/rest_server.js (previously this
// script carried its own copy, which lacked the status checks in src/).
// Note: existing rest_baseline_results.json was produced by the older inline copy.

// ── HTTP helper (uses http module, connects to 127.0.0.1 explicitly) ──────────
function httpPost(urlPath, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = http.request(
      { hostname: "127.0.0.1", port: PORT, path: urlPath, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const app    = createApp();
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`REST server listening on http://127.0.0.1:${PORT}\n`);

  const allResults = {};

  for (const batchSize of BATCH_SIZES) {
    console.log("=".repeat(55));
    console.log(`Batch: ${batchSize} lifecycle requests`);
    console.log("=".repeat(55));

    app.resetState();

    const lifecycleMs = [], createMs = [], confirmMs = [], redeemMs = [];
    const t0_batch = Date.now();

    for (let i = 0; i < batchSize; i++) {
      const produce = ["wheat","rice","maize","soybean","barley"][i % 5];
      const price   = 1000 + (i % 9000);

      const t0 = Date.now();
      const { txId }    = await httpPost("/transaction", { farmer: "0xFarmer", produceType: produce, quantityKg: 10, agreedPriceINR: price });
      const t1 = Date.now();
      const { tokenId } = await httpPost(`/confirm/${txId}`);
      const t2 = Date.now();
      await httpPost(`/redeem/${tokenId}`);
      const t3 = Date.now();

      createMs.push(t1 - t0);
      confirmMs.push(t2 - t1);
      redeemMs.push(t3 - t2);
      lifecycleMs.push(t3 - t0);

      if ((i + 1) % 200 === 0 || i === batchSize - 1)
        process.stdout.write(`\r  Progress: ${i + 1}/${batchSize}`);
    }

    const wallSec = (Date.now() - t0_batch) / 1000;
    process.stdout.write("\n");

    const toSec = (arr) => arr.map((v) => v / 1000);
    const result = {
      batchSize,
      lifecycle_s:         stats(toSec(lifecycleMs)),
      create_s:            stats(toSec(createMs)),
      confirm_s:           stats(toSec(confirmMs)),
      redeem_s:            stats(toSec(redeemMs)),
      throughput_rps:      +(batchSize / wallSec).toFixed(2),
      wallClockSeconds:    +wallSec.toFixed(3),
      settlementCertainty: 1.0
    };

    allResults[batchSize] = result;
    console.log(`  Lifecycle:  mean=${result.lifecycle_s.mean}s  median=${result.lifecycle_s.median}s  IQR=${result.lifecycle_s.iqr}s  p95=${result.lifecycle_s.p95}s`);
    console.log(`  Throughput: ${result.throughput_rps} req/s  (wall: ${result.wallClockSeconds}s)`);
  }

  server.close();

  const outPath = path.join(RESULTS_DIR, "rest_baseline_results.json");
  fs.writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nSaved → rest_baseline_results.json`);

  console.log("\n" + "=".repeat(90));
  console.log("  EXPERIMENT 3 — REST BASELINE SUMMARY");
  console.log("=".repeat(90));
  printTable(
    ["Batch","Lat_mean(ms)","Lat_med(ms)","IQR(ms)","p95(ms)","p99(ms)","RPS","Certainty"],
    Object.values(allResults).map(r => [
      r.batchSize,
      +(r.lifecycle_s.mean   * 1000).toFixed(3),
      +(r.lifecycle_s.median * 1000).toFixed(3),
      +(r.lifecycle_s.iqr    * 1000).toFixed(3),
      +(r.lifecycle_s.p95    * 1000).toFixed(3),
      +(r.lifecycle_s.p99    * 1000).toFixed(3),
      r.throughput_rps,
      "100.0%"
    ]),
    [8, 14, 13, 10, 10, 10, 9, 10]
  );
}

main().catch(e => { console.error(e); process.exit(1); });
