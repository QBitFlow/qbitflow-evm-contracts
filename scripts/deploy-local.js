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

// This is only for testing purposes, to deploy a mock USDC token
// In production, you would use a real USDC token contract or a similar ERC20 token
async function deployTokens(hre, deployer) {
	console.log("\nDeploying mock tokens...");

	const usdc = await deploy(hre, "USDC", deployer, []);

	// Mint 1000 USDC (with 18 decimals)
	const USER_ADDRESS = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199"; // Replace with the actual user address
	await usdc.mint(USER_ADDRESS, hre.ethers.parseUnits("1000", 18)); // 1000 USDC with 18 decimals

	// Get the USDC balance of the user
	const userBalance = await usdc.balanceOf(USER_ADDRESS);
	console.log(
		`User ${USER_ADDRESS} USDC balance: ${hre.ethers.formatUnits(
			userBalance,
			18,
		)} USDC`,
	);

	// Deploy WETH token
	const weth = await deploy(hre, "WETH", deployer, []);

	// Mint 50 WETH (with 18 decimals)
	await weth.mint(USER_ADDRESS, hre.ethers.parseUnits("50", 18)); // 50 WETH with 18 decimals

	// Get the WETH balance of the user
	const userWethBalance = await weth.balanceOf(USER_ADDRESS);
	console.log(
		`User ${USER_ADDRESS} WETH balance: ${hre.ethers.formatUnits(
			userWethBalance,
			18,
		)} WETH`,
	);

	return {
		USDC: await usdc.getAddress(),
		WETH: await weth.getAddress(),
	};
}

async function main() {
	// Deploy QBitFlowPaymentSystem and QBitFlowSubscriptionHandler contracts

	// Program takes an environment file as parameter. Ensure it's a valid one, then load the environment variables
	if (process.argv.length !== 4) {
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

	// Create deployer account from private key
	const privateKey = process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY;
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

	// Deploy mock tokens
	const tokensAddresses = await deployTokens(hre, deployer);

	// Save the contract addresses for later use
	const addresses = {
		QBitFlowPaymentSystem: await coreSystem.getAddress(),
		// QBitFlowSubscriptionHandler: await subscriptionHandler.getAddress(),
		...tokensAddresses,
	};

	// Write addresses to a file
	fs.writeFileSync(
		path.join(__dirname, "../deployed-addresses.json"),
		JSON.stringify(addresses, null, 2),
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error);
		process.exit(1);
	});
