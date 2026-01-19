const ethers = require("ethers");

async function signERC2612Permit(
	token,
	owner,
	spender,
	value,
	deadline,
	provider,
) {
	const name = await token.name();
	const version = "1";
	const chainId = (await provider.getNetwork()).chainId;
	const nonce = await token.nonces(owner);

	const domain = {
		name,
		version,
		chainId,
		verifyingContract: token.target,
	};

	const types = {
		Permit: [
			{ name: "owner", type: "address" },
			{ name: "spender", type: "address" },
			{ name: "value", type: "uint256" },
			{ name: "nonce", type: "uint256" },
			{ name: "deadline", type: "uint256" },
		],
	};

	const message = {
		owner: owner.address,
		spender,
		value,
		nonce,
		deadline,
	};

	const sig = await owner.signTypedData(domain, types, message);
	const { v, r, s } = ethers.Signature.from(sig);
	return { v, r, s, nonce, deadline };
}

module.exports = { signERC2612Permit };
