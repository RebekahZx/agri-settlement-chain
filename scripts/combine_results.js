/**
 * Combine all experiment results → combined_results.json
 * Fetch live ETH price and compute cost analysis → cost_analysis.json
 * Print final comparison table.
 *
 * Run: node scripts/combine_results.js
 */

const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR, printTable } = require("./utils");

const ROOT = RESULTS_DIR;

// ── Load result files ─────────────────────────────────────────────────────────
function loadJSON(filename) {
  const p = path.join(ROOT, filename);
  if (!fs.existsSync(p)) {
    console.warn(`  ⚠  ${filename} not found — skipping`);
    return null;
  }
  return JSON.parse(fs.readFileSync(p));
}

// ── ETH price ─────────────────────────────────────────────────────────────────
// Reproducibility: set ETH_PRICE_USD to pin the price (e.g. to the value stored
// in an existing cost_analysis.json). Otherwise a live price is fetched and its
// source and timestamp are recorded. There is no silent hard-coded fallback:
// previously a made-up $3000 was used without being flagged in the output.
async function getEthPrice() {
  const fetchedAt = new Date().toISOString();
  if (process.env.ETH_PRICE_USD) {
    const price = Number(process.env.ETH_PRICE_USD);
    if (!Number.isFinite(price) || price <= 0) throw new Error("ETH_PRICE_USD must be a positive number");
    console.log(`  ETH price: $${price} USD (pinned via ETH_PRICE_USD)`);
    return { price, source: "ETH_PRICE_USD (pinned)", fetchedAt };
  }
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const json = await res.json();
    const price = json?.ethereum?.usd;
    if (price) { console.log(`  ETH price: $${price} USD (CoinGecko)`); return { price, source: "CoinGecko", fetchedAt }; }
  } catch (e) {
    console.warn("  CoinGecko fetch failed:", e.message);
  }
  try {
    const res  = await fetch("https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD");
    const json = await res.json();
    if (json?.USD) { console.log(`  ETH price: $${json.USD} USD (CryptoCompare)`); return { price: json.USD, source: "CryptoCompare", fetchedAt }; }
  } catch {}
  throw new Error("Could not fetch an ETH price. Re-run with ETH_PRICE_USD=<price> to pin one explicitly.");
}

// ── Cost calculations ─────────────────────────────────────────────────────────
function computeCost(gasUnits, gasPriceGwei, ethPriceUSD) {
  const ethCost = (gasUnits * gasPriceGwei * 1e-9);   // ETH
  const usdCost = ethCost * ethPriceUSD;
  return { ethCost: +ethCost.toFixed(8), usdCost: +usdCost.toFixed(6) };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\nLoading result files...");
  const exp1 = loadJSON("full_latency_results.json");
  const exp2 = loadJSON("failure_dispute_results.json");
  const exp3 = loadJSON("rest_baseline_results.json");
  const exp4 = loadJSON("besu_results.json");

  console.log("\nGetting ETH/USD price...");
  const { price: ethPriceUSD, source: ethPriceSource, fetchedAt: ethPriceFetchedAt } = await getEthPrice();

  const inrPerUSD = Number(process.env.INR_PER_USD || 83.5);
  const INR_TO_USD = 1 / inrPerUSD;

  // ── Cost analysis ───────────────────────────────────────────────────────────
  console.log("\nComputing cost analysis...");

  // Sepolia gas data comes only from measured results (Exp 1 batch 100 and
  // Exp 2 happy path). Previously, missing data was silently replaced with
  // hard-coded estimates (130000 / 30000 gas, 3 gwei); now it is an error.
  const b100 = exp1?.["100"];
  const sepoliaCreateGas    = b100?.createGas?.mean;
  const sepoliaConfirmGas   = b100?.confirmGas?.mean;
  const sepoliaGasPriceGwei = b100?.avgGasPrice_gwei;
  const sepoliaRedeemGas    = exp2?.happyPath?.finalGas?.mean;

  const missing = Object.entries({
    "full_latency_results.json[100].createGas.mean":  sepoliaCreateGas,
    "full_latency_results.json[100].confirmGas.mean": sepoliaConfirmGas,
    "full_latency_results.json[100].avgGasPrice_gwei": sepoliaGasPriceGwei,
    "failure_dispute_results.json.happyPath.finalGas.mean": sepoliaRedeemGas
  }).filter(([, v]) => typeof v !== "number").map(([k]) => k);
  if (missing.length) {
    throw new Error(`Cannot compute Sepolia cost; missing measured values:\n  ${missing.join("\n  ")}`);
  }

  // Full lifecycle gas (createTx + confirmDelivery + redeemToken)
  const sepoliaLifecycleGas = Math.round(sepoliaCreateGas) + Math.round(sepoliaConfirmGas) + Math.round(sepoliaRedeemGas);

  const sepoliaCost = computeCost(sepoliaLifecycleGas, sepoliaGasPriceGwei, ethPriceUSD);

  // Besu: gas is charged on private network (configurable). On a private network,
  // min-gas-price is typically 0, so effective cost to users = $0. We record gas units
  // for informational purposes only.
  const besuCostUSD = 0;

  // REST: no blockchain, no gas cost
  const restCostUSD = 0;

  // Traditional banking comparison (India) — published fee schedules, not measured.
  const neftCostINR = 2.5;
  const neftCostUSD = +(neftCostINR * INR_TO_USD).toFixed(6);
  const upiCostINR  = 0;
  const upiCostUSD  = 0;

  const costAnalysis = {
    ethPriceUSD,
    ethPriceSource,
    ethPriceFetchedAt,
    inrPerUSD,
    sepoliaTestnet: {
      note: "Sepolia testnet — gas units are measured; the gas price is the Sepolia testnet price, so ETH/USD/INR figures are illustrative, not a mainnet cost estimate",
      createGas:         Math.round(sepoliaCreateGas),
      confirmGas:        Math.round(sepoliaConfirmGas),
      redeemGas:         Math.round(sepoliaRedeemGas),
      lifecycleGas:      sepoliaLifecycleGas,
      gasPriceGwei:      sepoliaGasPriceGwei,
      lifecycleETH:      sepoliaCost.ethCost,
      lifecycleUSD:      sepoliaCost.usdCost,
      lifecycleINR:      +(sepoliaCost.usdCost * inrPerUSD).toFixed(4)
    },
    besuPrivateNetwork: {
      note: "Private Besu consortium — min-gas-price=0, no token cost to participants",
      lifecycleGas:  sepoliaLifecycleGas,  // same EVM bytecode = same gas units
      gasPriceGwei:  0,
      lifecycleETH:  0,
      lifecycleUSD:  besuCostUSD,
      lifecycleINR:  0,
      infrastructureCostNote: "Infrastructure/cloud costs apply (out of scope)"
    },
    restAPIBaseline: {
      note: "In-memory REST API — no blockchain, no transaction fees",
      lifecycleUSD: restCostUSD,
      lifecycleINR: 0
    },
    traditionalPayments: {
      NEFT: {
        costINR: neftCostINR,
        costUSD: neftCostUSD,
        note: "Flat ₹2.5 per transfer (NPCI schedule of charges)"
      },
      RTGS: {
        costINR: 25,
        costUSD: +(25 * INR_TO_USD).toFixed(4),
        note: "₹25 per transfer for amounts ≥ ₹2 lakh"
      },
      UPI: {
        costINR: upiCostINR,
        costUSD: upiCostUSD,
        note: "Free for users; merchant MDR applicable"
      }
    }
  };

  // ── Combined results ────────────────────────────────────────────────────────
  const combined = {
    generatedAt: new Date().toISOString(),
    ethPriceUSD,
    ethPriceSource,
    experiments: {
      exp1_sepoliaFullLatency:   exp1,
      exp2_failureDispute:       exp2,
      exp3_restBaseline:         exp3,
      exp4_besuLocal:            exp4
    },
    costAnalysis
  };

  fs.writeFileSync(path.join(ROOT, "combined_results.json"), JSON.stringify(combined, null, 2));
  fs.writeFileSync(path.join(ROOT, "cost_analysis.json"), JSON.stringify(costAnalysis, null, 2));

  console.log("Saved → combined_results.json");
  console.log("Saved → cost_analysis.json\n");

  // ── Print comparison table ──────────────────────────────────────────────────
  function getRow(label, data, batchKey) {
    if (!data) return [label, "—", "—", "—", "—", "—", "—", "—"];
    const d = data[batchKey] ?? Object.values(data)[0];
    if (!d) return [label, "—", "—", "—", "—", "—", "—", "—"];

    const lat = d.settlementLatency_s ?? d.lifecycle_s;
    const gas = d.confirmGas ?? d.createGas ?? {};
    const tps = d.throughput_tps ?? d.throughput_rps ?? "—";
    const cert = ((d.settlementCertainty ?? 1) * 100).toFixed(1) + "%";

    return [
      label,
      lat?.median  ?? "—",
      lat?.iqr     ?? "—",
      lat?.p95     ?? "—",
      Math.round(gas?.mean ?? 0) || "—",
      tps,
      cert
    ];
  }

  const BATCHES = ["100", "500", "1000"];

  for (const b of BATCHES) {
    console.log("=".repeat(100));
    console.log(`  COMBINED COMPARISON TABLE  —  Batch ${b}`);
    console.log("=".repeat(100));
    printTable(
      ["System", "Median_lat(s)†", "IQR(s)", "p95(s)", "ConfirmGas", "TPS/RPS", "Certainty"],
      [
        getRow("Sepolia (Exp 1)",  exp1, b),
        getRow("Besu local (Exp 4)", exp4, b),
        [
          "REST baseline (Exp 3)",
          exp3?.[b]?.lifecycle_s?.median   ?? "—",
          exp3?.[b]?.lifecycle_s?.iqr      ?? "—",
          exp3?.[b]?.lifecycle_s?.p95      ?? "—",
          "N/A",
          exp3?.[b]?.throughput_rps        ?? "—",
          "100.0%"
        ]
      ],
      [23, 14, 10, 10, 11, 10, 10]
    );
    console.log("  † Blockchain rows: settlement latency (createTx confirmed → confirmDelivery confirmed).");
    console.log("    REST row: full create→confirm→redeem request lifecycle. Not the same interval.");
    console.log("  Sepolia batches 500/1000 are 75/50-tx samples; no extrapolation is computed.\n");
  }

  // Cost table
  console.log("=".repeat(85));
  console.log("  COST PER SETTLEMENT LIFECYCLE");
  console.log("=".repeat(85));
  const ca = costAnalysis;
  printTable(
    ["Method", "Gas (units)", "Gas Price", "ETH cost", "USD cost", "INR cost"],
    [
      ["Sepolia (Ethereum)", ca.sepoliaTestnet.lifecycleGas, `${ca.sepoliaTestnet.gasPriceGwei} gwei`,
       `${ca.sepoliaTestnet.lifecycleETH} ETH`, `$${ca.sepoliaTestnet.lifecycleUSD}`,
       `₹${ca.sepoliaTestnet.lifecycleINR}`],
      ["Besu private chain", ca.besuPrivateNetwork.lifecycleGas, "0 gwei (free)", "0 ETH", "$0.000000", "₹0.00"],
      ["REST API",           "N/A",                              "N/A",           "N/A",   "$0.000000", "₹0.00"],
      ["NEFT bank transfer", "N/A",                              "N/A",           "N/A",   `$${ca.traditionalPayments.NEFT.costUSD}`, `₹${ca.traditionalPayments.NEFT.costINR}`],
      ["RTGS bank transfer", "N/A",                              "N/A",           "N/A",   `$${ca.traditionalPayments.RTGS.costUSD}`, `₹${ca.traditionalPayments.RTGS.costINR}`],
      ["UPI transfer",       "N/A",                              "N/A",           "N/A",   "$0.000000", "₹0.00"]
    ],
    [22, 14, 18, 16, 12, 14]
  );
  console.log("\n  ETH price used:", `$${ethPriceUSD} (${ethPriceSource}, ${ethPriceFetchedAt})  |  INR/USD: ${inrPerUSD}`);
}

main().catch(e => { console.error(e); process.exit(1); });
