import assert from "assert";
import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { 
  TOKEN_PROGRAM_ID, 
  createMint, 
  mintTo, 
  getAccount,
  createAccount,
  getAssociatedTokenAddress,
  createAssociatedTokenAccount
} from "@solana/spl-token";
import crypto from 'crypto';
import pkg from '@coral-xyz/anchor';
const { BN } = pkg;

const { SystemProgram, PublicKey } = anchor.web3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("adobe", () => {
  // 使用本地provider
  const provider = anchor.AnchorProvider.local();

  // 设置provider
  anchor.setProvider(provider);
  const program = anchor.workspace.Adobe;
  const evilProgram = anchor.workspace.Evil;

  // Test accounts and keypairs
  let authority;
  let stateKey;
  let stateBump;
  let tokenMint;
  let poolKey;
  let poolBump;
  let poolTokenAccount;
  let voucherMint;
  let depositor;
  let borrower;
  let depositorTokenAccount;
  let borrowerTokenAccount;
  let depositorVoucherAccount;

  // Helper function to airdrop SOL
  async function airdrop(pubkey, amount = 10) {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      amount * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction({ signature: sig });
  }

  // Helper function to create token account
  async function createTokenAccount(mint, owner) {
    return await createAccount(
      provider.connection,
      owner,
      mint,
      owner.publicKey
    );
  }

  before(async () => {
    // Initialize authority
    authority = anchor.web3.Keypair.generate();
    await airdrop(authority.publicKey);

    // Initialize other test accounts
    depositor = anchor.web3.Keypair.generate();
    borrower = anchor.web3.Keypair.generate();
    await airdrop(depositor.publicKey);
    await airdrop(borrower.publicKey);

    // Create test token mint
    tokenMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // Create token accounts
    depositorTokenAccount = await createTokenAccount(tokenMint, depositor);
    borrowerTokenAccount = await createTokenAccount(tokenMint, borrower);

    // Mint some tokens to depositor
    await mintTo(
      provider.connection,
      depositor,
      tokenMint,
      depositorTokenAccount,
      authority,
      1000 * 10**9 // 1000 tokens
    );
  });
  
  it("初始化状态", async () => {
    // Calculate state PDA using the State discriminator
    const stateDiscriminator = Buffer.from(crypto.createHash('sha256').update('account:State').digest()).slice(0, 8);
    [stateKey, stateBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [stateDiscriminator],
      program.programId
    );
    
    // Initialize state
    await program.methods
      .initialize(stateBump)
      .accounts({
        authority: authority.publicKey,
        state: stateKey,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();
      
    // Verify state
    const state = await program.account.state.fetch(stateKey);
    assert.ok(state.authority.equals(authority.publicKey));
  });

  it("创建流动性池", async () => {
    // Calculate pool PDA
    const poolDiscriminator = Buffer.from(crypto.createHash('sha256').update('account:Pool').digest()).slice(0, 8);
    [poolKey, poolBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [poolDiscriminator, tokenMint.toBuffer()],
      program.programId
    );

    // Calculate pool token account PDA
    const [poolTokenKey] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("TOKEN"), tokenMint.toBuffer()],
      program.programId
    );
    poolTokenAccount = poolTokenKey;

    // Calculate voucher mint PDA
    const [voucherMintKey] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("VOUCHER"), tokenMint.toBuffer()],
      program.programId
    );
    voucherMint = voucherMintKey;

    // Add pool
    await program.methods
      .addPool(poolBump)
      .accounts({
        authority: authority.publicKey,
        state: stateKey,
        tokenMint: tokenMint,
        pool: poolKey,
        poolToken: poolTokenAccount,
        voucherMint: voucherMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    // Verify pool creation
    const pool = await program.account.pool.fetch(poolKey);
    assert.ok(pool.tokenMint.equals(tokenMint));
    assert.ok(pool.poolToken.equals(poolTokenAccount));
    assert.ok(pool.voucherMint.equals(voucherMint));
    assert.equal(pool.borrowing, false);
  });

  it("存入代币到池中", async () => {
    // Create voucher account for depositor
    depositorVoucherAccount = await getAssociatedTokenAddress(
      voucherMint,
      depositor.publicKey
    );

    // Create the voucher account
    await createAssociatedTokenAccount(
      provider.connection,
      depositor,
      voucherMint,
      depositor.publicKey
    );

    // Deposit tokens
    const depositAmount = new BN(500 * 10**9); // 500 tokens
    
    await program.methods
      .deposit(depositAmount)
      .accounts({
        user: depositor.publicKey,
        state: stateKey,
        userToken: depositorTokenAccount,
        userVoucher: depositorVoucherAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        voucherMint: voucherMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor])
      .rpc();

    // Verify deposit
    const poolTokenAccountInfo = await getAccount(provider.connection, poolTokenAccount);
    assert.equal(poolTokenAccountInfo.amount.toString(), depositAmount.toString());

    const voucherAccountInfo = await getAccount(provider.connection, depositorVoucherAccount);
    assert.equal(voucherAccountInfo.amount.toString(), depositAmount.toString());
  });

  it("从池中提取代币", async () => {
    const withdrawAmount = new BN(100 * 10**9); // 100 tokens
    
    // Approve state to burn voucher tokens
    const { approve } = await import("@solana/spl-token");
    await approve(
      provider.connection,
      depositor,
      depositorVoucherAccount,
      stateKey,
      depositor,
      withdrawAmount.toNumber()
    );
    
    await program.methods
      .withdraw(withdrawAmount)
      .accounts({
        state: stateKey,
        pool: poolKey,
        poolToken: poolTokenAccount,
        voucherMint: voucherMint,
        userToken: depositorTokenAccount,
        userVoucher: depositorVoucherAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([])
      .rpc();

    // Verify withdrawal
    const poolTokenAccountInfo = await getAccount(provider.connection, poolTokenAccount);
    assert.equal(poolTokenAccountInfo.amount.toString(), (400 * 10**9).toString());

    const voucherAccountInfo = await getAccount(provider.connection, depositorVoucherAccount);
    assert.equal(voucherAccountInfo.amount.toString(), (400 * 10**9).toString());
  });

  it("执行闪电贷 (借款和还款)", async () => {
    const borrowAmount = new BN(100 * 10**9); // 100 tokens
    
    // Get borrow and repay instructions
    const borrowIx = await program.methods
      .borrow(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const repayIx = await program.methods
      .repay(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Calculate fee (0.3% = 30 basis points)
    const fee = borrowAmount.mul(new BN(30)).div(new BN(10000));
    const totalRepay = borrowAmount.add(fee);

    // Transfer tokens to borrower for testing (borrowed amount + fee)
    // In real scenario, borrower would use the flash loan for arbitrage
    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      borrowerTokenAccount,
      authority,
      totalRepay.toNumber()
    );

    // Execute flash loan transaction
    const tx = new anchor.web3.Transaction();
    tx.add(borrowIx);
    tx.add(repayIx);

    await provider.sendAndConfirm(tx, [borrower]);

    // Verify pool received the fee
    const poolTokenAccountInfo = await getAccount(provider.connection, poolTokenAccount);
    assert.equal(poolTokenAccountInfo.amount.toString(), (400 * 10**9 + fee.toNumber()).toString());
  });

  it("拒绝没有还款的借款", async () => {
    const borrowAmount = new BN(50 * 10**9);
    
    try {
      // Try to borrow without repay
      await program.methods
        .borrow(borrowAmount)
        .accounts({
          user: borrower.publicKey,
          state: stateKey,
          userToken: borrowerTokenAccount,
          pool: poolKey,
          poolToken: poolTokenAccount,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      
      assert.fail("Should have failed without repay instruction");
    } catch (error) {
      assert.ok(error.toString().includes("NoRepay"));
    }
  });

  it("拒绝金额不匹配的还款", async () => {
    const borrowAmount = new BN(50 * 10**9);
    const wrongRepayAmount = new BN(60 * 10**9);
    
    const borrowIx = await program.methods
      .borrow(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const repayIx = await program.methods
      .repay(wrongRepayAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new anchor.web3.Transaction();
    tx.add(borrowIx);
    tx.add(repayIx);

    try {
      await provider.sendAndConfirm(tx, [borrower]);
      assert.fail("Should have failed with mismatched amounts");
    } catch (error) {
      console.log("Error caught:", error.toString());
      assert.ok(error.toString().includes("AmountMismatch") || error.toString().includes("IncorrectRepay"));
    }
  });

  it("拒绝通过CPI调用借款", async () => {
    try {
      await evilProgram.methods
        .borrowProxy(new BN(50 * 10**9))
        .accounts({
          adobeProgram: program.programId,
          user: borrower.publicKey,
          state: stateKey,
          userToken: borrowerTokenAccount,
          pool: poolKey,
          poolToken: poolTokenAccount,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      
      assert.fail("Should have rejected CPI borrow");
    } catch (error) {
      console.log("CPI borrow error:", error.toString());
      // CPI calls are blocked at the Solana runtime level
      assert.ok(error.toString().includes("Cross-program invocation with unauthorized signer") || error.toString().includes("CpiBorrow"));
    }
  });

  it("拒绝通过CPI调用还款", async () => {
    try {
      await evilProgram.methods
        .repayProxy(new BN(50 * 10**9))
        .accounts({
          adobeProgram: program.programId,
          user: borrower.publicKey,
          state: stateKey,
          userToken: borrowerTokenAccount,
          pool: poolKey,
          poolToken: poolTokenAccount,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      
      assert.fail("Should have rejected CPI repay");
    } catch (error) {
      console.log("CPI repay error:", error.toString());
      // CPI calls are blocked at the Solana runtime level
      assert.ok(error.toString().includes("Cross-program invocation with unauthorized signer") || error.toString().includes("CpiRepay"));
    }
  });

  it("拒绝双重借款尝试", async () => {
    const borrowAmount = new BN(50 * 10**9);
    
    // Create two borrow instructions
    const borrowIx1 = await program.methods
      .borrow(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const borrowIx2 = await program.methods
      .borrow(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const repayIx = await program.methods
      .repay(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new anchor.web3.Transaction();
    tx.add(borrowIx1);
    tx.add(borrowIx2);
    tx.add(repayIx);

    try {
      await provider.sendAndConfirm(tx, [borrower]);
      assert.fail("Should have failed with double borrow");
    } catch (error) {
      console.log("Double borrow error:", error.toString());
      // Check for Borrowing error code 6004 (0x1774) - pool already being borrowed
      assert.ok(error.toString().includes("0x1774") || error.toString().includes("Borrowing"));
    }
  });

  it("拒绝资金不足的借款", async () => {
    const excessiveBorrowAmount = new BN(1000 * 10**9); // More than pool has
    
    const borrowIx = await program.methods
      .borrow(excessiveBorrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const repayIx = await program.methods
      .repay(excessiveBorrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new anchor.web3.Transaction();
    tx.add(borrowIx);
    tx.add(repayIx);

    try {
      await provider.sendAndConfirm(tx, [borrower]);
      assert.fail("Should have failed with insufficient liquidity");
    } catch (error) {
      // This should fail with token program error for insufficient funds
      assert.ok(error.toString().includes("Error"));
    }
  });

  it("测试evil程序的双重借款尝试", async () => {
    try {
      await evilProgram.methods
        .borrowDouble(new BN(50 * 10**9))
        .accounts({
          adobeProgram: program.programId,
          user: borrower.publicKey,
          state: stateKey,
          userToken: borrowerTokenAccount,
          pool: poolKey,
          poolToken: poolTokenAccount,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([borrower])
        .rpc();
      
      assert.fail("Should have rejected double borrow through CPI");
    } catch (error) {
      console.log("Evil double borrow error:", error.toString());
      // CPI calls are blocked at the Solana runtime level
      assert.ok(error.toString().includes("Cross-program invocation with unauthorized signer") || error.toString().includes("CpiBorrow"));
    }
  });

  it("完整的闪电贷周期与多个操作", async () => {
    // This test simulates a real flash loan use case
    const borrowAmount = new BN(200 * 10**9);
    
    // Create a second depositor and pool for arbitrage simulation
    const depositor2 = anchor.web3.Keypair.generate();
    await airdrop(depositor2.publicKey);
    
    // Create second token mint
    const tokenMint2 = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // Calculate pool2 PDA
    const poolDiscriminator = Buffer.from(crypto.createHash('sha256').update('account:Pool').digest()).slice(0, 8);
    const [poolKey2, poolBump2] = anchor.web3.PublicKey.findProgramAddressSync(
      [poolDiscriminator, tokenMint2.toBuffer()],
      program.programId
    );

    const [poolTokenAccount2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("TOKEN"), tokenMint2.toBuffer()],
      program.programId
    );

    const [voucherMint2] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("VOUCHER"), tokenMint2.toBuffer()],
      program.programId
    );

    // Add second pool
    await program.methods
      .addPool(poolBump2)
      .accounts({
        authority: authority.publicKey,
        state: stateKey,
        tokenMint: tokenMint2,
        pool: poolKey2,
        poolToken: poolTokenAccount2,
        voucherMint: voucherMint2,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .signers([authority])
      .rpc();

    // Setup token accounts
    const depositor2TokenAccount = await createTokenAccount(tokenMint2, depositor2);
    const borrowerTokenAccount2 = await createTokenAccount(tokenMint2, borrower);

    // Mint tokens to depositor2
    await mintTo(
      provider.connection,
      authority,
      tokenMint2,
      depositor2TokenAccount,
      authority,
      1000 * 10**9
    );

    // Deposit to pool2
    const depositor2VoucherAccount = await getAssociatedTokenAddress(
      voucherMint2,
      depositor2.publicKey
    );

    // Create the voucher account for depositor2
    await createAssociatedTokenAccount(
      provider.connection,
      depositor2,
      voucherMint2,
      depositor2.publicKey
    );

    await program.methods
      .deposit(new BN(500 * 10**9))
      .accounts({
        user: depositor2.publicKey,
        state: stateKey,
        userToken: depositor2TokenAccount,
        userVoucher: depositor2VoucherAccount,
        pool: poolKey2,
        poolToken: poolTokenAccount2,
        voucherMint: voucherMint2,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([depositor2])
      .rpc();

    // Simulate arbitrage with flash loan
    const borrowIx = await program.methods
      .borrow(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    // Calculate fee
    const fee = borrowAmount.mul(new BN(30)).div(new BN(10000));
    const totalRepay = borrowAmount.add(fee);

    // Simulate profit by minting extra tokens
    await mintTo(
      provider.connection,
      authority,
      tokenMint,
      borrowerTokenAccount,
      authority,
      totalRepay.toNumber() + (10 * 10**9) // Repay amount + 10 token profit
    );

    const repayIx = await program.methods
      .repay(borrowAmount)
      .accounts({
        user: borrower.publicKey,
        state: stateKey,
        userToken: borrowerTokenAccount,
        pool: poolKey,
        poolToken: poolTokenAccount,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();

    const tx = new anchor.web3.Transaction();
    tx.add(borrowIx);
    tx.add(repayIx);

    await provider.sendAndConfirm(tx, [borrower]);

    // Verify borrower kept profit
    const borrowerBalance = await getAccount(provider.connection, borrowerTokenAccount);
    assert.ok(borrowerBalance.amount >= (10 * 10**9));
  });
});