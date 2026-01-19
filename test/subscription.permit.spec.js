const { expect } = require("chai");
const { ethers } = require("hardhat");
const { uuidToBytes16 } = require("./helpers/uuid");
const { signERC2612Permit } = require("./helpers/permit");

const {
	ETH_PRICE_USD,
	TOKEN_PRICE_USD,
	TOKEN_DECIMALS,
} = require("./helpers/constants");
const { getGasRefundData } = require("./helpers/helpers");

const createNewProxy = async (system) => {
	const tx = await system.createNewProxy();
	const rc = await tx.wait();
	return rc.logs
		.map((log) => system.interface.parseLog(log))
		.find((e) => e.name === "ProxyCreated")?.args[0];
};

describe("QBitFlowPaymentSystem - Subscription (Permit)", () => {
	let owner, user, merchant, org;
	let TokenPermit, token;
	let System, system;
	let provider;

	beforeEach(async () => {
		[owner, user, merchant, org] = await ethers.getSigners();
		provider = ethers.provider;

		// ERC20 with permit
		TokenPermit = await ethers.getContractFactory("MockERC20Permit");
		token = await TokenPermit.deploy("PermitToken", "PRM", TOKEN_DECIMALS);
		await token.waitForDeployment();

		// Payment system, deploys factory
		System = await ethers.getContractFactory("QBitFlowPaymentSystem");
		system = await System.deploy();
		await system.waitForDeployment();

		// Mint tokens to user
		await token.mint(user.address, ethers.parseEther("1000"));
	});

	async function createSubSig(data, frequency, signer = user) {
		const { chainId } = await provider.getNetwork();
		const domain = {
			name: "QBitFlow",
			version: "1",
			chainId,
			verifyingContract: await system.getAddress(),
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
		const message = {
			merchant: data.to,
			tokenAddress: data.tokenAddress,
			frequency,
			uuid: data.uuid,
			organization: org.address,
		};
		const sig = await signer.signTypedData(domain, types, message);
		return ethers.Signature.from(sig);
	}

	async function createPermitSignature(
		spender,
		allowance = ethers.parseEther("100"),
		deadline = null,
		signer = user,
	) {
		const { timestamp } = await provider.getBlock("latest");
		const finalDeadline = deadline || timestamp + 3600;

		const sig = await signERC2612Permit(
			token,
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
		};
	}

	describe("createSubscription", () => {
		it("creates subscription with valid permit signature", async () => {
			const uuid = uuidToBytes16("11111111-1111-1111-1111-111111111111");
			const frequency = 86400n;
			const allowance = ethers.parseEther("200");

			const proxyAddress = await createNewProxy(system);
			const permitParams = await createPermitSignature(
				proxyAddress,
				allowance,
			);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};

			const sig = await createSubSig(data, frequency);

			// Call with permit
			await expect(
				system.createSubscription(
					data,
					frequency,
					0n,
					{
						allowance: permitParams.allowance,
						spender: proxyAddress,
						deadline: permitParams.deadline,
						signature: permitParams.signature,
					},
					true, // permitSupported
					org.address, // Organization fee address
					sig,
					getGasRefundData(),
				),
			).to.emit(system, "SubscriptionCreated");

			// Subscription struct check
			const sub = await system.getSubscription(uuid);
			expect(sub.signer).to.eq(user.address);
			expect(sub.active).to.be.true;

			// Check that proxy has allowance
			const proxyAllowance = await token.allowance(
				user.address,
				proxyAddress,
			);
			expect(proxyAllowance).to.gt(ethers.parseEther("199.99")); // slight margin due to gas refund
		});

		it("reverts with invalid permit signature", async () => {
			const uuid = uuidToBytes16("BADBAD00-1111-2222-3333-444444444444");
			const frequency = 86400n;
			const allowance = ethers.parseEther("200");
			const proxyAddress = await createNewProxy(system);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};

			const sig = await createSubSig(data, frequency);

			const validPermit = await createPermitSignature(
				proxyAddress,
				allowance,
			);
			// Invalid permit signature
			const badPermitParams = {
				...validPermit,
				spender: proxyAddress,
				signature: { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash },
			};

			await expect(
				system.createSubscription(
					data,
					frequency,
					0,
					badPermitParams,
					true,
					org.address, // Organization fee address
					sig,
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "ECDSAInvalidSignature"); // from ERC20Permit
		});

		it("reverts with expired permit", async () => {
			const uuid = uuidToBytes16("BADBAD00-1111-2222-3333-444444444444");
			const frequency = 86400n;
			const allowance = ethers.parseEther("200");
			const proxyAddress = await createNewProxy(system);

			// Create permit with past deadline
			const expiredDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
			const permitParams = await createPermitSignature(
				proxyAddress,
				allowance,
				expiredDeadline,
			);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};

			const sig = await createSubSig(data, frequency);

			await expect(
				system.createSubscription(
					data,
					frequency,
					0,
					{
						allowance: permitParams.allowance,
						spender: proxyAddress,
						deadline: permitParams.deadline,
						signature: permitParams.signature,
					},
					true,
					org.address, // Organization fee address
					sig,
					getGasRefundData(),
				),
			).to.be.reverted; // ERC20Permit will revert with expired deadline
		});

		it("should work with free trial", async () => {
			const uuid2 = uuidToBytes16("99999999-AAAA-BBBB-CCCC-DDDDDDDDDDDD");
			const frequency2 = 86400n;
			const allowance2 = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			const permitParams = await createPermitSignature(
				proxyAddr,
				allowance2,
			);

			const data2 = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid: uuid2,
			};
			const sig2 = await createSubSig(data2, frequency2);

			// Create subscription with 3 days free trial
			await system.createSubscription(
				data2,
				frequency2,
				70400n,
				{
					allowance: permitParams.allowance,
					spender: proxyAddr,
					deadline: permitParams.deadline,
					signature: permitParams.signature,
				},
				true,
				org.address, // Organization fee address
				sig2,
				getGasRefundData(),
			);

			// Try to execute immediately, should revert
			const amount = ethers.parseEther("50");
			await expect(
				system.executeSubscription(
					data2,
					amount,
					frequency2,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "PaymentNotDueYet");

			// Increase time by 4 days and try again, should work
			await ethers.provider.send("evm_increaseTime", [4 * 86400]);
			await expect(
				system.executeSubscription(
					data2,
					amount,
					frequency2,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.not.be.reverted;
		});

		it("SHould fail if execute doesn't provide the same organization address as in the creation", async () => {
			const uuid = uuidToBytes16("22222222-3333-4444-5555-666666666666");
			const frequency = 86400n;
			const allowance = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			const permitParams = await createPermitSignature(
				proxyAddr,
				allowance,
			);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};
			const sig = await createSubSig(data, frequency);

			await system.createSubscription(
				data,
				frequency,
				0n,
				{
					allowance: permitParams.allowance,
					spender: proxyAddr,
					deadline: permitParams.deadline,
					signature: permitParams.signature,
				},
				true,
				org.address, // Organization fee address
				sig,
				getGasRefundData(),
			);

			// Move time forward
			await ethers.provider.send("evm_increaseTime", [2 * 86400]);

			// Try to execute with different organization address
			const amount = ethers.parseEther("100");
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					100,
					{ organization: merchant.address, feeBps: 100 }, // Different org address
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InvalidSignature");
		});
	});

	describe("executeSubscription", () => {
		let uuid, frequency, allowance, data, sig, proxyAddr;
		beforeEach(async () => {
			uuid = uuidToBytes16("22222222-3333-4444-5555-666666666666");
			frequency = 86400n;
			allowance = ethers.parseEther("500");

			proxyAddr = await createNewProxy(system);
			const permitParams = await createPermitSignature(
				proxyAddr,
				allowance,
			);

			data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};
			sig = await createSubSig(data, frequency);

			await system.createSubscription(
				data,
				frequency,
				0n,
				{
					allowance: permitParams.allowance,
					spender: proxyAddr,
					deadline: permitParams.deadline,
					signature: permitParams.signature,
				},
				true,
				org.address, // Organization fee address
				sig,
				getGasRefundData(),
			);
		});

		it("runs correctly and transfers funds, updates nextPaymentDue", async () => {
			const blockTimestamp = (await provider.getBlock("latest"))
				.timestamp;

			const amount = ethers.parseEther("100");
			const orgFee = { organization: org.address, feeBps: 200 }; // 2%
			const feeBps = 200; // 2%
			const beforeUserBal = await token.balanceOf(user.address);
			const beforeOrg = await token.balanceOf(org.address);
			const beforeMerchant = await token.balanceOf(merchant.address);
			const beforeOwner = await token.balanceOf(owner.address);

			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					feeBps,
					orgFee,
					getGasRefundData(),
				),
			).to.emit(system, "SubscriptionPaymentProcessed");

			const afterUser = await token.balanceOf(user.address);
			const afterOrg = await token.balanceOf(org.address);
			const afterMerchant = await token.balanceOf(merchant.address);
			const afterOwner = await token.balanceOf(owner.address);

			// Fee calc
			const ownerShare = (amount * BigInt(feeBps)) / 10000n;
			const orgShare =
				((amount - ownerShare) * BigInt(orgFee.feeBps)) / 10000n;
			const merchantShare = amount - ownerShare - orgShare;

			expect(afterOwner - beforeOwner).to.gt(ownerShare); // greater due to gas refund
			expect(afterOrg - beforeOrg).to.eq(orgShare);
			expect(afterMerchant - beforeMerchant).to.eq(merchantShare);

			const sub = await system.getSubscription(uuid);
			expect(sub.nextPaymentDue).to.be.gte(
				BigInt(blockTimestamp) + frequency,
			);
		});

		it("reverts if amount exceeds remaining permit allowance", async () => {
			// First, use up most of the allowance
			await system.executeSubscription(
				data,
				ethers.parseEther("400"),
				frequency,
				100,
				{ organization: org.address, feeBps: 0 },
				getGasRefundData(),
			);

			// Move time forward
			await ethers.provider.send("evm_increaseTime", [2 * 86400]);

			// Try to execute with amount that exceeds remaining allowance
			const amount = ethers.parseEther("200"); // Should exceed remaining
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InsufficientAllowance");
		});

		it("Should handle multiple subscriptions from the same user/token (and proxy different)", async () => {
			// Create second subscription with different token (new proxy)
			const uuid2 = uuidToBytes16("77777777-8888-9999-AAAA-BBBBBBBBBBBB");
			const frequency2 = 86400n; // 24 hours
			const allowance2 = ethers.parseEther("300");
			const proxy2 = await createNewProxy(system);
			const permitParams2 = await createPermitSignature(
				proxy2,
				allowance2,
			);
			const data2 = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid: uuid2,
			};
			const sig2 = await createSubSig(data2, frequency2);

			await system.createSubscription(
				data2,
				frequency2,
				0n,
				{
					allowance: permitParams2.allowance,
					spender: proxy2,
					deadline: permitParams2.deadline,
					signature: permitParams2.signature,
				},
				true,
				org.address, // Organization fee address
				sig2,
				getGasRefundData(),
			);

			// Execute first subscription
			await expect(
				system.executeSubscription(
					data,
					ethers.parseEther("50"),
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.not.be.reverted;

			// Create another subscription, execute, and check the allowances of the two (should be different)
			const uuid3 = uuidToBytes16("DDDDDDDD-EEEE-FFFF-0000-111111111111");
			const frequency3 = 86400n; // 24 hours
			const allowance3 = ethers.parseEther("150");
			const proxy3 = await createNewProxy(system);
			const permitParams3 = await createPermitSignature(
				proxy3,
				allowance3,
			);
			const data3 = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid: uuid3,
			};
			const sig3 = await createSubSig(data3, frequency3);

			await system.createSubscription(
				data3,
				frequency3,
				0n,
				{
					allowance: permitParams3.allowance,
					spender: proxy3,
					deadline: permitParams3.deadline,
					signature: permitParams3.signature,
				},
				true,
				org.address, // Organization fee address
				sig3,
				getGasRefundData(),
			);

			// Execute third subscription
			await expect(
				system.executeSubscription(
					data3,
					ethers.parseEther("30"),
					frequency3,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.not.be.reverted;

			// Check allowances of proxies
			const allowanceFirst = await token.allowance(
				user.address,
				proxyAddr,
			);
			const allowanceSecond = await token.allowance(user.address, proxy2);
			const allowanceThird = await token.allowance(user.address, proxy3);

			expect(allowanceFirst).to.lt(ethers.parseEther("450")); // Used 50 from 500 (should be 450 left + gas refund)
			expect(allowanceFirst).to.gt(ethers.parseEther("449")); // slight margin due to gas refund
			expect(allowanceSecond).to.gt(
				allowance2 - ethers.parseEther("0.1"),
			); // Not used, should be near 300 (less gas refund for creation)
			expect(allowanceThird).to.lt(ethers.parseEther("120")); // used 30 from 150
			expect(allowanceThird).to.gt(ethers.parseEther("119")); // slight margin due to gas refund
		});
	});

	describe("increaseAllowance", () => {
		it("updates permit allowance via factory", async () => {
			const uuid = uuidToBytes16("CCCCCCCC-DDDD-EEEE-FFFF-111111111111");
			const allowance = ethers.parseEther("100");
			const freq = 86400n;

			const proxyAddr = await createNewProxy(system);
			const permitParams = await createPermitSignature(
				proxyAddr,
				allowance,
			);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};
			const sig = await createSubSig(data, freq);

			await system.createSubscription(
				data,
				freq,
				0n,
				{
					allowance: permitParams.allowance,
					spender: proxyAddr,
					deadline: permitParams.deadline,
					signature: permitParams.signature,
				},
				true,
				org.address, // Organization fee address
				sig,
				getGasRefundData(),
			);

			// Execute most of the allowance
			await system.executeSubscription(
				data,
				ethers.parseEther("95"),
				freq,
				100,
				{ organization: org.address, feeBps: 0 },
				getGasRefundData(),
			);

			// Move time forward
			await ethers.provider.send("evm_increaseTime", [2 * 86400]);

			// Try to execute again, should fail due to insufficient allowance
			await expect(
				system.executeSubscription(
					data,
					ethers.parseEther("50"),
					freq,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InsufficientAllowance");

			// Increase allowance with new permit
			const newAllowance = ethers.parseEther("500");
			const newPermitParams = await createPermitSignature(
				proxyAddr,
				newAllowance,
			);

			await expect(
				system.increaseAllowance(
					uuid,
					await token.getAddress(),
					user.address,
					{
						allowance: newPermitParams.allowance,
						spender: proxyAddr,
						deadline: newPermitParams.deadline,
						signature: newPermitParams.signature,
					},
					getGasRefundData(),
				),
			)
				.to.emit(system, "AllowanceIncreased")
				.withArgs(newAllowance, uuid);

			// Now execution should work
			await expect(
				system.executeSubscription(
					data,
					ethers.parseEther("50"),
					freq,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.not.be.reverted;
		});
	});
});
