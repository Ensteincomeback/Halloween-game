// Real Solana wallets, step 1: "Sign in with Solana".
//
// The player's wallet (Phantom, Solflare, Backpack...) signs a one-time,
// human-readable message. It is not a transaction and moves no funds. The
// server checks the ed25519 signature against the wallet's public key and links
// that address to the character, so the same wallet can sign back in later on
// any device. In-game balances still live on the simulated chain for now.

import crypto from 'node:crypto';
import { GameError } from './core.js';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = Object.fromEntries([...B58].map((c, i) => [c, BigInt(i)]));

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(str) {
  if (typeof str !== 'string' || !str.length || str.length > 128) throw new Error('bad base58');
  let n = 0n;
  for (const c of str) {
    const v = B58_MAP[c];
    if (v === undefined) throw new Error('bad base58');
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of str) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

// A Solana address is a base58-encoded 32-byte ed25519 public key.
export function isSolanaAddress(address) {
  try {
    return base58Decode(address).length === 32;
  } catch {
    return false;
  }
}

export function verifySignature(address, message, signature) {
  try {
    const pub = base58Decode(address);
    if (pub.length !== 32 || signature.length !== 64) return false;
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub).toString('base64url') }, format: 'jwk' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature));
  } catch {
    return false;
  }
}

const CHALLENGE_MS = 5 * 60_000;

export function installSolana(ctx, { cluster = 'devnet', rpcUrl = 'https://api.devnet.solana.com' } = {}) {
  const { state } = ctx;
  const now = () => ctx.now();
  state.solanaLinks ??= {}; // address -> player id
  const challenges = new Map(); // nonce -> { address, message, expiresAt } (in memory: 5 minute lifetime)

  ctx.solanaInfo = { cluster, rpcUrl };

  // Sign-In-With-Solana style message (CAIP-122 layout), bound to this site,
  // the address, a fresh nonce and a 5 minute expiry.
  ctx.walletChallenge = (address, host = 'localhost') => {
    address = String(address || '').trim();
    if (!isSolanaAddress(address)) throw new GameError('That is not a Solana address');
    for (const [k, c] of challenges) if (c.expiresAt < now()) challenges.delete(k);
    if (challenges.size > 10_000) throw new GameError('Too many sign-in attempts. Try again in a minute.', 429);
    const domain = String(host).replace(/[^\w.:-]/g, '').slice(0, 100) || 'localhost';
    const nonce = crypto.randomBytes(12).toString('hex');
    const issued = new Date(now());
    const expires = new Date(now() + CHALLENGE_MS);
    const message = [
      `${domain} wants you to sign in with your Solana account:`,
      address,
      '',
      'Sign in to Knock. This is free: it is not a transaction and does not move any funds.',
      '',
      `URI: http://${domain}`,
      'Version: 1',
      `Chain ID: ${cluster}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issued.toISOString()}`,
      `Expiration Time: ${expires.toISOString()}`,
    ].join('\n');
    challenges.set(nonce, { address, message, expiresAt: expires.getTime() });
    return { nonce, message };
  };

  // Check a signed challenge. Returns the verified address; each nonce works once.
  function consume(nonce, signature) {
    const c = challenges.get(String(nonce || ''));
    challenges.delete(String(nonce || ''));
    if (!c || c.expiresAt < now()) throw new GameError('Sign-in request expired. Try connecting again.', 401);
    let sig;
    try {
      sig = base58Decode(String(signature || ''));
    } catch {
      throw new GameError('Bad signature', 401);
    }
    if (!verifySignature(c.address, c.message, sig)) throw new GameError('Signature does not match this wallet', 401);
    return c.address;
  }

  function link(p, address, walletName) {
    const owner = state.solanaLinks[address];
    if (owner && owner !== p.id) {
      throw new GameError(`This wallet already belongs to ${state.players[owner]?.name || 'another character'}. Log out and connect it to play as them.`, 409);
    }
    if (p.solana && p.solana.address !== address) delete state.solanaLinks[p.solana.address];
    state.solanaLinks[address] = p.id;
    p.solana = { address, wallet: String(walletName || 'Wallet').slice(0, 30), linkedAt: now() };
    ctx.onWalletLinked?.(p);
  }

  // Logged in → link the wallet to this character.
  // Not logged in → sign in as the wallet's character, or create one with `name`.
  ctx.walletVerify = ({ nonce, signature, walletName, name, player, ip }) => {
    const address = consume(nonce, signature);
    if (player) {
      link(player, address, walletName);
      return { player, linked: true };
    }
    const pid = state.solanaLinks[address];
    if (pid && state.players[pid]) {
      const token = crypto.randomBytes(24).toString('hex');
      state.tokens[token] = pid;
      const p = state.players[pid];
      p.solana.wallet = String(walletName || p.solana.wallet).slice(0, 30);
      return { player: p, token, signedIn: true };
    }
    if (!String(name || '').trim()) throw new GameError('New wallet! Type a character name first, then connect again.', 400);
    const { player: p, token } = ctx.newPlayer(name, ip);
    link(p, address, walletName);
    return { player: p, token, created: true };
  };

  ctx.walletUnlink = (p) => {
    if (!p.solana) throw new GameError('No wallet linked');
    delete state.solanaLinks[p.solana.address];
    p.solana = null;
  };
}
