// Shared utilities for all experiment scripts

const path = require("path");

// All experiment inputs/outputs (deployment info, results) live in results/.
// Override with RESULTS_DIR=/some/dir to avoid overwriting the stored results.
const RESULTS_DIR = process.env.RESULTS_DIR
  ? path.resolve(process.env.RESULTS_DIR)
  : path.join(__dirname, "..", "results");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stats(values) {
  if (!values || values.length === 0) return {};
  const sorted = [...values].sort((a, b) => a - b);
  const n    = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const q1   = percentile(sorted, 25);
  const q3   = percentile(sorted, 75);
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return {
    n,
    mean:   round(mean),
    median: round(percentile(sorted, 50)),
    q1:     round(q1),
    q3:     round(q3),
    iqr:    round(q3 - q1),
    stddev: round(Math.sqrt(variance)),
    min:    round(sorted[0]),
    max:    round(sorted[n - 1]),
    p95:    round(percentile(sorted, 95)),
    p99:    round(percentile(sorted, 99))
  };
}

function round(v, decimals = 4) {
  return +v.toFixed(decimals);
}

function printTable(headers, rows, widths) {
  const seg  = (j) => widths.map(w => "─".repeat(w)).join(j);
  const head = headers.map((h, i) => h.padEnd(widths[i])).join("│");
  console.log("┌" + seg("┬") + "┐");
  console.log("│" + head + "│");
  console.log("├" + seg("┼") + "┤");
  for (const row of rows) {
    console.log("│" + row.map((c, i) => String(c).padEnd(widths[i])).join("│") + "│");
  }
  console.log("└" + seg("┴") + "┘");
}

// Optional override for quick smoke runs, e.g. BATCH_SIZES=10,20.
// Defaults are the batch sizes used for the reported results.
function batchSizesFromEnv(defaults) {
  const raw = process.env.BATCH_SIZES;
  if (!raw) return defaults;
  const sizes = raw.split(",").map((s) => Number(s.trim()));
  if (sizes.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`BATCH_SIZES must be comma-separated positive integers, got "${raw}"`);
  }
  return sizes;
}

// Which contract the deploy/experiment scripts use. Default is the v1 contract
// the stored results were measured with; set CONTRACT=SettlementSystemOptimized
// (together with a separate RESULTS_DIR) to measure the optimised version.
const CONTRACTS = ["SettlementSystem", "SettlementSystemOptimized", "SettlementSystemV0"];
const CONTRACT = process.env.CONTRACT || "SettlementSystem";
if (!CONTRACTS.includes(CONTRACT)) {
  throw new Error(`CONTRACT must be one of ${CONTRACTS.join(", ")}, got "${CONTRACT}"`);
}

// Refuse to overwrite stored results unless OVERWRITE=1 is set.
function guardOverwrite(filePath) {
  const fs = require("fs");
  if (fs.existsSync(filePath) && process.env.OVERWRITE !== "1") {
    throw new Error(
      `${filePath} already exists. Use a different RESULTS_DIR (recommended) or set OVERWRITE=1.`
    );
  }
}

module.exports = { guardOverwrite, CONTRACT, RESULTS_DIR, sleep, stats, percentile, round, printTable, batchSizesFromEnv };
