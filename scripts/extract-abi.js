const fs = require("fs");
const path = require("path");

// Read the full artifact
const baseDir = path.join(__dirname, "../artifacts/contracts/");
const outDir = path.join(__dirname, "../abi/");

// Ensure the output directory exists, otherwise create it
if (!fs.existsSync(outDir)) {
	fs.mkdirSync(outDir, { recursive: true });
}

const extractAndSave = (contractName, contractDir) => {
	const artifactPath = path.join(
		contractDir || baseDir,
		`${contractName}.sol/${contractName}.json`,
	);
	if (!fs.existsSync(artifactPath)) {
		throw new Error(
			`Artifact not found for ${contractName} at ${artifactPath}`,
		);
	}
	const artifact = JSON.parse(fs.readFileSync(artifactPath));
	// Extract just the ABI
	const abi = JSON.stringify(artifact.abi);

	// Write the ABI to a new file
	fs.writeFileSync(path.join(outDir, `${contractName}.abi`), abi);
	// Extract the bytecode as well (useful for deployment)
	const bytecode = artifact.bytecode;
	fs.writeFileSync(path.join(outDir, `${contractName}.bin`), bytecode);
};

extractAndSave("QBitFlowPaymentSystem");

// const artifactPath = path.join(
// 	baseDir,
// 	"QBitFlowPaymentSystem.sol/QBitFlowPaymentSystem.json",
// );
// const artifact = JSON.parse(fs.readFileSync(artifactPath));

// // Extract just the ABI
// const abi = JSON.stringify(artifact.abi);

// // Write the ABI to a new file
// fs.writeFileSync(path.join(outDir, "QBitFlowPaymentSystem.abi"), abi);

// // Extract the bytecode as well (useful for deployment)
// const bytecode = artifact.bytecode;
// fs.writeFileSync(path.join(outDir, "QBitFlowPaymentSystem.bin"), bytecode);

// Extract the proxy factory ABI
// extractAndSave("QBitFlowProxyFactory");
// extractAndSave("QBitFlowProxy");
// const proxyFactoryPath = path.join(
// 	baseDir,
// 	"QBitFlowProxyFactory.sol/QBitFlowProxyFactory.json",
// );
// const proxyFactoryArtifact = JSON.parse(fs.readFileSync(proxyFactoryPath));
// fs.writeFileSync(
// 	path.join(outDir, "QBitFlowProxyFactory.abi"),
// 	JSON.stringify(proxyFactoryArtifact.abi),
// );
// fs.writeFileSync(
// 	path.join(outDir, "QBitFlowProxyFactory.bin"),
// 	proxyFactoryArtifact.bytecode,
// );

// Extract mock tokens ABI
const mockTokens = ["USDC", "WETH"];
const mockTokensDir = path.join(baseDir, "mocks");

mockTokens.forEach((token) => {
	extractAndSave(token, mockTokensDir);
	// const tokenArtifactPath = path.join(
	// 	mockTokensDir,
	// 	`${token}.sol/${token}.json`,
	// );
	// const tokenArtifact = JSON.parse(fs.readFileSync(tokenArtifactPath));
	// fs.writeFileSync(
	// 	path.join(outDir, `${token}.abi`),
	// 	JSON.stringify(tokenArtifact.abi),
	// );
	// fs.writeFileSync(path.join(outDir, `${token}.bin`), tokenArtifact.bytecode);
});
