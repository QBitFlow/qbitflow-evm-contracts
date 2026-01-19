const { expect } = require("chai");
const { ethers } = require("hardhat");
const { uuidToBytes16 } = require("./helpers/uuid");

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

describe("QBitFlowPaymentSystem - Subscription (Approval)", () => {
	let owner, user, merchant, org;
	let TokenNoPermit, token;
	let System, system;
	let provider;

	beforeEach(async () => {
		[owner, user, merchant, org] = await ethers.getSigners();
		provider = ethers.provider;

		// ERC20 without permit
		TokenNoPermit = await ethers.getContractFactory("MockERC20NoPermit");
		token = await TokenNoPermit.deploy("NoPermit", "NOP", TOKEN_DECIMALS);
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

	describe("createSubscription", () => {
		it("creates subscription with valid signature", async () => {
			const uuid = uuidToBytes16("11111111-1111-1111-1111-111111111111");
			const frequency = 86400n;
			const allowance = ethers.parseEther("200");

			// approve proxy in advance
			const proxyAddress = await createNewProxy(system);
			await token.connect(user).approve(proxyAddress, allowance);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};
			const sig = await createSubSig(data, frequency);

			// Call
			await expect(
				system.createSubscription(
					data,
					frequency,
					0n,
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
					org.address, // Organization fee address
					sig,
					getGasRefundData(),
				),
			).to.emit(system, "SubscriptionCreated");

			// Subscription struct check
			const sub = await system.getSubscription(uuid);
			expect(sub.signer).to.eq(user.address);
			expect(sub.active).to.be.true;
		});

		it("reverts with invalid signature", async () => {
			const uuid = uuidToBytes16("BADBAD00-1111-2222-3333-444444444444");
			const frequency = 86400n;
			const allowance = ethers.parseEther("200");
			const proxyAddress = await createNewProxy(system);
			await token.connect(user).approve(proxyAddress, allowance);

			const data = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid,
			};
			const sig = { v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash };

			await expect(
				system.createSubscription(
					data,
					frequency,
					0,
					{
						allowance,
						spender: proxyAddress,
						deadline: 0,
						signature: sig,
					},
					false,
					org.address, // Organization fee address
					sig,
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "ECDSAInvalidSignature()"); // openzeppelin error when trying to recover address

			// Now that we tried a bad sig, we want to try a sig from a different signer
			const badSig = await createSubSig(
				data,
				frequency,
				merchant, // different signer
			);
			await expect(
				system.createSubscription(
					data,
					frequency,
					0,
					{
						allowance,
						spender: proxyAddress,
						deadline: 0,
						signature: badSig,
					},
					false,
					org.address, // Organization fee address
					badSig,
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InvalidSignature()"); // Now it should revert with our custom error
		});

		it("should work with free trial", async () => {
			const uuid2 = uuidToBytes16("99999999-AAAA-BBBB-CCCC-DDDDDDDDDDDD");
			const frequency2 = 86400n;
			const allowance2 = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			await token.connect(user).approve(proxyAddr, allowance2);

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
					allowance: allowance2,
					spender: proxyAddr,
					deadline: 0,
					signature: { v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash },
				},
				false,
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
			).to.be.revertedWithCustomError(system, "PaymentNotDueYet()");

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

		it("reverts if trial period >= frequency", async () => {
			const uuid3 = uuidToBytes16("55555555-6666-7777-8888-999999999999");
			const frequency3 = 86400n;
			const allowance3 = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			await token.connect(user).approve(proxyAddr, allowance3);

			const data3 = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid: uuid3,
			};
			const sig3 = await createSubSig(data3, frequency3);

			// Create subscription with invalid free trial equal to frequency
			await expect(
				system.createSubscription(
					data3,
					frequency3,
					frequency3, // invalid, equal to frequency
					{
						allowance: allowance3,
						spender: proxyAddr,
						deadline: 0,
						signature: {
							v: 0,
							r: ethers.ZeroHash,
							s: ethers.ZeroHash,
						},
					},
					false,
					org.address, // Organization fee address
					sig3,
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InvalidTrialPeriod");

			// Create subscription with invalid free trial greater than frequency
			await expect(
				system.createSubscription(
					data3,
					frequency3,
					frequency3 + 1n, // invalid, greater than frequency
					{
						allowance: allowance3,
						spender: proxyAddr,
						deadline: 0,
						signature: {
							v: 0,
							r: ethers.ZeroHash,
							s: ethers.ZeroHash,
						},
					},
					false,
					org.address, // Organization fee address
					sig3,
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InvalidTrialPeriod");
		});

		it("reverts if frequency is too low", async () => {
			const uuid4 = uuidToBytes16("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE");
			const frequency4 = 3599n; // below minimum of 1 hour
			const allowance4 = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			await token.connect(user).approve(proxyAddr, allowance4);

			const data4 = {
				from: user.address,
				to: merchant.address,
				tokenAddress: await token.getAddress(),
				uuid: uuid4,
			};
			const sig4 = await createSubSig(data4, frequency4);

			// Create subscription with invalid frequency below minimum
			await expect(
				system.createSubscription(
					data4,
					frequency4,
					0n,
					{
						allowance: allowance4,
						spender: proxyAddr,
						deadline: 0,
						signature: {
							v: 0,
							r: ethers.ZeroHash,
							s: ethers.ZeroHash,
						},
					},
					false,
					org.address, // Organization fee address
					sig4,
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InvalidFrequency");
		});
	});

	describe("executeSubscription", () => {
		let uuid, frequency, allowance, data, sig;
		beforeEach(async () => {
			uuid = uuidToBytes16("22222222-3333-4444-5555-666666666666");
			frequency = 86400n;
			allowance = ethers.parseEther("500");

			const proxyAddr = await createNewProxy(system);
			await token.connect(user).approve(proxyAddr, allowance);

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
					allowance,
					spender: proxyAddr,
					deadline: 0,
					signature: { v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash },
				},
				false,
				org.address, // Organization fee address
				sig,
				getGasRefundData(),
			);
		});

		it("runs correctly and transfers funds, updates nextPaymentDue", async () => {
			const blockTimestamp = (await provider.getBlock("latest"))
				.timestamp;

			const amount = ethers.parseEther("100");
			const orgFee = { organization: org.address, feeBps: 100 }; // 1%
			const feeBps = 200; // 2%
			const beforeUserBal = await token.balanceOf(user.address);
			const beforeOrg = await token.balanceOf(org.address);
			const beforeMerchant = await token.balanceOf(merchant.address);
			const beforeOwner = await token.balanceOf(owner.address);

			await token.connect(user).transfer(user.address, 0); // ensure state mine

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
			const minFee = (amount * 100n) / 10000n; // 1% min enforced
			const ownerShare = (amount * BigInt(feeBps)) / 10000n;
			const orgShare =
				((amount - ownerShare) * BigInt(orgFee.feeBps)) / 10000n;
			const merchantShare = amount - ownerShare - orgShare;

			expect(afterOwner - beforeOwner).to.gt(ownerShare); // greater than the fees because of gas refund in tokens
			expect(afterOrg - beforeOrg).to.eq(orgShare);
			expect(afterMerchant - beforeMerchant).to.eq(merchantShare);
			// expect(beforeUserBal - afterUser).to.eq(amount);

			const sub = await system.getSubscription(uuid);
			expect(sub.nextPaymentDue).to.be.gte(
				BigInt(blockTimestamp) + frequency,
			);
		});

		it("reverts if subscription not active", async () => {
			const amount = ethers.parseEther("50");
			await system.forceCancelSubscription(uuid);
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					100,
					{ organization: org.address, feeBps: 100 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "SubscriptionNotActive()");
		});

		it("reverts if not due yet", async () => {
			const amount = ethers.parseEther("50");

			// The subscription was created with a free trial of 0, so it's due immediately
			// We execute a payment to move the nextPaymentDue forward
			await system.executeSubscription(
				data,
				amount,
				frequency,
				100,
				{ organization: org.address, feeBps: 100 },
				getGasRefundData(),
			);

			// Now try again immediately, should revert because the next payment is not due yet
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					100,
					{ organization: org.address, feeBps: 100 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "PaymentNotDueYet()");
		});

		it("reverts if amount exceeds allowance", async () => {
			const amount = ethers.parseEther("600"); // exceeds allowance of 500
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					100,
					{ organization: org.address, feeBps: 100 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InsufficientAllowance"); // reverts from fetchFromProxy (it returns false, which triggers this error)
		});

		it("reverts if amount is zero", async () => {
			const amount = 0n;
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					100,
					{ organization: org.address, feeBps: 100 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "ZeroAmount()");
		});

		it("should ensure the minimum feeBps is enforced", async () => {
			const amount = ethers.parseEther("100");
			const minFeeBps = 100; // 1%
			const belowMinFeeBps = 50; // 0.5%
			const beforeMerchant = await token.balanceOf(merchant.address);
			await expect(
				system.executeSubscription(
					data,
					amount,
					frequency,
					belowMinFeeBps,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.not.be.reverted;

			const afterMerchant = await token.balanceOf(merchant.address);
			const expectedMerchantShare =
				amount - (amount * BigInt(minFeeBps)) / 10000n; // enforce min fee
			expect(afterMerchant - beforeMerchant).to.eq(expectedMerchantShare);
		});
	});

	describe("cancelSubscription", () => {
		it("cancels and deletes subscription", async () => {
			const uuid = uuidToBytes16("77777777-8888-9999-AAAA-BBBBBBBBBBBB");
			const allowance = ethers.parseEther("300");
			const freq = 86400n;
			const proxy = await createNewProxy(system);
			await token.connect(user).approve(proxy, allowance);

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
					allowance,
					spender: proxy,
					deadline: 0,
					signature: { v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash },
				},
				false,
				org.address, // Organization fee address
				sig,
				getGasRefundData(),
			);

			// Cancel it.
			// Since the trial period is 0, the subscription is due for immediate payment, so cannot be cancelled before first payment.

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
			const message = {
				uuid: data.uuid,
			};
			const cancelSig = ethers.Signature.from(
				await user.signTypedData(domain, types, message),
			);

			await expect(
				system.cancelSubscription(uuid, cancelSig),
			).to.be.revertedWith("Subscription due for payment, cannot cancel");

			// Execute first payment to move nextPaymentDue forward
			await system.executeSubscription(
				data,
				ethers.parseEther("10"),
				freq,
				100,
				{ organization: org.address, feeBps: 0 },
				getGasRefundData(),
			);

			// Now we can cancel
			await expect(system.cancelSubscription(uuid, cancelSig)).to.not.be
				.reverted;

			const sub = await system.getSubscription(uuid);
			expect(sub.active).to.be.false;
		});
	});

	describe("increaseAllowance", () => {
		it("updates allowance via factory", async () => {
			const uuid = uuidToBytes16("CCCCCCCC-DDDD-EEEE-FFFF-111111111111");
			const allowance = ethers.parseEther("100");
			const freq = 86400n;

			const proxyAddr = await createNewProxy(system);
			await token.connect(user).approve(proxyAddr, allowance);

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
					allowance,
					spender: proxyAddr,
					deadline: 0,
					signature: { v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash },
				},
				false,
				org.address, // Organization fee address
				sig,
				getGasRefundData(),
			);

			// Since the createSubscription gas fees have been refunded, the remaining allowance is slightly less than the initial allowance
			// So we execute a payment that uses up most of the allowance

			// Execute the subscription (for the full amount) so that we can then increase the allowance
			await system.executeSubscription(
				data,
				ethers.parseEther("95"),
				freq,
				100,
				{ organization: org.address, feeBps: 0 },
				getGasRefundData(),
			);

			// Increase the time so that nextPaymentDue is in the past
			await ethers.provider.send("evm_increaseTime", [2 * 86400]);

			// Try to execute again, should revert because allowance is too low
			await expect(
				system.executeSubscription(
					data,
					ethers.parseEther("50"), // try to pay 50 but remaining is less than 5
					freq,
					100,
					{ organization: org.address, feeBps: 0 },
					getGasRefundData(),
				),
			).to.be.revertedWithCustomError(system, "InsufficientAllowance"); // reverts from fetchFromProxy (it returns false, which triggers this error)

			// Now increase allowance

			const newAllowance = ethers.parseEther("500");
			await token.connect(user).approve(proxyAddr, newAllowance);

			await expect(
				system.increaseAllowance(
					uuid,
					await token.getAddress(),
					user.address,
					{
						allowance: newAllowance,
						spender: proxyAddr,
						deadline: 0,
						signature: {
							v: 0,
							r: ethers.ZeroHash,
							s: ethers.ZeroHash,
						},
					},
					getGasRefundData(),
				),
			)
				.to.emit(system, "AllowanceIncreased")
				.withArgs(newAllowance, uuid);

			// Now try to execute again, should work now
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
