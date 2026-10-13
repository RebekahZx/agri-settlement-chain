const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { RESULTS_DIR } = require("./utils");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Account has no ETH. Get Sepolia ETH from https://sepoliafaucet.com/");
  }

  console.log("\nDeploying SettlementSystem...");
  const Factory = await ethers.getContractFactory("SettlementSystem");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const receipt = await ethers.provider.getTransactionReceipt(contract.deploymentTransaction().hash);

  console.log("Contract deployed at:", address);
  console.log("Deploy tx hash:      ", contract.deploymentTransaction().hash);
  console.log("Gas used:            ", receipt.gasUsed.toString());

  // Save deployment info
  const info = {
    address,
    deployer: deployer.address,
    network: "sepolia",
    txHash: contract.deploymentTransaction().hash,
    gasUsed: receipt.gasUsed.toString(),
    deployedAt: new Date().toISOString()
  };

  const outPath = path.join(RESULTS_DIR, "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(info, null, 2));
  console.log("\nDeployment info saved to deployment.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
