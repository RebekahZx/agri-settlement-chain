const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { CONTRACT, RESULTS_DIR, guardOverwrite } = require("./utils");

async function main() {
  guardOverwrite(path.join(RESULTS_DIR, "deployment.json"));
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", ethers.formatEther(balance), "ETH");

  if (balance === 0n) {
    throw new Error("Account has no ETH. Get Sepolia ETH from https://sepoliafaucet.com/");
  }

  console.log(`\nDeploying ${CONTRACT}...`);
  const Factory = await ethers.getContractFactory(CONTRACT);
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const receipt = await ethers.provider.getTransactionReceipt(contract.deploymentTransaction().hash);

  console.log("Contract deployed at:", address);
  console.log("Deploy tx hash:      ", contract.deploymentTransaction().hash);
  console.log("Gas used:            ", receipt.gasUsed.toString());

  // Save deployment info
  const info = {
    contract: CONTRACT,
    address,
    deployer: deployer.address,
    network: (await ethers.provider.getNetwork()).name,
    txHash: contract.deploymentTransaction().hash,
    gasUsed: receipt.gasUsed.toString(),
    deployedAt: new Date().toISOString()
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outPath = path.join(RESULTS_DIR, "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(info, null, 2));
  console.log(`\nDeployment info saved to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
