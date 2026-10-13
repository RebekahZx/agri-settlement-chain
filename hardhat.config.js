require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Accept PRIVATE_KEY with or without a 0x prefix (previously "0x…" became "0x0x…").
const pk = (process.env.PRIVATE_KEY || "").replace(/^0x/, "");

module.exports = {
  // `npm run test:gas` prints per-function gas usage from the unit tests
  // (gas units only; no price lookup, so it works offline).
  gasReporter: {
    enabled: process.env.REPORT_GAS === "1",
    currency: "USD",
    offline: true,
    excludeContracts: ["ReentrantBuyer", "RejectingBuyer", "SettlementSystemV0"]
  },
  solidity: {
    version: "0.8.19",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_URL || "",
      accounts: pk ? [`0x${pk}`] : [],
      timeout: 180000
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      timeout: 60000
    },
    // Interval mining is used by Experiment 4. Unit tests re-enable automine
    // in test/SettlementSystem.test.js so they don't wait for 2 s blocks.
    hardhat: {
      mining: {
        auto: false,
        interval: 2000   // 2-second block time — simulates Besu/Quorum consortium node
      }
    }
  }
};
