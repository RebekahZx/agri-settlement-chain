/**
 * REST Settlement API — in-memory, no persistence.
 * Mirrors the SettlementSystem.sol contract lifecycle:
 *   POST /transaction          → create (returns txId)
 *   POST /confirm/:txId        → admin confirms delivery (returns tokenId)
 *   POST /redeem/:tokenId      → farmer redeems token
 *   POST /reclaim/:tokenId     → admin reclaims (dispute)
 *
 * This is a deliberately minimal baseline: no authentication, no persistence,
 * no consensus. It is used only to measure the cost of the same lifecycle
 * without a blockchain (Experiment 3).
 *
 * Usage: node src/rest_server.js [port]
 * Library use: const { createApp } = require("./src/rest_server");
 */

const express = require("express");

function createApp() {
  const app = express();
  app.use(express.json());

  let transactions = {};
  let tokens = {};
  let txCounter = 0;
  let tokenCounter = 0;

  function resetState() {
    transactions = {};
    tokens = {};
    txCounter = 0;
    tokenCounter = 0;
  }

  // Reset state (for repeated test runs)
  app.post("/reset", (_req, res) => {
    resetState();
    res.json({ ok: true });
  });

  // Create transaction
  app.post("/transaction", (req, res) => {
    const { farmer = "0xFarmer", produceType = "wheat", quantityKg = 10, agreedPriceINR = 5000 } = req.body || {};
    const txId = ++txCounter;
    transactions[txId] = {
      id: txId,
      farmer,
      buyer: "0xBuyer",
      produceType,
      quantityKg,
      agreedPriceINR,
      status: "PENDING",
      createdAt: Date.now()
    };
    res.json({ txId, status: "PENDING" });
  });

  // Confirm delivery → issues settlement token
  app.post("/confirm/:txId", (req, res) => {
    const txId = parseInt(req.params.txId, 10);
    const tx = transactions[txId];
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    if (tx.status !== "PENDING") return res.status(400).json({ error: "Already processed" });

    tx.status = "CONFIRMED";
    tx.confirmedAt = Date.now();

    const tokenId = ++tokenCounter;
    tokens[tokenId] = {
      id: tokenId,
      txId,
      farmer: tx.farmer,
      amountINR: tx.agreedPriceINR,
      status: "ACTIVE",
      issuedAt: Date.now()
    };

    res.json({ tokenId, status: "ACTIVE" });
  });

  // Redeem token (farmer)
  app.post("/redeem/:tokenId", (req, res) => {
    const tokenId = parseInt(req.params.tokenId, 10);
    const tok = tokens[tokenId];
    if (!tok) return res.status(404).json({ error: "Token not found" });
    if (tok.status !== "ACTIVE") return res.status(400).json({ error: "Token not active" });

    tok.status = "REDEEMED";
    tok.redeemedAt = Date.now();

    res.json({ tokenId, status: "REDEEMED" });
  });

  // Reclaim token (admin dispute)
  app.post("/reclaim/:tokenId", (req, res) => {
    const tokenId = parseInt(req.params.tokenId, 10);
    const tok = tokens[tokenId];
    if (!tok) return res.status(404).json({ error: "Token not found" });
    if (tok.status !== "ACTIVE") return res.status(400).json({ error: "Token not active" });

    tok.status = "RECLAIMED";
    tok.reclaimedAt = Date.now();

    res.json({ tokenId, status: "RECLAIMED" });
  });

  app.resetState = resetState;
  return app;
}

module.exports = { createApp };

// Only bind a port when run directly (previously the server started on import,
// which made the module impossible to reuse or test).
if (require.main === module) {
  const PORT = process.argv[2] || 3001;
  createApp().listen(PORT, () => {
    console.log(`REST Settlement API listening on http://localhost:${PORT}`);
  });
}
