/**
 * Gas comparison: original vs current vs storage-optimised contract
 * ------------------------------------------------------------------
 * Run: npx hardhat run scripts/gas_comparison.js
 *
 * Gas used by a transaction is deterministic for a given contract, input and
 * EVM version, so unlike latency it can be measured on a local chain and
 * carried over to any EVM chain with the same gas schedule.
 *
 * For each contract it runs the same workload as the Sepolia experiments:
 *   - one warm-up lifecycle (not measured), so storage counters are already
 *     non-zero, as they were on Sepolia after earlier runs
 *   - N lifecycles: createTransaction(admin, PRODUCE[i%5], 10+i%90, 1000+i%9000)
 *     → confirmDelivery → redeemToken (even i) or reclaimToken (odd i)
 *
 * Contracts:
 *   SettlementSystemV0         original source, as deployed to Sepolia
 *   SettlementSystem           current v1 (adds input validation)
 *   SettlementSystemOptimized  same behaviour, packed storage
 *
 * Validation: V0's local means are compared with the stored Sepolia means
 * (results/full_latency_results.json batch 100, failure_dispute_results.json).
 *
 * Output: results/gas_comparison.json (or $RESULTS_DIR).
 */

const { ethers, network, config } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR, stats, printTable } = require("./utils");

const N        = Number(process.env.GAS_N || 100);
const PRODUCE  = ["wheat", "rice", "maize", "soybean", "barley"];
const CONTRACTS = ["SettlementSystemV0", "SettlementSystem", "SettlementSystemOptimized"];

async function gas(txPromise) {
  return Number((await (await txPromise).wait()).gasUsed);
}

async function measure(name, admin) {
  const Factory = await ethers.getContractFactory(name);
  const c = await Factory.deploy();
  const deployGas = Number((await c.deploymentTransaction().wait()).gasUsed);
  await (await c.registerFarmer(admin.address)).wait();
  await (await c.registerBuyer(admin.address)).wait();

  // Warm-up lifecycle (not measured).
  await (await c.createTransaction(admin.address, "wheat", 1, 1)).wait();
  await (await c.confirmDelivery(1)).wait();
  await (await c.redeemToken(1)).wait();

  const g = { create: [], confirm: [], redeem: [], reclaim: [] };
  for (let i = 0; i < N; i++) {
    g.create.push(await gas(c.createTransaction(admin.address, PRODUCE[i % 5], 10 + (i % 90), 1000 + (i % 9000))));
    const txId = Number(await c.txCounter());
    g.confirm.push(await gas(c.confirmDelivery(txId)));
    const tokenId = Number(await c.tokenCounter());
    if (i % 2 === 0) g.redeem.push(await gas(c.redeemToken(tokenId)));
    else             g.reclaim.push(await gas(c.reclaimToken(tokenId)));
  }

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  return {
    deployGas,
    perCall: {
      createTransaction: stats(g.create),
      confirmDelivery:   stats(g.confirm),
      redeemToken:       stats(g.redeem),
      reclaimToken:      stats(g.reclaim)
    },
    lifecycleRedeemMean:  Math.round(mean(g.create) + mean(g.confirm) + mean(g.redeem)),
    lifecycleReclaimMean: Math.round(mean(g.create) + mean(g.confirm) + mean(g.reclaim))
  };
}

function loadJSON(name) {
  const p = path.join(RESULTS_DIR, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p)) : null;
}

async function main() {
  await network.provider.send("evm_setAutomine", [true]);
  const [admin] = await ethers.getSigners();

  const out = {
    generatedAt: new Date().toISOString(),
    environment: {
      network: network.name,
      hardfork: config.networks.hardhat.hardfork,
      solc: config.solidity.compilers[0].version,
      optimizer: config.solidity.compilers[0].settings.optimizer
    },
    lifecyclesPerContract: N,
    contracts: {}
  };

  for (const name of CONTRACTS) {
    console.log(`Measuring ${name} (${N} lifecycles)...`);
    out.contracts[name] = await measure(name, admin);
  }

  // Validation against stored Sepolia measurements (original contract).
  const e1 = loadJSON("full_latency_results.json");
  const e2 = loadJSON("failure_dispute_results.json");
  if (e1?.["100"] && e2?.happyPath && e2?.disputePath) {
    const v0 = out.contracts.SettlementSystemV0.perCall;
    const rows = [
      ["createTransaction", v0.createTransaction.mean, e1["100"].createGas.mean],
      ["confirmDelivery",   v0.confirmDelivery.mean,   e1["100"].confirmGas.mean],
      ["redeemToken",       v0.redeemToken.mean,       e2.happyPath.finalGas.mean],
      ["reclaimToken",      v0.reclaimToken.mean,      e2.disputePath.finalGas.mean]
    ];
    out.validationAgainstSepolia = rows.map(([fn, local, sepolia]) => ({
      function: fn,
      localMean: local,
      sepoliaMean: sepolia,
      differencePct: +(((local - sepolia) / sepolia) * 100).toFixed(3)
    }));
  }

  const base = out.contracts.SettlementSystem;
  const opt  = out.contracts.SettlementSystemOptimized;
  const pct  = (a, b) => +(((b - a) / a) * 100).toFixed(2);
  out.optimizedVsCurrent = {
    createTransaction: pct(base.perCall.createTransaction.mean, opt.perCall.createTransaction.mean),
    confirmDelivery:   pct(base.perCall.confirmDelivery.mean,   opt.perCall.confirmDelivery.mean),
    redeemToken:       pct(base.perCall.redeemToken.mean,       opt.perCall.redeemToken.mean),
    reclaimToken:      pct(base.perCall.reclaimToken.mean,      opt.perCall.reclaimToken.mean),
    lifecycleRedeem:   pct(base.lifecycleRedeemMean,            opt.lifecycleRedeemMean),
    lifecycleReclaim:  pct(base.lifecycleReclaimMean,           opt.lifecycleReclaimMean),
    deploy:            pct(base.deployGas,                      opt.deployGas)
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, "gas_comparison.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${outPath}\n`);

  printTable(
    ["Contract", "create", "confirm", "redeem", "reclaim", "lifecycle(redeem)", "deploy"],
    CONTRACTS.map((n) => {
      const r = out.contracts[n];
      return [n, Math.round(r.perCall.createTransaction.mean), Math.round(r.perCall.confirmDelivery.mean),
              Math.round(r.perCall.redeemToken.mean), Math.round(r.perCall.reclaimToken.mean),
              r.lifecycleRedeemMean, r.deployGas];
    }),
    [27, 9, 9, 8, 9, 19, 9]
  );
  console.log("\nOptimized vs current (% change):", out.optimizedVsCurrent);
  if (out.validationAgainstSepolia) {
    console.log("\nOriginal contract, local vs stored Sepolia means:");
    for (const v of out.validationAgainstSepolia) {
      console.log(`  ${v.function.padEnd(18)} local=${v.localMean}  sepolia=${v.sepoliaMean}  diff=${v.differencePct}%`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
