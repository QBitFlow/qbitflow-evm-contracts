// In Hardhat console or a script
const { ethers } = require("hardhat");

// Get error signatures
const errors = [
	"InvalidAddress()",
	"ZeroAmount()",
	"InvalidFeePercentage()",
	"TransferFailed(string)",
	"SubscriptionNotActive()",
	"NotAuthorized()",
	"PaymentNotDueYet()",
	"InvalidFrequency()",
	"SpendingLimitExceeded()",
	"InsufficientAllowance()",
	"NotFound()",

	// Add common ERC20 errors (OpenZeppelin v5.x)
	"ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
	"ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
	"ERC20InvalidSender(address sender)",
	"ERC20InvalidReceiver(address receiver)",
	"ERC20InvalidApprover(address approver)",
	"ERC20InvalidSpender(address spender)",

	"ERC2612ExpiredSignature(uint256 deadline)",
	"ERC2612InvalidSigner(address signer, address owner)",

	"ERC20ExceededCap(uint256 increasedSupply, uint256 cap)",
	"ERC20InvalidCap(uint256 cap)",

	"EnforcedPause()",
	"ExpectedPause()",

	"ERC20ExceededSafeSupply(uint256 increasedSupply, uint256 cap)",
	"ERC20InvalidUnderlying(address token)",

	"ERC3156UnsupportedToken(address token)",
	"ERC3156ExceededMaxLoan(uint256 maxLoan)",
	"ERC3156InvalidReceiver(address receiver)",

	"ERC1363TransferFailed(address receiver, uint256 value)",
	"ERC1363TransferFromFailed(address sender, address receiver, uint256 value)",
	"ERC1363ApproveFailed(address spender, uint256 value)",
];

// Print error signatures
console.log("Error Signatures:");
errors.forEach((error) => {
	const signature = ethers.id(error).slice(0, 10);
	console.log(`"${signature}": "${error.split("(")[0]}",`);
});
