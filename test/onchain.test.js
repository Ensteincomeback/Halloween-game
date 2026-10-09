// End-to-end tests of the real-Solana bridge, run against LiteSVM: an
// in-process Solana runtime with the real System, Token-2022 and Associated
// Token Account programs. Transactions, signatures and balances are all real;
// only the network is local.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { LiteSVM } from 'litesvm';
import { Keypair, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createGame } from '../server/game.js';
import { loadSeason, deepMerge } from '../server/config.js';
import { base58Encode } from '../server/solana.js';
import { createLiteSvmConnection } from '../server/onchain/connection.js';
import { installBridge } from '../server/onchain/bridge.js';
import { setupChain } from '../server/onchain/setup.js';
import { ata, transferTokenIxs, sendTx } from '../server/onchain/tokens.js';

const season = deepMerge(loadSeason(new URL('../season/halloween-2026.json', import.meta.url).pathname), { travel: { maxSpeed: 1e9 } });
const SOL = LAMPORTS_PER_SOL;

async function setup() {
  const svm = new LiteSVM();
  const conn = await createLiteSvmConnection(svm);
  const authority = Keypair.generate();
  const vault = Keypair.generate();
  await conn.airdrop(authority.publicKey, 100 * SOL);
  const { booMint } = await setupChain(conn, { authority, vault, supply: season.token.totalSupply, publicUrl: 'http://knock.test' });
  let t = Date.parse('2026-10-09T18:00:00Z');
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const game = createGame({ season, state: {}, now: clock.now, rng, solana: { cluster: 'localnet' }, onchain: { install: installBridge, conn, authority, vault, booMint, publicUrl: 'http://knock.test' } });
  const ctx = game._ctx;
  let ip = 0;
  // A player with a real keypair as their wallet, linked through Sign in with Solana.
  const player = async (name, sol = 5) => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    if (sol) await conn.airdrop(kp.publicKey, sol * SOL);
    const ch = game.walletChallenge(address, 'knock.test');
    const key = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(kp.secretKey.subarray(0, 32)).toString('base64url'), x: Buffer.from(kp.secretKey.subarray(32)).toString('base64url') }, format: 'jwk' });
    const signature = base58Encode(crypto.sign(null, Buffer.from(ch.message), key));
    const r = game.walletVerify(null, { nonce: ch.nonce, signature, walletName: 'Test Wallet', name }, `10.7.0.${ip++}`);
    const p = ctx.state.players[r.player.id];
    p.xp = 2000;
    p.trust = 80;
    return { kp, address, token: r.token, p };
  };
  // What a wallet does with `solana:signTransaction`: add its signature, change nothing else.
  const walletSign = (b64, kp) => {
    const tx = Transaction.from(Buffer.from(b64, 'base64'));
    tx.partialSign(kp);
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  };
  // Run the outbox worker until it's idle; each round, time passes and the blockhash expires.
  const flush = async () => {
    for (let i = 0; i < 12; i++) {
      const n = await ctx.processOutbox();
      clock.advance(60_000);
      svm.expireBlockhash();
      if (!n && !ctx.state.onchain.outbox.some((o) => o.status === 'sending')) break;
    }
  };
  return { svm, conn, authority, vault, booMint, game, ctx, clock, player, walletSign, flush };
}

test('chain setup: fixed-supply $BOO mint with the whole supply in the game vault', async () => {
  const env = await setup();
  assert.equal(await env.conn.tokenAmount(ata(env.booMint, env.vault.publicKey)), BigInt(season.token.totalSupply));
  const rep = await env.game.onchainReport();
  assert.equal(rep.vaultBoo, rep.ledgerBooInVault, 'vault holds exactly what the ledger says');
  assert.equal(env.game.catalog().solana.onchain, true);
});

test('deposits: wallet-signed, byte-checked, server pays the fee, credited only after confirmation, no replays', async () => {
  const env = await setup();
  const a = await env.player('Alice');
  const before = await env.conn.lamports(a.address);
  const r = await env.game.deposit(a.token, 'SOL', 2);
  assert.match(r.summary, /Deposit 2 SOL/);
  assert.equal(env.ctx.chain.solBal(a.p.wallet), 0, 'nothing credited before it lands');
  const signed = env.walletSign(r.transaction, a.kp);
  const done = await env.game.submitIntent(a.token, r.intent, signed);
  assert.ok(done.signature);
  assert.equal(env.ctx.chain.solBal(a.p.wallet), 2 * SOL);
  assert.equal(await env.conn.lamports(a.address), before - 2 * SOL, 'the player paid no network fee');
  await assert.rejects(() => env.game.submitIntent(a.token, r.intent, signed), /already used/);

  // A wallet that changes the transaction (here: a different amount) is refused.
  const r2 = await env.game.deposit(a.token, 'SOL', 1);
  const other = await env.game.deposit(a.token, 'SOL', 3);
  await assert.rejects(() => env.game.submitIntent(a.token, r2.intent, env.walletSign(other.transaction, a.kp)), /changed the transaction/);
  // Someone else's signature doesn't count.
  const r3 = await env.game.deposit(a.token, 'SOL', 1);
  const forged = Transaction.from(Buffer.from(r3.transaction, 'base64'));
  const mallory = Keypair.generate();
  forged.addSignature(a.kp.publicKey, crypto.sign(null, forged.serializeMessage(), crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(mallory.secretKey.subarray(0, 32)).toString('base64url'), x: Buffer.from(mallory.secretKey.subarray(32)).toString('base64url') }, format: 'jwk' })));
  await assert.rejects(() => env.game.submitIntent(a.token, r3.intent, forged.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')), /wallet signature/);
  // Expired requests can't be used.
  const r4 = await env.game.deposit(a.token, 'SOL', 1);
  env.clock.advance(91_000);
  await assert.rejects(() => env.game.submitIntent(a.token, r4.intent, env.walletSign(r4.transaction, a.kp)), /expired/);
  // A failed on-chain transfer (not enough SOL) credits nothing.
  const r5 = await env.game.deposit(a.token, 'SOL', 50);
  await assert.rejects(() => env.game.submitIntent(a.token, r5.intent, env.walletSign(r5.transaction, a.kp)), /Solana rejected/);
  assert.equal(env.ctx.chain.solBal(a.p.wallet), 2 * SOL);
});

test('house deeds: bought with deposited SOL, minted as a real NFT into the buyer wallet', async () => {
  const env = await setup();
  const a = await env.player('Alice');
  const r = await env.game.deposit(a.token, 'SOL', 2);
  await env.game.submitIntent(a.token, r.intent, env.walletSign(r.transaction, a.kp));
  env.game.buyDeed(a.token, 4);
  const h = env.ctx.state.houses[4];
  await env.flush();
  const mint = env.ctx.chain.state.nfts[h.deed].meta.mint;
  assert.ok(mint, 'mint address recorded');
  assert.equal(await env.conn.tokenAmount(ata(mint, a.address)), 1n);
  assert.equal(env.game.house(4, a.token).deedMint, mint);
  const view = (await env.game.onchain(a.token));
  assert.ok(view.nfts.some((n) => n.mint === mint && n.inWallet));
  assert.equal(env.game.nftMetadata(h.deed).symbol, 'KNOCK');
});

test('withdraw and deposit $BOO; ledger burns are mirrored by real burns', async () => {
  const env = await setup();
  const a = await env.player('Alice');
  env.game.faucet(a.token); // devnet $BOO into the game balance
  const start = env.ctx.chain.bal(a.p.wallet);
  env.game.withdraw(a.token, 'BOO', 300);
  assert.equal(env.ctx.chain.bal(a.p.wallet), start - 300, 'debited immediately');
  await env.flush();
  assert.equal(await env.conn.tokenAmount(ata(env.booMint, a.address)), 300n);
  const r = await env.game.deposit(a.token, 'BOO', 100);
  await env.game.submitIntent(a.token, r.intent, env.walletSign(r.transaction, a.kp));
  assert.equal(await env.conn.tokenAmount(ata(env.booMint, a.address)), 200n);
  assert.equal(env.ctx.chain.bal(a.p.wallet), start - 200);

  // Premium costume: part of the price is burned in the ledger → burned on-chain too.
  a.p.ownedCostumes = ['sheet'];
  env.game.buy(a.token, 'costume', 'headless');
  await env.flush();
  const rep = await env.game.onchainReport();
  assert.ok(rep.burnedLedger > 0);
  assert.equal(rep.burnedOnchain, rep.burnedLedger);
  assert.equal(rep.vaultBoo, rep.ledgerBooInVault, 'on-chain vault matches the ledger after burns and withdrawals');
});

test('SOL withdrawals; a withdrawal that cannot be sent is refunded; a lost confirmation is never paid twice', async () => {
  const env = await setup();
  const a = await env.player('Alice');
  const r = await env.game.deposit(a.token, 'SOL', 3);
  await env.game.submitIntent(a.token, r.intent, env.walletSign(r.transaction, a.kp));

  // The send goes through but the confirmation is "lost": the worker must check, not resend.
  const realSend = env.conn.send;
  let sends = 0;
  env.conn.send = async (...args) => {
    sends += 1;
    await realSend(...args);
    throw new Error('confirmation timed out');
  };
  const before = await env.conn.lamports(a.address);
  env.game.withdraw(a.token, 'SOL', 1);
  await env.flush();
  env.conn.send = realSend;
  assert.equal(sends, 1, 'sent exactly once');
  assert.equal(await env.conn.lamports(a.address), before + SOL);
  assert.equal(env.ctx.chain.solBal(a.p.wallet), 2 * SOL);

  // Every attempt fails → refunded after the last retry.
  env.conn.send = async () => {
    throw new Error('RPC down');
  };
  env.game.withdraw(a.token, 'SOL', 1);
  assert.equal(env.ctx.chain.solBal(a.p.wallet), SOL);
  await env.flush();
  env.conn.send = realSend;
  assert.equal(env.ctx.chain.solBal(a.p.wallet), 2 * SOL, 'refunded');
  assert.ok(a.p.inbox[0].text.includes("couldn't be sent"));
});

test('market: listing escrows the NFT from the wallet, the buyer gets it on-chain; outside sales are followed', async () => {
  const env = await setup();
  const a = await env.player('Alice');
  const b = await env.player('Bob');
  for (const x of [a, b]) {
    const r = await env.game.deposit(x.token, 'SOL', 3);
    await env.game.submitIntent(x.token, r.intent, env.walletSign(r.transaction, x.kp));
  }
  env.game.buyDeed(a.token, 4);
  await env.flush();
  const h = env.ctx.state.houses[4];
  const mint = env.ctx.chain.state.nfts[h.deed].meta.mint;

  // The deed is in Alice's wallet, so listing first asks her wallet to move it into escrow.
  const list = await env.game.listHouse(a.token, 4, 1);
  assert.ok(list.intent && list.transaction);
  assert.equal(env.game.market().length, 0);
  await env.game.submitIntent(a.token, list.intent, env.walletSign(list.transaction, a.kp));
  assert.equal(env.game.market()[0].price, 1);
  assert.equal(await env.conn.tokenAmount(ata(mint, env.vault.publicKey)), 1n);

  const aliceSol = env.ctx.chain.solBal(a.p.wallet);
  env.game.buyListing(b.token, 4);
  await env.flush();
  assert.equal(await env.conn.tokenAmount(ata(mint, b.address)), 1n, 'delivered to the buyer wallet');
  assert.equal(env.ctx.houseOwner(h).id, b.p.id);
  assert.equal(env.ctx.chain.solBal(a.p.wallet), aliceSol + SOL - Math.floor(SOL * season.houses.marketFee));

  // Bob sells it somewhere else: sends the NFT to an outside wallet.
  const carol = Keypair.generate();
  await env.conn.airdrop(carol.publicKey, SOL);
  await sendTx(env.conn, b.kp, transferTokenIxs({ payer: b.kp.publicKey, mint, owner: b.address, to: carol.publicKey.toBase58(), amount: 1 }));
  const changed = await env.ctx.syncNftOwners();
  assert.equal(changed, 1);
  assert.equal(env.ctx.houseOwner(h), null);
  assert.equal(env.game.house(4).externalOwner, carol.publicKey.toBase58());
  assert.ok(b.p.inbox[0].text.includes('no longer yours'));
});

test('ownership follows the wallet: NFTs bought before linking are delivered once a wallet is linked', async () => {
  const env = await setup();
  const g = env.game.login('Guest', '10.8.0.1');
  const p = env.ctx.state.players[env.ctx.state.tokens[g.token]];
  p.xp = 2000;
  // Guests can't deposit real SOL; give this one ledger SOL as if they had.
  env.ctx.chain.mintSol(p.wallet, 2 * SOL, 'test');
  env.game.buyDeed(g.token, 4);
  await env.flush();
  const n = env.ctx.chain.state.nfts[env.ctx.state.houses[4].deed];
  assert.equal(await env.conn.tokenAmount(ata(n.meta.mint, env.vault.publicKey)), 1n, 'held by the vault for now');
  const kp = Keypair.generate();
  const ch = env.game.walletChallenge(kp.publicKey.toBase58(), 'knock.test');
  const key = crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: Buffer.from(kp.secretKey.subarray(0, 32)).toString('base64url'), x: Buffer.from(kp.secretKey.subarray(32)).toString('base64url') }, format: 'jwk' });
  env.game.walletVerify(g.token, { nonce: ch.nonce, signature: base58Encode(crypto.sign(null, Buffer.from(ch.message), key)), walletName: 'Test' }, '10.8.0.1');
  await env.flush();
  assert.equal(await env.conn.tokenAmount(ata(n.meta.mint, kp.publicKey)), 1n, 'delivered to the newly linked wallet');
});
