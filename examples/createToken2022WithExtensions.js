/**
 * Token-2022 创建工具
 * 支持 MintCloseAuthority、PermanentDelegate 扩展和 TokenMetadata
 *
 * 依赖安装:
 * npm install @solana/web3.js @solana/spl-token @solana/spl-token-metadata
 *
 * 注意: 使用 ES Module，需要在 package.json 中设置 "type": "module"
 * 或者将文件扩展名改为 .mjs
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";

import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeMintCloseAuthorityInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeMetadataPointerInstruction,
  getMint,
  getTokenMetadata,
} from "@solana/spl-token";

import {
  createInitializeInstruction,
  createUpdateFieldInstruction,
  createUpdateAuthorityInstruction,
  pack,
} from "@solana/spl-token-metadata";

/**
 * 创建带有完整扩展功能的 Token-2022
 *
 * @param {Connection} connection - Solana 连接
 * @param {Keypair} payer - 付款人（也是交易签名者）
 * @param {Keypair|null} mintKeypair - Mint 账户密钥对，如果为 null 则自动生成
 * @param {PublicKey} mintAuthority - Mint 权限
 * @param {PublicKey|null} freezeAuthority - 冻结权限（可选）
 * @param {PublicKey|null} permanentDelegate - 永久代理权限（可选）
 * @param {PublicKey|null} closeAuthority - 关闭 Mint 权限（可选）
 * @param {number} decimals - 代币精度
 * @param {string} name - 代币名称
 * @param {string} symbol - 代币符号
 * @param {string} uri - 代币 metadata URI
 * @param {bigint|number} supply - 初始供应量（以最小单位计算）
 * @param {Object} options - 额外选项
 * @param {PublicKey} [options.metadataUpdateAuthority] - Metadata 更新权限，默认为 mintAuthority
 * @param {Array<[string, string]>} [options.additionalMetadata] - 额外的 metadata 键值对
 * @returns {Promise<Object>} 返回创建结果
 */
export async function createToken2022WithAllFeatures(
  connection,
  payer,
  mintKeypair,
  mintAuthority,
  freezeAuthority,
  permanentDelegate,
  closeAuthority,
  decimals,
  name,
  symbol,
  uri,
  supply,
  options = {}
) {
  // 如果没有提供 mintKeypair，则自动生成
  const mint = mintKeypair || Keypair.generate();

  // Metadata 更新权限，默认为 mintAuthority
  const metadataUpdateAuthority =
    options.metadataUpdateAuthority || mintAuthority;

  // 确定需要的扩展类型
  const extensions = [];

  // MintCloseAuthority 扩展
  if (closeAuthority) {
    extensions.push(ExtensionType.MintCloseAuthority);
  }

  // PermanentDelegate 扩展
  if (permanentDelegate) {
    extensions.push(ExtensionType.PermanentDelegate);
  }

  // MetadataPointer 扩展（用于指向 metadata 存储位置）
  extensions.push(ExtensionType.MetadataPointer);

  // 计算 metadata 长度
  const tokenMetadata = {
    updateAuthority: metadataUpdateAuthority,
    mint: mint.publicKey,
    name: name,
    symbol: symbol,
    uri: uri,
    additionalMetadata: options.additionalMetadata || [],
  };

  const metadataLen = pack(tokenMetadata).length;

  // 计算 mint 账户所需空间
  const mintLen = getMintLen(extensions);
  // TokenMetadata 是变长扩展，需要额外计算
  // 格式: [type: 2 bytes][length: 2 bytes][data: N bytes]
  const totalMintLen = mintLen + 4 + metadataLen;

  // 获取租金豁免所需的最小余额
  const lamports = await connection.getMinimumBalanceForRentExemption(
    totalMintLen
  );

  // 构建交易
  const transaction = new Transaction();

  // 1. 创建 Mint 账户
  transaction.add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: totalMintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    })
  );

  // 2. 初始化 PRE-INITIALIZE 扩展（必须在 InitializeMint 之前）

  // 2a. MintCloseAuthority
  if (closeAuthority) {
    transaction.add(
      createInitializeMintCloseAuthorityInstruction(
        mint.publicKey,
        closeAuthority,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // 2b. PermanentDelegate
  if (permanentDelegate) {
    transaction.add(
      createInitializePermanentDelegateInstruction(
        mint.publicKey,
        permanentDelegate,
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  // 2c. MetadataPointer（指向 mint 自身）
  transaction.add(
    createInitializeMetadataPointerInstruction(
      mint.publicKey,
      metadataUpdateAuthority, // authority
      mint.publicKey, // metadata address (指向自身)
      TOKEN_2022_PROGRAM_ID
    )
  );

  // 3. 初始化 Mint
  transaction.add(
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      mintAuthority,
      freezeAuthority,
      TOKEN_2022_PROGRAM_ID
    )
  );

  // 4. 初始化 TokenMetadata（POST-INITIALIZE，必须在 InitializeMint 之后）
  transaction.add(
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      updateAuthority: metadataUpdateAuthority,
      mint: mint.publicKey,
      mintAuthority: mintAuthority,
      name: name,
      symbol: symbol,
      uri: uri,
    })
  );

  // 5. 添加额外的 metadata 字段（如果有）
  if (options.additionalMetadata && options.additionalMetadata.length > 0) {
    for (const [key, value] of options.additionalMetadata) {
      transaction.add(
        createUpdateFieldInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mint.publicKey,
          updateAuthority: metadataUpdateAuthority,
          field: key,
          value: value,
        })
      );
    }
  }

  // 确定签名者
  const signers = [payer, mint];

  // 如果 mintAuthority 是 Keypair 且不是 payer，需要添加为签名者
  if (
    mintAuthority instanceof Keypair &&
    !mintAuthority.publicKey.equals(payer.publicKey)
  ) {
    signers.push(mintAuthority);
  }

  // 发送交易
  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    signers,
    {
      commitment: "confirmed",
    }
  );

  console.log("Token 创建成功!");
  console.log("Mint 地址:", mint.publicKey.toBase58());
  console.log("交易签名:", signature);

  // 如果需要 mint 初始供应量
  let mintToSignature = null;
  let tokenAccount = null;

  if (supply && BigInt(supply) > 0n) {
    // 获取或创建 associated token account
    const ata = getAssociatedTokenAddressSync(
      mint.publicKey,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const mintToTransaction = new Transaction();

    // 创建 ATA
    mintToTransaction.add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        payer.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Mint tokens
    mintToTransaction.add(
      createMintToInstruction(
        mint.publicKey,
        ata,
        mintAuthority,
        BigInt(supply),
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );

    const mintToSigners = [payer];
    if (
      mintAuthority instanceof Keypair &&
      !mintAuthority.publicKey.equals(payer.publicKey)
    ) {
      mintToSigners.push(mintAuthority);
    }

    mintToSignature = await sendAndConfirmTransaction(
      connection,
      mintToTransaction,
      mintToSigners,
      { commitment: "confirmed" }
    );

    tokenAccount = ata;
    console.log("初始供应量已 mint!");
    console.log("Token Account:", ata.toBase58());
    console.log("Mint 交易签名:", mintToSignature);
  }

  return {
    mint: mint.publicKey,
    mintKeypair: mint,
    signature,
    mintToSignature,
    tokenAccount,
    extensions: {
      hasCloseAuthority: !!closeAuthority,
      hasPermanentDelegate: !!permanentDelegate,
      hasMetadata: true,
    },
  };
}

/**
 * 更新已存在 Token 的 Metadata
 *
 * @param {Connection} connection - Solana 连接
 * @param {Keypair} payer - 付款人
 * @param {PublicKey} mint - Mint 地址
 * @param {Keypair|PublicKey} updateAuthority - Metadata 更新权限
 * @param {Object} updates - 要更新的字段
 * @param {string} [updates.name] - 新名称
 * @param {string} [updates.symbol] - 新符号
 * @param {string} [updates.uri] - 新 URI
 * @param {Array<[string, string]>} [updates.additionalMetadata] - 额外的 metadata 键值对
 * @returns {Promise<string>} 返回交易签名
 */
export async function updateTokenMetadata(
  connection,
  payer,
  mint,
  updateAuthority,
  updates
) {
  const transaction = new Transaction();

  const updateAuthorityPubkey =
    updateAuthority instanceof Keypair
      ? updateAuthority.publicKey
      : updateAuthority;

  // 更新 Name
  if (updates.name !== undefined) {
    transaction.add(
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: updateAuthorityPubkey,
        field: "name",
        value: updates.name,
      })
    );
  }

  // 更新 Symbol
  if (updates.symbol !== undefined) {
    transaction.add(
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: updateAuthorityPubkey,
        field: "symbol",
        value: updates.symbol,
      })
    );
  }

  // 更新 URI
  if (updates.uri !== undefined) {
    transaction.add(
      createUpdateFieldInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        metadata: mint,
        updateAuthority: updateAuthorityPubkey,
        field: "uri",
        value: updates.uri,
      })
    );
  }

  // 更新自定义字段
  if (updates.additionalMetadata && updates.additionalMetadata.length > 0) {
    for (const [key, value] of updates.additionalMetadata) {
      transaction.add(
        createUpdateFieldInstruction({
          programId: TOKEN_2022_PROGRAM_ID,
          metadata: mint,
          updateAuthority: updateAuthorityPubkey,
          field: key,
          value: value,
        })
      );
    }
  }

  if (transaction.instructions.length === 0) {
    throw new Error("没有要更新的字段");
  }

  const signers = [payer];
  if (
    updateAuthority instanceof Keypair &&
    !updateAuthority.publicKey.equals(payer.publicKey)
  ) {
    signers.push(updateAuthority);
  }

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    signers,
    { commitment: "confirmed" }
  );

  console.log("Metadata 更新成功!");
  console.log("交易签名:", signature);

  return signature;
}

/**
 * 更新 Metadata 更新权限
 *
 * @param {Connection} connection - Solana 连接
 * @param {Keypair} payer - 付款人
 * @param {PublicKey} mint - Mint 地址
 * @param {Keypair} currentAuthority - 当前更新权限
 * @param {PublicKey|null} newAuthority - 新的更新权限（null 表示放弃权限）
 * @returns {Promise<string>} 返回交易签名
 */
export async function updateMetadataAuthority(
  connection,
  payer,
  mint,
  currentAuthority,
  newAuthority
) {
  const transaction = new Transaction().add(
    createUpdateAuthorityInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint,
      oldAuthority: currentAuthority.publicKey,
      newAuthority: newAuthority,
    })
  );

  const signers = [payer];
  if (!currentAuthority.publicKey.equals(payer.publicKey)) {
    signers.push(currentAuthority);
  }

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    signers,
    { commitment: "confirmed" }
  );

  console.log("Metadata 权限更新成功!");
  console.log("交易签名:", signature);

  return signature;
}

/**
 * 获取 Token 的 Metadata 信息
 *
 * @param {Connection} connection - Solana 连接
 * @param {PublicKey} mint - Mint 地址
 * @returns {Promise<Object|null>} 返回 metadata 信息
 */
export async function getTokenMetadataInfo(connection, mint) {
  try {
    const metadata = await getTokenMetadata(
      connection,
      mint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    if (!metadata) {
      return null;
    }

    return {
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      updateAuthority: metadata.updateAuthority?.toBase58() || null,
      additionalMetadata: metadata.additionalMetadata || [],
    };
  } catch (error) {
    console.error("获取 metadata 失败:", error.message);
    return null;
  }
}

/**
 * 获取 Token 的扩展信息
 *
 * @param {Connection} connection - Solana 连接
 * @param {PublicKey} mint - Mint 地址
 * @returns {Promise<Object|null>} 返回扩展信息
 */
export async function getTokenExtensionsInfo(connection, mint) {
  try {
    const mintInfo = await getMint(
      connection,
      mint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );

    const result = {
      address: mint.toBase58(),
      decimals: mintInfo.decimals,
      supply: mintInfo.supply.toString(),
      mintAuthority: mintInfo.mintAuthority?.toBase58() || null,
      freezeAuthority: mintInfo.freezeAuthority?.toBase58() || null,
      extensions: {},
    };

    // 检查 MintCloseAuthority
    if (mintInfo.mintCloseAuthority) {
      result.extensions.mintCloseAuthority =
        mintInfo.mintCloseAuthority.closeAuthority?.toBase58() || null;
    }

    // 检查 PermanentDelegate
    if (mintInfo.permanentDelegate) {
      result.extensions.permanentDelegate =
        mintInfo.permanentDelegate.delegate?.toBase58() || null;
    }

    // 检查 MetadataPointer
    if (mintInfo.metadataPointer) {
      result.extensions.metadataPointer = {
        authority: mintInfo.metadataPointer.authority?.toBase58() || null,
        metadataAddress:
          mintInfo.metadataPointer.metadataAddress?.toBase58() || null,
      };
    }

    return result;
  } catch (error) {
    console.error("获取扩展信息失败:", error.message);
    return null;
  }
}

// ============ 使用示例 ============

async function main() {
  // 连接到 Solana devnet
  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  // 创建或加载 payer（这里使用随机生成的，实际使用时应该加载本地密钥）
  const payer = Keypair.generate();

  console.log("Payer 地址:", payer.publicKey.toBase58());
  console.log("请先为该地址充值 SOL（使用 solana airdrop）");

  // 请求空投（仅 devnet/testnet）
  try {
    const airdropSignature = await connection.requestAirdrop(
      payer.publicKey,
      2 * 1e9 // 2 SOL
    );
    await connection.confirmTransaction(airdropSignature, "confirmed");
    console.log("空投成功!");
  } catch (error) {
    console.log("空投失败，请手动充值:", error.message);
    return;
  }

  // Token 参数
  const token_name = "My Test Token";
  const token_symbol = "MTT";
  const token_uri = "https://example.com/token-metadata.json";
  const supply = 1000000000000n; // 1,000,000 tokens (假设 6 位精度)

  try {
    // 创建 Token
    const result = await createToken2022WithAllFeatures(
      connection,
      payer,
      null, // 如果 mintKeypair = null 会自动创建
      payer.publicKey, // mintAuthority
      payer.publicKey, // freezeAuthority
      payer.publicKey, // permanentDelegate
      payer.publicKey, // closeAuthority
      6, // decimals
      token_name,
      token_symbol,
      token_uri,
      supply,
      {
        // 可选: 额外的 metadata
        additionalMetadata: [
          ["description", "This is my test token"],
          ["website", "https://example.com"],
        ],
      }
    );

    console.log("\n========== Token 创建结果 ==========");
    console.log("Mint 地址:", result.mint.toBase58());
    console.log("Token Account:", result.tokenAccount?.toBase58());

    // 获取并显示 metadata
    const metadata = await getTokenMetadataInfo(connection, result.mint);
    console.log("\n========== Token Metadata ==========");
    console.log(JSON.stringify(metadata, null, 2));

    // 获取并显示扩展信息
    const extensions = await getTokenExtensionsInfo(connection, result.mint);
    console.log("\n========== Token Extensions ==========");
    console.log(JSON.stringify(extensions, null, 2));

    // 更新 metadata 示例
    console.log("\n========== 更新 Metadata ==========");
    await updateTokenMetadata(connection, payer, result.mint, payer, {
      name: "My Updated Token Name",
      additionalMetadata: [["version", "2.0"]],
    });

    // 再次获取 metadata 确认更新
    const updatedMetadata = await getTokenMetadataInfo(connection, result.mint);
    console.log("\n========== 更新后的 Metadata ==========");
    console.log(JSON.stringify(updatedMetadata, null, 2));
  } catch (error) {
    console.error("错误:", error);
  }
}

// 如果直接运行此文件，执行示例
// 使用: node createToken2022WithExtensions.js
main().catch(console.error);
