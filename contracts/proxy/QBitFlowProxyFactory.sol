// SPDX-License-Identifier: MPL 2.0
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./QBitFlowProxy.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";


/**
 * @title QBitFlowProxyFactory
 * @dev Factory contract for creating and managing QBitFlowProxy instances.
 *      Each proxy is used to handle token reservations for payment streams.
 * 	The factory ensures that each user-token pair has a unique proxy to avoid
 *    overriding reservations/permits.
 * @author QBitFlow Team
 */
contract QBitFlowProxyFactory {
    using Clones for address;
    
	address public immutable main; // The main contract that manages the payment streams
    address public immutable implementation; // The implementation address of the QBitFlowProxy
    uint32 public nextProxyId; // Counter for the next proxy ID to be created
    
    struct PermitParams {
        uint256 allowance;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }
    
    struct PaymentStream {
        address proxy;
        address token;
        bool active;
		bool permitSupported;
    }
    
    // Array of all created proxy contracts
    address[] private proxies;
    
    // user => uuid => PaymentStream
    mapping(address => mapping(bytes16 => PaymentStream)) private userStreams;
    

	modifier onlyMain() {
		require(msg.sender == main, "Only main contract can call this");
		_;
	}

	// Constructor initializes the factory with the main contract address
	// and deploys the QBitFlowProxy implementation
	constructor(address _main) {
		main = _main;
		implementation = address(new QBitFlowProxy());
		nextProxyId = 1; // Start proxy IDs from 1
	}
    
	/**	
	 * Creates a new payment stream for a user.
	 * This function reserves tokens for a specific stream and allows the user to
	 * use the proxy to manage their payment streams.

	 * @param uuid The unique identifier for the payment stream
	 * @param user The user for whom the stream is being created
	 * @param token The token to be used for the payment stream
	 * @param permitParams The parameters for the ERC20 permit, allowing this contract to spend
	 *                     tokens on behalf of the user.
	 */
    function createPaymentStream(
		bytes16 uuid,
		address user,
        address token,
		address proxyAddress,
        PermitParams calldata permitParams,
		bool permitSupported
    ) external onlyMain {
        require(user != address(0), "Invalid user address");
        require(token != address(0), "Invalid token address");
		require(proxyAddress != address(0), "Invalid proxy address");
		require(!userStreams[user][uuid].active, "Stream already exists");

		// Ensure the proxy is valid, and is created by this factory
		QBitFlowProxy proxy = QBitFlowProxy(proxyAddress);

		// Check that the proxy was created by this factory
		// It's possible the proxy doesn't implement getFactory(), so we use a try-catch
		try proxy.getFactory() returns (address factoryAddress) {

			// If the proxy implements getFactory(), check that it matches this factory
			require(factoryAddress == address(this), "Proxy not from this factory");
		} catch {
			revert("Invalid proxy for stream");
		}


		// Create a permit for the user to allow this contract to spend tokens, and keep track of the payment stream
		if (permitSupported) {
			proxy.reserveForStream(user, token, permitParams.allowance, permitParams.deadline, permitParams.v, permitParams.r, permitParams.s);
		} else {
			// Approval-based reservation (no permit)
			proxy.reserveForStreamWithApproval(user, token, permitParams.allowance);
		}
        
        // Store the stream
		userStreams[user][uuid] = PaymentStream({
            proxy: proxyAddress,
            token: token,
            active: true,
			permitSupported: permitSupported
        });
    }


	/**
	 * Updates an existing payment stream for a user.
	 * This function allows the factory to update the reservation for a specific stream,
	 * using the ERC20 permit mechanism to allow this contract to spend tokens on behalf of the user.
	 * This function can be used to adjust the reservation amount (increase allowance)
	 * @param user The user for whom the stream is being updated
	 * @param token The token to be used for the payment stream
	 * @param uuid The unique identifier for the payment stream
	 * @param permitParams The parameters for the ERC20 permit, allowing this contract to spend
	 *                     tokens on behalf of the user.
	 */
	function updatePaymentStream(
		address user,
		address token,
		bytes16 uuid,
		PermitParams calldata permitParams
	) external onlyMain {
		require(user != address(0), "Invalid user address");
        require(token != address(0), "Invalid token address");

		PaymentStream storage existingStream = userStreams[user][uuid];
		require(existingStream.active, "Stream not active");

		// Now, we can update the stream reservation
		if (existingStream.permitSupported) {
			QBitFlowProxy(existingStream.proxy).updateStream(user, token, permitParams.allowance, permitParams.deadline, permitParams.v, permitParams.r, permitParams.s);
		} else {
			// Approval-based update (no permit)
			QBitFlowProxy(existingStream.proxy).updateStreamReservationWithApproval(user, token, permitParams.allowance);
		}
	} 
    
	/**
	 * Fetches funds from the proxy for a specific stream.
	 * This function allows the main contract to process payments
	 * by transferring tokens from the user to the factory via the proxy.

	 * @param user The user whose stream is being processed
	 * @param uuid The ID of the stream to process
	 * @param amount The amount to fetch from the proxy
	 * @return bool indicating success or failure of the operation
	 */
    function fetchFundsFromProxy(
        address user,
        bytes16 uuid,
        uint256 amount
    ) external onlyMain returns (bool) {
        PaymentStream storage stream = userStreams[user][uuid];
        require(stream.active, "Stream not active");
        
        // Transfer tokens from user to this contract via proxy
		try QBitFlowProxy(stream.proxy).transferToFactory(user, stream.token, amount) {
			return true;
		}
		catch {
			// If it failed, then the user might not have enough tokens, release the reservation
			return false;
		}
    }


	/**
	 * Transfers tokens to a specific address from the factory.
	 * This function allows the factory to transfer tokens to a recipient, and must be called by the main contract, after fetching funds from the proxy.
	 * @param tokenAddress The address of the token to transfer
	 * @param to The address of the recipient
	 * @param amount The amount of tokens to transfer
	 */
	function transferTo(address tokenAddress, address to, uint256 amount) external onlyMain {
		require(to != address(0), "Invalid recipient");
		require(amount > 0, "Amount must be greater than zero");

		// Transfer tokens from this contract to the recipient
		SafeERC20.safeTransfer(IERC20(tokenAddress), to, amount);
	}
    
	/**
	 * Cancels a payment stream for a user.
	 * This function allows the main contract to cancel a stream and release the reservation.
	 * @param user The user whose stream is being cancelled
	 * @param uuid The ID of the stream to cancel
	 * @notice This function will release the reservation for the user and token associated with the stream
	 */
    function cancelStream(address user, bytes16 uuid) external onlyMain {
        PaymentStream storage stream = userStreams[user][uuid];
        require(stream.active, "Stream not active");
        
        // Release the reservation
        QBitFlowProxy(stream.proxy).releaseStreamReservation(user, stream.token);

		// Remove the stream from userStreams mapping
		delete(userStreams[user][uuid]);
    }

	/**
	 * Get the available proxy for a user and token.
	 * This function ensures that each user-token pair has a unique proxy (spender), to avoid overriding the reservation/permits.
	 * If no existing proxy is found, it creates a new one.
	 * @param user The user for whom the proxy is being fetched
	 * @param token The token for which the proxy is being fetched
	 * @return address The address of the available proxy for the user and token
	 * @notice This function is used to ensure that each user-token pair has a unique proxy
	 *         and to create a new proxy if no existing one is available.
	 */
    function getAvailableProxyForUser(address user, address token) external onlyMain view returns (address) {
		// Now, iterate through all the available proxies, and return the first one that is not used for this tuple (user, token)
		for (uint i = 0; i < proxies.length; i++) {
			if (!QBitFlowProxy(proxies[i]).hasStreamReservation(user, token)) {
				return proxies[i];
			}
		}

		return address(0);
    }

    
	/**
	 * Creates a new proxy contract.
	 * This function is used internally to create a new proxy when no existing one is available for a user and token.
	 * It initializes the proxy with the next available proxy ID.
	 * @return address The address of the newly created proxy
	 * @notice This function is called when a new proxy is needed for a user-token pair
	 *         to ensure that each user-token pair has a unique proxy.
	 */
    function createNewProxy() external onlyMain returns (address) {
        address proxy = implementation.clone();
        QBitFlowProxy(proxy).initialize(nextProxyId);
        
        proxies.push(proxy);

        nextProxyId++;
        
        return proxy;
    }
    
	/**
	 * Gets the count of all proxies created by this factory.
	 * This function allows the main contract to know how many proxies have been created.
	 * @return uint256 The count of all proxies created
	 * @notice This function is useful for tracking the number of proxies created by the factory,
	 *         which can be useful for monitoring and management purposes.
	 */
    function getProxyCount() external onlyMain view returns (uint256) {
        return proxies.length;
    }
    
	/**
	 * Gets the information of a specific stream for a user.
	 * This function allows the main contract to fetch the details of a payment stream for a user
	 * by providing the user address and stream ID.
	 * @param user The user whose stream information is being fetched
	 * @param uuid The ID of the stream to fetch information for
	 * @return PaymentStream The payment stream object containing details of the stream
	 * @notice This function is used to retrieve the details of a specific payment stream for a user,
	 *         allowing the main contract to manage and monitor payment streams effectively.
	 */
    function getStreamInfo(address user, bytes16 uuid) 
        external 
		onlyMain
        view 
        returns (PaymentStream memory) 
    {
        return userStreams[user][uuid];
    }

	/**
	 * Gets the current spender (proxy) for a user and stream ID.
	 * This function allows the main contract to check which proxy is currently managing the payment stream for a specific user and stream ID.
	 * @param user The user whose current spender is being fetched
	 * @param uuid The ID of the stream to fetch the current spender for
	 * @return address The address of the current spender (proxy) for the user and stream ID
	 */
	function getCurrentSpender(address user, bytes16 uuid) 
		external 
		onlyMain
		view 
		returns (address) 
	{
		PaymentStream memory stream = userStreams[user][uuid];
		require(stream.active, "Stream not active");
		
		return stream.proxy;
	}
    
	/**
	 * Gets the stream reservation for a user and stream ID.
	 * This function allows the main contract to check the reservation details for a specific stream.
	 * @param user The user whose stream reservation is being fetched
	 * @param uuid The ID of the stream to fetch the reservation for
	 * @return QBitFlowProxy.StreamReservation The stream reservation object containing details of the reservation
	 * @notice This function is used to retrieve the reservation details for a specific stream,
	 *         allowing the main contract to manage and monitor payment streams effectively.
	 */
    function getStreamReservation(address user, bytes16 uuid) 
        external 
        onlyMain
        view 
        returns (QBitFlowProxy.StreamReservation memory) 
    {
        PaymentStream memory stream = userStreams[user][uuid];
        require(stream.active, "Stream not active");
        
        return QBitFlowProxy(stream.proxy).getStreamReservation(user, stream.token);
    }

	/**
	 * Gets the remaining reservation amount for a user and stream ID.
	 * This function allows the main contract to check the remaining reservation amount for a specific stream.
	 * @param user The user whose remaining reservation is being fetched
	 * @param uuid The ID of the stream to fetch the remaining reservation for
	 * @return uint256 The remaining reservation amount for the user and stream ID
	 * @notice This function is used to retrieve the remaining reservation amount for a specific stream,
	 *         allowing the main contract to manage and monitor payment streams effectively.
	 */
	function getRemainingReservation(address user, bytes16 uuid) 
		external 
		onlyMain
		view 
		returns (uint256) 
	{
		PaymentStream memory stream = userStreams[user][uuid];
		require(stream.active, "Stream not active");
		
		return QBitFlowProxy(stream.proxy).getRemainingReservation(user, stream.token);
	}


	/**
	 * Gets all proxies created by this factory.
	 * This function allows the main contract to fetch the list of all proxies created by the factory.
	 * @return address[] An array of addresses of all proxies created
	 * @notice This function is useful for tracking and managing all proxies created by the factory,
	 *         allowing the main contract to have an overview of all proxies in use.
	 */
	function getAllProxies() external onlyMain view returns (address[] memory) {
		return proxies;
	}
}