import assert from "assert";
import * as anchor from "@coral-xyz/anchor";
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const { SystemProgram } = anchor.web3;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("adobe", () => {
  // 使用本地provider
  const provider = anchor.AnchorProvider.local();

  // 设置provider
  anchor.setProvider(provider);
  const program = anchor.workspace.Adobe;

  // 测试账户
  let myAccount;
  
  it("初始化状态", async () => {
    // 生成一个新的账户
    const authority = anchor.web3.Keypair.generate();
    
    // 为authority账户提供资金
    const airdropSignature = await provider.connection.requestAirdrop(
      authority.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    
    // 等待确认
    await provider.connection.confirmTransaction({ signature: airdropSignature });
    
    // 在Anchor中，Account Discriminator是对账户名称的8字节哈希
    // 在Rust代码中使用的是 State::DISCRIMINATOR
    const stateDiscriminator = Buffer.from(anchor.utils.sha256.hash("account:State").slice(0, 8));
    console.log("State账户Discriminator:", stateDiscriminator.toString('hex'));
    
    const [stateKey, stateBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [stateDiscriminator],
      program.programId
    );
    
    console.log("计算的状态密钥:", stateKey.toString());
    console.log("程序ID:", program.programId.toString());
    
    try {
      // 初始化
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
        
      // 获取state账户
      const state = await program.account.state.fetch(stateKey);
      
      // 验证state已正确初始化
      assert.ok(state.authority.equals(authority.publicKey));
    } catch (error) {
      console.error(error);
      throw error;
    }
  });
}); 