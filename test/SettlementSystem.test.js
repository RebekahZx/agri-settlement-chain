const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

// hardhat.config.js sets interval mining (2 s blocks, automine off) for
// Experiment 4. Unit tests don't need realistic block times, so turn
// automine back on to keep the suite fast and deterministic.
before(async () => {
  await network.provider.send("evm_setAutomine", [true]);
});

const Status = { NONE: 0n, ACTIVE: 1n, REDEEMED: 2n, RECLAIMED: 3n };

// The same behavioural suite runs against the original contract and the
// storage-optimised one; passing both is the equivalence check.
for (const CONTRACT of ["SettlementSystem", "SettlementSystemOptimized"]) {

async function deployFixture() {
  const [admin, farmer, buyer, other] = await ethers.getSigners();
  const contract = await (await ethers.getContractFactory(CONTRACT)).deploy();
  await contract.waitForDeployment();
  return { contract, admin, farmer, buyer, other };
}

async function registeredFixture() {
  const f = await deployFixture();
  await f.contract.registerFarmer(f.farmer.address);
  await f.contract.registerBuyer(f.buyer.address);
  return f;
}

// One agreement created by `buyer` for `farmer`: txId 1.
async function createdFixture() {
  const f = await registeredFixture();
  await f.contract.connect(f.buyer).createTransaction(f.farmer.address, "wheat", 100, 5000);
  return f;
}

// Delivery confirmed: tokenId 1 is ACTIVE.
async function confirmedFixture() {
  const f = await createdFixture();
  await f.contract.confirmDelivery(1);
  return f;
}

describe(CONTRACT, function () {
  describe("deployment", function () {
    it("sets the deployer as admin and starts counters at zero", async function () {
      const { contract, admin } = await loadFixture(deployFixture);
      expect(await contract.admin()).to.equal(admin.address);
      expect(await contract.txCounter()).to.equal(0n);
      expect(await contract.tokenCounter()).to.equal(0n);
    });
  });

  describe("registration", function () {
    it("lets the admin register farmers and buyers and emits events", async function () {
      const { contract, farmer, buyer } = await loadFixture(deployFixture);
      await expect(contract.registerFarmer(farmer.address))
        .to.emit(contract, "FarmerRegistered").withArgs(farmer.address);
      await expect(contract.registerBuyer(buyer.address))
        .to.emit(contract, "BuyerRegistered").withArgs(buyer.address);
      expect(await contract.registeredFarmers(farmer.address)).to.equal(true);
      expect(await contract.registeredBuyers(buyer.address)).to.equal(true);
    });

    it("rejects registration by non-admins", async function () {
      const { contract, other } = await loadFixture(deployFixture);
      await expect(contract.connect(other).registerFarmer(other.address)).to.be.revertedWith("Not admin");
      await expect(contract.connect(other).registerBuyer(other.address)).to.be.revertedWith("Not admin");
    });

    it("rejects the zero address", async function () {
      const { contract } = await loadFixture(deployFixture);
      await expect(contract.registerFarmer(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
      await expect(contract.registerBuyer(ethers.ZeroAddress)).to.be.revertedWith("Zero address");
    });

    it("is idempotent (experiment scripts re-register without reverting)", async function () {
      const { contract, farmer } = await loadFixture(registeredFixture);
      await expect(contract.registerFarmer(farmer.address)).not.to.be.reverted;
      expect(await contract.registeredFarmers(farmer.address)).to.equal(true);
    });
  });

  describe("createTransaction", function () {
    it("stores the agreement and emits TransactionCreated", async function () {
      const { contract, farmer, buyer } = await loadFixture(registeredFixture);
      await expect(contract.connect(buyer).createTransaction(farmer.address, "rice", 25, 1200))
        .to.emit(contract, "TransactionCreated").withArgs(1n, farmer.address, buyer.address, 1200n);

      const t = await contract.getTransaction(1);
      expect(t.farmer).to.equal(farmer.address);
      expect(t.buyer).to.equal(buyer.address);
      expect(t.produceType).to.equal("rice");
      expect(t.quantityKg).to.equal(25n);
      expect(t.agreedPriceINR).to.equal(1200n);
      expect(t.deliveryConfirmed).to.equal(false);
      expect(t.agreedAt).to.be.greaterThan(0n);
      expect(t.confirmedAt).to.equal(0n);
    });

    it("assigns sequential ids", async function () {
      const { contract, farmer, buyer } = await loadFixture(registeredFixture);
      await contract.connect(buyer).createTransaction(farmer.address, "wheat", 1, 1);
      await contract.connect(buyer).createTransaction(farmer.address, "wheat", 1, 1);
      expect(await contract.txCounter()).to.equal(2n);
    });

    it("rejects callers that are not registered buyers", async function () {
      const { contract, farmer, other } = await loadFixture(registeredFixture);
      await expect(contract.connect(other).createTransaction(farmer.address, "wheat", 1, 1))
        .to.be.revertedWith("Not a registered buyer");
    });

    it("rejects unregistered farmers", async function () {
      const { contract, buyer, other } = await loadFixture(registeredFixture);
      await expect(contract.connect(buyer).createTransaction(other.address, "wheat", 1, 1))
        .to.be.revertedWith("Farmer not registered");
    });

    it("rejects zero quantity and zero price", async function () {
      const { contract, farmer, buyer } = await loadFixture(registeredFixture);
      await expect(contract.connect(buyer).createTransaction(farmer.address, "wheat", 0, 1))
        .to.be.revertedWith("Quantity must be > 0");
      await expect(contract.connect(buyer).createTransaction(farmer.address, "wheat", 1, 0))
        .to.be.revertedWith("Price must be > 0");
    });
  });

  describe("confirmDelivery", function () {
    it("marks delivery confirmed and issues an ACTIVE token for the agreed amount", async function () {
      const { contract, farmer, buyer } = await loadFixture(createdFixture);
      const tx = contract.confirmDelivery(1);
      await expect(tx).to.emit(contract, "DeliveryConfirmed");
      await expect(tx).to.emit(contract, "SettlementTokenIssued").withArgs(1n, farmer.address, 5000n);

      const t = await contract.getTransaction(1);
      expect(t.deliveryConfirmed).to.equal(true);
      expect(t.confirmedAt).to.be.greaterThan(0n);

      const tok = await contract.getToken(1);
      expect(tok.issuedAt).to.equal(t.confirmedAt);
      expect(tok.farmer).to.equal(farmer.address);
      expect(tok.buyer).to.equal(buyer.address);
      expect(tok.amountINR).to.equal(5000n);
      expect(tok.status).to.equal(Status.ACTIVE);
    });

    it("rejects non-admins", async function () {
      const { contract, buyer } = await loadFixture(createdFixture);
      await expect(contract.connect(buyer).confirmDelivery(1)).to.be.revertedWith("Not admin");
    });

    it("rejects a second confirmation of the same transaction", async function () {
      const { contract } = await loadFixture(confirmedFixture);
      await expect(contract.confirmDelivery(1)).to.be.revertedWith("Already confirmed");
      expect(await contract.tokenCounter()).to.equal(1n);
    });

    // Regression test: the original contract accepted any txId and minted an
    // ACTIVE token for address(0) with amount 0.
    it("rejects unknown transaction ids", async function () {
      const { contract } = await loadFixture(registeredFixture);
      await expect(contract.confirmDelivery(42)).to.be.revertedWith("Unknown transaction");
      expect(await contract.tokenCounter()).to.equal(0n);
    });
  });

  describe("redeemToken", function () {
    it("lets the token's farmer redeem it once", async function () {
      const { contract, farmer } = await loadFixture(confirmedFixture);
      await expect(contract.connect(farmer).redeemToken(1))
        .to.emit(contract, "SettlementTokenRedeemed").withArgs(1n, farmer.address, 5000n);
      expect((await contract.getToken(1)).status).to.equal(Status.REDEEMED);
      await expect(contract.connect(farmer).redeemToken(1)).to.be.revertedWith("Token not active");
    });

    it("rejects anyone other than the token's farmer, including the admin", async function () {
      const { contract, admin, buyer } = await loadFixture(confirmedFixture);
      await expect(contract.connect(buyer).redeemToken(1)).to.be.revertedWith("Not your token");
      await expect(contract.connect(admin).redeemToken(1)).to.be.revertedWith("Not your token");
    });

    it("rejects non-existent tokens", async function () {
      const { contract, farmer } = await loadFixture(confirmedFixture);
      await expect(contract.connect(farmer).redeemToken(99)).to.be.revertedWith("Not your token");
    });

    it("rejects redeeming a reclaimed token", async function () {
      const { contract, farmer } = await loadFixture(confirmedFixture);
      await contract.reclaimToken(1);
      await expect(contract.connect(farmer).redeemToken(1)).to.be.revertedWith("Token not active");
    });
  });

  describe("reclaimToken", function () {
    it("lets the admin reclaim an ACTIVE token", async function () {
      const { contract } = await loadFixture(confirmedFixture);
      await expect(contract.reclaimToken(1)).to.emit(contract, "SettlementTokenReclaimed").withArgs(1n);
      expect((await contract.getToken(1)).status).to.equal(Status.RECLAIMED);
    });

    it("rejects non-admins", async function () {
      const { contract, farmer } = await loadFixture(confirmedFixture);
      await expect(contract.connect(farmer).reclaimToken(1)).to.be.revertedWith("Not admin");
    });

    it("rejects reclaiming a redeemed, reclaimed or non-existent token", async function () {
      const { contract, farmer } = await loadFixture(confirmedFixture);
      await contract.connect(farmer).redeemToken(1);
      await expect(contract.reclaimToken(1)).to.be.revertedWith("Token not active");
      await expect(contract.reclaimToken(99)).to.be.revertedWith("Token not active");
    });
  });

  describe("views of unknown ids", function () {
    it("return all-zero structs", async function () {
      const { contract } = await loadFixture(registeredFixture);
      const t = await contract.getTransaction(7);
      expect(t.farmer).to.equal(ethers.ZeroAddress);
      expect(t.quantityKg).to.equal(0n);
      const tok = await contract.getToken(7);
      expect(tok.farmer).to.equal(ethers.ZeroAddress);
      expect(tok.status).to.equal(Status.NONE);
    });
  });

  describe("full lifecycle (as run by the experiment scripts)", function () {
    it("supports one account acting as admin, farmer and buyer", async function () {
      const { contract, admin } = await loadFixture(deployFixture);
      await contract.registerFarmer(admin.address);
      await contract.registerBuyer(admin.address);
      await contract.createTransaction(admin.address, "maize", 10, 1000);
      await contract.confirmDelivery(1);
      await contract.redeemToken(1);
      expect((await contract.getToken(1)).status).to.equal(Status.REDEEMED);
    });
  });
});

} // for CONTRACT
