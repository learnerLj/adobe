# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Building and Testing
- `anchor build` - Build the Solana program
- `anchor test` - Run tests (uses mocha with 1000000ms timeout as configured in Anchor.toml)
- `mocha -t 1000000 tests/` - Run tests directly with mocha

### Deployment
- `anchor deploy` - Deploy to configured cluster (localnet by default)
- `solana-test-validator` - Start local Solana validator for testing

## Architecture Overview

This is a Solana flash loan protocol built with Anchor framework. The core program is an **atomic flash loan system** that enforces repayment within the same transaction.

### Core Components

**Programs:**
- `adobe` - Main flash loan program with borrow/repay enforcement
- `evil` - Test program for validating security constraints

**Key Security Features:**
- **Atomic Transactions**: Borrow must be paired with repay in same transaction
- **CPI Protection**: Direct calls only - prevents cross-program invocation abuse
- **Instruction Validation**: Uses Solana sysvar to verify transaction structure
- **Pool State Management**: Prevents concurrent borrows on same pool

### Program Architecture

**State Management:**
- `State` - Global program authority and configuration
- `Pool` - Per-token lending pools with borrowing state tracking

**Core Operations:**
1. `initialize` - Setup program authority
2. `add_pool` - Create lending pool for a token mint
3. `deposit/withdraw` - Liquidity provider operations using voucher tokens
4. `borrow/repay` - Flash loan operations (must be atomic)

**Key Constraints:**
- Borrow scans ahead in transaction for matching repay instruction
- Exact amount matching required between borrow and repay
- Pool borrowing flag prevents reentrancy
- CPI calls to borrow/repay are explicitly forbidden

### Client Integration

**JavaScript API** (`app/api.js`):
- Uses `@coral-xyz/anchor` for program interaction
- Handles token account creation and approvals
- `borrow()` returns instruction pair that must be inserted into user transaction
- Automatic PDA derivation for pools and voucher mints

**Address Derivation:**
- State: `[State::DISCRIMINATOR]`
- Pool: `[Pool::DISCRIMINATOR, token_mint]`
- Pool Token: `["TOKEN", token_mint]`
- Voucher Mint: `["VOUCHER", token_mint]`

### Testing Notes
- Tests use local provider with funding via airdrop
- Chinese comments in test files indicate multilingual development
- Tests validate discriminator calculation and PDA derivation
- Program ID: `VzRKfyFWHZtYWbQWfcnCGBrTg3tqqRV2weUqvrvVhuo`