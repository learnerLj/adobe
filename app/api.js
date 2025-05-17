import anchor from "@coral-xyz/anchor";
import { 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID,
    createApproveInstruction,
    createAssociatedTokenAccountInstruction
} from "@solana/spl-token";
import { findAddr, findAssocAddr, discriminator } from "../app/util.js";
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const LAMPORTS_PER_SOL = anchor.web3.LAMPORTS_PER_SOL;
const SYSVAR_INSTRUCTIONS_PUBKEY = anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 获取provider
const provider = anchor.getProvider();

// 使用程序ID
const adobeProgramId = new anchor.web3.PublicKey("VzRKfyFWHZtYWbQWfcnCGBrTg3tqqRV2weUqvrvVhuo");

// 从文件读取IDL (不使用硬编码备选)
const idlPath = join(dirname(__dirname), 'target', 'idl', 'adobe.json');
console.log("尝试从路径加载IDL:", idlPath);
const idlFile = readFileSync(idlPath, 'utf8');
const idl = JSON.parse(idlFile);
const adobe = new anchor.Program(idl, adobeProgramId, provider);

let [stateKey, stateBump] = findAddr([discriminator("State")], adobe.programId);

function getMintKeys(mint) {
    let [poolKey, poolBump] = findAddr([discriminator("Pool"), mint.publicKey.toBuffer()], adobe.programId);
    let [poolTokenKey] = findAddr([Buffer.from("TOKEN"), mint.publicKey.toBuffer()], adobe.programId);
    let [voucherMintKey] = findAddr([Buffer.from("VOUCHER"), mint.publicKey.toBuffer()], adobe.programId);

    return [poolKey, poolTokenKey, voucherMintKey, poolBump];
}

function setProvider(provider) {
    anchor.setProvider(provider);
}

function initialize(authority) {
    return adobe.rpc.initialize(stateBump, {
        accounts: {
            authority: authority.publicKey,
            state: stateKey,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            systemProgram: anchor.web3.SystemProgram.programId,
        },
        signers: [authority.payer],
    });
}

function addPool(authority, mint) {
    let [poolKey, poolTokenKey, voucherMintKey, poolBump] = getMintKeys(mint);

    return adobe.rpc.addPool(poolBump, {
        accounts: {
            authority: authority.publicKey,
            state: stateKey,
            tokenMint: mint.publicKey,
            pool: poolKey,
            poolToken: poolTokenKey,
            voucherMint: voucherMintKey,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [authority.payer],
    });
}

async function deposit(user, mint, amount) {
    let [poolKey, poolTokenKey, voucherMintKey] = getMintKeys(mint);
    let [userTokenKey] = findAssocAddr(user.publicKey, mint.publicKey);
    let [userVoucherKey] = findAssocAddr(user.publicKey, voucherMintKey);

    let ixns = [];

    // create the voucher account for user if it doesnt exist
    if(!await anchor.getProvider().connection.getAccountInfo(userVoucherKey)) {
        ixns.push(createAssociatedTokenAccountInstruction(
            user.publicKey,
            userVoucherKey,
            user.publicKey,
            voucherMintKey,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
        ));
    }

    // approve a token transfer to avoid requiring the wallet
    ixns.push(createApproveInstruction(
        userTokenKey,
        stateKey,
        user.publicKey,
        amount,
        [],
        TOKEN_PROGRAM_ID
    ));

    return adobe.rpc.deposit(new anchor.BN(amount), {
        accounts: {
            state: stateKey,
            pool: poolKey,
            poolToken: poolTokenKey,
            voucherMint: voucherMintKey,
            userToken: userTokenKey,
            userVoucher: userVoucherKey,
            tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [user.payer],
        instructions: ixns,
    });
}

function withdraw(user, mint, amount) {
    let [poolKey, poolTokenKey, voucherMintKey] = getMintKeys(mint);
    let [userTokenKey] = findAssocAddr(user.publicKey, mint.publicKey);
    let [userVoucherKey] = findAssocAddr(user.publicKey, voucherMintKey);

    // again this is hardly much different
    return adobe.rpc.withdraw(new anchor.BN(amount), {
        accounts: {
            state: stateKey,
            pool: poolKey,
            poolToken: poolTokenKey,
            voucherMint: voucherMintKey,
            userToken: userTokenKey,
            userVoucher: userVoucherKey,
            tokenProgram: TOKEN_PROGRAM_ID,
        },
        signers: [user.payer],
        instructions: [
            createApproveInstruction(
                userVoucherKey,
                stateKey,
                user.publicKey,
                amount,
                [],
                TOKEN_PROGRAM_ID
            ),
        ],
    });
}

// all the other api functions return promises of rpc calls
// this function returns a 2-array with borrow and repay instructions
// caller should insert them into their transaction where appropriate
// do not attempt to call any adobe methods between borrow and repay
// that would be rude if you tried
function borrow(user, mint, amount) {
    let [poolKey, poolTokenKey] = getMintKeys(mint);
    let [userTokenKey] = findAssocAddr(user.publicKey, mint.publicKey);

    let borrowIxn = adobe.instruction.borrow(new anchor.BN(amount), {
        accounts: {
            state: stateKey,
            pool: poolKey,
            poolToken: poolTokenKey,
            userToken: userTokenKey,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
    }});

    // XXX my one regret about the current design is this requires a user signature
    // we could put the signature on borrow, and have borrow do an approval
    // but this doesnt actually get us anything of value
    // we could also have a client approval, and this would be my ideal design
    // but requiring a third instruction drastically reduces avail bytes for transaction proper
    // the new tx format might make this viable by cutting address repetition tho
    let repayIxn = adobe.instruction.repay(new anchor.BN(amount), {
        accounts: {
            user: user.publicKey,
            state: stateKey,
            pool: poolKey,
            poolToken: poolTokenKey,
            userToken: userTokenKey,
            instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
            tokenProgram: TOKEN_PROGRAM_ID,
    }});

    return [borrowIxn, repayIxn];
}

export { setProvider, initialize, addPool, deposit, withdraw, borrow };
