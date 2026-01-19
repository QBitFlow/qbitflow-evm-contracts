const { tokenPriceInWei } = require("./constants");

const getGasRefundData = () => ({
	gasPrice: 600000000, // 0.6 gwei
	tokenPriceInWei: BigInt(tokenPriceInWei), // e.g. for a 2 USD token with 3500 USD/ETH, this would be (3500 / 2) * 10^6 = 1,750,000 * 10^6 = 1,750,000,000,000
});

module.exports = {
	getGasRefundData,
};
