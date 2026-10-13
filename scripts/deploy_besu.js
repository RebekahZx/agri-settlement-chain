/**
 * Deploy SettlementSystem to local Hardhat Node (Besu stand-in).
 * Run: npx hardhat run scripts/deploy_besu.js --network localhost
 */

const { ethers } = require("hardhat");
const fs   = require("fs");
const path = require("path");
const { RESULTS_DIR } = require("./utils");

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer:", deployer.address);
  console.log("Balance: ", ethers.formatEther(bal), "ETH");

  const Factory = await ethers.getContractFactory("SettlementSystem");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const receipt = await ethers.provider.getTransactionReceipt(contract.deploymentTransaction().hash);

  console.log("Deployed at:", address);
  console.log("Gas used:   ", receipt.gasUsed.toString());

  const info = {
    address,
    deployer: deployer.address,
    network: "hardhat-local (Besu proxy)",
    txHash: contract.deploymentTransaction().hash,
    gasUsed: receipt.gasUsed.toString(),
    deployedAt: new Date().toISOString()
  };

  fs.writeFileSync(path.join(RESULTS_DIR, "besu_deployment.json"), JSON.stringify(info, null, 2));
  console.log("Saved → besu_deployment.json");
}

main().catch(e => { console.error(e); process.exit(1); });
