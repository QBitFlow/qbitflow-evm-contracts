# QBitFlow Payment System - Smart Contracts

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL%202.0-brightgreen.svg)](https://opensource.org/licenses/MPL-2.0)
[![Solidity](https://img.shields.io/badge/Solidity-^0.8.28-blue.svg)](https://docs.soliditylang.org/)

> Non-custodial payment and subscription infrastructure for Ethereum and EVM-compatible chains

🌐 **Website:** [qbitflow.app](https://qbitflow.app)

**Deployed Contract Address:** [`0x843D775050522739c0b8F8c832549F81C2151E0C`](https://etherscan.io/address/0x843D775050522739c0b8F8c832549F81C2151E0C)

## 📋 Overview

QBitFlow is a decentralized payment system that enables **non-custodial** one-time payments and recurring subscriptions on Ethereum. Built with security and user experience in mind, QBitFlow allows users to pay in ERC20 tokens without holding ETH for gas fees, through an innovative gas refund mechanism.

### Key Features

- ✅ **Non-Custodial**: Users maintain full control of their funds at all times
- 💰 **One-Time Payments**: Process instant payments in ETH or any ERC20 token
- 🔄 **Recurring Subscriptions**: Automated subscription payments with configurable frequencies
- ⚡ **Pay-As-You-Go**: Flexible subscription model with variable payment amounts
- 🎫 **EIP-2612 Permit Support**: Gasless approvals using signed permits
- 💸 **Gas Refunds**: Users can pay in tokens without holding ETH
- 🏢 **Organization Fees**: Support for revenue sharing with platform partners
- 🔐 **EIP-712 Signatures**: Secure off-chain authorization
- 🔄 **Proxy Pattern**: Efficient allowance management through minimal proxies

## 🏗️ Architecture

The system consists of three main contracts:

### 1. **QBitFlowPaymentSystem.sol**
The main contract that handles all payment logic, subscriptions, and fee management.

**Capabilities:**
- Process ETH and ERC20 token payments
- Create and manage subscription lifecycles
- Execute recurring payments automatically
- Calculate and distribute fees
- Validate EIP-712 signatures
- Refund gas costs in tokens

### 2. **QBitFlowProxyFactory.sol**
Factory contract that creates and manages proxy instances for payment streams.

**Purpose:**
- Create minimal proxy clones for gas efficiency
- Manage user-token-subscription mappings
- Coordinate token reservations across proxies
- Prevent permit/allowance conflicts

### 3. **QBitFlowProxy.sol**
Lightweight proxy contract that handles token reservations for individual payment streams.

**Functions:**
- Reserve tokens using EIP-2612 permits
- Track used/remaining allowances per stream
- Transfer tokens on behalf of users
- Support both permit-based and approval-based flows

## 📊 Contract Flow Diagrams

### One-Time Payment Flow
```
User → Backend → QBitFlowPaymentSystem
                   ↓
                Calculates Fees
                   ↓
         Transfers to Merchant
         Transfers to Fee Recipient
         Transfers to Organization (if applicable)
```

### Subscription Creation Flow
```
User Signs Permit → Backend → QBitFlowPaymentSystem
                                ↓
                         QBitFlowProxyFactory
                                ↓
                          QBitFlowProxy
                                ↓
                    Reserves Tokens via Permit
                    Creates Subscription Record
```

### Subscription Execution Flow
```
Backend → QBitFlowPaymentSystem
            ↓
      Validates Subscription
            ↓
      QBitFlowProxyFactory
            ↓
      QBitFlowProxy.transferToFactory()
            ↓
      Distributes Funds
      Updates Next Payment Date
```

## 🔧 Installation

### Prerequisites
- Node.js >= 16.x
- npm or yarn
- Hardhat

### Setup

```bash
# Clone the repository
git clone https://github.com/QBitFlow/qbitflow-evm-contracts.git
cd qbitflow-evm-contracts/eth

# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Deploy to local network
npx hardhat node
npm run deploy-test <cosigner-address>
```

## 📝 Smart Contract API

### One-Time Payments

#### `processPayment`
Process a payment in native ETH.

```solidity
function processPayment(
    address payable merchant,
    uint16 feeBps,
    bytes16 uuid,
    OrganizationFee calldata organizationFee
) external payable
```

#### `processTokenPayment`
Process a payment in ERC20 tokens with permit support.

```solidity
function processTokenPayment(
    Data calldata data,
    uint16 feeBps,
    OrganizationFee calldata organizationFee,
    PermitParams calldata permitParams,
    bool permitSupported,
    GasRefund calldata gasRefundData
) external
```

### Subscriptions

#### `createSubscription`
Create a new recurring subscription.

```solidity
function createSubscription(
    Data calldata data,
    uint256 maxAmount,
    uint32 frequency,
    PermitParams calldata permitParams,
    bool permitSupported,
    address organizationFee,
    Signature calldata signature,
    GasRefund calldata gasRefundData
) external
```

**Parameters:**
- `frequency`: Minimum 7 days (604800 seconds)
- `maxAmount`: Maximum allowed payment per period - to allow for price fluctuations, but prevent overspending
- `signature`: EIP-712 signature from user

#### `executeSubscription`
Execute a subscription payment (called by backend when payment is due).

```solidity
function executeSubscription(
    Data calldata data,
    uint32 frequency,
    uint16 feeBps,
    OrganizationFee calldata organizationFee,
    GasRefund calldata gasRefundData
) external
```

#### `cancelSubscription`
Cancel an active subscription.

```solidity
function cancelSubscription(
    bytes16 uuid,
    Signature memory signature
) external
```

### Pay-As-You-Go Subscriptions

#### `createPayAsYouGoSubscription`
Create a flexible subscription where payment amounts can vary.

```solidity
function createPayAsYouGoSubscription(
    Data calldata data,
    uint256 maxAmount,
    uint32 frequency,
    PermitParams calldata permitParams,
    bool permitSupported,
    address organizationFee,
    Signature calldata signature,
    GasRefund calldata gasRefundData
) external
```

#### `executePayAsYouGoPayment`
Execute a pay-as-you-go payment (amount can vary per execution).

```solidity
function executePayAsYouGoPayment(
    Data calldata data,
    uint32 frequency,
    uint16 feeBps,
    OrganizationFee calldata organizationFee,
    GasRefund calldata gasRefundData
) external
```

### Allowance Management

#### `increaseAllowance`
Increase the token allowance for an existing subscription.

```solidity
function increaseAllowance(
    bytes16 uuid,
    address tokenAddress,
    address signer,
    PermitParams calldata permitParams,
    GasRefund calldata gasRefundData
) external
```

#### `updateMaxAmount`
Update the maximum payment amount for a subscription.

```solidity
function updateMaxAmount(
    bytes16 uuid,
    address from,
    address tokenAddress,
    uint256 newMaxAmount,
    Signature memory signature,
    GasRefund calldata gasRefundData
) external
```

## 🔐 Security Features

### Gas Refund Mechanism
The contract owner (backend) pays for gas fees, then refunds the cost in tokens from the user. This enables:
- Users to pay without holding ETH
- Seamless UX for token-only holders
- Automatic gas price adjustment

**Safety Measures:**
- Refund ratio capped between 0.995x and 1.1x actual gas used
- Per-function overhead calibration
- Non-reverting on refund failure (emits event instead)

### EIP-712 Typed Data Signing
All subscription operations require EIP-712 signatures:
```solidity
// Domain separator
EIP712("QBitFlow", "1")

// Type hashes for different operations
CREATE_SUBSCRIPTION_TYPEHASH
CANCEL_SUBSCRIPTION_TYPEHASH
UPDATE_MAX_AMOUNT_TYPEHASH
```

### Access Control
- `onlyOwner` modifier for administrative functions
- `nonReentrant` guard on all payment functions
- Cosigner validation for critical operations

### Proxy Pattern Security
- Each user-token pair gets a unique proxy to prevent allowance conflicts
- Minimal proxy clones for gas efficiency
- Factory pattern ensures controlled proxy creation

## 💰 Fee Structure

### Fee Configuration
- **Contract Fee**: 0.75% - 10% (75-1000 basis points)
- **Organization Fee**: 0% - 10% (0-1000 basis points)
- **Fee Denominator**: 10,000 (1 basis point = 0.01%)

### Fee Calculation
```solidity
ownerFee = (amount * feeBps) / 10000
organizationFee = ((amount - ownerFee) * orgFeeBps) / 10000
merchantAmount = amount - ownerFee - organizationFee
```

## 🧪 Testing

The contracts include comprehensive test coverage:

```bash
# Run all tests
npx hardhat test

# Run specific test file
npx hardhat test test/subscription.permit.spec.js

# Run with gas reporting
REPORT_GAS=true npx hardhat test
```

### Test Files
- `payment.approval.js` - One-time payments with approval
- `payment.permit.spec.js` - One-time payments with permit
- `subscription.approval.spec.js` - Subscriptions with approval
- `subscription.permit.spec.js` - Subscriptions with permit
- `payg-subscription.spec.js` - Pay-as-you-go subscriptions
- `proxyFactory.spec.js` - Proxy factory operations
- `gasRefund.spec.js` - Gas refund mechanism
- `other.js` - Edge cases and utilities

## 📜 Deployment

### Local Deployment
```bash
# Start local node
npx hardhat node

# Deploy contracts
npm run deploy-test
```

### Testnet Deployment
```bash
# Deploy to Sepolia
npx hardhat run scripts/deploy.js --network sepolia

# Verify on Etherscan
npx hardhat verify --network sepolia <CONTRACT_ADDRESS>
```

### Deployment Outputs
After deployment, the following files are generated:
- `deployed-addresses.json` - Contract addresses
- `gas-usage.txt` - Deployment gas costs
- `test-accounts.txt` - Test account details
- `abi/` - Contract ABIs for frontend integration

## 🌐 Supported Networks

The contracts can be deployed on any EVM-compatible network:
- Ethereum Mainnet
- Ethereum Testnets (Sepolia, Holesky)
- Polygon
- Arbitrum
- Optimism
- Base
- Avalanche
- BSC

## 📄 License

This project is licensed under the [Mozilla Public License 2.0](https://opensource.org/licenses/MPL-2.0).


## 📞 Support

- **Website**: [qbitflow.app](https://qbitflow.app)
- **Documentation**: [qbitflow.app/docs](https://qbitflow.app/docs)
- **Issues**: [GitHub Issues](https://github.com/QBitFlow/qbitflow-evm-contracts/issues)


## 🔮 Roadmap

- [ ] Multi-chain deployment
- [ ] Formal security audit
- [ ] Gasless meta-transactions
- [ ] Dynamic fee adjustment
- [ ] Subscription pause/resume
- [ ] Batch payment processing
- [ ] NFT-gated subscriptions

