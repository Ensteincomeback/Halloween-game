// One-time chain setup, shared by `npm run solana:setup` (devnet), the local
// in-process chain (`npm run solana:local`) and the tests.

import fs from 'node:fs';
import path from 'node:path';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { createBooMint, sendTx } from './tokens.js';

// The game's two keys: `authority` pays fees and mints NFTs; `vault` holds the
// SOL and $BOO behind in-game balances, and escrowed NFTs.
export function loadOrCreateKeys(file) {
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { authority: Keypair.fromSecretKey(Uint8Array.from(raw.authority)), vault: Keypair.fromSecretKey(Uint8Array.from(raw.vault)) };
  }
  const keys = { authority: Keypair.generate(), vault: Keypair.generate() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ authority: [...keys.authority.secretKey], vault: [...keys.vault.secretKey] }), { mode: 0o600 });
  return keys;
}

// Needs the authority funded (~0.05 SOL covers setup; more for NFT mints).
export async function setupChain(conn, { authority, vault, supply, publicUrl, symbol = 'BOO', name = 'Boo' }) {
  // A system account must hold the rent-exempt minimum before it can receive small deposits.
  const min = await conn.rentExempt(0);
  if ((await conn.lamports(vault.publicKey)) < min) {
    await sendTx(conn, authority, [SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: vault.publicKey, lamports: min })]);
  }
  const booMint = await createBooMint(conn, { payer: authority, vault: vault.publicKey, supply, name, symbol, uri: `${publicUrl}/api/token/boo.json` });
  return { booMint };
}
