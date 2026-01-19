const { ethers } = require("hardhat");

const hre = require("hardhat");
const { expect } = require("chai");
const { uuidToBytes16 } = require("./helpers/uuid");
const { signERC2612Permit } = require("./helpers/permit");
const { getGasRefundData } = require("./helpers/helpers");

describe("One-time token payments - permit path (comprehensive)", () => {
	let owner, user, merchant, organization;
	let token, system;
	let tokenAddress, systemAddress;

	let provider;

	beforeEach(async () => {
		[owner, user, merchant, organization] = await ethers.getSigners();

		const Token = await ethers.getContractFactory("MockERC20Permit");
		token = await Token.deploy("PermitToken", "PRM", 18);
		await token.waitForDeployment();

		tokenAddress = await token.getAddress();

		const System = await ethers.getContractFactory("QBitFlowPaymentSystem");
		system = await System.deploy();
		await system.waitForDeployment();

		systemAddress = await system.getAddress();

		await token.mint(user.address, ethers.parseEther("1000"));

		provider = hre.ethers.provider;
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

	const createPermitSignature = async (
		spender = systemAddress,
		allowance = ethers.parseEther("100"),
		deadline = null,
		signer = user,
	) => {
		const currentBlock = await provider.getBlock("latest");
		const finalDeadline = deadline || currentBlock.timestamp + 3600;

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
			spender,
		};
	};

	describe("Successful payments", () => {
		it("processes payment with no fees using permit", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

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
					true,
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

		it("processes payment with platform fee only using permit", async () => {
			const amount = ethers.parseEther("100");
			const feeBps = BigInt(250); // 2.5%
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

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
					true,
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

		it("processes payment with organization fee only using permit", async () => {
			const amount = ethers.parseEther("100");
			const orgFeeBps = BigInt(150); // 1.5%
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			const initialMerchantBalance = await token.balanceOf(
				merchant.address,
			);
			const initialOrgBalance = await token.balanceOf(
				organization.address,
			);
			const initialUserBalance = await token.balanceOf(user.address);

			// Minimum platform fee is 1%
			const expectedPlatformFee = (amount * BigInt(100)) / BigInt(10000);
			const amountAfterPlatformFee = amount - expectedPlatformFee;
			const expectedOrgFee =
				(amountAfterPlatformFee * orgFeeBps) / BigInt(10000);
			const expectedMerchantAmount =
				amountAfterPlatformFee - expectedOrgFee;

			await expect(
				system.processTokenPayment(
					data,
					amount,
					0, // no platform fee (but minimum applies)
					{ organization: organization.address, feeBps: orgFeeBps },
					permitParams,
					true,
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
			expect(await token.balanceOf(organization.address)).to.eq(
				initialOrgBalance + expectedOrgFee,
			);
			expect(await token.balanceOf(user.address)).to.eq(
				initialUserBalance - amount,
			);
		});

		it("processes payment with both platform and organization fees using permit", async () => {
			const amount = ethers.parseEther("100");
			const platformFeeBps = BigInt(200); // 2%
			const orgFeeBps = BigInt(100); // 1%
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

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
					true,
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

		it("processes payment with exact permit allowance", async () => {
			const amount = ethers.parseEther("50");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			); // exact amount

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100, // 1% fee
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");

			const expectedMerchantAmount = (amount * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantAmount,
			);
		});

		it("processes payment with excess permit allowance", async () => {
			const amount = ethers.parseEther("50");
			const allowance = ethers.parseEther("100"); // more than needed
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				allowance,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100, // 1% fee
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");

			const expectedMerchantAmount = (amount * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantAmount,
			);
		});

		it("processes payment with permit near deadline", async () => {
			const amount = ethers.parseEther("100");
			const currentBlock = await provider.getBlock("latest");
			const nearDeadline = currentBlock.timestamp + 60; // 1 minute from now

			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
				nearDeadline,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");

			const expectedMerchantAmount = (amount * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantAmount,
			);
		});

		it("processes multiple consecutive payments with different permits", async () => {
			const amount = ethers.parseEther("50");
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
			const gasRefundData = getGasRefundData();

			const permitParams1 = await createPermitSignature(
				systemAddress,
				amount,
			);
			await system.processTokenPayment(
				data1,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams1,
				true,
				gasRefundData,
			);

			const permitParams2 = await createPermitSignature(
				systemAddress,
				amount,
			);

			await system.processTokenPayment(
				data2,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams2,
				true,
				gasRefundData,
			);

			const permitParams3 = await createPermitSignature(
				systemAddress,
				amount,
			);

			await system.processTokenPayment(
				data3,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams3,
				true,
				gasRefundData,
			);

			const expectedMerchantTotal =
				(amount * BigInt(3) * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantTotal,
			);
		});
	});

	describe("Failure cases", () => {
		it("reverts when permit spender is not the contract", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				merchant.address,
				amount,
			); // wrong spender

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.revertedWith("Permit spender mismatch");
		});

		it("reverts when permit signature is invalid", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();

			// Create invalid permit with wrong signature
			const permitParams = {
				allowance: amount,
				deadline: Math.floor(Date.now() / 1000) + 3600,
				signature: {
					v: 27,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				spender: systemAddress,
			};

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidSignature");
		});

		it("reverts when permit is expired", async () => {
			const amount = ethers.parseEther("100");
			const expiredDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago

			const data = createPaymentData();
			const gasRefundData = getGasRefundData();

			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
				expiredDeadline,
			);

			// This will fail during permit signing due to expired deadline
			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.rejected;
		});

		it("reverts when permit allowance is insufficient", async () => {
			const amount = ethers.parseEther("100");
			const insufficientAllowance = ethers.parseEther("50");

			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				insufficientAllowance,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.reverted; // Should revert on transferFrom due to insufficient allowance
		});

		it("reverts when 'to' address is zero", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData(user.address, ethers.ZeroAddress);
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
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
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidAddress");
		});

		it("reverts when user has insufficient token balance", async () => {
			const amount = ethers.parseEther("2000"); // More than minted (1000)
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.reverted; // Should revert on transfer
		});

		it("reverts when called by non-owner", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			await expect(
				system
					.connect(user)
					.processTokenPayment(
						data,
						amount,
						100,
						{ organization: ethers.ZeroAddress, feeBps: 0 },
						permitParams,
						true,
						gasRefundData,
					),
			).to.be.revertedWithCustomError(
				system,
				"OwnableUnauthorizedAccount",
			);
		});

		it("reverts with maximum fee rates", async () => {
			const amount = ethers.parseEther("100");
			const maxFeeBps = 10000; // 100%
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					maxFeeBps,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidFeePercentage");
		});
	});

	describe("Edge cases", () => {
		it("reverts with zero amount payment", async () => {
			const amount = 0;
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				ethers.parseEther("1"),
			); // Valid permit but zero amount

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "ZeroAmount");
		});

		it("handles permit with organization fee but zero organization address", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 100 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidAddress");
		});

		it("verifies permit allowance is consumed correctly", async () => {
			const amount = ethers.parseEther("100");
			const permitAllowance = ethers.parseEther("200");

			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				permitAllowance,
			);

			await system.processTokenPayment(
				data,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams,
				true,
				gasRefundData,
			);

			const remainingAllowance = await token.allowance(
				user.address,
				systemAddress,
			);
			expect(remainingAllowance).to.lt(permitAllowance - amount); // allow for gas refund
		});

		it("handles permit with different signer", async () => {
			const [, , , , differentUser] = await ethers.getSigners();
			await token.mint(differentUser.address, ethers.parseEther("1000"));

			const amount = ethers.parseEther("100");
			const data = createPaymentData(
				differentUser.address,
				merchant.address,
			);
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
				null,
				differentUser,
			);

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");

			const expectedMerchantAmount = (amount * BigInt(99)) / BigInt(100);
			expect(await token.balanceOf(merchant.address)).to.eq(
				expectedMerchantAmount,
			);
		});

		it("handles permit reuse attempt (should fail)", async () => {
			const amount = ethers.parseEther("50");
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
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			// First payment should succeed
			await system.processTokenPayment(
				data1,
				amount,
				100,
				{ organization: ethers.ZeroAddress, feeBps: 0 },
				permitParams,
				true,
				gasRefundData,
			);

			// Second payment with same permit should fail due to insufficient allowance
			await expect(
				system.processTokenPayment(
					data2,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.be.reverted;
		});
	});

	describe("Gas and reentrancy", () => {
		it("should not allow reentrancy", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();
			const permitParams = await createPermitSignature(
				systemAddress,
				amount,
			);

			// Normal call should work
			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					permitParams,
					true,
					gasRefundData,
				),
			).to.emit(system, "TokenPaymentProcessed");
		});
	});

	describe("Permit signature validation", () => {
		it("handles permit with wrong v value", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();

			const validPermit = await createPermitSignature(
				systemAddress,
				amount,
			);
			const invalidPermit = {
				...validPermit,
				signature: {
					...validPermit.signature,
					v: validPermit.signature.v === 27 ? 28 : 27, // flip v
				},
			};

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					invalidPermit,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidSignature");
		});

		it("handles permit with wrong r value", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();

			const validPermit = await createPermitSignature(
				systemAddress,
				amount,
			);
			const invalidPermit = {
				...validPermit,
				signature: {
					...validPermit.signature,
					r: ethers.keccak256(ethers.toUtf8Bytes("wrong r")),
				},
			};

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					invalidPermit,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidSignature");
		});

		it("handles permit with wrong s value", async () => {
			const amount = ethers.parseEther("100");
			const data = createPaymentData();
			const gasRefundData = getGasRefundData();

			const validPermit = await createPermitSignature(
				systemAddress,
				amount,
			);
			const invalidPermit = {
				...validPermit,
				signature: {
					...validPermit.signature,
					s: ethers.keccak256(ethers.toUtf8Bytes("wrong s")),
				},
			};

			await expect(
				system.processTokenPayment(
					data,
					amount,
					100,
					{ organization: ethers.ZeroAddress, feeBps: 0 },
					invalidPermit,
					true,
					gasRefundData,
				),
			).to.be.revertedWithCustomError(system, "InvalidSignature");
		});
	});
});
