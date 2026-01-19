const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

async function main() {
	// Validate args: recipient and amount in ETH
	if (process.argv.length !== 4) {
		console.error(
			"Usage: node scripts/send-sepolia.js <recipientAddress> <amountInETH>",
		);
		process.exit(1);
	}
	const recipient = process.argv[2];
	const amountStr = process.argv[3];

	// Ensure the .env.development file exists and load it
	const envPath = path.resolve(__dirname, "../../../.env.development");
	if (!fs.existsSync(envPath)) {
		throw new Error(`Environment file not found at ${envPath}`);
	}
	dotenv.config({ path: envPath });
	// Export HARDHAT_NETWORK=sepolia, so that hardhat uses the correct network
	process.env.HARDHAT_NETWORK = "sepolia";

	const hre = require("hardhat");

	// Load private key from env
	const privateKeyRaw =
		process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY_TEST;
	if (!privateKeyRaw) {
		throw new Error(
			"Missing ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY_TEST in environment",
		);
	}

	const privateKey = privateKeyRaw.startsWith("0x")
		? privateKeyRaw
		: `0x${privateKeyRaw}`;

	// Basic validations
	if (!hre.ethers.isAddress(recipient)) {
		throw new Error("Invalid recipient address");
	}
	let value;
	try {
		value = hre.ethers.parseEther(amountStr);
	} catch {
		throw new Error(
			"Invalid amount. Provide a numeric amount in ETH, e.g., 0.05",
		);
	}
	if (value <= 0n) {
		throw new Error("Amount must be greater than 0");
	}

	// Provider and wallet
	console.log(`Network: ${hre.network.name}`);
	const provider = hre.ethers.provider;
	const wallet = new hre.ethers.Wallet(privateKey, provider);
	console.log(`Sender: ${wallet.address}`);

	// Check balance and estimate fees
	const balance = await provider.getBalance(wallet.address);
	const feeData = await provider.getFeeData();
	const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
	if (!maxFeePerGas) {
		throw new Error("Unable to determine gas price/fees");
	}

	const gasLimit = await provider.estimateGas({
		from: wallet.address,
		to: recipient,
		value,
	});
	const estimatedFees = gasLimit * maxFeePerGas;

	if (balance < value + estimatedFees) {
		const balEth = hre.ethers.formatEther(balance);
		const needEth = hre.ethers.formatEther(value + estimatedFees);
		throw new Error(
			`Insufficient funds. Balance: ${balEth} ETH, required (amount + est. fees): ${needEth} ETH`,
		);
	}

	// Send transaction
	console.log(
		`Sending ${hre.ethers.formatEther(
			value,
		)} ETH to ${recipient} (gasLimit=${gasLimit}, maxFeePerGas=${maxFeePerGas})`,
	);

	const tx = await wallet.sendTransaction({
		to: recipient,
		value,
		gasLimit,
		maxFeePerGas,
		maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? undefined,
	});

	console.log(`Tx submitted: ${tx.hash}`);
	const receipt = await tx.wait();
	console.log(`Tx confirmed in block ${receipt.blockNumber}`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err.message || err);
		process.exit(1);
	});
