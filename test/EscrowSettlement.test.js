const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

before(async () => {
  // hardhat.config.js uses 2 s interval mining for Experiment 4; tests don't need it.
  await network.provider.send("evm_setAutomine", [true]);
});

const A = { NONE: 0n, FUNDED: 1n, DELIVERED: 2n, CANCELLED: 3n };
const T = { NONE: 0n, ACTIVE: 1n, REDEEMED: 2n, RECLAIMED: 3n };
const PRICE = ethers.parseEther("1");

async function deployFixture() {
  const [admin, farmer, buyer, other] = await ethers.getSigners();
  const escrow = await (await ethers.getContractFactory("EscrowSettlement")).deploy();
  await escrow.waitForDeployment();
  await escrow.registerFarmer(farmer.address);
  await escrow.registerBuyer(buyer.address);
  return { escrow, admin, farmer, buyer, other };
}

async function fundedFixture() {
  const f = await deployFixture();
  await f.escrow.connect(f.buyer).createAgreement(f.farmer.address, "wheat", 100, { value: PRICE });
  return f;
}

async function deliveredFixture() {
  const f = await fundedFixture();
  await f.escrow.confirmDelivery(1);
  return f;
}

// The contract's accounting must always cover exactly the ETH it holds.
async function expectSolvent(escrow) {
  const bal = await ethers.provider.getBalance(await escrow.getAddress());
  expect(bal).to.equal((await escrow.totalEscrowed()) + (await escrow.totalOwed()));
}

describe("EscrowSettlement (v2)", function () {
  describe("registration", function () {
    it("is admin-only and rejects the zero address", async function () {
      const { escrow, other } = await loadFixture(deployFixture);
      await expect(escrow.connect(other).registerFarmer(other.address)).to.be.revertedWith("Not admin");
      await expect(escrow.registerBuyer(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });
  });

  describe("createAgreement", function () {
    it("escrows msg.value and records the agreement", async function () {
      const { escrow, farmer, buyer } = await loadFixture(deployFixture);
      const tx = escrow.connect(buyer).createAgreement(farmer.address, "rice", 25, { value: PRICE });
      await expect(tx).to.emit(escrow, "AgreementFunded").withArgs(1n, farmer.address, buyer.address, PRICE);
      await expect(tx).to.changeEtherBalances([buyer, escrow], [-PRICE, PRICE]);

      const a = await escrow.getAgreement(1);
      expect(a.farmer).to.equal(farmer.address);
      expect(a.buyer).to.equal(buyer.address);
      expect(a.produceType).to.equal("rice");
      expect(a.quantityKg).to.equal(25n);
      expect(a.priceWei).to.equal(PRICE);
      expect(a.status).to.equal(A.FUNDED);
      expect(await escrow.totalEscrowed()).to.equal(PRICE);
      await expectSolvent(escrow);
    });

    it("rejects unregistered buyers/farmers, zero quantity and zero payment", async function () {
      const { escrow, farmer, buyer, other } = await loadFixture(deployFixture);
      await expect(escrow.connect(other).createAgreement(farmer.address, "w", 1, { value: 1 }))
        .to.be.revertedWith("Not a registered buyer");
      await expect(escrow.connect(buyer).createAgreement(other.address, "w", 1, { value: 1 }))
        .to.be.revertedWith("Farmer not registered");
      await expect(escrow.connect(buyer).createAgreement(farmer.address, "w", 0, { value: 1 }))
        .to.be.revertedWith("Quantity must be > 0");
      await expect(escrow.connect(buyer).createAgreement(farmer.address, "w", 1, { value: 0 }))
        .to.be.revertedWith("Price must be > 0");
    });
  });

  describe("cancelAgreement", function () {
    it("lets the buyer cancel before delivery and credits a refund", async function () {
      const { escrow, buyer } = await loadFixture(fundedFixture);
      await expect(escrow.connect(buyer).cancelAgreement(1))
        .to.emit(escrow, "AgreementCancelled").withArgs(1n, buyer.address);
      expect((await escrow.getAgreement(1)).status).to.equal(A.CANCELLED);
      expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(PRICE);
      expect(await escrow.totalEscrowed()).to.equal(0n);
      await expectSolvent(escrow);
    });

    it("lets the admin cancel; refund still goes to the buyer", async function () {
      const { escrow, admin, buyer } = await loadFixture(fundedFixture);
      await escrow.connect(admin).cancelAgreement(1);
      expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(PRICE);
      expect(await escrow.pendingWithdrawals(admin.address)).to.equal(0n);
    });

    it("rejects the farmer, other accounts, double cancel and cancel after delivery", async function () {
      const { escrow, farmer, buyer, other } = await loadFixture(fundedFixture);
      await expect(escrow.connect(farmer).cancelAgreement(1)).to.be.revertedWith("Not buyer or admin");
      await expect(escrow.connect(other).cancelAgreement(1)).to.be.revertedWith("Not buyer or admin");
      await escrow.connect(buyer).cancelAgreement(1);
      await expect(escrow.connect(buyer).cancelAgreement(1)).to.be.revertedWith("Not cancellable");

      await escrow.connect(buyer).createAgreement(farmer.address, "wheat", 1, { value: PRICE });
      await escrow.confirmDelivery(2);
      await expect(escrow.connect(buyer).cancelAgreement(2)).to.be.revertedWith("Not cancellable");
      await expect(escrow.cancelAgreement(99)).to.be.revertedWith("Not cancellable");
    });
  });

  describe("confirmDelivery", function () {
    it("issues an ACTIVE token for the escrowed amount", async function () {
      const { escrow, farmer, buyer } = await loadFixture(fundedFixture);
      await expect(escrow.confirmDelivery(1)).to.emit(escrow, "DeliveryConfirmed").withArgs(1n, 1n);
      const t = await escrow.getToken(1);
      expect(t.agreementId).to.equal(1n);
      expect(t.farmer).to.equal(farmer.address);
      expect(t.buyer).to.equal(buyer.address);
      expect(t.amountWei).to.equal(PRICE);
      expect(t.status).to.equal(T.ACTIVE);
      expect((await escrow.getAgreement(1)).status).to.equal(A.DELIVERED);
      expect(await escrow.totalEscrowed()).to.equal(PRICE); // still locked until settled
    });

    it("rejects non-admins, unknown ids, repeats and cancelled agreements", async function () {
      const { escrow, buyer, farmer } = await loadFixture(fundedFixture);
      await expect(escrow.connect(buyer).confirmDelivery(1)).to.be.revertedWith("Not admin");
      await expect(escrow.confirmDelivery(42)).to.be.revertedWith("Not awaiting delivery");
      await escrow.confirmDelivery(1);
      await expect(escrow.confirmDelivery(1)).to.be.revertedWith("Not awaiting delivery");

      await escrow.connect(buyer).createAgreement(farmer.address, "wheat", 1, { value: PRICE });
      await escrow.connect(buyer).cancelAgreement(2);
      await expect(escrow.confirmDelivery(2)).to.be.revertedWith("Not awaiting delivery");
    });
  });

  describe("redeem / reclaim", function () {
    it("redeem credits the farmer, who can withdraw exactly once", async function () {
      const { escrow, farmer } = await loadFixture(deliveredFixture);
      await expect(escrow.connect(farmer).redeemToken(1))
        .to.emit(escrow, "TokenRedeemed").withArgs(1n, farmer.address, PRICE);
      expect(await escrow.pendingWithdrawals(farmer.address)).to.equal(PRICE);
      await expectSolvent(escrow);

      await expect(escrow.connect(farmer).withdraw())
        .to.changeEtherBalances([farmer, escrow], [PRICE, -PRICE]);
      await expect(escrow.connect(farmer).withdraw()).to.be.revertedWith("Nothing to withdraw");
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
      await expectSolvent(escrow);
    });

    it("reclaim (dispute) refunds the buyer, not the farmer", async function () {
      const { escrow, farmer, buyer } = await loadFixture(deliveredFixture);
      await expect(escrow.reclaimToken(1))
        .to.emit(escrow, "TokenReclaimed").withArgs(1n, buyer.address, PRICE);
      expect(await escrow.pendingWithdrawals(buyer.address)).to.equal(PRICE);
      expect(await escrow.pendingWithdrawals(farmer.address)).to.equal(0n);
      await expect(escrow.connect(buyer).withdraw()).to.changeEtherBalance(buyer, PRICE);
    });

    it("enforces who may redeem/reclaim and that a token settles only once", async function () {
      const { escrow, farmer, buyer } = await loadFixture(deliveredFixture);
      await expect(escrow.connect(buyer).redeemToken(1)).to.be.revertedWith("Not your token");
      await expect(escrow.connect(farmer).reclaimToken(1)).to.be.revertedWith("Not admin");
      await escrow.connect(farmer).redeemToken(1);
      await expect(escrow.connect(farmer).redeemToken(1)).to.be.revertedWith("Token not active");
      await expect(escrow.reclaimToken(1)).to.be.revertedWith("Token not active");
      await expect(escrow.reclaimToken(99)).to.be.revertedWith("Token not active");
    });
  });

  describe("withdrawal safety", function () {
    it("a re-entrant buyer is paid exactly once", async function () {
      const { escrow, admin, farmer } = await loadFixture(deployFixture);
      const attacker = await (await ethers.getContractFactory("ReentrantBuyer")).deploy(await escrow.getAddress());
      await escrow.connect(admin).registerBuyer(await attacker.getAddress());

      // A second, honest agreement keeps extra ETH in the contract for the attacker to target.
      await escrow.connect(admin).registerBuyer(admin.address);
      await escrow.connect(admin).createAgreement(farmer.address, "maize", 1, { value: PRICE });

      await attacker.create(farmer.address, { value: PRICE });
      await attacker.cancel(2);

      await expect(attacker.attackWithdraw()).to.changeEtherBalance(attacker, PRICE);
      expect(await attacker.reentryAttempts()).to.equal(1n);
      expect(await attacker.reentrySuccesses()).to.equal(0n);
      expect(await escrow.pendingWithdrawals(await attacker.getAddress())).to.equal(0n);
      // The honest buyer's escrow is untouched.
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(PRICE);
      await expectSolvent(escrow);
    });

    it("a failed transfer reverts and leaves the amount claimable", async function () {
      const { escrow, admin, farmer } = await loadFixture(deployFixture);
      const rejecting = await (await ethers.getContractFactory("RejectingBuyer")).deploy(await escrow.getAddress());
      await escrow.connect(admin).registerBuyer(await rejecting.getAddress());
      await rejecting.create(farmer.address, { value: PRICE });
      await rejecting.cancel(1);

      await expect(rejecting.tryWithdraw()).to.be.revertedWith("Transfer failed");
      expect(await escrow.pendingWithdrawals(await rejecting.getAddress())).to.equal(PRICE);
      await expectSolvent(escrow);
    });
  });

  describe("accounting invariant under a random operation sequence", function () {
    it("balance == totalEscrowed + totalOwed after every step (200 steps, fixed seed)", async function () {
      const { escrow, admin, farmer, buyer } = await loadFixture(deployFixture);
      let seed = 12345;
      // LCG; use the high bits (the low bits of this generator cycle with a short period).
      const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed >>> 16) % n; };

      const funded = new Set();   // agreement ids in FUNDED
      const active = new Set();   // token ids ACTIVE
      const pick = (s) => [...s][rand(s.size)];
      const counts = { create: 0, cancel: 0, confirm: 0, redeem: 0, reclaim: 0, withdraw: 0 };

      for (let step = 0; step < 200; step++) {
        const op = rand(6);
        if (op === 0 || funded.size + active.size === 0) {
          const value = BigInt(1 + rand(1000)) * 10n ** 12n;
          await escrow.connect(buyer).createAgreement(farmer.address, "wheat", 1 + rand(50), { value });
          funded.add(Number(await escrow.agreementCounter())); counts.create++;
        } else if (op === 1 && funded.size) {
          const id = pick(funded); funded.delete(id);
          await escrow.connect(rand(2) ? buyer : admin).cancelAgreement(id); counts.cancel++;
        } else if (op === 2 && funded.size) {
          const id = pick(funded); funded.delete(id);
          await escrow.confirmDelivery(id);
          active.add(Number(await escrow.tokenCounter())); counts.confirm++;
        } else if (op === 3 && active.size) {
          const id = pick(active); active.delete(id);
          await escrow.connect(farmer).redeemToken(id); counts.redeem++;
        } else if (op === 4 && active.size) {
          const id = pick(active); active.delete(id);
          await escrow.reclaimToken(id); counts.reclaim++;
        } else if (op === 5) {
          const who = rand(2) ? farmer : buyer;
          if ((await escrow.pendingWithdrawals(who.address)) > 0n) {
            await escrow.connect(who).withdraw(); counts.withdraw++;
          }
        }
        await expectSolvent(escrow);
      }
      // Sanity: every operation type was actually exercised.
      for (const [k, v] of Object.entries(counts)) expect(v, k).to.be.greaterThan(0);
    });
  });
});
