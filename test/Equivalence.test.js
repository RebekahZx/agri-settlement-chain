// Differential test: SettlementSystem and SettlementSystemOptimized receive the
// same random sequence of calls (including invalid ones) and must agree on
// every outcome: success vs revert, the revert message, and all stored state.
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

before(async () => {
  await network.provider.send("evm_setAutomine", [true]);
});

const PRODUCE = ["wheat", "rice", "maize", "soybean", "barley", "a-very-long-produce-name-over-32-bytes"];

async function outcome(promise) {
  try {
    await (await promise).wait();
    return "ok";
  } catch (e) {
    return e.reason ?? e.shortMessage ?? String(e.message);
  }
}

async function snapshotState(c, ids) {
  const out = {
    txCounter: await c.txCounter(),
    tokenCounter: await c.tokenCounter()
  };
  for (let i = 0; i <= ids; i++) {
    const t = await c.getTransaction(i);
    const k = await c.getToken(i);
    // Timestamps differ between the two deployments (different blocks), so
    // compare "set or not" for them and exact values for everything else.
    out[`tx${i}`] = [t.farmer, t.buyer, t.produceType, t.quantityKg, t.agreedPriceINR, t.deliveryConfirmed, t.agreedAt > 0n, t.confirmedAt > 0n];
    out[`tok${i}`] = [k.farmer, k.buyer, k.amountINR, k.issuedAt > 0n, k.status];
  }
  return out;
}

describe("SettlementSystem ≡ SettlementSystemOptimized (differential)", function () {
  this.timeout(120000);

  it("agree on 300 random operations, including invalid ones", async function () {
    const [admin, farmer, buyer, stranger] = await ethers.getSigners();
    const v1 = await (await ethers.getContractFactory("SettlementSystem")).deploy();
    const v2 = await (await ethers.getContractFactory("SettlementSystemOptimized")).deploy();
    for (const c of [v1, v2]) {
      await c.registerFarmer(farmer.address);
      await c.registerBuyer(buyer.address);
    }

    let seed = 2024;
    const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 16) % n; };
    const actors = [admin, farmer, buyer, stranger];
    const seen = new Set();

    for (let step = 0; step < 300; step++) {
      const op = rand(5);
      // Usually the caller with the right role, sometimes anyone (to hit access checks).
      const rightRole = [buyer, admin, farmer, admin, admin][op];
      const who = rand(10) < 6 ? rightRole : actors[rand(actors.length)];
      const id = rand(12); // often valid, sometimes unknown (incl. 0)
      let call;
      if (op === 0) {
        const qty = rand(4) === 0 ? 0 : 1 + rand(500);
        const price = rand(4) === 0 ? 0 : 1 + rand(10000);
        const farmerAddr = rand(5) === 0 ? stranger.address : farmer.address;
        const produce = PRODUCE[rand(PRODUCE.length)];
        call = (c) => c.connect(who).createTransaction(farmerAddr, produce, qty, price);
      } else if (op === 1) {
        call = (c) => c.connect(who).confirmDelivery(id);
      } else if (op === 2) {
        call = (c) => c.connect(who).redeemToken(id);
      } else if (op === 3) {
        call = (c) => c.connect(who).reclaimToken(id);
      } else {
        // Draw inputs once, outside the callback, so both contracts get the same call.
        const addr = rand(3) === 0 ? ethers.ZeroAddress : farmer.address;
        call = (c) => c.connect(who).registerFarmer(addr);
      }

      const r1 = await outcome(call(v1));
      const r2 = await outcome(call(v2));
      expect(r2, `step ${step}, op ${op}`).to.equal(r1);
      seen.add(`${op}:${r1 === "ok" ? "ok" : "revert"}`);
    }

    expect(await snapshotState(v2, 12)).to.deep.equal(await snapshotState(v1, 12));
    // Sanity: each operation type both succeeded and reverted at least once.
    for (const op of [0, 1, 2, 3]) {
      expect(seen.has(`${op}:ok`), `op ${op} ok`).to.equal(true);
      expect(seen.has(`${op}:revert`), `op ${op} revert`).to.equal(true);
    }
  });
});
