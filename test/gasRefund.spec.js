const { ethers } = require("hardhat");
const { expect, use } = require("chai");
const { uuidToBytes16 } = require("./helpers/uuid");
const { signERC2612Permit } = require("./helpers/permit");
const {
	ETH_PRICE_USD,
	ETH_DECIMALS,
	TOKEN_PRICE_USD,
	TOKEN_DECIMALS,
	tokenPriceInWei,
} = require("./helpers/constants");
const { getGasRefundData } = require("./helpers/helpers");

const computeExpectedRefund = (
	gasUsed,
	gasPrice,
	tokenPriceInWei,
	balanceDifferenceAfterFees,
	log = false,
) => {
	// Compute the total gas cost in WEI
	const totalGasCostInWei = gasUsed * BigInt(gasPrice);

	const totalGasCostInEth = Number(totalGasCostInWei) / 10 ** ETH_DECIMALS;

	// Calculate the total cost in tokens
	const totalGasCostInTokens = tokenPriceInWei * totalGasCostInEth;

	// Check that the refund is within a reasonable range of the expected refund
	const refundRatio =
		Number(balanceDifferenceAfterFees) / totalGasCostInTokens;

	if (log) {
		console.log(
			"Total gas cost in WEI:",
			totalGasCostInWei.toString(),
			"Total gas cost in ETH:",
			totalGasCostInEth,
			"USD:",
			totalGasCostInEth * ETH_PRICE_USD,
		);

		console.log(
			"Total gas cost in tokens (expected refund):",
			totalGasCostInTokens,
			"USD:",
			(totalGasCostInTokens * TOKEN_PRICE_USD) / 10 ** TOKEN_DECIMALS,
		);

		console.log(
			"Actual refund (balance difference after fees):",
			balanceDifferenceAfterFees.toString(),
		);
		console.log(`Refund ratio (actual/expected): ${refundRatio}`);
	}

	expect(refundRatio).to.be.gt(0.995); // at least 99.5% of expected refund
	expect(refundRatio).to.be.lt(1.1); // at most 10% more than expected (some variability in gas cost)
};

describe("Gas refund modifier", () => {
	let owner,
		user,
		merchant,
		org,
		tokenNoPermit,
		system,
		systemAddr,
		tokenNoPermitAddr,
		provider,
		tokenPermit,
		tokenPermitAddress,
		proxy;

	beforeEach(async () => {
		[owner, user, merchant, org] = await ethers.getSigners();

		const TokenNoPermit = await ethers.getContractFactory(
			"MockERC20NoPermit",
		);
		tokenNoPermit = await TokenNoPermit.deploy(
			"NoPermit",
			"NOP",
			TOKEN_DECIMALS,
		);
		await tokenNoPermit.waitForDeployment();
		tokenNoPermitAddr = await tokenNoPermit.getAddress();

		const System = await ethers.getContractFactory("QBitFlowPaymentSystem");
		system = await System.deploy();
		await system.waitForDeployment();
		systemAddr = await system.getAddress();

		// Give user some tokens by default
		await tokenNoPermit.mint(
			user.address,
			ethers.parseUnits("1000", TOKEN_DECIMALS),
		);

		// Deploy token with permit support
		const TokenPermit = await ethers.getContractFactory("MockERC20Permit");
		tokenPermit = await TokenPermit.deploy(
			"PermitToken",
			"PRM",
			TOKEN_DECIMALS,
		);
		await tokenPermit.waitForDeployment();

		tokenPermitAddress = await tokenPermit.getAddress();
		await tokenPermit.mint(
			user.address,
			ethers.parseUnits("1000", TOKEN_DECIMALS),
		);

		provider = hre.ethers.provider;

		// Create a proxy
		const tx = await system.createNewProxy();
		const rc = await tx.wait();
		proxy = rc.logs
			.map((log) => system.interface.parseLog(log))
			.find((e) => e.name === "ProxyCreated")?.args[0];
	});

	const getMockPermitParams = async (spenderAddress, allowanceAmount) => {
		return {
			allowance: allowanceAmount,
			deadline: 0,
			signature: {
				v: 0,
				r: ethers.ZeroHash,
				s: ethers.ZeroHash,
			},
			spender: spenderAddress,
		};
	};

	const createPermitSignature = async (
		spender = systemAddr,
		allowance = ethers.parseUnits("100", TOKEN_DECIMALS),
		deadline = null,
		signer = user,
	) => {
		const currentBlock = await provider.getBlock("latest");
		const finalDeadline = deadline || currentBlock.timestamp + 3600;

		const sig = await signERC2612Permit(
			tokenPermit,
			signer,
			spender,
			allowance,
			finalDeadline,
			provider,
		);

		return {
			allowance,
			deadline: sig.deadline,
			signature: { v: sig.v, r: sig.r, s: sig.s },
			spender,
		};
	};

	// Subscriptions and recurring payments must use proxies (because the modifier is called with proxy == true)
	// One-time payments do not use proxies
	// Recurring payments without proxy should fail to refund gas
	async function createSubscriptionWithSig(
		useProxy = false,
		permitSupported = false,
	) {
		const allowanceAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

		if (useProxy) {
			// If no permit, we need to simulate the approval beforehand
			if (!permitSupported) {
				await tokenNoPermit
					.connect(user)
					.approve(proxy, allowanceAmount);
			}
		} else {
			await tokenNoPermit
				.connect(user)
				.approve(systemAddr, allowanceAmount);
		}

		const amount = ethers.parseUnits("10", TOKEN_DECIMALS);
		const maxAmount = ethers.parseUnits("15", TOKEN_DECIMALS);
		const data = {
			from: user.address,
			to: merchant.address,
			tokenAddress: permitSupported
				? tokenPermitAddress
				: tokenNoPermitAddr,
			uuid: uuidToBytes16("01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b"),
			amount: amount,
		};

		const { chainId } = await provider.getNetwork();
		const domain = {
			name: "QBitFlow",
			version: "1",
			chainId,
			verifyingContract: systemAddr,
		};

		const types = {
			createSubscription: [
				{ name: "merchant", type: "address" },
				{ name: "tokenAddress", type: "address" },
				{ name: "frequency", type: "uint32" },
				{ name: "uuid", type: "bytes16" },
				{ name: "organization", type: "address" },
			],
		};

		const frequency = 60 * 60 * 24 * 7; // weekly
		const message = {
			merchant: merchant.address,
			tokenAddress: permitSupported
				? tokenPermitAddress
				: tokenNoPermitAddr,
			frequency,
			uuid: data.uuid,
			organization: org.address,
		};
		const sig = await user.signTypedData(domain, types, message);
		const { v, r, s } = ethers.Signature.from(sig);

		// Since no permit is used, the allowance must be set beforehand
		// The smart contract functions will simply check if allowance is sufficient

		const permitParams = await createPermitSignature(
			useProxy ? proxy : systemAddr,
		);

		// If useProxy is false, the subscription should not be created because recurring payments must use proxies
		if (useProxy) {
			await expect(
				system.createSubscription(
					data,
					maxAmount,
					frequency,
					{
						spender: permitParams.spender,
						allowance: allowanceAmount,
						deadline: permitParams.deadline,
						signature: {
							v: permitParams.signature.v,
							r: permitParams.signature.r,
							s: permitParams.signature.s,
						},
					},
					permitSupported,
					org.address, // empty organization fee address (matching the signed message)
					{ v, r, s },
					getGasRefundData(),
				),
			).to.emit(system, "SubscriptionCreated");
		}

		return { data, maxAmount, frequency, sig: { v, r, s } };
	}

	describe("Approval-based subscriptions and payments", () => {
		// Tests for approval-based subscriptions and payments

		it("Refunds should fail when no proxy is used for subscription (subscription reverts)", async () => {
			// This simulates a recurring payment without proxy, which should not be possible
			// because the modifier is called with proxy == true
			// The business logic should still succeed, but the gas refund should fail
			const { data, maxAmount, frequency, sig } =
				await createSubscriptionWithSig(false);

			// Calling the createSubscription method should revert because it must use a proxy
			const res = system.createSubscription(
				data,
				maxAmount,
				frequency,
				{
					spender: systemAddr,
					allowance: ethers.parseUnits("100", TOKEN_DECIMALS),
					deadline: 0n,
					signature: {
						v: sig.v,
						r: sig.r,
						s: sig.s,
					},
				},
				false,
				org.address, // empty organization fee address (matching the signed message)
				{ v: sig.v, r: sig.r, s: sig.s },
				getGasRefundData(),
			);
			await expect(res).to.be.revertedWith("Invalid proxy for stream");
		});

		it("successfully refunds when proxy is used for subscription (subscription succeeds)", async () => {
			const { data, frequency } = await createSubscriptionWithSig(true);

			await provider.send("evm_increaseTime", [frequency + 1]);
			await provider.send("evm_mine", []);

			const gasRefund = getGasRefundData();

			// Check balance before and after to ensure refund was sent
			const before = await tokenNoPermit.balanceOf(owner.address);

			const tx = await system.executeSubscription(
				data,
				frequency,
				100,
				{ organization: org.address, feeBps: 0 },
				gasRefund,
			);

			// Now, we need to get the gas used in the transaction to calculate the expected refund
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenNoPermit.balanceOf(owner.address);

			// We need to take into account the fees taken by the system (100 bps in this case)
			const expectedFees = (amount * 100n) / 10000n;
			console.log("Expected fees:", expectedFees.toString());

			const balanceDifferenceAfterFees = after - before - expectedFees;

			computeExpectedRefund(
				gasUsed,
				gasRefund.gasPrice,
				Number(gasRefund.tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});

		it("Should refund for processTokenPayment (without proxy)", async () => {
			const allowanceAmount = ethers.parseUnits("100", TOKEN_DECIMALS);
			await tokenNoPermit
				.connect(user)
				.approve(systemAddr, allowanceAmount); // processTokenPayment does not use proxy

			const gasRefund = getGasRefundData();
			const amount = ethers.parseUnits("20", TOKEN_DECIMALS); // 20 tokens

			// Check balance before and after to ensure refund was sent
			const before = await tokenNoPermit.balanceOf(owner.address);

			const tx = await system.processTokenPayment(
				{
					from: user.address,
					to: merchant.address,
					tokenAddress: tokenNoPermitAddr,
					uuid: uuidToBytes16("01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b"),
					amount: amount,
				},
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				await getMockPermitParams(systemAddr, amount),
				false,
				gasRefund,
			);

			// Now, we need to get the gas used in the transaction to calculate the expected refund
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenNoPermit.balanceOf(owner.address);

			const expectedFees = (amount * 100n) / 10000n;

			const balanceDifferenceAfterFees = after - before - expectedFees;

			computeExpectedRefund(
				gasUsed,
				gasRefund.gasPrice,
				Number(gasRefund.tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});

		it("Should refund for createSubscription (with proxy)", async () => {
			// Check balance before and after to ensure refund was sent
			const allowanceAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

			const txProxy = await system.createNewProxy();
			const rc = await txProxy.wait();
			const proxy = rc.logs
				.map((log) => system.interface.parseLog(log))
				.find((e) => e.name === "ProxyCreated")?.args[0];
			await tokenNoPermit.connect(user).approve(proxy, allowanceAmount);

			const amount = ethers.parseUnits("10", TOKEN_DECIMALS);
			const maxAmount = ethers.parseUnits("15", TOKEN_DECIMALS);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: tokenNoPermitAddr,
				uuid: uuidToBytes16("01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b"),
				amount: amount,
			};

			const { chainId } = await provider.getNetwork();
			const domain = {
				name: "QBitFlow",
				version: "1",
				chainId,
				verifyingContract: systemAddr,
			};

			const types = {
				createSubscription: [
					{ name: "merchant", type: "address" },
					{ name: "tokenAddress", type: "address" },
					{ name: "frequency", type: "uint32" },
					{ name: "uuid", type: "bytes16" },
					{ name: "organization", type: "address" },
				],
			};

			const frequency = 60 * 60 * 24 * 7; // weekly
			const message = {
				merchant: merchant.address,
				tokenAddress: tokenNoPermitAddr,
				frequency,
				uuid: data.uuid,
				organization: org.address,
			};
			const sig = await user.signTypedData(domain, types, message);
			const { v, r, s } = ethers.Signature.from(sig);

			const before = await tokenNoPermit.balanceOf(owner.address);

			const tx = await system.createSubscription(
				data,
				maxAmount,
				frequency,
				{
					spender: proxy,
					allowance: allowanceAmount,
					deadline: 0n,
					signature: {
						v: v,
						r: r,
						s: s,
					},
				},
				false,
				org.address, // empty organization fee address (matching the signed message)
				{ v: v, r: r, s: s },
				getGasRefundData(),
			);

			// Now, we need to get the gas used in the transaction to calculate the expected refund
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenNoPermit.balanceOf(owner.address);

			// No fees are taken when creating a subscription
			const balanceDifferenceAfterFees = after - before;

			computeExpectedRefund(
				gasUsed,
				getGasRefundData().gasPrice,
				Number(getGasRefundData().tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});

		it("Should refund for increaseAllowance", async () => {
			// First, we need to create a subscription (with a proxy) as increaseAllowance is only for subscriptions
			const { data } = await createSubscriptionWithSig(true);

			const before = await tokenNoPermit.balanceOf(owner.address);

			const gasRefund = getGasRefundData();

			// Now we can call increaseAllowance on the proxy
			const tx = await system.increaseAllowance(
				data.uuid,
				data.tokenAddress,
				data.from,
				await getMockPermitParams(
					proxy,
					ethers.parseUnits("50", TOKEN_DECIMALS),
				), // The new allowance will be 50 tokens
				gasRefund,
			);
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenNoPermit.balanceOf(owner.address);

			// No fees are taken when increasing allowance
			const balanceDifferenceAfterFees = after - before;

			computeExpectedRefund(
				gasUsed,
				gasRefund.gasPrice,
				Number(gasRefund.tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});
	});

	describe("Permit-based subscriptions and payments", () => {
		// Tests for permit-based subscriptions and payments

		it("Refunds should work for permit-based subscription with proxy", async () => {
			const { data, frequency } = await createSubscriptionWithSig(
				true,
				true,
			);

			await provider.send("evm_increaseTime", [frequency + 1]);
			await provider.send("evm_mine", []);

			const gasRefund = getGasRefundData();

			// Check balance before and after to ensure refund was sent
			const before = await tokenPermit.balanceOf(owner.address);

			console.log("Executing subscription with permit...");

			const tx = await system.executeSubscription(
				data,
				frequency,
				100,
				{ organization: org.address, feeBps: 0 },
				gasRefund,
			);

			// Now, we need to get the gas used in the transaction to calculate the expected refund
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenPermit.balanceOf(owner.address);

			// We need to take into account the fees taken by the system (100 bps in this case)
			const expectedFees = (amount * 100n) / 10000n;

			const balanceDifferenceAfterFees = after - before - expectedFees;

			computeExpectedRefund(
				gasUsed,
				gasRefund.gasPrice,
				Number(gasRefund.tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});

		it("Should refund for createSubscription with permit (with proxy)", async () => {
			// Check balance before and after to ensure refund was sent
			const allowanceAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

			const amount = ethers.parseUnits("10", TOKEN_DECIMALS);
			const maxAmount = ethers.parseUnits("15", TOKEN_DECIMALS);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: tokenPermitAddress,
				uuid: uuidToBytes16("01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b"),
				amount: amount,
			};

			const { chainId } = await provider.getNetwork();
			const domain = {
				name: "QBitFlow",
				version: "1",
				chainId,
				verifyingContract: systemAddr,
			};

			const types = {
				createSubscription: [
					{ name: "merchant", type: "address" },
					{ name: "tokenAddress", type: "address" },
					{ name: "frequency", type: "uint32" },
					{ name: "uuid", type: "bytes16" },
					{ name: "organization", type: "address" },
				],
			};

			const frequency = 60 * 60 * 24 * 7; // weekly
			const message = {
				merchant: merchant.address,
				tokenAddress: tokenPermitAddress,
				frequency,
				uuid: data.uuid,
				organization: org.address,
			};
			const sig = await user.signTypedData(domain, types, message);
			const { v, r, s } = ethers.Signature.from(sig);

			const permitParams = await createPermitSignature(
				proxy,
				allowanceAmount,
			);

			const before = await tokenPermit.balanceOf(owner.address);

			const tx = await system.createSubscription(
				data,
				maxAmount,
				frequency,
				{
					spender: permitParams.spender,
					allowance: permitParams.allowance,
					deadline: permitParams.deadline,
					signature: {
						v: permitParams.signature.v,
						r: permitParams.signature.r,
						s: permitParams.signature.s,
					},
				},
				true,
				org.address, // empty organization fee address (matching the signed message)
				{ v: v, r: r, s: s },
				getGasRefundData(),
			);
			// Now, we need to get the gas used in the transaction to calculate the expected refund
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenPermit.balanceOf(owner.address);
			// No fees are taken when creating a subscription
			const balanceDifferenceAfterFees = after - before;

			computeExpectedRefund(
				gasUsed,
				getGasRefundData().gasPrice,
				Number(getGasRefundData().tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});

		it("Should refund for processTokenPayment with permit (without proxy)", async () => {
			const gasRefund = getGasRefundData();
			const allowanceAmount = ethers.parseUnits("100", TOKEN_DECIMALS);
			const amount = ethers.parseUnits("20", TOKEN_DECIMALS); // 20 tokens

			// Check balance before and after to ensure refund was sent
			const before = await tokenPermit.balanceOf(owner.address);

			const block = await provider.getBlock("latest");
			const permitParams = await signERC2612Permit(
				tokenPermit,
				user,
				systemAddr,
				allowanceAmount,
				block.timestamp + 3600,
				provider,
			);

			const tx = await system.processTokenPayment(
				{
					from: user.address,
					to: merchant.address,
					tokenAddress: tokenPermitAddress,
					uuid: uuidToBytes16("01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b"),
					amount: amount,
				},
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				{
					spender: systemAddr,
					allowance: allowanceAmount,
					deadline: permitParams.deadline,
					signature: {
						v: permitParams.v,
						r: permitParams.r,
						s: permitParams.s,
					},
				},
				true,
				gasRefund,
			);

			// Now, we need to get the gas used in the transaction to calculate the expected refund
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenPermit.balanceOf(owner.address);

			const expectedFees = (amount * 100n) / 10000n;

			const balanceDifferenceAfterFees = after - before - expectedFees;

			computeExpectedRefund(
				gasUsed,
				gasRefund.gasPrice,
				Number(gasRefund.tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});

		it("Should refund for increaseAllowance with permit (with proxy)", async () => {
			// First, we need to create a subscription (with a proxy) as increaseAllowance is only for subscriptions
			const { data } = await createSubscriptionWithSig(true, true);

			const before = await tokenPermit.balanceOf(owner.address);

			const gasRefund = getGasRefundData();

			const permitParams = await createPermitSignature(
				proxy,
				ethers.parseUnits("50", TOKEN_DECIMALS),
			);

			// Now we can call increaseAllowance on the proxy
			const tx = await system.increaseAllowance(
				data.uuid,
				data.tokenAddress,
				data.from,
				{
					spender: permitParams.spender,
					allowance: permitParams.allowance,
					deadline: permitParams.deadline,
					signature: {
						v: permitParams.signature.v,
						r: permitParams.signature.r,
						s: permitParams.signature.s,
					},
				}, // The new allowance will be 50 tokens
				gasRefund,
			);
			const receipt = await tx.wait();
			const gasUsed = receipt.gasUsed;

			const after = await tokenPermit.balanceOf(owner.address);

			// No fees are taken when increasing allowance
			const balanceDifferenceAfterFees = after - before;

			computeExpectedRefund(
				gasUsed,
				gasRefund.gasPrice,
				Number(gasRefund.tokenPriceInWei),
				balanceDifferenceAfterFees,
				true,
			);
		});
	});

	describe("Edge cases", () => {
		// Edge cases and failure scenarios

		it("Transaction should fail when user lacks balance", async () => {
			const { data, frequency } = await createSubscriptionWithSig(true);

			// drain tokens
			await tokenNoPermit
				.connect(user)
				.transfer(
					owner.address,
					await tokenNoPermit.balanceOf(user.address),
				);

			await provider.send("evm_increaseTime", [frequency + 1]);
			await provider.send("evm_mine", []);

			const gasRefund = getGasRefundData();
			const amount = ethers.parseUnits("10000", TOKEN_DECIMALS); // more than user has

			await expect(
				system.executeSubscription(
					data,
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					gasRefund,
				),
			).to.be.revertedWithCustomError(system, "InsufficientAllowance");
		});

		it("emit GasRefundFailed if user has insufficient allowance after the successful payment", async () => {
			const { data, frequency } = await createSubscriptionWithSig(true);

			// reduce allowance to less than needed for refund
			await tokenNoPermit.connect(user).approve(proxy, data.amount);

			await provider.send("evm_increaseTime", [frequency + 1]);
			await provider.send("evm_mine", []);

			const gasRefund = getGasRefundData();

			// Now, we want to execute the subscription with the exact amount of the allowance, which means the remaining allowance will be insufficient for the gas refund

			// The business logic should succeed, but the gas refund should fail
			// We check for the GasRefundFailed event to confirm this
			await expect(
				system.executeSubscription(
					data,
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					gasRefund,
				),
			).to.emit(system, "GasRefundFailed");
		});

		it("reverts if gasPrice = 0", async () => {
			const { data, frequency } = await createSubscriptionWithSig(true);

			await provider.send("evm_increaseTime", [frequency + 1]);
			await provider.send("evm_mine", []);

			const gasRefund = {
				gasPrice: 0,
				tokenPriceInWei: tokenPriceInWei,
			};

			await expect(
				system.executeSubscription(
					data,
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					gasRefund,
				),
			).to.be.revertedWith("Gas price must be greater than zero");
		});

		it("reverts if tokenPriceInWei = 0", async () => {
			const { data, frequency } = await createSubscriptionWithSig(true);

			await provider.send("evm_increaseTime", [frequency + 1]);
			await provider.send("evm_mine", []);

			const gasRefund = {
				gasPrice: getGasRefundData().gasPrice,
				tokenPriceInWei: 0,
			};

			await expect(
				system.executeSubscription(
					data,
					frequency,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					gasRefund,
				),
			).to.be.revertedWith("Token per ETH must be greater than zero");
		});
	});
});
