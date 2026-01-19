const { expect } = require("chai");
const { ethers } = require("hardhat");
const { uuidToBytes16 } = require("./helpers/uuid");
const { signERC2612Permit } = require("./helpers/permit");
const { TOKEN_DECIMALS } = require("./helpers/constants");
const { getGasRefundData } = require("./helpers/helpers");

const createNewProxy = async (system) => {
	const tx = await system.createNewProxy();
	const rc = await tx.wait();
	return rc.logs
		.map((log) => system.interface.parseLog(log))
		.find((e) => e.name === "ProxyCreated")?.args[0];
};

describe("QBitFlowPaymentSystem - Pay-As-You-Go Subscriptions", () => {
	let owner, user, merchant, org;
	let TokenNoPermit, TokenPermit, tokenNoPermit, tokenPermit;
	let System, system;
	let provider;

	beforeEach(async () => {
		[owner, user, merchant, org] = await ethers.getSigners();
		provider = ethers.provider;

		// ERC20 without permit
		TokenNoPermit = await ethers.getContractFactory("MockERC20NoPermit");
		tokenNoPermit = await TokenNoPermit.deploy(
			"NoPermit",
			"NOP",
			TOKEN_DECIMALS,
		);
		await tokenNoPermit.waitForDeployment();

		// ERC20 with permit
		TokenPermit = await ethers.getContractFactory("MockERC20Permit");
		tokenPermit = await TokenPermit.deploy(
			"PermitToken",
			"PRM",
			TOKEN_DECIMALS,
		);
		await tokenPermit.waitForDeployment();

		// Payment system
		System = await ethers.getContractFactory("QBitFlowPaymentSystem");
		system = await System.deploy();
		await system.waitForDeployment();

		// Mint tokens to user
		await tokenNoPermit.mint(user.address, ethers.parseEther("1000"));
		await tokenPermit.mint(user.address, ethers.parseEther("1000"));
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
		};
	}

	describe("Pay-As-You-Go with Approval", () => {
		describe("createPayAsYouGoSubscription", () => {
			it("creates pay-as-you-go subscription with approval", async () => {
				const uuid = uuidToBytes16(
					"11111111-1111-1111-1111-111111111111",
				);
				const frequency = 86400n; // 1 day
				const allowance = ethers.parseEther("500");

				const proxyAddress = await createNewProxy(system);
				await tokenNoPermit
					.connect(user)
					.approve(proxyAddress, allowance);

				const data = {
					from: user.address,
					to: merchant.address,
					tokenAddress: await tokenNoPermit.getAddress(),
					uuid,
				};

				const sig = await createSubSig(data, frequency);

				const blockTimestamp = (await provider.getBlock("latest"))
					.timestamp;

				await expect(
					system.createPayAsYouGoSubscription(
						data,
						frequency,
						{
							allowance,
							spender: proxyAddress,
							deadline: 0n,
							signature: {
								v: 0,
								r: ethers.ZeroHash,
								s: ethers.ZeroHash,
							},
						},
						false, // permitSupported
						org.address, // Organization fee address, matching the signed message
						sig,
						getGasRefundData(),
					),
				).to.emit(system, "PayAsYouGoSubscriptionCreated");

				// Check subscription is created
				const sub = await system.getSubscription(uuid);
				expect(sub.signer).to.eq(user.address);
				expect(sub.active).to.be.true;
				expect(sub.nextPaymentDue).to.be.gte(
					BigInt(blockTimestamp) + frequency,
				);
			});

			it("reverts with invalid frequency", async () => {
				const uuid = uuidToBytes16(
					"11111111-1111-1111-1111-111111111111",
				);
				const frequency = 3599n; // Below minimum
				const allowance = ethers.parseEther("500");

				const proxyAddress = await createNewProxy(system);
				await tokenNoPermit
					.connect(user)
					.approve(proxyAddress, allowance);

				const data = {
					from: user.address,
					to: merchant.address,
					tokenAddress: await tokenNoPermit.getAddress(),
					uuid,
				};

				const sig = await createSubSig(data, frequency);

				await expect(
					system.createPayAsYouGoSubscription(
						data,
						frequency,
						{
							allowance,
							spender: proxyAddress,
							deadline: 0n,
							signature: {
								v: 0,
								r: ethers.ZeroHash,
								s: ethers.ZeroHash,
							},
						},
						false,
						org.address, // Organization fee address, matching the signed message
						sig,
						getGasRefundData(),
					),
				).to.be.revertedWithCustomError(system, "InvalidFrequency");
			});
		});

		describe("executePayAsYouGoPayment", () => {
			let uuid, frequency, allowance, data, proxyAddr;

			beforeEach(async () => {
				uuid = uuidToBytes16("11111111-1111-1111-1111-111111111111");
				frequency = 86400n;
				allowance = ethers.parseEther("500");

				proxyAddr = await createNewProxy(system);
				await tokenNoPermit.connect(user).approve(proxyAddr, allowance);

				data = {
					from: user.address,
					to: merchant.address,
					tokenAddress: await tokenNoPermit.getAddress(),
					uuid,
				};

				const sig = await createSubSig(data, frequency);

				await system.createPayAsYouGoSubscription(
					data,
					frequency,
					{
						allowance,
						spender: proxyAddr,
						deadline: 0n,
						signature: {
							v: 0,
							r: ethers.ZeroHash,
							s: ethers.ZeroHash,
						},
					},
					false,
					org.address, // Organization fee address, matching the signed message
					sig,
					getGasRefundData(),
				);

				// Move time forward so payment is due
				await ethers.provider.send("evm_increaseTime", [86400]);
			});

			it("executes payment correctly and updates nextPaymentDue", async () => {
				const amount = ethers.parseEther("100");
				const feeBps = 200; // 2%
				const orgFee = { organization: org.address, feeBps: 150 }; // 1.5%

				const beforeUser = await tokenNoPermit.balanceOf(user.address);
				const beforeMerchant = await tokenNoPermit.balanceOf(
					merchant.address,
				);
				const beforeOwner = await tokenNoPermit.balanceOf(
					owner.address,
				);
				const beforeOrg = await tokenNoPermit.balanceOf(org.address);

				const blockTimestamp = (await provider.getBlock("latest"))
					.timestamp;

				await expect(
					system.executePayAsYouGoPayment(
						data,
						amount,
						frequency,
						feeBps,
						orgFee,
						false, // not stopped
						getGasRefundData(),
					),
				).to.emit(system, "SubscriptionPaymentProcessed");

				const afterUser = await tokenNoPermit.balanceOf(user.address);
				const afterMerchant = await tokenNoPermit.balanceOf(
					merchant.address,
				);
				const afterOwner = await tokenNoPermit.balanceOf(owner.address);
				const afterOrg = await tokenNoPermit.balanceOf(org.address);

				// Calculate expected amounts
				const ownerShare = (amount * BigInt(feeBps)) / 10000n;
				const orgShare =
					((amount - ownerShare) * BigInt(orgFee.feeBps)) / 10000n;
				const merchantShare = amount - ownerShare - orgShare;

				expect(afterOwner - beforeOwner).to.gt(ownerShare); // Greater due to gas refund
				expect(afterOrg - beforeOrg).to.eq(orgShare);
				expect(afterMerchant - beforeMerchant).to.eq(merchantShare);

				// Check nextPaymentDue is updated from current timestamp
				const sub = await system.getSubscription(uuid);
				expect(sub.nextPaymentDue).to.be.gte(
					BigInt(blockTimestamp) + frequency,
				);
			});

			it("stops subscription when stopped=true", async () => {
				const amount = ethers.parseEther("50");

				// executePayAsYouGoPayment should emit SubscriptionCancelled event, and also GasRefundFailed if gas refund fails
				await expect(
					system.executePayAsYouGoPayment(
						data,
						amount,
						frequency,
						100,
						{ organization: org.address, feeBps: 0 },
						true, // stopped
						getGasRefundData(),
					),
				)
					.to.emit(system, "SubscriptionPaymentProcessed")
					.and.to.emit(system, "GasRefundFailed"); // Stream is cancelled within the function (stopped=true), so gas refund modifier won't be able to fetch funds from the proxy, leading to GasRefundFailed event. The refund is done manually in the function before cancelling the stream.

				// Subscription should be deleted
				const sub = await system.getSubscription(uuid);
				expect(sub.active).to.be.false;
			});

			it("reverts if insufficient allowance", async () => {
				const amount = ethers.parseEther("600"); // Exceeds allowance

				await expect(
					system.executePayAsYouGoPayment(
						data,
						amount,
						frequency,
						100,
						{ organization: org.address, feeBps: 0 },
						false,
						getGasRefundData(),
					),
				).to.be.revertedWithCustomError(
					system,
					"InsufficientAllowance",
				);
			});

			it("reverts if payment not due yet", async () => {
				// Execute one payment first
				await system.executePayAsYouGoPayment(
					data,
					ethers.parseEther("50"),
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					false,
					getGasRefundData(),
				);

				// Try to execute again immediately
				await expect(
					system.executePayAsYouGoPayment(
						data,
						ethers.parseEther("50"),
						frequency,
						100,
						{ organization: org.address, feeBps: 0 },
						false,
						getGasRefundData(),
					),
				).to.be.revertedWithCustomError(system, "PaymentNotDueYet");
			});
		});
	});

	describe("Pay-As-You-Go with Permit", () => {
		describe("createPayAsYouGoSubscription", () => {
			it("creates pay-as-you-go subscription with permit", async () => {
				const uuid = uuidToBytes16(
					"11111111-1111-1111-1111-111111111111",
				);
				const frequency = 86400n;
				const allowance = ethers.parseEther("500");

				const proxyAddress = await createNewProxy(system);
				const permitParams = await createPermitSignature(
					proxyAddress,
					allowance,
				);

				const data = {
					from: user.address,
					to: merchant.address,
					tokenAddress: await tokenPermit.getAddress(),
					uuid,
				};

				const sig = await createSubSig(data, frequency);

				await expect(
					system.createPayAsYouGoSubscription(
						data,
						frequency,
						{
							allowance: permitParams.allowance,
							spender: proxyAddress,
							deadline: permitParams.deadline,
							signature: permitParams.signature,
						},
						true, // permitSupported
						org.address, // Organization fee address, matching the signed message
						sig,
						getGasRefundData(),
					),
				).to.emit(system, "PayAsYouGoSubscriptionCreated");

				// Check allowance was set via permit
				const proxyAllowance = await tokenPermit.allowance(
					user.address,
					proxyAddress,
				);
				expect(proxyAllowance).to.gt(ethers.parseEther("499.99")); // slight margin due to gas refund after creation of the subscription
			});

			it("reverts with invalid permit signature", async () => {
				const uuid = uuidToBytes16(
					"11111111-1111-1111-1111-111111111111",
				);
				const frequency = 86400n;
				const allowance = ethers.parseEther("500");

				const proxyAddress = await createNewProxy(system);

				const data = {
					from: user.address,
					to: merchant.address,
					tokenAddress: await tokenPermit.getAddress(),
					uuid,
				};

				const sig = await createSubSig(data, frequency);

				// Bad permit params
				const badPermitParams = {
					allowance,
					spender: proxyAddress,
					deadline: Math.floor(Date.now() / 1000) + 8400,
					signature: {
						v: 27,
						r: ethers.ZeroHash,
						s: ethers.ZeroHash,
					},
				};

				await expect(
					system.createPayAsYouGoSubscription(
						data,
						frequency,
						badPermitParams,
						true,
						org.address, // Organization fee address, matching the signed message
						sig,
						getGasRefundData(),
					),
				).to.be.reverted;
			});
		});

		describe("executePayAsYouGoPayment", () => {
			let uuid, frequency, allowance, data, proxyAddr;

			beforeEach(async () => {
				uuid = uuidToBytes16("11111111-1111-1111-1111-111111111111");
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
					tokenAddress: await tokenPermit.getAddress(),
					uuid,
				};

				const sig = await createSubSig(data, frequency);

				await system.createPayAsYouGoSubscription(
					data,
					frequency,
					{
						allowance: permitParams.allowance,
						spender: proxyAddr,
						deadline: permitParams.deadline,
						signature: permitParams.signature,
					},
					true,
					org.address, // Organization fee address, matching the signed message
					sig,
					getGasRefundData(),
				);

				// Move time forward so payment is due
				await ethers.provider.send("evm_increaseTime", [86400]);
			});

			it("executes payment with permit correctly", async () => {
				const amount = ethers.parseEther("100");
				const feeBps = 200;
				const orgFee = { organization: org.address, feeBps: 100 };

				const beforeMerchant = await tokenPermit.balanceOf(
					merchant.address,
				);

				await expect(
					system.executePayAsYouGoPayment(
						data,
						amount,
						frequency,
						feeBps,
						orgFee,
						false,
						getGasRefundData(),
					),
				).to.emit(system, "SubscriptionPaymentProcessed");

				const afterMerchant = await tokenPermit.balanceOf(
					merchant.address,
				);

				// Calculate expected merchant share
				const ownerShare = (amount * BigInt(feeBps)) / 10000n;
				const orgShare =
					((amount - ownerShare) * BigInt(orgFee.feeBps)) / 10000n;
				const merchantShare = amount - ownerShare - orgShare;

				expect(afterMerchant - beforeMerchant).to.eq(merchantShare);
			});

			it("can execute multiple payments until allowance exhausted", async () => {
				const amount = ethers.parseEther("100");

				// Execute first payment
				await system.executePayAsYouGoPayment(
					data,
					amount,
					frequency,
					100,
					{ organization: org.address, feeBps: 0 },
					false,
					getGasRefundData(),
				);

				// Move time forward
				await ethers.provider.send("evm_increaseTime", [86400]);

				// Execute second payment
				await expect(
					system.executePayAsYouGoPayment(
						data,
						amount,
						frequency,
						100,
						{ organization: org.address, feeBps: 0 },
						false,
						getGasRefundData(),
					),
				).to.not.be.reverted;

				// Move time forward
				await ethers.provider.send("evm_increaseTime", [86400]);

				// Try to execute more than remaining allowance
				await expect(
					system.executePayAsYouGoPayment(
						data,
						ethers.parseEther("400"), // Should exceed remaining
						frequency,
						100,
						{ organization: org.address, feeBps: 0 },
						false,
						getGasRefundData(),
					),
				).to.be.revertedWithCustomError(
					system,
					"InsufficientAllowance",
				);
			});
		});
	});

	describe("validateCancelSubscription", () => {
		it("validates cancel signature correctly", async () => {
			const uuid = uuidToBytes16("11111111-1111-1111-1111-111111111111");
			const frequency = 86400n;
			const allowance = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			await tokenNoPermit.connect(user).approve(proxyAddr, allowance);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await tokenNoPermit.getAddress(),
				uuid,
			};

			const sig = await createSubSig(data, frequency);

			await system.createPayAsYouGoSubscription(
				data,
				frequency,
				{
					allowance,
					spender: proxyAddr,
					deadline: 0n,
					signature: { v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash },
				},
				false,
				org.address, // Organization fee address, matching the signed message
				sig,
				getGasRefundData(),
			);

			// Create cancel signature
			const { chainId } = await provider.getNetwork();
			const domain = {
				name: "QBitFlow",
				version: "1",
				chainId,
				verifyingContract: await system.getAddress(),
			};
			const types = {
				cancelSubscription: [{ name: "uuid", type: "bytes16" }],
			};
			const message = { uuid };
			const cancelSig = ethers.Signature.from(
				await user.signTypedData(domain, types, message),
			);

			// Should not revert with valid signature
			await expect(system.validateCancelSubscription(uuid, cancelSig)).to
				.not.be.reverted;

			// Should revert with invalid signature
			const badSig = { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };
			await expect(
				system.validateCancelSubscription(uuid, badSig),
			).to.be.revertedWithCustomError(system, "ECDSAInvalidSignature");

			// Try with different signer
			const badSigner = merchant;
			const badCancelSig = ethers.Signature.from(
				await badSigner.signTypedData(domain, types, message),
			);
			await expect(
				system.validateCancelSubscription(uuid, badCancelSig),
			).to.be.revertedWithCustomError(system, "InvalidSignature");
		});
	});
});
