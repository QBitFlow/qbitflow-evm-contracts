require("@nomicfoundation/hardhat-toolbox");

module.exports = {
	solidity: {
		version: "0.8.28",
		settings: {
			optimizer: {
				enabled: true,
				// runs: 100,
			},
			viaIR: true,
		},
	},
	networks: {
		hardhat: {
			chainId: 1337,
			mining: {
				auto: false, // disable automine
				interval: 1000, // mine every 1000 ms (1s)
			},
		},
		sepolia: {
			url: process.env.ETHEREUM_NETWORK_URL_TEST,
			accounts: process.env
				.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY_TEST
				? [process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY_TEST]
				: [],
		},
		mainnet: {
			url: process.env.ETHEREUM_NETWORK_URL,
			accounts: process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY
				? [process.env.ETHEREUM_CONTRACT_OWNER_WALLET_PRIVATE_KEY]
				: [],
		},
		localhost: {
			url: "http://127.0.0.1:8545",
			chainId: 1337,
			mining: {
				auto: false, // disable automine
				interval: 1000, // mine every 1000 ms (1s)
			},
	},
	// etherscan: {
	// 	apiKey: process.env.ETHEREUM_ETHERSCAN_API_KEY, // optional for verification
	// },
	paths: {
		sources: "./contracts",
		tests: "./test",
		cache: "./cache",
		artifacts: "./artifacts",
	},
};
