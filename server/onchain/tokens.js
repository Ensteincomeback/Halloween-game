// Solana token building blocks (Token-2022 with the metadata extension).
//
// $BOO: a fixed-supply Token-2022 mint (0 decimals, so 1 in-game $BOO is 1 token)
//       with its name, symbol and image stored on the mint itself.
// NFTs: house deeds and minted monster cards are Token-2022 mints with supply 1,
//       0 decimals, the mint authority removed, and on-chain name/symbol/uri.
// No Metaplex program is needed, and wallets read the metadata directly.

import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, ExtensionType, getMintLen, TYPE_SIZE, LENGTH_SIZE, AuthorityType,
  createInitializeMetadataPointerInstruction, createInitializeMintInstruction, createMintToInstruction,
  createSetAuthorityInstruction, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  createBurnCheckedInstruction, getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { createInitializeInstruction, pack } from '@solana/spl-token-metadata';

export const T22 = TOKEN_2022_PROGRAM_ID;

export const keypairFrom = (secret) => Keypair.fromSecretKey(Uint8Array.from(secret));
export const ata = (mint, owner) => getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, T22);

// Instructions that create a Token-2022 mint carrying its own metadata.
export async function createMintWithMetadataIxs(conn, { payer, mint, authority, decimals, name, symbol, uri }) {
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metaLen = TYPE_SIZE + LENGTH_SIZE + pack({ mint, name, symbol, uri, additionalMetadata: [] }).length;
  const lamports = await conn.rentExempt(mintLen + metaLen);
  return [
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, space: mintLen, lamports, programId: T22 }),
    createInitializeMetadataPointerInstruction(mint, authority, mint, T22),
    createInitializeMintInstruction(mint, decimals, authority, null, T22),
    createInitializeInstruction({ programId: T22, metadata: mint, updateAuthority: authority, mint, mintAuthority: authority, name, symbol, uri }),
  ];
}

// Build, sign and send a transaction paid for by `payer`.
export async function sendTx(conn, payer, ixs, extraSigners = []) {
  const bh = await conn.blockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, ...bh }).add(...ixs);
  tx.sign(payer, ...extraSigners.filter((s) => !s.publicKey.equals(payer.publicKey)));
  return conn.send(tx.serialize(), bh);
}

// One-time setup: create the $BOO mint, put the whole fixed supply in the game
// vault, then remove the mint authority so no more can ever be created.
export async function createBooMint(conn, { payer, vault, supply, name = 'Boo', symbol = 'BOO', uri = '' }) {
  const mint = Keypair.generate();
  const ixs = await createMintWithMetadataIxs(conn, { payer: payer.publicKey, mint: mint.publicKey, authority: payer.publicKey, decimals: 0, name, symbol, uri });
  await sendTx(conn, payer, ixs, [mint]);
  const vaultAta = ata(mint.publicKey, vault);
  await sendTx(conn, payer, [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vaultAta, new PublicKey(vault), mint.publicKey, T22),
    createMintToInstruction(mint.publicKey, vaultAta, payer.publicKey, BigInt(supply), [], T22),
    createSetAuthorityInstruction(mint.publicKey, payer.publicKey, AuthorityType.MintTokens, null, [], T22),
  ]);
  return mint.publicKey.toBase58();
}

// Mint a 1-of-1 NFT straight into `to`'s wallet. `mintKp` is supplied by the
// caller so a retry reuses the same address instead of minting twice.
export async function mintNftIxs(conn, { payer, mintKp, to, name, symbol, uri }) {
  const mint = mintKp.publicKey;
  const toAta = ata(mint, to);
  return [
    ...(await createMintWithMetadataIxs(conn, { payer, mint, authority: payer, decimals: 0, name, symbol, uri })),
    createAssociatedTokenAccountIdempotentInstruction(payer, toAta, new PublicKey(to), mint, T22),
    createMintToInstruction(mint, toAta, payer, 1n, [], T22),
    createSetAuthorityInstruction(mint, payer, AuthorityType.MintTokens, null, [], T22),
  ];
}

// Move `amount` of a Token-2022 token from `owner`'s account to `to`'s, creating
// the destination account if needed (rent paid by `payer`).
export function transferTokenIxs({ payer, mint, owner, to, amount, decimals = 0 }) {
  const from = ata(mint, owner);
  const dest = ata(mint, to);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, dest, new PublicKey(to), new PublicKey(mint), T22),
    createTransferCheckedInstruction(from, new PublicKey(mint), dest, new PublicKey(owner), BigInt(amount), decimals, [], T22),
  ];
}

export const burnIx = ({ mint, owner, amount }) => createBurnCheckedInstruction(ata(mint, owner), new PublicKey(mint), new PublicKey(owner), BigInt(amount), 0, [], T22);
