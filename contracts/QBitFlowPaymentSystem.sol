// SPDX-License-Identifier: MPL 2.0
pragma solidity ^0.8.28;

import "./IQBitFlowPaymentSystem.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import "./proxy/QBitFlowProxyFactory.sol";



/**
 * @title QBitFlowPaymentSystem
 * @dev Implementation of a non-custodial payment and subscription system on Ethereum
 * @notice This contract handles one-time payments and recurring subscriptions with a processing fee
 * @author QBitFlow Team
 */
contract QBitFlowPaymentSystem is IQBitFlowPaymentSystem, ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

	// Constants
	uint16 private constant FEE_DENOMINATOR = 10000;
	uint32 private constant MIN_FREQUENCY = 7 days; // Minimum frequency for subscriptions (7 days). Maximum is 1 year (365 days) < uint32 max value
	// uint32 private constant MIN_FREQUENCY = 10 minutes; // Minimum frequency for subscriptions (10 minutes). Maximum is 1 year (365 days) < uint32 max value
	uint16 private constant MIN_FEE_FOR_CONTRACT_BPS = 75; // 0.75% minimum fee for contract
	uint16 public constant MAX_FEE_BPS = 1000; // 10% maximum fee (for both contract and organization fees)

	address private owner;
	address private cosigner;

    // Type hash 

    // Type hash for createSubscription
    bytes32 private constant CREATE_SUBSCRIPTION_TYPEHASH = keccak256(
        "createSubscription(address merchant,address tokenAddress,uint32 frequency,bytes16 uuid,address organization)"
    );

	// Type hash for cancelSubscription
	bytes32 private constant CANCEL_SUBSCRIPTION_TYPEHASH = keccak256(
		"cancelSubscription(bytes16 uuid)"
	);

	bytes32 private constant UPDATE_MAX_AMOUNT_TYPEHASH = keccak256(
		"updateMaxAmount(bytes16 uuid,uint256 newMaxAmount)"
	);

	bytes32 private constant UPDATE_OWNER = keccak256(
		"updateOwner(address newOwner)"
	);
    

	// State variables
	mapping(bytes16 => Subscription) private subscriptions; // Mapping of subscription UUIDs to Subscription structs

	QBitFlowProxyFactory private immutable factory; // The factory contract that creates proxy instances, handling payment streams

	// Inherits from Ownable and EIP712
	// Ownable constructor sets the deployer as the initial owner
	// EIP712 constructor sets the domain separator for EIP-712 signatures
	constructor(address _cosigner) EIP712("QBitFlow", "1") {
		// Create the proxy factory instance
		// Proxies are used to manage payment streams and allowances for subscriptions
		// When creating a permit, the tuple (owner, spender, tokenAddress) must be unique, so we need proxies to allow multiple subscriptions with the same token for a user
		// The factory will create proxies as needed, and reuse existing ones if they are not already used for a (owner, spender, tokenAddress) tuple
		factory = new QBitFlowProxyFactory(address(this));
		owner = msg.sender;
		cosigner = _cosigner;
	}

	function ownerAddress() external view returns (address) {
		return owner;
	}

	/**
	 * @dev Updates the owner of the contract
	 * @param newOwner The address of the new owner
	 * @param cosignerSignature The signature from the cosigner
	 */
	function updateOwner(address newOwner, Signature calldata cosignerSignature) external onlyOwner {
		require(newOwner != address(0), "New owner cannot be zero address");
		require(newOwner != owner, "New owner must be different");
		require(newOwner != cosigner, "New owner cannot be the cosigner");
		

		// Validate the signature from the cosigner
		if (!validateSignature(
				abi.encode(
					UPDATE_OWNER,
					newOwner
				), 
				cosigner, 
				cosignerSignature
			)) revert InvalidSignature();

		owner = newOwner;
	}


	/**
	 * Refunds gas costs (paid by the contract owner) in tokens, from the user to the contract
	 */
	function refundGas(uint256 gasUsed, uint256 gasPrice, uint256 tokenPriceInWei, bytes16 uuid, address signer, address token, bool forSubscription, bool enforceErr) internal returns (bool, uint256) {
		// Calculate gas cost in tokens
        uint256 gasCostInWei = gasUsed * gasPrice;
        uint256 gasRefundInTokens = gasCostInWei * tokenPriceInWei / 1e18; // Convert to token amount based on the token price in wei

		bool transferSuccess = false;

		// If not for subscriptions, then the spender is this contract itself
		// Transfer the gas refund from the user to the contract
		if (!forSubscription) {
			// No proxy has been used -> the spender is the contract itself
			try IERC20(token).transferFrom(signer, owner, gasRefundInTokens) returns (bool ok) {
				transferSuccess = ok;
			} catch {
				transferSuccess = false;
			}
		} else {
			// For a subscription, the spender is the proxy

			// First, we need to ensure the total payment execution + gas refund does not exceed the maximum amount set for the subscription
			Subscription storage subscription = subscriptions[uuid];
			if (!subscription.active) {
				// If the subscription is not active, we cannot refund gas
				// Return true to avoid emitting GasRefundFailed event
				return (true, gasRefundInTokens);
			}

			if (subscription.lastPaymentAmount + gasRefundInTokens > subscription.maxAmount) {
				// Normally, revert the transaction to avoid overdraft
				// But in some cases (for example increasing allowance), if overdraft on refund, skip the refund this time 
				if (enforceErr) {
					revert MaxAmountExceeded();
				} else {
					return (false, gasRefundInTokens);
				}
			}

			// We only need to check for subscriptions since one-time payments are necessarily capped by the allowance (only for one period)
			// Whereas for subscriptions, if the allowance is set for multiple periods, we ensure the gasPrice and tokenPriceInWei are reasonable to avoid overdraft on the subscription maximum amount

			// Fetch funds from the proxy to the factory
			try factory.fetchFundsFromProxy(signer, uuid, gasRefundInTokens) returns (bool ok) {
				transferSuccess = ok;
			} catch {
				transferSuccess = false;
			}

			// Now, transfer the gas refund to the contract
			if (transferSuccess) {
				factory.transferTo(token, owner, gasRefundInTokens);
			}
		}

		return (transferSuccess, gasRefundInTokens);
	}

	// Modifier to refund gas costs (paid by the contract owner) in tokens, from the user to the contract
	// This is used to refund the gas costs paid by the contract owner when processing a transaction
	// The contract owner pays for the gas fees, so the user can pay in tokens, he doesn't need to hold ETH
	// ! If the transaction is reverted, the gas refund will not be processed, so the user will not be charged for the gas fees (but the contract owner will still pay for the gas fees used)
	// The refund ratio computed gas used (estimated with overhead) / expected gas used (received after the transaction) is capped between 0.995 and 1.1 to avoid extreme cases. overhead has been defined per function, based on tests.
	modifier gasRefund(uint256 gasPrice, uint256 tokenPriceInWei, bytes16 uuid, address signer, address token, bool forSubscription, uint16 overhead, bool enforceErr) {
		uint256 initialGas = gasleft();
		require(gasPrice > 0, "Gas price must be greater than zero");
		require(tokenPriceInWei > 0, "Token per ETH must be greater than zero");


		_;  // Execute the transaction

		// Continue only if the function did not revert

		// Calculate gas used (approximate)
        uint256 gasUsed = initialGas - gasleft() + 23000; // Base transaction cost

        // Add overhead for gas calculation and refund
		// overhead value is in gas units, and depends on the complexity of the function being called
		// It's in addition of the base overhead, since some functions are more complex and use more gas
        gasUsed += overhead; // Approximate overhead, can be adjusted based on testing

		bool transferSuccess;
		uint256 gasRefundInTokens;

        (transferSuccess, gasRefundInTokens) = refundGas(gasUsed, gasPrice, tokenPriceInWei, uuid, signer, token, forSubscription, enforceErr);


		// If the gas refund failed (likely because the user doesn't have enough tokens), emit an event so the backend can handle it
		if (!transferSuccess) {
			emit GasRefundFailed(uuid, signer, token, gasRefundInTokens);
		} 
	}

	modifier onlyOwner() {
		require(msg.sender == owner, "Only owner can call this function");
		_;
	}

	// Owner can withdraw collected funds
    function withdrawFromContract(address token, uint256 amount) external onlyOwner {
		SafeERC20.safeTransfer(IERC20(token), owner, amount);
    }

	
	
	//////////////////// Fee management \\\\\\\\\\\\\\\\\\\\

    function calculateFee(uint256 amount, uint16 feeBps, OrganizationFee calldata organizationFee) public pure override returns (uint256, uint256) {
		if (amount == 0) revert ZeroAmount();

		// Validate fee percentages
		if (feeBps > MAX_FEE_BPS || organizationFee.feeBps > MAX_FEE_BPS) revert InvalidFeePercentage();

		if (feeBps < MIN_FEE_FOR_CONTRACT_BPS) {
			feeBps = MIN_FEE_FOR_CONTRACT_BPS; // Enforce minimum fee percentage
		}

        uint256 ownerFeeAmount = (amount * feeBps) / FEE_DENOMINATOR;

		uint256 organizationFeeAmount = 0;

		// If an organization fee is specified, calculate it
		// The organization fee is calculated on the amount after the owner fee has been deducted
		if (organizationFee.feeBps > 0) {
			if (organizationFee.organization == address(0)) {
				revert InvalidAddress();
			} else {
				organizationFeeAmount = (amount - ownerFeeAmount) * organizationFee.feeBps / FEE_DENOMINATOR;
			}
		} 
			

		return (ownerFeeAmount, organizationFeeAmount);
    }


	//////////////////// One-time payment \\\\\\\\\\\\\\\\\\\\

    function processPayment(address payable merchant, uint16 feeBps, bytes16 uuid, OrganizationFee calldata organizationFee) 
        external 
        payable 
        override
        nonReentrant 
    {		
        if (merchant == address(0)) revert InvalidAddress();
        
		// Compute fee
        uint256 feeAmount;
		uint256 orgFeeAmount;
		(feeAmount, orgFeeAmount) = calculateFee(msg.value, feeBps, organizationFee);

		uint256 remainingAmount = msg.value - feeAmount - orgFeeAmount;
        
        
        // Transfer fee to fee recipient
        (bool feeSuccess, ) = owner.call{value: feeAmount}("");
        if (!feeSuccess) revert TransferFailed("Transfer fee to recipient failed");


		// Transfer organization fee if applicable
		if (orgFeeAmount > 0) {
			(bool orgFeeSuccess, ) = organizationFee.organization.call{value: orgFeeAmount}("");
			if (!orgFeeSuccess) revert TransferFailed("Transfer organization fee failed");
		}

        // Transfer remaining amount to merchant
        (bool merchantSuccess, ) = merchant.call{value: remainingAmount}("");
        if (!merchantSuccess) revert TransferFailed("Transfer to merchant failed");

        emit PaymentProcessed(
			uuid,
			msg.sender,
			merchant,
			remainingAmount
        );
    }

    function processTokenPayment(
		Data calldata data,
		uint16 feeBps,
		OrganizationFee calldata organizationFee,
		PermitParams calldata permitParams,
		bool permitSupported,
		GasRefund calldata gasRefundData
    ) external
        override
        nonReentrant
		onlyOwner
		gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, data.uuid, data.from, data.tokenAddress, false, 0, true)
    {
        if (data.to == address(0) || data.tokenAddress == address(0)) revert InvalidAddress();

		// Compute fees
		uint256 feeAmount;
		uint256 organizationFeeAmount;
        (feeAmount, organizationFeeAmount) = calculateFee(data.amount, feeBps, organizationFee);

		// Use the permit to set allowance
		if (permitSupported) {
			// Spender must be this contract for a processTokenPayment call (one-time payment)
			require(permitParams.spender == address(this), "Permit spender mismatch");

			// Ensure the allowance cover the amount
			if (permitParams.allowance <= data.amount) {
				revert InsufficientAllowance();
			}

			// No need to validate the signature, the permit function will do it and revert if invalid
			try IERC20Permit(data.tokenAddress).permit(
				data.from,
				address(this),
				permitParams.allowance,
				permitParams.deadline,
				permitParams.signature.v,
				permitParams.signature.r,
				permitParams.signature.s
			) {
				// Permit was successful
			} catch {
				revert InvalidSignature();
			}
		} else {
			// If permit is supported, the validation of the signature is done in the permit function
			// If not, the user must have approved this contract to spend the tokens
			// This function cannot be called by the backend to use an allowance created for a subscription as the spender for a one-time payment is always this contract, so no need to validate the signature here
			uint256 allowance = IERC20(data.tokenAddress).allowance(data.from, address(this));
			if (allowance <= data.amount) {
				revert InsufficientAllowance();
			}
		}

        IERC20 token = IERC20(data.tokenAddress);


		uint256 remainingAmount = data.amount - feeAmount - organizationFeeAmount;

        // Transfer tokens from sender to this contract
		SafeERC20.safeTransferFrom(token, data.from, address(this), data.amount);
        
        // Transfer fee to fee recipient
		SafeERC20.safeTransfer(token, owner, feeAmount);

		// Transfer organization fee if applicable
		if (organizationFeeAmount > 0) {
			SafeERC20.safeTransfer(token, organizationFee.organization, organizationFeeAmount);
		}

        // Transfer remaining amount to merchant
		SafeERC20.safeTransfer(token, data.to, remainingAmount);

        emit TokenPaymentProcessed(
            data.tokenAddress,
			data.uuid
        );
    }


	
	//////////////////// Subscription \\\\\\\\\\\\\\\\\\\\

	function _createSubscription(Data calldata data, uint256 maxAmount, uint32 frequency, PermitParams calldata permitParams, Signature calldata signature, bool permitSupported, address organization, bool isPayg) internal returns (uint256) {

		if (frequency < MIN_FREQUENCY) revert InvalidFrequency();
		if (data.to == address(0) || data.tokenAddress == address(0)) revert InvalidAddress();
		// Ensure max amount > initial amount
		require(maxAmount > data.amount, "Max amount must be greater than initial amount");

		// Validate the signature
		if (!validateSignature(
				abi.encode(
					CREATE_SUBSCRIPTION_TYPEHASH,
					data.to,
					data.tokenAddress,
					frequency,
					data.uuid,
					organization
            	), 
				data.from, 
				signature
			)) revert InvalidSignature();


		// Ensure the subscription does not already exist
		Subscription storage existingSubscription = subscriptions[data.uuid];
		if (existingSubscription.active) revert SubscriptionAlreadyExists();


		// Ensure allowance covers at least one period
		if (permitParams.allowance <= data.amount) {
			revert InsufficientAllowance();
		}

		// Create payment stream reservation (create a permit and reserve tokens for the stream)
		factory.createPaymentStream(data.uuid, data.from, data.tokenAddress, permitParams.spender, QBitFlowProxyFactory.PermitParams({
			allowance: permitParams.allowance,
			deadline: permitParams.deadline,
			v: permitParams.signature.v,
			r: permitParams.signature.r,
			s: permitParams.signature.s
		}), permitSupported);
        

		uint256 nextPaymentDue;

		if (!isPayg) {
			// Regular subscription
			nextPaymentDue = block.timestamp; // First payment is due immediately
		} else {
			// Pay-as-you-go subscription
			nextPaymentDue = block.timestamp + frequency; // Start after the frequency period, contrary to the classic subscription because now there's no usage
		}

		subscriptions[data.uuid] = Subscription({
			signer: data.from,
			nextPaymentDue: nextPaymentDue,
			active: true,
			signature: signature,
			stopped: false,
			maxAmount: maxAmount, // Set the maximum amount allowed per period (to handle price variations)
			lastPaymentAmount: data.amount // Set the last payment amount to the initial amount (so that gas refund will be able to use this amount to ensure the total refund does not exceed maxAmount - lastPaymentAmount)
        });

		return nextPaymentDue;
	}


	function _executeSubscription(Data calldata data, uint32 frequency, uint16 feeBps, OrganizationFee calldata organizationFee) internal returns (Subscription storage, uint256, uint256) {
		Subscription storage subscription = subscriptions[data.uuid];
		
		if (!subscription.active) revert SubscriptionNotActive();
		if (block.timestamp < subscription.nextPaymentDue) revert PaymentNotDueYet();
		if (data.amount == 0) revert ZeroAmount();
		if (data.amount >= subscription.maxAmount) revert MaxAmountExceeded();

		// Validate the parameters with the signature of the subscription
		// The parameters must match the signature the user signed when creating the subscription
		if (!validateSignature(
			abi.encode(
				CREATE_SUBSCRIPTION_TYPEHASH,
				data.to,
				data.tokenAddress,
				frequency,
				data.uuid,
				organizationFee.organization
			),
			subscription.signer,
			subscription.signature
		)) revert InvalidSignature();

		if (data.from != subscription.signer) revert InvalidSigner();


		// Check if it has sufficient allowance
		uint256 remainingAllowance = factory.getRemainingReservation(subscription.signer, data.uuid);
		if (remainingAllowance <= data.amount) {
			revert InsufficientAllowance();
		}
				 
		// Calculate fees
		uint256 feeAmount;
		uint256 organizationFeeAmount;
		(feeAmount, organizationFeeAmount) = calculateFee(data.amount, feeBps, organizationFee);

		uint256 remainingAmount = data.amount - feeAmount - organizationFeeAmount;

		// Process the payment
		bool transferSuccess = factory.fetchFundsFromProxy(
			subscription.signer,
			data.uuid,
			data.amount
		);
		if (!transferSuccess) revert TransferFailed("Transfer from subscriber to contract failed");

		// Transfer fee to fee recipient
		factory.transferTo(data.tokenAddress, owner, feeAmount);

		// Transfer organization fee if applicable
		if (organizationFeeAmount > 0) {
			factory.transferTo(data.tokenAddress, organizationFee.organization, organizationFeeAmount);
		}

		// Transfer remaining amount to merchant
		factory.transferTo(data.tokenAddress, data.to, remainingAmount);


		return (subscription, remainingAllowance, remainingAmount);
	}

    function createSubscription(
        Data calldata data,
		uint256 maxAmount,
        uint32 frequency,
		PermitParams calldata permitParams,
		bool permitSupported,
		address organizationFee,
		Signature calldata signature,
		GasRefund calldata gasRefundData
    ) 
        external 
        override
		onlyOwner
		nonReentrant
		gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, data.uuid, data.from, data.tokenAddress, true, 65000, true)
    {
		uint256 nextPaymentDue = _createSubscription(data, maxAmount, frequency, permitParams, signature, permitSupported, organizationFee, false);
        
        emit SubscriptionCreated(
			data.uuid, 
			nextPaymentDue,
			permitParams.allowance // Send the initial allowance so that the backend can keep track of it
        );
    }

    function executeSubscription(
        Data calldata data,
		uint32 frequency,
		uint16 feeBps,
		OrganizationFee calldata organizationFee,
		GasRefund calldata gasRefundData
    ) 
		external
        override
        nonReentrant 
		onlyOwner
		gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, data.uuid, data.from, data.tokenAddress, true, 7000, true)
    {

		Subscription storage subscription;
		uint256 remainingAllowance;
		uint256 remainingAmount;

		(subscription, remainingAllowance, remainingAmount) = _executeSubscription(data, frequency, feeBps, organizationFee);
        
        // Update next payment due date and the remaining allowance
        unchecked {
            subscription.nextPaymentDue = subscription.nextPaymentDue + frequency; // Here, we add the frequency to the last payment due date, so the range between the last payment and the next payment is always equal to the frequency
			subscription.lastPaymentAmount = data.amount;
        }

		emit SubscriptionPaymentProcessed(data.uuid, subscription.nextPaymentDue, factory.getRemainingReservation(subscription.signer, data.uuid));
    }


	// Cancel subscription. User can cancel on chain, or using the backend with a valid signature.
	function cancelSubscription(bytes16 uuid, Signature memory signature) external override {
		Subscription storage subscription = subscriptions[uuid];
		if (!subscription.active) return; // If the subscription is already inactive, do nothing

		if (!validateSignature(
			abi.encode(
				CANCEL_SUBSCRIPTION_TYPEHASH,
				uuid
			),
			subscription.signer,
			signature
		)) revert InvalidSignature();

		// Ensure the nextPaymentDue is in the future
		require(block.timestamp <= subscription.nextPaymentDue, "Subscription due for payment, cannot cancel");

		// Cancel the payment stream
		factory.cancelStream(subscription.signer, uuid);

		// Set the subscription to inactive
		delete(subscriptions[uuid]);

		emit SubscriptionCancelled(uuid);
	}

	function forceCancelSubscription(bytes16 uuid) external onlyOwner override {
		Subscription storage subscription = subscriptions[uuid];
		if (!subscription.active) return; // If the subscription is already inactive, do nothing

		// Cancel the payment stream
		factory.cancelStream(subscription.signer, uuid);

		// Set the subscription to inactive
		delete(subscriptions[uuid]);

		emit SubscriptionCancelled(uuid);
	}


    function getSubscription(bytes16 uuid) 
        external 
        view 
        override 
        returns (Subscription memory) 
    {
        return subscriptions[uuid];
    }

	function updateMaxAmount(bytes16 uuid, address from, address tokenAddress, uint256 newMaxAmount, Signature memory signature, GasRefund calldata gasRefundData) external override onlyOwner gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, uuid, from, tokenAddress, true, 60000, true){
		Subscription storage subscription = subscriptions[uuid];
		if (!subscription.active) revert SubscriptionNotActive();

		// Validate the signature
		if (!validateSignature(
			abi.encode(
				UPDATE_MAX_AMOUNT_TYPEHASH,
				uuid,
				newMaxAmount
			), 
			subscription.signer, 
			signature
		)) revert InvalidSignature();

		if (from != subscription.signer) revert InvalidSigner();

		// Ensure the new max amount is not less than the last payment amount
		require(newMaxAmount > subscription.lastPaymentAmount, "New max amount less than last payment amount");

		subscription.maxAmount = newMaxAmount;

		emit MaxAmountUpdated(uuid, newMaxAmount);
	}

	
	//////////////////// Pay-as-you-go subscription \\\\\\\\\\\\\\\\\\\\
 

	function createPayAsYouGoSubscription(
		Data calldata data,
		uint256 maxAmount,
		uint32 frequency,
		PermitParams calldata permitParams,
		bool permitSupported,
		address organizationFee,
		Signature calldata signature,
		GasRefund calldata gasRefundData
	) 
		external 
		override
		onlyOwner
		nonReentrant
		gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, data.uuid, data.from, data.tokenAddress, true, 65000, true)
	{
		uint256 nextPaymentDue = _createSubscription(data, maxAmount, frequency, permitParams, signature, permitSupported, organizationFee, true);
		
		emit SubscriptionCreated(
			data.uuid,
			nextPaymentDue, 
			permitParams.allowance // Send the initial allowance
		);
		
	}

	function executePayAsYouGoPayment(
		Data calldata data,
		uint32 frequency,
		uint16 feeBps,
		OrganizationFee calldata organizationFee,
		GasRefund calldata gasRefundData
	) 
		external 
		override
		nonReentrant 
		onlyOwner
		gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, data.uuid, data.from, data.tokenAddress, true, 7000, true)
	{

		Subscription storage subscription;
		uint256 remainingAllowance;
		uint256 remainingAmount;

		(subscription, remainingAllowance, remainingAmount) = _executeSubscription(data, frequency, feeBps, organizationFee);

		uint256 nextPaymentDue;

		unchecked {
			subscription.lastPaymentAmount = data.amount;

			// If the subscription was stopped, and we're here, it means the last billing was processed successfully, so we can now cancel the subscription
			if (subscription.stopped) {
				// Since the stream will be cancelled, the gasRefund modifier will not be able to fetch the funds from the proxy
				// So we need to manually refund gas here, using an average gas usage ~155,000 (based on tests)
				refundGas(155000, gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, data.uuid, subscription.signer, data.tokenAddress, true, false);


				// Cancel the payment stream
				factory.cancelStream(subscription.signer, data.uuid);

				remainingAllowance = 0; // No remaining allowance after cancellation
				nextPaymentDue = 0; // No next payment due after cancellation
				// Delete the subscription
				delete(subscriptions[data.uuid]);

				emit SubscriptionCancelled(data.uuid);

			} else {
				// Get the remaining allowance after the payment
				remainingAllowance = factory.getRemainingReservation(subscription.signer, data.uuid);
				
				// Contrary to a classic subscription, the starting point is the current timestamp, not the last payment date because the backend calling this function can skip some payments if the usage is very low (so no transfer, so no need to call this function, this saves gas)
				// This ensures the next payment due is always in the future
				// And the billing is done at the end of the period
				// We decrease by one hour to avoid pushing the next billing date a day each time (since the backend executes every 24 hours, therefore if we add 24 hours each time, the next payment due will be pushed by one day each time)
				nextPaymentDue = block.timestamp + frequency - 3600; 
				subscription.nextPaymentDue = nextPaymentDue;
			}
        }
		

		emit SubscriptionPaymentProcessed(
			data.uuid,
			nextPaymentDue,
			remainingAllowance
		);
	}

	// Cancel pay-as-you-go subscription. User can cancel on chain, or using the backend with a valid signature.
	function cancelPayAsYouGoSubscription(bytes16 uuid, Signature memory signature) external override {
		Subscription storage subscription = subscriptions[uuid];
		if (!subscription.active || subscription.stopped) return; // If the subscription is already inactive, do nothing

		if (!validateSignature(
			abi.encode(
				CANCEL_SUBSCRIPTION_TYPEHASH,
				uuid
			),
			subscription.signer,
			signature
		)) revert InvalidSignature();

		// Mark the subscription as stopped (and it will be cancelled at the next payment execution, since pay-as-you-go subscriptions are billed at the end of the period)
		subscription.stopped = true;

		emit SubscriptionStopped(uuid);
	}

	
	//////////////////// Allowance management \\\\\\\\\\\\\\\\\\\\

	function increaseAllowance(bytes16 uuid, address tokenAddress, address signer, PermitParams calldata permitParams, GasRefund calldata gasRefundData) 
		external 
		override
		onlyOwner
		nonReentrant
		gasRefund(gasRefundData.gasPrice, gasRefundData.tokenPriceInWei, uuid, signer, tokenAddress, true, 35000, false) // do not enforce error, so if the refund failed due to max amount exceeded, we can still increase the allowance
	{

		Subscription storage subscription = subscriptions[uuid];
		if (subscription.active) {	
			if (signer != subscription.signer) revert InvalidSigner();

			// Update the payment stream with the new allowance
			factory.updatePaymentStream(subscription.signer, tokenAddress, uuid, QBitFlowProxyFactory.PermitParams({
				allowance: permitParams.allowance,
				deadline: permitParams.deadline,
				v: permitParams.signature.v,
				r: permitParams.signature.r,
				s: permitParams.signature.s
			}));

			emit AllowanceIncreased(permitParams.allowance, uuid);
		} else {
			revert SubscriptionNotActive();
		}
	}



	
	//////////////////// Other \\\\\\\\\\\\\\\\\\\\

	/**
	 * @dev Validates the EIP-712 signature for a given struct encoding
	 * @param structEncoding The ABI-encoded struct to validate the signature against
	 * @param signer The expected signer address
	 * @param signature The signature to validate
	 * @return True if the signature is valid and matches the signer, false otherwise
	 */
	function validateSignature(bytes memory structEncoding, address signer, Signature memory signature) internal view returns (bool) {
		bytes32 structHash = keccak256(structEncoding);
		bytes32 digest = _hashTypedDataV4(structHash);

		address recoveredSigner = ECDSA.recover(digest, signature.v, signature.r, signature.s);

		return recoveredSigner != address(0) && recoveredSigner == signer;
	}

	function getAvailableProxySpender(address user, address token) external onlyOwner view override returns (address) {
		// This function is used to get the available proxy spender for a user and token
		// It will return the first proxy that is not used for this tuple (user, token)
		address proxy = factory.getAvailableProxyForUser(user, token);
		return proxy;
	}


	function createNewProxy() external onlyOwner returns (address) {
		// This function is used to create a new proxy for a user-token pair
		// It will ensure that each user-token pair has a unique proxy
		address proxy = factory.createNewProxy();

		emit ProxyCreated(proxy);
		return proxy;
	}

	function getSpender(address user, bytes16 uuid) external onlyOwner view override returns (address) {
		// This function is used to get the current proxy spender for a user and subscription uuid
		return factory.getCurrentSpender(user, uuid);
	}
}
