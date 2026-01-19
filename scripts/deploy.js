const path = require("path");
const fs = require("fs");

const deploy = async (hre, name, signer, contractArgs) => {
	console.log(`\nDeploying ${name} contract...`);
	const contractFactory = await hre.ethers.getContractFactory(name, {
		signer: signer,
	});
	const contract = await contractFactory.deploy(...contractArgs);
	await contract.waitForDeployment();
	console.log(`${name} deployed to:`, await contract.getAddress());
	return contract;
};

async function main() {
	// Deploy QBitFlowPaymentSystem and QBitFlowSubscriptionHandler contracts

	// Program takes an environment file as parameter. Ensure it's a valid one, then load the environment variables
	if (process.argv.length !== 5) {
		throw new Error(
			"Please provide the path to the .env file as an argument",
		);
	}

	const envFilePath = process.argv[2];
	if (!/^\.env(\..+)?$/.test(path.basename(envFilePath))) {
		throw new Error(
			"Please provide a valid environment file (.env, .env.test, .env.production, etc.)",
		);
	}

	// Ensure the file exists
	if (!fs.existsSync(envFilePath)) {
		throw new Error(`The file ${envFilePath} does not exist`);
	}

	// Load environment variables from the provided file
	require("dotenv").config({ path: envFilePath });

	const hre = require("hardhat");

	const cosignerAddress = process.argv[3];
	if (!hre.ethers.isAddress(cosignerAddress)) {
		throw new Error("Please provide a valid cosigner address");
	}

	const isTest = process.argv[4] === "test";
	console.log(`Using environment file: ${envFilePath} (isTest: ${isTest})`);

	// Create deployer account from private key
	const privateKey = isTest
		? process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY_TEST
		: process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY;
	if (!privateKey) {
		throw new Error(
			"Please set your ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY in .env file",
		);
	}

	console.log("Hardhat network:", hre.network.name);

	const deployer = new hre.ethers.Wallet(privateKey, hre.ethers.provider);
	if (!deployer) {
		throw new Error(
			"Failed to create deployer wallet. Please check your private key.",
		);
	}

	// Check if the deployer wallet is connected to the provider
	const deployerBalance = await hre.ethers.provider.getBalance(
		deployer.address,
	);

	console.log("Deploying contracts with account:", deployer.address);
	console.log("Deployer balance:", deployerBalance);

	if (deployerBalance == 0) {
		throw new Error(
			"Deployer wallet has no balance. Please fund the wallet before deploying.",
		);
	}

	const coreSystem = await deploy(hre, "QBitFlowPaymentSystem", deployer, [
		cosignerAddress,
	]);

	const deployerBalanceAfterDeployment = await hre.ethers.provider.getBalance(
		deployer.address,
	);
	console.log(
		"Deployer balance after deployment:",
		deployerBalanceAfterDeployment,
		"Deployment cost:",
		deployerBalance - deployerBalanceAfterDeployment,
	);

	// Save the contract addresses for later use
	const addresses = {
		QBitFlowPaymentSystem: await coreSystem.getAddress(),
	};

	console.log("\nDeployed contract addresses:", addresses);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
