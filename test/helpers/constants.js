const ETH_PRICE_USD = 3500;
const ETH_DECIMALS = 18;
const TOKEN_PRICE_USD = 2; // 2 USD per token
const TOKEN_DECIMALS = 6; // USDC-like token with 6 decimals

const tokenPriceInWei =
	(ETH_PRICE_USD * 10 ** TOKEN_DECIMALS) / TOKEN_PRICE_USD;

module.exports = {
	ETH_PRICE_USD,
	ETH_DECIMALS,
	TOKEN_PRICE_USD,
	tokenPriceInWei,
	TOKEN_DECIMALS,
};
