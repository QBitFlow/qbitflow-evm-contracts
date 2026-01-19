// SPDX-License-Identifier: MPL 2.0
pragma solidity ^0.8.28;

/**
 * @title IQBitFlowPaymentSystem
 * @dev Interface for the QBitFlowPaymentSystem contract that handles payments and subscriptions
 * @author QBitFlow Team
 */
interface IQBitFlowPaymentSystem {

	//////////////////// Errors \\\\\\\\\\\\\\\\\\\\


	/**
	 * @dev Error thrown when an invalid signature is provided
	 */
	error InvalidSignature();

    /**
     * @dev Error thrown when an invalid address is provided
     */
    error InvalidAddress();
    
    /**
     * @dev Error thrown when a zero amount is provided
     */
    error ZeroAmount();
    
    /**
     * @dev Error thrown when an invalid fee percentage is provided
     */
    error InvalidFeePercentage();
    
    /**
     * @dev Error thrown when a transfer fails
     */
    error TransferFailed(string reason);
    
    /**
     * @dev Error thrown when a subscription is not active
     */
    error SubscriptionNotActive();

	/**
	 * @dev Error thrown when a subscription already exists
	 */
	error SubscriptionAlreadyExists();
    
    /**
     * @dev Error thrown when a payment is not due yet
     */
    error PaymentNotDueYet();
    
    /**
     * @dev Error thrown when an invalid subscription frequency is provided
     */
    error InvalidFrequency();

	/**
	 * @dev Error thrown when a token transfer has insufficient allowance
	 */
	error InsufficientAllowance();

	/**
	 * @dev Error thrown when the maximum amount for a pay-as-you-go subscription is exceeded
	 */
	error MaxAmountExceeded();

	error InvalidSigner();




	
	//////////////////// Fee management \\\\\\\\\\\\\\\\\\\\

    /**
     * @dev Calculate fee amount based on the transaction amount
     * @param amount The amount to calculate fee for
	 * @param feeBps The fee percentage in basis points (bps) (100 bps = 1%)
	 * @param organizationFee The organization fee details
     * @return (uint256, uint256) The calculated owner fee and organization fee amounts
     */
    function calculateFee(uint256 amount, uint16 feeBps, OrganizationFee calldata organizationFee) external pure returns (uint256, uint256);


	struct OrganizationFee {
		address organization; // Address of the organization to receive the fee
		uint16 feeBps;        // Organization fee percentage in basis points (bps) (100 bps = 1%)
	}



	//////////////////// One-time payment \\\\\\\\\\\\\\\\\\\\

	/**
     * @dev Emitted when a payment is processed
	 * @param uuid Unique identifier for the payment
     */
    event PaymentProcessed(
		bytes16 uuid,
		address indexed from,
		address indexed to,
		uint256 amount
    );

	/**
     * @dev Emitted when a payment is processed
	 * @param tokenAddress Address of the ERC20 token (address(0) for ETH)
	 * @param uuid Unique identifier for the payment
     */
    event TokenPaymentProcessed(
        address tokenAddress,
		bytes16 uuid
    );

    /**
     * @dev Process a one-time payment in ETH
     * @param merchant Address of the merchant to receive payment
	 * @param feeBps Fee percentage in basis points (bps) (100 bps = 1%)
     */
    function processPayment(address payable merchant, uint16 feeBps, bytes16 uuid, OrganizationFee calldata organizationFee) external payable;

    /**
     * @dev Process a one-time payment in ERC20 tokens
     * @param data Payment data containing details of the payment
	 * @param feeBps Fee percentage in basis points (bps) (100 bps = 1%)
	 * @param organizationFee Organization fee details
	 * @param permitParams Permit parameters for token allowance
	 * @param permitSupported Whether the token supports permit (EIP-2612)
	 * @param gasRefund Gas refund parameters for the transaction
	 * @dev Throws if amount is zero, feeBps is invalid, or addresses are invalid
	 * @dev Uses IERC20Permit to set allowance for the payment
	 * @dev Emits PaymentProcessed event
     */
    function processTokenPayment(
		Data calldata data,
		uint16 feeBps,
		OrganizationFee calldata organizationFee,
		PermitParams calldata permitParams,
		bool permitSupported,
		GasRefund calldata gasRefund
    ) external;



	
	//////////////////// Subscription \\\\\\\\\\\\\\\\\\\\

	/**
     * @dev Struct representing a subscription
	 * @notice This struct contains all necessary details for a subscription, including the merchant, subscriber,
	 *         token address, amount, frequency, next payment due date, and whether the subscription is active.
	 * @notice The `merchant` is the address of the entity providing the service, while the `subscriber` is the user who pays for the subscription.
	 * @notice The `tokenAddress` is the address of the ERC20 token used for payments, or address(0) if payments are made in ETH.
	 * @notice The `nextPaymentDue` is the timestamp when the next payment is due, and the `active` field indicates whether the subscription is currently active.
	 * @notice This struct is used to create, manage, and process subscriptions within the QBitFlow payment system.
	 * @notice It is designed to be flexible enough to handle various types of subscriptions, including recurring payments and pay-as-you-go models.
     */
    struct Subscription {
        address signer;       // User paying for the subscription
        uint256 nextPaymentDue;   // Timestamp when next payment is due
        bool active;              // Whether subscription is active
		Signature signature; // Signature of the subscription details
		bool stopped; // Whether the subscription is stopped (for pay-as-you-go)
		uint256 maxAmount; // Maximum amount allowed per period (to be able to handle price variations)
		uint256 lastPaymentAmount; // Amount of the last payment made
    }

	/**
     * @dev Emitted when a subscription is created
	 * @param uuid Unique identifier for the subscription
	 * @param nextPaymentDue Timestamp when the next payment is due
	 * @param initialAllowance Amount of tokens allowed for the subscription
     */
    event SubscriptionCreated(
		bytes16 uuid, 
		uint256 nextPaymentDue,
		uint256 initialAllowance
    );


	/**
	 * @dev Emitted when a subscription payment is processed
	 * @param uuid Unique identifier for the subscription
	 * @param nextPaymentDue Timestamp when the next payment is due
	 * @param remainingAllowance Amount of tokens remaining in the subscription allowance
	 * @notice This event is emitted when a subscription payment is successfully processed
	 * @notice It indicates that the payment has been deducted from the subscriber's allowance
	 * @notice The `nextPaymentDue` field indicates when the next payment is due for the subscription
	 * @notice The `remainingAllowance` field indicates how much of the subscriber's allowance is left after the payment
	 * @notice This event can be used to track subscription payments
	 * @notice and to notify the subscriber and merchant about the payment status
	 */
	event SubscriptionPaymentProcessed(
		bytes16 uuid,
		uint256 nextPaymentDue,
		uint256 remainingAllowance
	);

	/**
	 * @dev Emitted when a subscription is cancelled
	 * @param uuid Unique identifier for the subscription
	 * @notice This event is emitted when a subscription is cancelled by the subscriber or by the backend
	 * @notice It indicates that no further payments will be processed for this subscription
	 * @notice The `uuid` field is a unique identifier for the subscription
	 */
	event SubscriptionCancelled(
		bytes16 uuid
	);

	/**
	 * @dev Emitted when a subscription is stopped (for pay-as-you-go subscriptions)
	 * @param uuid Unique identifier for the subscription
	 * @notice This event is emitted when a pay-as-you-go subscription is stopped by the subscriber or by the backend
	 * @notice It indicates that the last billing will be made, and then the subscription will be set to inactive
	 * @notice The `uuid` field is a unique identifier for the subscription
	 */
	event SubscriptionStopped(
		bytes16 uuid
	);


	/**
	 * @dev Emitted when the maximum amount per period for a subscription (or pay-as-you-go subscription) is updated
	 * @param uuid Unique identifier for the subscription
	 * @param newMaxAmount New maximum amount allowed per period
	 * @notice This event is emitted when the maximum amount per period for a subscription or pay-as-you-go subscription is updated
	 * @notice It indicates that the subscriber has changed the maximum amount that can be spent on their behalf for future payments
	 */
	event MaxAmountUpdated(
		bytes16 uuid,
		uint256 newMaxAmount
	);

    /**
     * @dev Create a new subscription
     * @param data Subscription data containing details of the subscription
	 * @param maxAmount Maximum amount allowed per period (to handle price variations)
     * @param frequency Billing frequency in seconds
	 * @param permitParams Permit parameters for token allowance
	 * @param permitSupported Whether the token supports permit (EIP-2612)
	 * @param organizationFee Organization fee details
	 * @param signature Signature of the subscription details
	 * @param gasRefundData Gas refund parameters for the transaction
	 * @dev Throws if amount is zero, frequency is less than minimum, or addresses are invalid
	 * @dev Uses IERC20Permit to set allowance for the subscription
	 * @dev Emits SubscriptionCreated event
     */
    function createSubscription(
		Data calldata data,
		uint256 maxAmount,
        uint32 frequency,
		PermitParams calldata permitParams,
		bool permitSupported,
		address organizationFee,
		Signature calldata signature,
		GasRefund calldata gasRefundData
    ) external;

	 /**
     * @dev Execute a subscription payment
	 * @dev Throws if the subscription is not active, payment is not due yet, or insufficient allowance
	 * @dev Uses IERC20Permit to set allowance for the payment
	 * @dev Emits SubscriptionPaymentProcessed event
	 * @param data Subscription data containing details of the subscription
	 * @param frequency Billing frequency in seconds
	 * @param feeBps Fee percentage in basis points (bps) (100 bps = 1%)
	 * @param organizationFee Organization fee details
	 * @param gasRefundData Gas refund parameters for the transaction
     */
    function executeSubscription(
		Data calldata data,
		uint32 frequency,
		uint16 feeBps,
		OrganizationFee calldata organizationFee,
		GasRefund calldata gasRefundData
    ) external;


	/**
	 * @dev Cancel a subscription and release any reserved streams
	 * @param uuid Unique identifier for the subscription
	 */
	function cancelSubscription(bytes16 uuid, Signature memory signature) external;


	/**	
	 * @dev Force cancel a subscription (can only be called by the backend, and it must be signed by the owner of the contract)
	 * @dev This function allows the backend to forcefully cancel a subscription in case of disputes or issues.
	 * @dev It can be used to cancel a regular or pay-as-you-go subscription.
	 * @param uuid Unique identifier for the subscription
	 */
	function forceCancelSubscription(bytes16 uuid) external;

	/**
     * @dev Get subscription (or pay-as-you-go subscription) details
     * @param uuid Unique identifier for the subscription
     * @return Subscription details
     */
    function getSubscription(bytes16 uuid) external view returns (Subscription memory);


	/**
	 * @dev Set a new maximum amount per period for a subscription (or pay-as-you-go subscription)
	 * @param uuid Unique identifier for the subscription
	 * @param from Address of the user who owns the subscription
	 * @param tokenAddress Address of the ERC20 token (address(0) for ETH)
	 * @param newMaxAmount New maximum amount allowed per period
	 * @param signature Signature of the request
	 * @param gasRefundData Gas refund parameters for the transaction
	 */
	function updateMaxAmount(bytes16 uuid, address from, address tokenAddress, uint256 newMaxAmount, Signature memory signature, GasRefund calldata gasRefundData) external;
    


	
	//////////////////// Pay-as-you-go subscription \\\\\\\\\\\\\\\\\\\\

	/**
	* @dev Create a new pay-as-you-go subscription
	* @param data Subscription data containing details of the subscription
	* @param maxAmount Maximum amount allowed per period (to handle price variations)
	* @param frequency Duration of each spending period in seconds
	* @param permitParams Permit parameters for token allowance
	* @param permitSupported Whether the token supports permit (EIP-2612)
	* @param organizationFee Organization fee address
	* @param signature Signature of the subscription details
	* @param gasRefundData Gas refund parameters for the transaction
	* @dev Uses IERC20Permit to set allowance for the subscription
	* @dev Emits PayAsYouGoSubscriptionCreated event
	*/
	function createPayAsYouGoSubscription(
		Data calldata data,
		uint256 maxAmount,
		uint32 frequency,
		PermitParams calldata permitParams,
		bool permitSupported,
		address organizationFee,
		Signature calldata signature,
		GasRefund calldata gasRefundData
	) external;

	/**
	* @dev Execute a pay-as-you-go payment
	* @dev Throws if the subscription is not active, spending limit is exceeded, or insufficient allowance
	* @dev Uses IERC20Permit to set allowance for the payment
	* @dev Emits PayAsYouGoPaymentProcessed event
	* @param data Subscription data containing details of the subscription
	* @param frequency Duration of each spending period in seconds
	* @param feeBps Fee percentage in basis points
	* @param organizationFee Organization fee details
	* @param gasRefundData Gas refund parameters for the transaction
	*/
	function executePayAsYouGoPayment(
		Data calldata data,
		uint32 frequency,
		uint16 feeBps,
		OrganizationFee calldata organizationFee,
		GasRefund calldata gasRefundData
	) external;


	/**
	 * @dev Cancel a pay-as-you-go subscription, setting it as stopped. The last billing will be made, and then the subscription will be cancelled.
	 * @param uuid Unique identifier for the subscription
	 * @param signature Signature of the cancellation request
	 */
	function cancelPayAsYouGoSubscription(bytes16 uuid, Signature memory signature) external;

	
	//////////////////// Allowance management \\\\\\\\\\\\\\\\\\\\


	/**
	 * @dev Emitted when the allowance for a subscription (or pay-as-you-go subscription) is increased
	 * @param newAllowance The new allowance set for the subscription
	 * @param uuid Unique identifier for the subscription
	 * @notice This event is emitted when a subscriber increases their allowance for a subscription or pay-as-you-go subscription
	 * @notice It indicates that the subscriber has allowed more funds to be spent on their behalf for future payments
	 */
	event AllowanceIncreased(
		uint256 newAllowance,
		bytes16 uuid
	);

	/**
	* @dev Increase the allowance for a subscription (or pay-as-you-go subscription)
	* @dev Throws if the subscription does not exist or is not active
	* @dev Uses IERC20Permit to set allowance for the subscription
	* @param uuid Unique identifier for the subscription
	* @param tokenAddress Address of the ERC20 token (address(0) for ETH)
	* @param signer Address of the user who is increasing the allowance
	* @param permitParams Permit parameters for token allowance
	* @param gasRefundData Gas refund parameters for the transaction
	* @notice This function allows the subscriber to increase the allowance for a subscription or pay-as-you-go subscription
	*         without needing to cancel and recreate the subscription.
	 */
	function increaseAllowance(
		bytes16 uuid,
		address tokenAddress,
		address signer,
		PermitParams calldata permitParams,
		GasRefund calldata gasRefundData
	) external;



	//////////////////// Proxy \\\\\\\\\\\\\\\\\\\\

	event ProxyCreated(
		address proxy
	);

	/**
	 * @dev Create a new proxy for a user-token pair
	 * @notice This function is used to create a new proxy for a user-token pair
	 *         to ensure that each user-token pair has a unique proxy.
	 * @return The address of the newly created proxy
	 */
	function createNewProxy() external returns (address);

	/**
	 * @dev Get the available proxy spender for a user and token
	 * @param user The address of the user
	 * @param token The address of the token
	 * @return The address of the available proxy spender
	 */
	function getAvailableProxySpender(address user, address token) external returns (address);


	/**
	 * @dev Get the current proxy spender for a user and token
	 * @param user The address of the user
	 * @param uuid The unique identifier for the subscription
	 * @return The address of the current proxy spender
	 */
	function getSpender(address user, bytes16 uuid) external view returns (address);


	//////////////////// Gas Refund \\\\\\\\\\\\\\\\\\\\


	/**
	 * @dev Event emitted when a gas refund fails
	 * @param uuid Unique identifier for the transaction
	 * @param signer The address of the signer for the transaction
	 * @notice This event is emitted when a gas refund fails to be processed
	 * @notice It indicates that the gas refund could not be completed for the specified transaction
	 */
	event GasRefundFailed(
		bytes16 uuid,
		address signer,
		address tokenAddress,
		uint256 amount
	);

	struct GasRefund {
		uint256 gasPrice; // Gas price at the time of the transaction
		uint256 tokenPriceInWei; // Price of the token in wei
	}

	/**
	 * @dev Withdraw funds collected by the contract. Transfers the specified amount of tokens to the owner (which pays the gas fees in ETH).
	 * @param token The address of the ERC20 token (address(0) for ETH)
	 * @param amount The amount of tokens to withdraw
	 */
	function withdrawFromContract(address token, uint256 amount) external;


	//////////////////// Other \\\\\\\\\\\\\\\\\\\\

	struct Signature {
		uint8 v;          // Recovery byte of the signature
		bytes32 r;       // First 32 bytes of the signature
		bytes32 s;       // Second 32 bytes of the signature
	}
	
	struct Data {
		bytes16 uuid; // Unique identifier for the payment
		address from; // Address of the user making the payment
		address payable to; // Address of the merchant receiving the payment
		address tokenAddress; // Address of the ERC20 token (address(0) for ETH)
		uint256 amount; // Amount of the payment
	}

	/**
     * @dev Struct representing parameters for permit-based token transfers
	 * @notice This struct is used to allow off-chain approvals for ERC20 tokens
	 * @notice It includes the amount of tokens to allow, deadline for the permit signature,
	 *         and the signature components (v, r, s) for EIP-2612 permits.
	 * @notice The `allowance` field specifies how many tokens the contract is allowed to transfer on behalf of the user.
	 * @notice The `deadline` field is used to prevent replay attacks by ensuring the permit can only be used before a certain time.
	 * @notice The `v`, `r`, and `s` fields are the components of the ECDSA signature that authorizes the transfer.
	 * @notice This struct is typically used in conjunction with the IERC20Permit interface to allow users to approve token transfers without needing to send a transaction.
	 * @notice This is particularly useful for subscription payments where the user can pre-approve a certain amount of tokens to be spent by the contract on their behalf.
	 * @notice The `allowance` should be set to the maximum amount the contract can spend on behalf of the user for the subscription.
	 * @notice The `deadline` should be set to a future timestamp to ensure the permit is valid when used.
	 * @notice The `v`, `r`, and `s` fields are derived from the user's signature and are used to verify the authenticity of the permit.
     */
    struct PermitParams {
		address spender; // Address that is allowed to spend the tokens
		uint256 allowance;   // Amount of tokens to allow for transfer
        uint256 deadline; // Deadline for permit signature
        Signature signature; // Signature components for EIP-2612 permit
    }
}
