// SPDX-License-Identifier: MPL 2.0
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";


/**
 * @title QBitFlowProxy
 * @dev A proxy contract for handling token reservations for payment streams.
 *      This contract allows users to reserve tokens for specific payment streams,
 *      enabling efficient and secure token management for streaming payments.
 * @author QBitFlow Team
 */
contract QBitFlowProxy {
    address public immutable factory;
    uint32 public proxyId;

	struct StreamReservation {
		uint256 amount;
		uint256 usedAmount;
		bool exists; // Indicates if the reservation exists
	}

    // user => token => reserved amount for this specific stream
    mapping(address => mapping(address => StreamReservation)) public streamReservations;

    modifier onlyFactory() {
        require(msg.sender == factory, "Only factory can call this");
        _;
    }
    
    constructor() {
        factory = msg.sender;
    }

	function initialize(uint32 _proxyId) external onlyFactory {
		require(_proxyId > 0, "Proxy ID must be positive");

		proxyId = _proxyId;
	}

	function isInitialized() external view returns (bool) {
		return proxyId > 0;
	}
    

	/**
	 * Reserves tokens for a specific stream ID and user.
	 * This function allows the factory to reserve tokens for a user for a specific stream,
	 * using the ERC20 permit mechanism to allow this contract to spend tokens on behalf of the user.
	 * @param user The user for whom the stream is being created
	 * @param token The token to be used for the payment stream
	 * @param amount The amount of tokens to reserve for the stream
	 * @param deadline The deadline for the permit to be valid
	 * @param v The recovery byte of the signature
	 * @param r The output of the ECDSA signature
	 * @param s The output of the ECDSA signature
	 */
    function reserveForStream(
        address user,
        address token,
        uint256 amount,
		uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external onlyFactory {
		require(amount > 0, "Amount must be greater than zero");
		// Ensure an existing reservation does not already exist
		require(!streamReservations[user][token].exists, "Reservation already exists for this user and token");
		require(this.isInitialized(), "Proxy not initialized");


		// Use permit to allow this contract to spend tokens on behalf of the user
		IERC20Permit(token).permit(
			user,
			address(this),
			amount,
			deadline,
			v,
			r,
			s
		);


		// Update the stream reservation for the user
		streamReservations[user][token] = StreamReservation({
			amount: amount,
			usedAmount: 0,
			exists: true // Mark the reservation as existing
		});
    }

	function updateStream(
		address user,
        address token,
        uint256 amount,
		uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
	) external onlyFactory {
		require(amount > 0, "New amount must be greater than zero");
		require(this.isInitialized(), "Proxy not initialized");
		StreamReservation storage reservation = streamReservations[user][token];
		require(reservation.exists, "No existing reservation for this user and token");

		// Can only increase the reservation
		require(amount > reservation.amount, "New amount must be greater than existing amount");

		// Use permit to allow this contract to spend tokens on behalf of the user
		IERC20Permit(token).permit(
			user,
			address(this),
			amount,
			deadline,
			v,
			r,
			s
		);

		reservation.amount = amount;
		reservation.usedAmount = 0; // Reset used amount on update
	}

	// Approval-based reservation (no permit)
    function reserveForStreamWithApproval(
        address user,
        address token,
        uint256 amount
    ) external onlyFactory {
        require(amount > 0, "Amount must be > 0");
		require(this.isInitialized(), "Proxy not initialized");
        require(!streamReservations[user][token].exists, "Reservation exists");

        // Ensure the user has granted this proxy enough allowance.
        uint256 allowance = IERC20(token).allowance(user, address(this));
        require(allowance >= amount, "Insufficient allowance to proxy");

        streamReservations[user][token] = StreamReservation({ amount: amount, usedAmount: 0, exists: true });
    }

    // Approval-based update (increase/change reserved amount)
    function updateStreamReservationWithApproval(
        address user,
        address token,
        uint256 newAmount
    ) external onlyFactory {
        require(newAmount > 0, "Amount must be > 0");
		require(this.isInitialized(), "Proxy not initialized");
        StreamReservation storage reservation = streamReservations[user][token];
        require(reservation.exists, "No reservation");

		// Can only increase the reservation
		require(newAmount > reservation.amount, "New amount must be greater than existing amount");

        uint256 allowance = IERC20(token).allowance(user, address(this));
        require(allowance >= newAmount, "Insufficient allowance to proxy");

        reservation.amount = newAmount;
		reservation.usedAmount = 0; // Reset used amount on update
    }

	/**
	 * Releases the reservation for a user and token.
	 * This function allows the factory to release the reservation if it is no longer needed.
	 * @param user The user whose reservation is being released
	 * @param token The token for which the reservation is being released
	 */
    function releaseStreamReservation(
        address user,
        address token
    ) external onlyFactory {
		require(this.isInitialized(), "Proxy not initialized");
		StreamReservation storage reservation = streamReservations[user][token];

		if (!reservation.exists || reservation.amount == 0) {
			// No reservation exists, nothing to release
			return;
		}
		
		// Release the reservation
		delete(streamReservations[user][token]);
    }
    
	/**
	 * Creates a new payment stream for a user, allowing them to reserve tokens
	 * for a specific stream ID. This function uses the QBitFlowProxy to handle
	 * the reservation and tracks the stream in the userStreams mapping.
	 * @param user The user for whom the stream is being created
	 * @param token The token to be used for the payment stream
	 * @param amount The amount of tokens to reserve for the stream
	 */
    function transferToFactory(
        address user,
        address token,
        uint256 amount
    ) external onlyFactory {
		require(this.isInitialized(), "Proxy not initialized");
		StreamReservation storage reservation = streamReservations[user][token];

		require(reservation.exists, "No reservation exists for this user and token");
        require(amount + reservation.usedAmount <= reservation.amount, "Amount exceeds stream reservation");

        // Transfer tokens
		SafeERC20.safeTransferFrom(IERC20(token), user, factory, amount);

		// Update reservations
		unchecked {
        	reservation.usedAmount += amount;
		}
    }
    
	/**
	 * Fetches the stream reservation for a user and token.
	 * This function allows the main contract to check the reservation details
	 * for a specific user and token, including the amount reserved and the stream ID.
	 * @param user The user whose reservation is being queried
	 * @param token The token for which the reservation is being checked
	 * @return StreamReservation The reservation details for the user and token
	 * @dev Reverts if no reservation exists for the user and token
	 */
    function getStreamReservation(address user, address token) 
        external 
        view 
        returns (StreamReservation memory) 
    {
		require(this.isInitialized(), "Proxy not initialized");
		StreamReservation storage reservation = streamReservations[user][token];
		require(reservation.exists, "No reservation exists for this user and token");
		return reservation;
    }


	/**
	 * Fetches the remaining reservation amount for a user and token.
	 * This function allows the main contract to check how much of the reservation
	 * is still available for use in the payment stream.
	 * @param user The user whose reservation is being queried
	 * @param token The token for which the reservation is being checked
	 * @return uint256 The remaining reservation amount for the user and token
	 */
	function getRemainingReservation(address user, address token) 
		external 
		view 
		returns (uint256) 
	{
		require(this.isInitialized(), "Proxy not initialized");
		StreamReservation storage reservation = streamReservations[user][token];
		require(reservation.exists, "No reservation exists for this user and token");
		return reservation.amount - reservation.usedAmount;
	}

	/**
	 * Checks if a user has an active stream reservation for a specific token.
	 * This function allows the main contract to verify if a user has an existing
	 * reservation for a payment stream with a specific token.
	 * @param user The user whose reservation is being checked
	 * @param token The token for which the reservation is being checked
	 * @return bool indicating whether the user has an active stream reservation
	 */
	function hasStreamReservation(address user, address token) 
		external 
		view 
		returns (bool) 
	{
		require(this.isInitialized(), "Proxy not initialized");
		return streamReservations[user][token].exists;
	}


	function getFactory() external view returns (address) {
		require(this.isInitialized(), "Proxy not initialized");
		return factory;
	}
}