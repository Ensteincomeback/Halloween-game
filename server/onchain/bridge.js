// The bridge between the game's ledger and real Solana (`CHAIN=solana`).
//
// Gameplay stays fast: candy, knocks and in-game $BOO/SOL balances live in the
// server's ledger (server/chain.js), like a game account. Value crosses to and
// from real Solana here:
//
//   Deposits (player → game)   The server builds a transaction, the player's
//                              wallet signs it, the server checks that the
//                              signed message is exactly the one it built, adds
//                              its fee-payer signature and sends it. Only after
//                              it confirms does the ledger credit the player.
//   NFT escrow (player → game) Same flow, used before listing a house or
//                              raffling a card NFT that sits in the player's wallet.
//   Outbox (game → player)     Withdrawals, NFT mints, NFT deliveries and $BOO
//                              burns are queued and sent by a worker, with
//                              retries; a withdrawal that can't be sent is refunded.
//   Ownership sync             NFTs live in players' own wallets. If one is
//                              sold or sent elsewhere, the game follows the
//                              on-chain holder.
//
// Escrow is held by the game's vault key until the Knock program
// (programs/knock) is deployed and takes over escrow on-chain.

import crypto from 'node:crypto';
import { Keypair, Message, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { GameError } from '../core.js';
import { base58Decode, base58Encode } from '../solana.js';
import { toSol } from '../chain.js';
import { ata, T22, mintNftIxs, transferTokenIxs, burnIx, sendTx } from './tokens.js';

const INTENT_MS = 90_000;
const MAX_ATTEMPTS = 5;

// ---------- wire format helpers (legacy transactions) ----------
function readShortVec(buf, at) {
  let len = 0;
  let size = 0;
  for (;;) {
    const b = buf[at + size];
    len |= (b & 0x7f) << (size * 7);
    size += 1;
    if ((b & 0x80) === 0) return [len, size];
  }
}
function shortVec(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return Buffer.from(out);
  }
}
export function parseWire(bytes) {
  const [count, size] = readShortVec(bytes, 0);
  const sigs = [];
  for (let i = 0; i < count; i++) sigs.push(bytes.subarray(size + i * 64, size + (i + 1) * 64));
  return { signatures: sigs, message: bytes.subarray(size + count * 64) };
}
const buildWire = (sigs, message) => Buffer.concat([shortVec(sigs.length), ...sigs, message]);

function ed25519Key(secretKey) {
  const seed = Buffer.from(secretKey.subarray(0, 32)).toString('base64url');
  const x = Buffer.from(secretKey.subarray(32, 64)).toString('base64url');
  return crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: seed, x }, format: 'jwk' });
}
const signBytes = (kp, msg) => crypto.sign(null, msg, ed25519Key(kp.secretKey));
function verifyBytes(address, msg, sig) {
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(base58Decode(address)).toString('base64url') }, format: 'jwk' });
  return crypto.verify(null, msg, key, sig);
}

export function installBridge(ctx, { conn, authority, vault, booMint, publicUrl = 'http://localhost:3000', cluster = 'devnet' }) {
  const { state, chain, season } = ctx;
  const now = () => ctx.now();
  const sym = season.token.symbol;
  const VAULT = vault.publicKey.toBase58();
  const O = (state.onchain ??= { intents: {}, outbox: [], nextOp: 1, nfts: {}, burnedOnchain: 0, solDeposited: 0, solWithdrawn: 0 });
  O.booMint = booMint;

  const linked = (p) => p?.solana?.address || null;
  const playerByAddress = (addr) => state.players[state.solanaLinks?.[addr]];
  const requireLinked = (p) => {
    const a = linked(p);
    if (!a) throw new GameError('Connect your Solana wallet first (Settings → Solana wallet).', 403);
    return a;
  };
  const amountFor = (currency, amount) => {
    const n = Number(amount);
    const v = currency === 'SOL' ? Math.round(n * 1e9) : Math.round(n);
    if (!Number.isFinite(v) || v <= 0) throw new GameError('Enter an amount above zero');
    return v;
  };

  // ---------- intents: player-signed transactions ----------
  const handlers = {};

  async function createIntent(p, kind, params, ixs, summary) {
    const signer = requireLinked(p);
    const bh = await conn.blockhash();
    const tx = new Transaction({ feePayer: authority.publicKey, ...bh }).add(...ixs);
    const message = tx.serializeMessage();
    const id = crypto.randomBytes(8).toString('hex');
    for (const [k, it] of Object.entries(O.intents)) if (it.expiresAt < now() - 3600_000) delete O.intents[k];
    O.intents[id] = { id, playerId: p.id, kind, params, signer, message: message.toString('base64'), blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight, expiresAt: now() + INTENT_MS, status: 'open', summary };
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { intent: id, transaction: wire.toString('base64'), summary, cluster };
  }

  ctx.submitIntent = async (p, id, signedB64) => {
    const it = O.intents[id];
    if (!it || it.playerId !== p.id) throw new GameError('Unknown request. Try again.', 404);
    if (it.status !== 'open') throw new GameError('This request was already used.', 409);
    if (it.expiresAt < now()) {
      it.status = 'expired';
      throw new GameError('This request expired. Try again.', 410);
    }
    const message = Buffer.from(it.message, 'base64');
    let parsed;
    try {
      parsed = parseWire(Buffer.from(String(signedB64 || ''), 'base64'));
    } catch {
      throw new GameError('Bad transaction', 400);
    }
    // The wallet may only add its signature: the transaction itself must be byte-for-byte ours.
    if (!message.equals(parsed.message)) throw new GameError('The wallet changed the transaction, so it was not sent.', 400);
    const msg = Message.from(message);
    const keys = msg.accountKeys.map((k) => k.toBase58());
    const n = msg.header.numRequiredSignatures;
    const at = keys.indexOf(it.signer);
    if (at < 0 || at >= n || !parsed.signatures[at] || !verifyBytes(it.signer, message, parsed.signatures[at])) {
      throw new GameError('Missing or invalid wallet signature', 400);
    }
    const sigs = keys.slice(0, n).map((k, i) => (k === authority.publicKey.toBase58() ? signBytes(authority, message) : parsed.signatures[i]));
    it.status = 'sending';
    it.signature = base58Encode(sigs[0]);
    ctx.changed();
    try {
      await conn.send(buildWire(sigs, message), { blockhash: it.blockhash, lastValidBlockHeight: it.lastValidBlockHeight });
    } catch (err) {
      it.status = 'failed';
      it.error = err.message;
      ctx.changed();
      throw new GameError(`Solana rejected the transaction: ${err.message}`, 400);
    }
    return finishIntent(it);
  };

  function finishIntent(it) {
    it.status = 'done';
    const p = state.players[it.playerId];
    const result = handlers[it.kind].confirmed(p, it.params, it.signature);
    ctx.changed();
    return { ...result, signature: it.signature };
  }

  // Deposit SOL or $BOO from the linked wallet into the game balance.
  ctx.prepareDeposit = async (p, currency, amount) => {
    const from = requireLinked(p);
    const amt = amountFor(currency, amount);
    const ixs = currency === 'SOL'
      ? [SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: vault.publicKey, lamports: amt })]
      : transferTokenIxs({ payer: authority.publicKey, mint: booMint, owner: from, to: VAULT, amount: amt });
    return createIntent(p, 'deposit', { currency, amount: amt }, ixs, `Deposit ${currency === 'SOL' ? `${toSol(amt)} SOL` : `${amt} $${sym}`} into Knock`);
  };
  handlers.deposit = {
    confirmed(p, { currency, amount }, sig) {
      if (currency === 'SOL') {
        chain.mintSol(p.wallet, amount, `deposit ${sig}`);
        O.solDeposited += amount;
      } else chain.transfer('onchain:wallets', p.wallet, amount, `deposit ${sig}`);
      ctx.notify(p, `Deposited ${currency === 'SOL' ? `${toSol(amount)} SOL` : `${amount} $${sym}`} from your wallet.`);
      return { deposited: { currency, amount: currency === 'SOL' ? toSol(amount) : amount } };
    },
  };

  // Move an NFT from the player's wallet into the game's escrow, then run `then`.
  const escrowFollowUps = {};
  ctx.prepareNftEscrow = async (p, ledgerId, then) => {
    const from = requireLinked(p);
    const info = O.nfts[ledgerId];
    if (!info?.mint) throw new GameError('That NFT is still being minted. Try again in a moment.', 409);
    return createIntent(p, 'nftEscrow', { ledgerId, then }, transferTokenIxs({ payer: authority.publicKey, mint: info.mint, owner: from, to: VAULT, amount: 1 }),
      `Move ${chain.state.nfts[ledgerId].meta.name} into Knock's escrow`);
  };
  handlers.nftEscrow = {
    confirmed(p, { ledgerId, then }) {
      O.nfts[ledgerId].holder = VAULT;
      try {
        return { done: escrowFollowUps[then.action](p, then) };
      } catch (err) {
        // The follow-up was refused (limits changed, etc.): send the NFT straight back.
        queue('sendNft', { ledgerId });
        throw err;
      }
    },
  };
  ctx.registerEscrowFollowUp = (name, fn) => (escrowFollowUps[name] = fn);

  // Where an NFT should sit on-chain given its owner in the ledger.
  ctx.nftInCustody = (ledgerId) => !O.nfts[ledgerId]?.mint || O.nfts[ledgerId].holder === VAULT;
  function desiredHolder(n) {
    if (n.owner.startsWith('escrow')) return VAULT;
    if (n.owner.startsWith('ext:')) return n.owner.slice(4);
    return linked(ctx.playerByWallet(n.owner)) || VAULT;
  }

  // ---------- outbox: game-signed transactions ----------
  function queue(kind, params) {
    // Burns are batched into one pending op.
    const open = kind === 'burn' && O.outbox.find((o) => o.kind === 'burn' && o.status === 'queued');
    if (open) {
      open.params.amount += params.amount;
      return open;
    }
    const op = { id: O.nextOp++, kind, params, status: 'queued', attempts: 0, nextAt: 0, createdAt: now() };
    O.outbox.push(op);
    ctx.changed();
    return op;
  }

  // Each op: build() returns the instructions and extra signers (or null when
  // the work is already done on-chain); after() records the result once confirmed.
  const ops = {
    mintNft: {
      async build(op) {
        const n = chain.state.nfts[op.params.ledgerId];
        op.params.mintSecret ??= [...Keypair.generate().secretKey];
        const mintKp = Keypair.fromSecretKey(Uint8Array.from(op.params.mintSecret));
        op.params.mint = mintKp.publicKey.toBase58();
        op.params.to = desiredHolder(n);
        if (await conn.exists(op.params.mint)) return null; // a retry after it already landed
        const name = String(n.meta.name || n.kind).slice(0, 32);
        return { ixs: await mintNftIxs(conn, { payer: authority.publicKey, mintKp, to: op.params.to, name, symbol: 'KNOCK', uri: `${publicUrl}/api/nft/${n.id}.json` }), signers: [mintKp] };
      },
      after(op) {
        const n = chain.state.nfts[op.params.ledgerId];
        O.nfts[n.id] = { mint: op.params.mint, holder: op.params.to };
        n.meta.mint = op.params.mint;
        // The ledger owner may have changed while it was minting.
        if (desiredHolder(n) !== op.params.to && op.params.to === VAULT) queue('sendNft', { ledgerId: n.id });
      },
    },
    sendNft: {
      async build(op) {
        const n = chain.state.nfts[op.params.ledgerId];
        const info = O.nfts[n.id];
        const to = (op.params.to = desiredHolder(n));
        if ((await conn.tokenAmount(ata(info.mint, to))) === 1n) return null;
        if ((await conn.tokenAmount(ata(info.mint, VAULT))) !== 1n) throw new Error(`NFT ${n.id} is not in the vault`);
        return { ixs: transferTokenIxs({ payer: authority.publicKey, mint: info.mint, owner: VAULT, to, amount: 1 }), signers: [vault] };
      },
      after(op) {
        O.nfts[op.params.ledgerId].holder = op.params.to;
      },
    },
    withdraw: {
      async build(op) {
        const { currency, amount, to } = op.params;
        const ixs = currency === 'SOL'
          ? [SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: new PublicKey(to), lamports: amount })]
          : transferTokenIxs({ payer: authority.publicKey, mint: booMint, owner: VAULT, to, amount });
        return { ixs, signers: [vault] };
      },
      after() {},
    },
    burn: {
      async build(op) {
        return { ixs: [burnIx({ mint: booMint, owner: VAULT, amount: op.params.amount })], signers: [vault] };
      },
      after(op) {
        O.burnedOnchain += op.params.amount;
      },
    },
  };

  // Sign first (so the signature is saved before sending), then send.
  async function sendOp(op, ixs, extra) {
    const bh = await conn.blockhash();
    const tx = new Transaction({ feePayer: authority.publicKey, ...bh }).add(...ixs);
    tx.sign(authority, ...extra);
    Object.assign(op, { status: 'sending', signature: base58Encode(tx.signature), blockhash: bh.blockhash });
    ctx.changed();
    await conn.send(tx.serialize(), bh);
  }

  const done = {
    withdraw(op) {
      const { currency, amount, playerId } = op.params;
      if (currency === 'SOL') {
        chain.burnSol('onchain:pending-out', amount, `withdraw ${op.signature}`);
        O.solWithdrawn += amount;
      } else chain.transfer('onchain:pending-out', 'onchain:wallets', amount, `withdraw ${op.signature}`);
      const p = state.players[playerId];
      if (p) ctx.notify(p, `Withdrew ${currency === 'SOL' ? `${toSol(amount)} SOL` : `${amount} $${sym}`} to your wallet.`);
    },
  };
  const failed = {
    withdraw(op) {
      const { currency, amount, playerId } = op.params;
      const p = state.players[playerId];
      chain.move(currency, 'onchain:pending-out', p.wallet, amount, 'withdraw refund');
      ctx.notify(p, `Your withdrawal of ${currency === 'SOL' ? `${toSol(amount)} SOL` : `${amount} $${sym}`} couldn't be sent, so it's back in your game balance.`);
    },
  };

  function complete(op) {
    ops[op.kind].after(op);
    op.status = 'done';
    op.doneAt = now();
    done[op.kind]?.(op);
  }

  let running = false;
  let current = null;
  ctx.processOutbox = async () => {
    if (running) return 0;
    running = true;
    let count = 0;
    try {
      await settleSending();
      for (const op of O.outbox) {
        if (op.status !== 'queued' || op.nextAt > now()) continue;
        current = op;
        try {
          const plan = await ops[op.kind].build(op);
          if (plan) await sendOp(op, plan.ixs, plan.signers);
          complete(op);
        } catch (err) {
          // If it was sent, find out what happened before ever sending it again.
          if (op.status === 'sending') {
            const s = await conn.status(op.signature).catch(() => 'unknown');
            if (s === 'confirmed') {
              complete(op);
              count += 1;
              continue;
            }
            if (s === 'unknown' && (await conn.blockhashValid(op.blockhash).catch(() => true))) {
              op.error = err.message; // still in flight: reconcileOnchain() settles it later
              continue;
            }
          }
          op.attempts += 1;
          op.error = err.message;
          op.status = op.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
          op.nextAt = now() + 2000 * 2 ** op.attempts;
          if (op.status === 'failed') failed[op.kind]?.(op);
        }
        count += 1;
        ctx.changed();
      }
      O.outbox = O.outbox.filter((o) => !(o.status === 'done' && o.doneAt < now() - 24 * 3600_000));
    } finally {
      running = false;
      current = null;
    }
    return count;
  };

  // After a restart: anything caught mid-send is checked on-chain before retrying.
  // Ops caught mid-send (a lost confirmation, a crash): check before retrying.
  async function settleSending() {
    for (const op of O.outbox.filter((o) => o.status === 'sending' && o !== current)) {
      const s = await conn.status(op.signature).catch(() => 'unknown');
      if (s === 'confirmed') complete(op); // it landed: record it, never send it again
      else if (s === 'failed' || !(await conn.blockhashValid(op.blockhash).catch(() => false))) {
        op.attempts += 1;
        op.status = op.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued';
        if (op.status === 'failed') failed[op.kind]?.(op);
      }
    }
  }

  ctx.reconcileOnchain = async () => {
    await settleSending();
    for (const it of Object.values(O.intents).filter((i) => i.status === 'sending')) {
      const s = await conn.status(it.signature);
      if (s === 'confirmed') finishIntent(it);
      else if (s === 'failed' || !(await conn.blockhashValid(it.blockhash))) it.status = 'failed';
    }
  };

  // Test networks only: free SOL for the player's linked wallet.
  ctx.airdropToWallet = async (p, sol = 2) => {
    const to = requireLinked(p);
    if (!['localnet', 'devnet', 'testnet'].includes(cluster)) throw new GameError('Airdrops only exist on test networks');
    await conn.airdrop(to, Math.round(Math.min(5, Number(sol) || 2) * 1e9));
    return { airdropped: Math.min(5, Number(sol) || 2) };
  };

  ctx.withdraw = (p, currency, amount) => {
    const to = requireLinked(p);
    const amt = amountFor(currency, amount);
    chain.move(currency, p.wallet, 'onchain:pending-out', amt, 'withdraw');
    const op = queue('withdraw', { currency, amount: amt, to, playerId: p.id });
    return { queued: op.id };
  };

  // ---------- ledger → chain mirroring ----------
  chain.on('mint', (n) => {
    if (n.kind === 'house' || n.kind === 'card') queue('mintNft', { ledgerId: n.id });
  });
  chain.on('nftTransfer', (n, from, to, event) => {
    if (event === 'onchain-sync' || event === 'raffled' || event === 'listed') return;
    const info = O.nfts[n.id];
    if (info?.mint && info.holder === VAULT && desiredHolder(n) !== VAULT) queue('sendNft', { ledgerId: n.id });
  });
  chain.on('burn', (amount, memo) => {
    if (!String(memo).startsWith('withdraw')) queue('burn', { amount });
  });
  // NFTs a player owned before linking a wallet are delivered to it.
  ctx.onWalletLinked = (p) => {
    for (const n of chain.nftsOf(p.wallet)) {
      const info = O.nfts[n.id];
      if (info?.mint && info.holder === VAULT) queue('sendNft', { ledgerId: n.id });
    }
  };

  // Follow NFTs that moved outside the game (sold on a marketplace, gifted...).
  // `extra`: more addresses to check (only LiteSVM needs hints; RPC finds any holder).
  ctx.syncNftOwners = async (extra = []) => {
    const busy = new Set(O.outbox.filter((o) => o.status !== 'done' && o.status !== 'failed' && o.params.ledgerId).map((o) => o.params.ledgerId));
    const candidates = [VAULT, ...Object.keys(state.solanaLinks || {}), ...extra];
    let changed = 0;
    for (const [id, info] of Object.entries(O.nfts)) {
      const n = chain.state.nfts[id];
      if (!info.mint || busy.has(id) || n.owner.startsWith('escrow')) continue;
      const holder = await conn.nftHolder(info.mint, [info.holder, ...candidates], T22);
      if (!holder || holder === info.holder) continue;
      info.holder = holder;
      if (holder === VAULT) continue;
      const p = playerByAddress(holder);
      const owner = p ? p.wallet : `ext:${holder}`;
      if (owner !== n.owner) {
        const prev = ctx.playerByWallet(n.owner);
        chain.transferNft(id, n.owner, owner, 'onchain-sync');
        if (prev) ctx.notify(prev, `${n.meta.name} left your wallet, so it's no longer yours in Knock.`);
        if (p) ctx.notify(p, `${n.meta.name} arrived in your wallet. It's yours in Knock now.`);
        changed += 1;
      }
    }
    if (changed) ctx.changed();
    return changed;
  };

  // ---------- views ----------
  ctx.onchainView = async (p) => {
    const addr = linked(p);
    const mine = chain.nftsOf(p.wallet).map((n) => ({ id: n.id, kind: n.kind, name: n.meta.name, mint: O.nfts[n.id]?.mint || null, inWallet: !!addr && O.nfts[n.id]?.holder === addr }));
    return {
      enabled: true, cluster, booMint, vault: VAULT,
      wallet: addr ? {
        address: addr,
        sol: toSol(await conn.lamports(addr)),
        boo: Number(await conn.tokenAmount(ata(booMint, addr))),
      } : null,
      game: { sol: toSol(chain.solBal(p.wallet)), boo: chain.bal(p.wallet) },
      nfts: mine,
      pending: O.outbox.filter((o) => o.params.playerId === p.id && o.status !== 'done').slice(-10)
        .map((o) => ({ id: o.id, kind: o.kind, status: o.status, currency: o.params.currency, amount: o.params.currency === 'SOL' ? toSol(o.params.amount) : o.params.amount, error: o.status === 'failed' ? o.error : undefined })),
    };
  };

  ctx.onchainReport = async () => {
    const solLiabilities = Object.values(chain.state.sol).reduce((a, b) => a + b, 0);
    return {
      cluster, booMint, vault: VAULT, authority: authority.publicKey.toBase58(),
      vaultSol: toSol(await conn.lamports(VAULT)), ledgerSol: toSol(solLiabilities),
      vaultBoo: Number(await conn.tokenAmount(ata(booMint, VAULT))),
      ledgerBooInVault: chain.state.supply.total - chain.bal('onchain:wallets') - chain.bal('onchain:pending-out'),
      burnedOnchain: O.burnedOnchain, burnedLedger: chain.state.supply.burned,
      outbox: { queued: O.outbox.filter((o) => o.status === 'queued').length, failed: O.outbox.filter((o) => o.status === 'failed').length },
      nftsMinted: Object.values(O.nfts).filter((x) => x.mint).length,
    };
  };

  ctx.onchainEnabled = true;
  ctx.onchainKeys = { authority: authority.publicKey.toBase58(), vault: VAULT };
  return { sendTx: (ixs, extra) => sendTx(conn, authority, ixs, extra) };
}
