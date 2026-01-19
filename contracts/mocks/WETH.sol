// contracts/MockUSDC.sol
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

contract WETH is ERC20, ERC20Permit {
    constructor() ERC20("WETH", "WETH") ERC20Permit("WETH") {
		// Mint an initial supply of 1 million WETH to the contract deployer
		_mint(msg.sender, 1000000 * 10 ** decimals());
	}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }


	// Override the decimals function to return 18 to match WETH's standard
	function decimals() public view virtual override returns (uint8) {
		return 18;
	}
}