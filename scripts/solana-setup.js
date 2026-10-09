// One-time devnet setup: `npm run solana:setup`
//
// 1. Creates the game's two keys in data/solana-keys.json (keep this file
//    secret and backed up: it controls the vault).
// 2. Funds the authority key (devnet airdrop, or tells you where to send SOL).
// 3. Creates the $BOO token (Token-2022, fixed supply, metadata on the mint)
//    with the whole supply in the game vault, and removes the mint authority.
// 4. Writes data/solana.json, which `CHAIN=solana npm start` reads.
//
// Options (env): SOLANA_CLUSTER (devnet), SOLANA_RPC, PUBLIC_URL (where the
// game is served, used in token metadata links).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSeason } from '../server/config.js';
import { createRpcConnection } from '../server/onchain/connection.js';
import { loadOrCreateKeys, setupChain } from '../server/onchain/setup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cluster = process.env.SOLANA_CLUSTER || 'devnet';
const rpcUrl = process.env.SOLANA_RPC || `https://api.${cluster}.solana.com`;
const publicUrl = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const configFile = path.join(root, 'data', 'solana.json');
const season = loadSeason(process.env.SEASON || path.join(root, 'season', 'halloween-2026.json'));

if (cluster === 'mainnet-beta' && process.env.I_UNDERSTAND_MAINNET !== 'yes') {
  console.error('Refusing to set up mainnet. Get the game and the program audited first, then set I_UNDERSTAND_MAINNET=yes.');
  process.exit(1);
}
if (fs.existsSync(configFile) && !process.argv.includes('--force')) {
  console.log(`Already set up: ${configFile}\n${fs.readFileSync(configFile, 'utf8')}\nUse --force to create a new $BOO mint.`);
  process.exit(0);
}

const conn = createRpcConnection(rpcUrl);
const keys = loadOrCreateKeys(path.join(root, 'data', 'solana-keys.json'));
console.log(`Cluster:   ${cluster} (${rpcUrl})`);
console.log(`Authority: ${keys.authority.publicKey.toBase58()}  (pays fees, mints NFTs)`);
console.log(`Vault:     ${keys.vault.publicKey.toBase58()}  (holds deposits, $BOO supply, escrow)`);

const need = 0.5e9;
let have = await conn.lamports(keys.authority.publicKey);
if (have < need && cluster !== 'mainnet-beta') {
  console.log('Requesting a devnet airdrop for the authority...');
  try {
    await conn.airdrop(keys.authority.publicKey, 1e9);
  } catch (err) {
    console.log(`Airdrop failed (${err.message}).`);
  }
  have = await conn.lamports(keys.authority.publicKey);
}
if (have < need) {
  console.error(`\nThe authority needs at least 0.5 SOL. Send devnet SOL to ${keys.authority.publicKey.toBase58()}\n(https://faucet.solana.com), then run this again.`);
  process.exit(1);
}

const { booMint } = await setupChain(conn, { ...keys, supply: season.token.totalSupply, publicUrl, name: season.token.name, symbol: season.token.symbol });
fs.writeFileSync(configFile, JSON.stringify({ cluster, rpcUrl, booMint, publicUrl, createdAt: new Date().toISOString() }, null, 2));
console.log(`\n$${season.token.symbol} mint: ${booMint}`);
console.log(`Explorer:  https://explorer.solana.com/address/${booMint}?cluster=${cluster}`);
console.log(`\nDone. Start the game on ${cluster} with:  CHAIN=solana npm start`);
