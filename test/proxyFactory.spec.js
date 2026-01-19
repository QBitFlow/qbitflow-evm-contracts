const { expect } = require("chai");
const { ethers } = require("hardhat");
const { signERC2612Permit } = require("./helpers/permit");
const { uuidToBytes16 } = require("./helpers/uuid");

const { TOKEN_DECIMALS } = require("./helpers/constants");

describe("QBitFlowProxyFactory", () => {
	let owner, user, merchant, other;
	let TokenNoPermit, TokenPermit;
	let tokenNoPermit, tokenPermit;
	let Factory, factory;
	let ProxyImpl, proxy, proxyAddress;
	let provider;

	beforeEach(async () => {
		[owner, user, merchant, other] = await ethers.getSigners();
		provider = ethers.provider;

		// Mock tokens
		TokenNoPermit = await ethers.getContractFactory("MockERC20NoPermit");
		TokenPermit = await ethers.getContractFactory("MockERC20Permit");

		tokenNoPermit = await TokenNoPermit.deploy(
			"NoPermit",
			"NOP",
			TOKEN_DECIMALS,
		);
		await tokenNoPermit.waitForDeployment();

		tokenPermit = await TokenPermit.deploy(
			"PermitToken",
			"PRM",
			TOKEN_DECIMALS,
		);
		await tokenPermit.waitForDeployment();

		// Deploy factory directly (not through system)
		Factory = await ethers.getContractFactory("QBitFlowProxyFactory");
		factory = await Factory.deploy(owner.address); // owner acts as "main" contract
		await factory.waitForDeployment();

		// Create a proxy for testing
		const tx = await factory.createNewProxy();
		await tx.wait();

		proxyAddress = await factory.getAllProxies().then((arr) => arr[0]);
		proxy = await ethers.getContractAt("QBitFlowProxy", proxyAddress);

		// Mint tokens
		await tokenNoPermit.mint(user.address, ethers.parseEther("1000"));
		await tokenPermit.mint(user.address, ethers.parseEther("1000"));
	});

	// -------- helper to create permit signatures ----------
	const createPermitSignature = async (
		spender,
		allowance = ethers.parseEther("100"),
		deadline = null,
		signer = user,
	) => {
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
			v: sig.v,
			r: sig.r,
			s: sig.s,
		};
	};

	// ============= Core Tests ============= //

	describe("createPaymentStream", () => {
		it("should create stream with permit", async () => {
			const amount = ethers.parseEther("100");
			const permitParams = await createPermitSignature(
				proxyAddress,
				amount,
			);

			const uuid = uuidToBytes16("11111111-1111-1111-1111-111111111111");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenPermit.getAddress(),
				proxyAddress,
				permitParams,
				true,
			);

			const info = await factory.getStreamInfo(user.address, uuid);
			expect(info.proxy).to.eq(proxyAddress);
			expect(info.active).to.be.true;
			expect(info.permitSupported).to.be.true;
		});

		it("should create stream with approval (no permit)", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);

			const permitParams = {
				allowance: amount,
				deadline: 0,
				v: 0,
				r: ethers.ZeroHash,
				s: ethers.ZeroHash,
			};
			const uuid = uuidToBytes16("22222222-2222-2222-2222-222222222222");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				permitParams,
				false,
			);

			const info = await factory.getStreamInfo(user.address, uuid);
			expect(info.proxy).to.eq(proxyAddress);
			expect(info.permitSupported).to.be.false;
		});

		it("reverts if stream already exists", async () => {
			const amount = ethers.parseEther("100");
			const permitParams = await createPermitSignature(
				proxyAddress,
				amount,
			);
			const uuid = uuidToBytes16("33333333-3333-3333-3333-333333333333");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenPermit.getAddress(),
				proxyAddress,
				permitParams,
				true,
			);

			await expect(
				factory.createPaymentStream(
					uuid,
					user.address,
					await tokenPermit.getAddress(),
					proxyAddress,
					permitParams,
					true,
				),
			).to.be.revertedWith("Stream already exists");
		});

		it("reverts if proxy not from this factory", async () => {
			// Deploy a standalone proxy (not through factory)
			const ProxyContract = await ethers.getContractFactory(
				"QBitFlowProxy",
			);
			const fakeProxy = await ProxyContract.deploy();
			await fakeProxy.waitForDeployment();

			const amount = ethers.parseEther("100");
			const permitParams = await createPermitSignature(
				await fakeProxy.getAddress(),
				amount,
			);

			const uuid = uuidToBytes16("44444444-4444-4444-4444-444444444444");

			// createPaymentStream revert "Proxy not from this factory" if the proxy implements getFactory function, but the address returned is not the factory address
			// It reverts "Invalid proxy for stream" if the proxy does not implement getFactory function
			await expect(
				factory.createPaymentStream(
					uuid,
					user.address,
					await tokenPermit.getAddress(),
					await fakeProxy.getAddress(),
					permitParams,
					true,
				),
			).to.be.revertedWith("Proxy not from this factory");
		});

		it("reverts with invalid addresses", async () => {
			const amount = ethers.parseEther("100");
			const permitParams = await createPermitSignature(
				proxyAddress,
				amount,
			);
			const uuid = uuidToBytes16("55555555-5555-5555-5555-555555555555");

			// Invalid user address
			await expect(
				factory.createPaymentStream(
					uuid,
					ethers.ZeroAddress,
					await tokenPermit.getAddress(),
					proxyAddress,
					permitParams,
					true,
				),
			).to.be.revertedWith("Invalid user address");

			// Invalid token address
			await expect(
				factory.createPaymentStream(
					uuid,
					user.address,
					ethers.ZeroAddress,
					proxyAddress,
					permitParams,
					true,
				),
			).to.be.revertedWith("Invalid token address");

			// Invalid proxy address
			await expect(
				factory.createPaymentStream(
					uuid,
					user.address,
					await tokenPermit.getAddress(),
					ethers.ZeroAddress,
					permitParams,
					true,
				),
			).to.be.revertedWith("Invalid proxy address");
		});
	});

	// -------- fetching funds -------
	describe("fetchFundsFromProxy", () => {
		it("should transfer tokens from user via proxy to factory", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);

			const permitParams = {
				allowance: amount,
				deadline: 0,
				v: 0,
				r: ethers.ZeroHash,
				s: ethers.ZeroHash,
			};
			const uuid = uuidToBytes16("66666666-6666-6666-6666-666666666666");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				permitParams,
				false,
			);

			const factoryBalanceBefore = await tokenNoPermit.balanceOf(
				await factory.getAddress(),
			);
			const userBalanceBefore = await tokenNoPermit.balanceOf(
				user.address,
			);

			const success = await factory.fetchFundsFromProxy(
				user.address,
				uuid,
				amount,
			);

			const factoryBalanceAfter = await tokenNoPermit.balanceOf(
				await factory.getAddress(),
			);
			const userBalanceAfter = await tokenNoPermit.balanceOf(
				user.address,
			);

			expect(factoryBalanceAfter).to.eq(factoryBalanceBefore + amount);
			expect(userBalanceAfter).to.eq(userBalanceBefore - amount);

			const reservation = await proxy.getStreamReservation(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(reservation.usedAmount).to.eq(amount);
		});

		it("returns false if insufficient balance", async () => {
			const amount = ethers.parseEther("2000"); // user has 1000 only
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);

			const permitParams = {
				allowance: amount,
				deadline: 0,
				v: 0,
				r: ethers.ZeroHash,
				s: ethers.ZeroHash,
			};
			const uuid = uuidToBytes16("77777777-7777-7777-7777-777777777777");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				permitParams,
				false,
			);

			const success = await factory.fetchFundsFromProxy.staticCall(
				user.address,
				uuid,
				amount,
			);
			expect(success).to.be.false;
		});

		it("reverts if stream not active", async () => {
			const uuid = uuidToBytes16("88888888-8888-8888-8888-888888888888");

			await expect(
				factory.fetchFundsFromProxy(
					user.address,
					uuid,
					ethers.parseEther("100"),
				),
			).to.be.revertedWith("Stream not active");
		});
	});

	// -------- transferTo -------
	describe("transferTo", () => {
		it("should transfer tokens from factory to recipient", async () => {
			const amount = ethers.parseEther("50");
			await tokenNoPermit.transfer(await factory.getAddress(), amount);

			const merchantBalanceBefore = await tokenNoPermit.balanceOf(
				merchant.address,
			);
			const factoryBalanceBefore = await tokenNoPermit.balanceOf(
				await factory.getAddress(),
			);

			await factory.transferTo(
				await tokenNoPermit.getAddress(),
				merchant.address,
				amount,
			);

			const merchantBalanceAfter = await tokenNoPermit.balanceOf(
				merchant.address,
			);
			const factoryBalanceAfter = await tokenNoPermit.balanceOf(
				await factory.getAddress(),
			);

			expect(merchantBalanceAfter).to.eq(merchantBalanceBefore + amount);
			expect(factoryBalanceAfter).to.eq(factoryBalanceBefore - amount);
		});

		it("reverts if to == zero address", async () => {
			await expect(
				factory.transferTo(
					await tokenNoPermit.getAddress(),
					ethers.ZeroAddress,
					100,
				),
			).to.be.revertedWith("Invalid recipient");
		});

		it("reverts if amount is zero", async () => {
			await expect(
				factory.transferTo(
					await tokenNoPermit.getAddress(),
					merchant.address,
					0,
				),
			).to.be.revertedWith("Amount must be greater than zero");
		});
	});

	// -------- cancelStream -------
	describe("cancelStream", () => {
		it("should cancel a stream and free reservation", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("99999999-9999-9999-9999-999999999999");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// Verify stream exists
			const infoBefore = await factory.getStreamInfo(user.address, uuid);
			expect(infoBefore.active).to.be.true;
			expect(infoBefore.proxy).to.eq(proxyAddress);

			// Cancel stream
			await factory.cancelStream(user.address, uuid);

			// Get stream info should return proxy address(0) and active = false
			const infoAfter = await factory.getStreamInfo(user.address, uuid);
			expect(infoAfter.active).to.be.false;
			expect(infoAfter.proxy).to.eq(ethers.ZeroAddress);

			// Verify stream is deleted
			await expect(
				factory.getStreamReservation(user.address, uuid),
			).to.be.revertedWith("Stream not active");

			// Verify stream is deleted
			await expect(
				factory.getRemainingReservation(user.address, uuid),
			).to.be.revertedWith("Stream not active");

			// Verify reservation is released
			expect(
				await proxy.hasStreamReservation(user.address, infoBefore[1]),
			).to.be.false;
		});

		it("reverts if stream not active", async () => {
			const uuid = uuidToBytes16("AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA");

			await expect(
				factory.cancelStream(user.address, uuid),
			).to.be.revertedWith("Stream not active");
		});
	});

	// -------- updateStream -------
	describe("updatePaymentStream", () => {
		it("should update stream with permit", async () => {
			const amount = ethers.parseEther("100");
			const permitParams = await createPermitSignature(
				proxyAddress,
				amount,
			);
			const uuid = uuidToBytes16("BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenPermit.getAddress(),
				proxyAddress,
				permitParams,
				true,
			);

			const newAmount = ethers.parseEther("200");
			const newPermitParams = await createPermitSignature(
				proxyAddress,
				newAmount,
			);

			await factory.updatePaymentStream(
				user.address,
				await tokenPermit.getAddress(),
				uuid,
				newPermitParams,
			);

			const reservation = await proxy.getStreamReservation(
				user.address,
				await tokenPermit.getAddress(),
			);
			expect(reservation.amount).to.eq(newAmount);
			expect(reservation.usedAmount).to.eq(0); // Reset on update
		});

		it("should update stream with approval", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			const newAmount = ethers.parseEther("200");
			await tokenNoPermit.connect(user).approve(proxyAddress, newAmount);

			await factory.updatePaymentStream(
				user.address,
				await tokenNoPermit.getAddress(),
				uuid,
				{
					allowance: newAmount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
			);

			const reservation = await proxy.getStreamReservation(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(reservation.amount).to.eq(newAmount);
		});

		it("keeps the same proxy after update", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			const proxyBefore = await factory.getCurrentSpender(
				user.address,
				uuid,
			);

			const newAmount = ethers.parseEther("200");
			await tokenNoPermit.connect(user).approve(proxyAddress, newAmount);

			await factory.updatePaymentStream(
				user.address,
				await tokenNoPermit.getAddress(),
				uuid,
				{
					allowance: newAmount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
			);

			const proxyAfter = await factory.getCurrentSpender(
				user.address,
				uuid,
			);
			expect(proxyAfter).to.eq(proxyBefore);
		});

		it("reverts if stream not active", async () => {
			const uuid = uuidToBytes16("EEEEEEEE-EEEE-EEEE-EEEE-EEEEEEEEEEEE");

			await expect(
				factory.updatePaymentStream(
					user.address,
					await tokenNoPermit.getAddress(),
					uuid,
					{
						allowance: 100,
						deadline: 0,
						v: 0,
						r: ethers.ZeroHash,
						s: ethers.ZeroHash,
					},
				),
			).to.be.revertedWith("Stream not active");
		});
	});

	// -------- Proxy creation and getters -------
	describe("proxy management", () => {
		it("createNewProxy should increase proxy count", async () => {
			const countBefore = await factory.getProxyCount();
			await factory.createNewProxy();
			const countAfter = await factory.getProxyCount();
			expect(countAfter).to.eq(countBefore + 1n);
		});

		it("createNewProxy should return valid proxy address", async () => {
			const newProxyAddress = await factory.createNewProxy.staticCall();
			expect(newProxyAddress).to.not.eq(ethers.ZeroAddress);

			// Actually create it
			await factory.createNewProxy();
			const newProxy = await ethers.getContractAt(
				"QBitFlowProxy",
				newProxyAddress,
			);
			expect(await newProxy.getFactory()).to.eq(
				await factory.getAddress(),
			);
		});

		it("getCurrentSpender returns correct proxy address", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// getCurrentSpender should return the proxy address, as it's the only one, and the stream has been created with it
			const spender = await factory.getCurrentSpender(user.address, uuid);
			expect(spender).to.eq(proxyAddress);
		});

		it("getCurrentSpender reverts if stream not active", async () => {
			const uuid = uuidToBytes16("00000000-0000-0000-0000-000000000000");

			await expect(
				factory.getCurrentSpender(user.address, uuid),
			).to.be.revertedWith("Stream not active");
		});

		it("getAvailableProxyForUser returns address(0) when no proxy available", async () => {
			// Create a stream that uses the only proxy
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("12345678-1234-1234-1234-123456789012");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// Now try to get available proxy for same user/token - should return 0
			const availableProxy = await factory.getAvailableProxyForUser(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(availableProxy).to.eq(ethers.ZeroAddress);
		});

		it("getAvailableProxyForUser returns existing proxy when available", async () => {
			// Don't create any streams, so proxy should be available
			const availableProxy = await factory.getAvailableProxyForUser(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(availableProxy).to.eq(proxyAddress);

			// Now, create a payment stream (so that proxy is used for that user/token)
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("87654321-4321-4321-4321-210987654321");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// Now try to get available proxy for same user/token - should return 0
			const availableProxyAfter = await factory.getAvailableProxyForUser(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(availableProxyAfter).to.eq(ethers.ZeroAddress);

			// Now create a new proxy
			const newProxyAddress = await factory.createNewProxy.staticCall();
			await factory.createNewProxy();

			// Now, get available proxy for same user/token - should return the new proxy address
			const availableProxyNew = await factory.getAvailableProxyForUser(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(availableProxyNew).to.eq(newProxyAddress);

			// Create a stream for the newly created proxy
			await tokenNoPermit
				.connect(user)
				.approve(availableProxyNew, amount);
			const uuid2 = uuidToBytes16("11223344-5566-7788-99AA-BBCCDDEEFF00");

			await factory.createPaymentStream(
				uuid2,
				user.address,
				await tokenNoPermit.getAddress(),
				availableProxyNew,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// Now try to get available proxy for same user/token - should return 0 again since no proxies are free
			const availableProxyAfter2 = await factory.getAvailableProxyForUser(
				user.address,
				await tokenNoPermit.getAddress(),
			);
			expect(availableProxyAfter2).to.eq(ethers.ZeroAddress);

			// Now cancel the first stream
			await factory.cancelStream(user.address, uuid);

			// Now try to get available proxy for same user/token - should return the first proxy address again, since it's now free
			const availableProxyAfterCancel =
				await factory.getAvailableProxyForUser(
					user.address,
					await tokenNoPermit.getAddress(),
				);
			expect(availableProxyAfterCancel).to.eq(proxyAddress);
		});
	});

	// -------- Reservation checks -------
	describe("remaining reservation", () => {
		it("getRemainingReservation decreases correctly after fetch", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			const remainingBefore = await factory.getRemainingReservation(
				user.address,
				uuid,
			);
			expect(remainingBefore).to.eq(amount);

			const fetchAmount = amount / 2n;
			await factory.fetchFundsFromProxy(user.address, uuid, fetchAmount);

			const remainingAfter = await factory.getRemainingReservation(
				user.address,
				uuid,
			);
			expect(remainingAfter).to.eq(amount - fetchAmount);
		});

		it("getRemainingReservation reverts if stream not active", async () => {
			const uuid = uuidToBytes16("FEDCBAFE-DCBA-FEDC-BAFE-DCBAFEDCBAFE");

			await expect(
				factory.getRemainingReservation(user.address, uuid),
			).to.be.revertedWith("Stream not active");
		});

		it("getStreamReservation returns correct data", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("ABABABAB-ABAB-ABAB-ABAB-ABABABABABAB");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			const reservation = await factory.getStreamReservation(
				user.address,
				uuid,
			);
			expect(reservation.amount).to.eq(amount);
			expect(reservation.usedAmount).to.eq(0);
			expect(reservation.exists).to.be.true;
		});
	});

	// -------- Edge cases and error handling -------
	describe("edge cases", () => {
		it("handles multiple streams for same user with different tokens", async () => {
			const amount = ethers.parseEther("100");

			// Create second proxy for different token
			const proxy2Address = await factory.createNewProxy.staticCall();
			await factory.createNewProxy();

			// Stream 1: user + tokenNoPermit + proxy1
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid1 = uuidToBytes16("11111111-2222-3333-4444-555555555555");

			await factory.createPaymentStream(
				uuid1,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// Stream 2: user + tokenPermit + proxy2
			const permitParams = await createPermitSignature(
				proxy2Address,
				amount,
			);
			const uuid2 = uuidToBytes16("66666666-7777-8888-9999-AAAAAAAAAAAA");

			await factory.createPaymentStream(
				uuid2,
				user.address,
				await tokenPermit.getAddress(),
				proxy2Address,
				permitParams,
				true,
			);

			// Both streams should be active
			const info1 = await factory.getStreamInfo(user.address, uuid1);
			const info2 = await factory.getStreamInfo(user.address, uuid2);

			expect(info1.active).to.be.true;
			expect(info2.active).to.be.true;
			expect(info1.proxy).to.not.eq(info2.proxy);
		});

		it("handles stream operations after partial usage", async () => {
			const amount = ethers.parseEther("100");
			await tokenNoPermit.connect(user).approve(proxyAddress, amount);
			const uuid = uuidToBytes16("66666666-7777-8888-9999-AAAAAAAAAAAA");

			await factory.createPaymentStream(
				uuid,
				user.address,
				await tokenNoPermit.getAddress(),
				proxyAddress,
				{
					allowance: amount,
					deadline: 0,
					v: 0,
					r: ethers.ZeroHash,
					s: ethers.ZeroHash,
				},
				false,
			);

			// Use half the reservation
			await factory.fetchFundsFromProxy(user.address, uuid, amount / 2n);

			// Should still be able to cancel
			await factory.cancelStream(user.address, uuid);

			// Stream should be deleted
			await expect(
				factory.getStreamReservation(user.address, uuid),
			).to.be.revertedWith("Stream not active");
		});
	});
});
