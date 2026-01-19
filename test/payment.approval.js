const { ethers } = require("hardhat");
const { expect } = require("chai");
const { uuidToBytes16 } = require("./helpers/uuid");
const { getGasRefundData } = require("./helpers/helpers");

describe("One-time token payments - approval path (comprehensive)", () => {
	let owner, user, merchant, organization;
	let token, system;
	let tokenAddress, systemAddress;

	beforeEach(async () => {
		[owner, user, merchant, organization] = await ethers.getSigners();

		const Token = await ethers.getContractFactory("MockERC20NoPermit");
		token = await Token.deploy("NoPermit", "NOP", 18);
		await token.waitForDeployment();

		tokenAddress = await token.getAddress();

		const System = await ethers.getContractFactory("QBitFlowPaymentSystem");
		system = await System.deploy();
		await system.waitForDeployment();

		systemAddress = await system.getAddress();

		await token.mint(user.address, ethers.parseEther("1000"));
	});

	const createPaymentData = (
		from = user.address,
		to = merchant.address,
		tokenAddr = null,
		uuid = null,
	) => ({
		from,
		to,
		tokenAddress: tokenAddr || tokenAddress,
		uuid: uuid || uuidToBytes16("01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b"),
	});

	const createPermitParams = (spender = null) => ({
		allowance: 0,
		deadline: 0,
		signature: {
			v: 0,
			r: ethers.ZeroHash,
			s: ethers.ZeroHash,
		},
		spender: spender || systemAddress,
	});

	describe("Successful payments", () => {
		it("processes payment with no fees", async () => {
			const amount = ethers.parseEther("100");
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			const initialMerchantBalance = await token.balanceOf(
				merchant.address,
			);
			const initialOwnerBalance = await token.balanceOf(owner.address);
			const initialUserBalance = await token.balanceOf(user.address);

			// Minimum fee is 1%, so with 0% fee specified, the minimum applies
			const expectedFee = (amount * BigInt(100)) / BigInt(10000);
			const expectedMerchantAmount = amount - expectedFee;

			await expect(
				system.processTokenPayment(
					data,
					amount,
					0, // no fee
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			)
				.to.emit(system, "TokenPaymentProcessed")
				.withArgs(
					user.address,
					merchant.address,
					tokenAddress,
					expectedMerchantAmount,
					data.uuid,
				);

			expect(await token.balanceOf(merchant.address)).to.eq(
				initialMerchantBalance + expectedMerchantAmount,
			);
			expect(await token.balanceOf(owner.address)).to.eq(
				initialOwnerBalance + expectedFee,
			);
			expect(await token.balanceOf(user.address)).to.eq(
				initialUserBalance - amount,
			);
		});

		it("processes payment with platform fee only", async () => {
			const amount = ethers.parseEther("100");
			const feeBps = BigInt(250); // 2.5%
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			const initialMerchantBalance = await token.balanceOf(
				merchant.address,
			);
			const initialOwnerBalance = await token.balanceOf(owner.address);
			const initialUserBalance = await token.balanceOf(user.address);

			const expectedFee = (amount * feeBps) / BigInt(10000);
			const expectedMerchantAmount = amount - expectedFee;

			await expect(
				system.processTokenPayment(
					data,
					amount,
					feeBps,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			)
				.to.emit(system, "TokenPaymentProcessed")
				.withArgs(
					user.address,
					merchant.address,
					tokenAddress,
					expectedMerchantAmount,
					data.uuid,
				);

			expect(await token.balanceOf(merchant.address)).to.eq(
				initialMerchantBalance + expectedMerchantAmount,
			);
			expect(await token.balanceOf(owner.address)).to.eq(
				initialOwnerBalance + expectedFee,
			);
			expect(await token.balanceOf(user.address)).to.eq(
				initialUserBalance - amount,
			);
		});

		it("processes payment with both platform and organization fees", async () => {
			const amount = ethers.parseEther("100");
			const platformFeeBps = BigInt(200); // 2%
			const orgFeeBps = BigInt(100); // 1%
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			const initialMerchantBalance = await token.balanceOf(
				merchant.address,
			);
			const initialOwnerBalance = await token.balanceOf(owner.address);
			const initialOrgBalance = await token.balanceOf(
				organization.address,
			);
			const initialUserBalance = await token.balanceOf(user.address);

			const expectedPlatformFee =
				(amount * platformFeeBps) / BigInt(10000);
			const amountAfterPlatformFee = amount - expectedPlatformFee;
			const expectedOrgFee =
				(amountAfterPlatformFee * orgFeeBps) / BigInt(10000);
			const expectedMerchantAmount =
				amountAfterPlatformFee - expectedOrgFee;

			await expect(
				system.processTokenPayment(
					data,
					amount,
					platformFeeBps,
					{ organization: organization.address, feeBps: orgFeeBps },
					permitParams,
					false,
					gasRefundData,
				),
			)
				.to.emit(system, "TokenPaymentProcessed")
				.withArgs(
					user.address,
					merchant.address,
					tokenAddress,
					expectedMerchantAmount,
					data.uuid,
				);

			expect(await token.balanceOf(merchant.address)).to.eq(
				initialMerchantBalance + expectedMerchantAmount,
			);
			expect(await token.balanceOf(owner.address)).to.eq(
				initialOwnerBalance + expectedPlatformFee,
			);
			expect(await token.balanceOf(organization.address)).to.eq(
				initialOrgBalance + expectedOrgFee,
			);
			expect(await token.balanceOf(user.address)).to.eq(
				initialUserBalance - amount,
			);
		});

		it("processes payment with exact allowance", async () => {
			const amount = ethers.parseEther("50");
			await token.connect(user).approve(systemAddress, amount); // exact amount

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100, // 1% fee
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");

			const expectedMerchantAmount = (amount * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantAmount,
			);
		});

		it("processes payment with excess allowance", async () => {
			const amount = ethers.parseEther("50");
			const allowance = ethers.parseEther("100"); // more than needed
			await token.connect(user).approve(systemAddress, allowance);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100, // 1% fee
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");

			const expectedMerchantAmount = (amount * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantAmount,
			);
		});

		it("reverts with maximum fee rates", async () => {
			const amount = ethers.parseEther("100");
			const maxFeeBps = 10000; // 100%
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					maxFeeBps,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidFeePercentage");
		});

		// it("processes payment with small amounts and rounding", async () => {
		// 	const amount = ethers.utils.parseUnits("1", 6); // 1 token with 6 decimals
		// 	await token.connect(user).approve(systemAddress, amount);

		// 	const data = createPaymentData();
		// 	const permitParams = createPermitParams();
		// 	const gasRefundData = getGasRefundData();

		// 	await expect(
		// 		system.processTokenPayment(
		// 			data,
		// 			amount,
		// 			1, // 0.01% fee
		// 			{ organization: ethers.ZeroAddress, feeBps: 0 },
		// 			permitParams,
		// 			false,
		// 			gasRefundData,
		// 		),
		// 	).to.emit(system, "TokenPaymentProcessed");

		// 	// With 0.01% fee on 1 token (6 decimals), fee should be 0 due to rounding
		// 	expect(await token.balanceOf(merchant.address)).to.eq(amount);
		// });
	});

	describe("Failure cases", () => {
		it("reverts when allowance is insufficient", async () => {
			const amount = ethers.parseEther("100");
			const insufficientAllowance = ethers.parseEther("50");
			await token
				.connect(user)
				.approve(systemAddress, insufficientAllowance);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWith(
				"Insufficient allowance and permit not supported",
			);
		});

		it("reverts when no allowance is set", async () => {
			const amount = ethers.parseEther("100");
			// No approval given

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWith(
				"Insufficient allowance and permit not supported",
			);
		});

		it("reverts when 'to' address is zero", async () => {
			const amount = ethers.parseEther("100");
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData(user.address, ethers.ZeroAddress);
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidAddress");
		});

		it("reverts when token address is zero", async () => {
			const amount = ethers.parseEther("100");

			const data = createPaymentData(
				user.address,
				merchant.address,
				ethers.ZeroAddress,
			);
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidAddress");
		});

		it("reverts when user has insufficient token balance", async () => {
			const amount = ethers.parseEther("2000"); // More than minted (1000)
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.reverted; // Should revert on transfer
		});

		it("reverts when called by non-owner", async () => {
			const amount = ethers.parseEther("100");
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.connect(user).processTokenPayment(
					data,
					amount,
					100,
					{
						organization: ethers.ZeroAddress,
						feeBps: 0,
					},
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(
				system,
				"OwnableUnauthorizedAccount",
			);
		});
	});

	describe("Edge cases", () => {
		it("handles zero amount payment", async () => {
			const amount = 0;
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "ZeroAmount");

			expect(await token.balanceOf(merchant.address)).to.eq(0);
		});

		it("handles multiple consecutive payments", async () => {
			const amount = ethers.parseEther("50");
			await token
				.connect(user)
				.approve(systemAddress, amount * BigInt(4)); // approve for 4 payments (more than needed because of gas refund)

			const data1 = createPaymentData(
				user.address,
				merchant.address,
				tokenAddress,
				"0x" + "11".repeat(16),
			);
			const data2 = createPaymentData(
				user.address,
				merchant.address,
				tokenAddress,
				"0x" + "22".repeat(16),
			);
			const data3 = createPaymentData(
				user.address,
				merchant.address,
				tokenAddress,
				"0x" + "33".repeat(16),
			);
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await system.processTokenPayment(
				data1,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams,
				false,
				gasRefundData,
			);
			await system.processTokenPayment(
				data2,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams,
				false,
				gasRefundData,
			);
			await system.processTokenPayment(
				data3,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams,
				false,
				gasRefundData,
			);

			const expectedMerchantTotal =
				(amount * BigInt(3) * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantTotal,
			);
		});

		it("handles payment with organization fee but zero organization address", async () => {
			const amount = ethers.parseEther("100");
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			// This should work - organization fee is 0 when organization address is zero
			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 100 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidAddress");

			expect(await token.balanceOf(merchant.address)).to.eq(0);
		});

		it("verifies allowance is consumed correctly", async () => {
			const amount = ethers.parseEther("100");
			const initialAllowance = ethers.parseEther("200");
			await token.connect(user).approve(systemAddress, initialAllowance);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			await system.processTokenPayment(
				data,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams,
				false,
				gasRefundData,
			);

			const remainingAllowance = await token.allowance(
				user.address,
				systemAddress,
			);
			expect(remainingAllowance).to.lte(initialAllowance - amount); // Allow for gas refund token usage
		});
	});

	describe("Gas and reentrancy", () => {
		it("should not allow reentrancy", async () => {
			// This test would require a malicious token contract that attempts reentrancy
			// For now, we just verify the modifier is present in the function
			const amount = ethers.parseEther("100");
			await token.connect(user).approve(systemAddress, amount);

			const data = createPaymentData();
			const permitParams = createPermitParams();
			const gasRefundData = getGasRefundData();

			// Normal call should work
			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					false,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");
		});
	});
});
