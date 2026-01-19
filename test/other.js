const { ethers } = require("hardhat");
const { expect } = require("chai");

describe("QBitFlowPaymentSystem Owner Update Tests", function () {
	let system, owner, cosigner, newOwner, systemAddr;

	beforeEach(async () => {
		[owner, cosigner, newOwner] = await ethers.getSigners();
		const System = await ethers.getContractFactory("QBitFlowPaymentSystem");
		system = await System.deploy(cosigner.address);
		await system.waitForDeployment();
		systemAddr = await system.getAddress();
	});

	async function createUpdateOwnerSig(newOwnerAddress, signer) {
		const { chainId } = await ethers.provider.getNetwork();
		const domain = {
			name: "QBitFlow",
			version: "1",
			chainId,
			verifyingContract: systemAddr,
		};
		const types = {
			updateOwner: [{ name: "newOwner", type: "address" }],
		};
		const message = {
			newOwner: newOwnerAddress,
		};
		const sig = await signer.signTypedData(domain, types, message);
		return ethers.Signature.from(sig);
	}

	async function createProxy(wallet) {
		// connect contract to newOwner signer (otherwise the default signer is still the old owner)
		const systemAsNewOwner = system.connect(wallet);

		const tx = await systemAsNewOwner.createNewProxy();
		const receipt = await tx.wait();

		const proxy = receipt.logs
			.map((log) => system.interface.parseLog(log))
			.find((e) => e.name === "ProxyCreated")?.args[0];

		expect(proxy).to.properAddress;

		return proxy;
	}

	it("should allow the owner to create a new proxy", async () => {
		const proxy = await createProxy(owner);

		const newUserAddress = ethers.Wallet.createRandom().address;
		const tokenAddress = ethers.Wallet.createRandom().address;

		const availableProxy = await system.getAvailableProxySpender(
			newUserAddress,
			tokenAddress,
		);
		expect(availableProxy).to.equal(proxy);
	});

	it("should fail when updating owner with an invalid cosigner signature", async () => {
		const invalidSignature = {
			v: 0,
			r: ethers.ZeroHash,
			s: ethers.ZeroHash,
		};

		try {
			const res = await system.updateOwner(
				newOwner.address,
				invalidSignature,
			);
			await res.wait();
			expect.fail("Expected error was not thrown");
		} catch (error) {}
	});

	it("should fail when updating owner with a signature from the wrong cosigner", async () => {
		const wrongCosigner = ethers.Wallet.createRandom();
		const cosignerSignature = await createUpdateOwnerSig(
			newOwner.address,
			wrongCosigner,
		);
		try {
			const res = await system.updateOwner(
				newOwner.address,
				cosignerSignature,
			);
			await res.wait();
			expect.fail("Expected error was not thrown");
		} catch (error) {}
	});

	it("should allow the owner to update the owner with a valid cosigner signature", async () => {
		const cosignerSignature = await createUpdateOwnerSig(
			newOwner.address,
			cosigner,
		);

		const receipt = await system.updateOwner(
			newOwner.address,
			cosignerSignature,
		);
		await receipt.wait();

		// verify ownership transfer
		const currentOwner = await system.ownerAddress();
		expect(currentOwner).to.equal(newOwner.address);
	});

	it("should fail when the old owner tries to create a new proxy after ownership transfer", async () => {
		const cosignerSignature = await createUpdateOwnerSig(
			newOwner.address,
			cosigner,
		);

		const res = await system.updateOwner(
			newOwner.address,
			cosignerSignature,
		);
		await res.wait();
		expect(await system.ownerAddress()).to.equal(newOwner.address);

		// New owner should be able to create a proxy
		const proxy = await createProxy(newOwner);
		expect(await system.ownerAddress()).to.equal(newOwner.address);
		expect(proxy).to.properAddress;

		// Old owner should not be able to create a proxy
		try {
			const res = await createProxy(owner);
			await res.wait();
			expect.fail("Expected error was not thrown");
		} catch (error) {}
	});

	it("should allow the new owner to create a new proxy", async () => {
		const cosignerSignature = await createUpdateOwnerSig(
			newOwner.address,
			cosigner,
		);

		const res = await system.updateOwner(
			newOwner.address,
			cosignerSignature,
		);
		await res.wait();

		expect(await system.ownerAddress()).to.equal(newOwner.address);

		await createProxy(newOwner);
	});
});
