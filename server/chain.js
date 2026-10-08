// Simulated chain (devnet stand-in). Every value-bearing action is a
// transaction in a hash-linked block log, and its programs mirror the ones the
// real contracts need: SPL-style token, NFT deeds/collectibles, a staking bond,
// marketplace escrow, signed reward claims and hash anchors. Swap this module
// for a Solana client and the game code above it does not change.

import crypto from 'node:crypto';

export class ChainError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function createChain({ state, token, now = () => Date.now(), secret }) {
  const c = (state.chain ??= {
    height: 0,
    head: '0'.repeat(64),
    blocks: [],
    balances: {},
    stakes: {},
    nfts: {},
    nextNft: 1,
    listings: {},
    usedNonces: {},
    anchors: [],
    supply: { total: 0, burned: 0 },
  });

  function commit(type, data) {
    const tx = { type, ...data, time: now() };
    const hash = sha(c.head + JSON.stringify(tx));
    const block = { height: ++c.height, prev: c.head, hash, tx };
    c.head = hash;
    c.blocks.push(block);
    if (c.blocks.length > 500) c.blocks.splice(0, c.blocks.length - 500);
    return block;
  }

  // ---------- genesis ----------
  if (c.height === 0) {
    for (const [acct, share] of Object.entries(token.allocation)) {
      const amt = Math.round(token.totalSupply * share);
      c.balances[acct] = amt;
      c.supply.total += amt;
    }
    commit('genesis', { symbol: token.symbol, supply: c.supply.total, allocation: token.allocation });
  }

  const bal = (a) => c.balances[a] || 0;

  function need(a, amt) {
    if (!Number.isInteger(amt) || amt <= 0) throw new ChainError('Amount must be a positive whole number');
    if (bal(a) < amt) throw new ChainError(`Insufficient $${token.symbol}`);
  }

  function transfer(from, to, amt, memo) {
    need(from, amt);
    c.balances[from] -= amt;
    c.balances[to] = bal(to) + amt;
    return commit('transfer', { from, to, amt, memo });
  }

  function burn(from, amt, memo) {
    need(from, amt);
    c.balances[from] -= amt;
    c.supply.total -= amt;
    c.supply.burned += amt;
    return commit('burn', { from, amt, memo });
  }

  // Pay `amt`, burning `burnShare` of it and sending the rest to `to`.
  function payWithBurn(from, to, amt, burnShare, memo) {
    need(from, amt);
    const burnt = Math.floor(amt * burnShare);
    if (burnt > 0) burn(from, burnt, memo);
    if (amt - burnt > 0) transfer(from, to, amt - burnt, memo);
    return { burnt, paid: amt - burnt };
  }

  // ---------- staking bond (Monster License) ----------
  // `since` is time-weighted: adding to a stake pulls it toward now, so a
  // just-borrowed balance can never look like a long-held one (anti flash loan).
  function stake(addr, amt) {
    need(addr, amt);
    const s = c.stakes[addr] || { amount: 0, since: now() };
    s.since = Math.round((s.amount * s.since + amt * now()) / (s.amount + amt));
    s.amount += amt;
    c.stakes[addr] = s;
    c.balances[addr] -= amt;
    c.balances['stake:pool'] = bal('stake:pool') + amt;
    return commit('stake', { addr, amt });
  }

  function unstake(addr, amt) {
    const s = c.stakes[addr];
    if (!s || s.amount < amt || amt <= 0) throw new ChainError('Not enough staked');
    s.amount -= amt;
    c.balances['stake:pool'] -= amt;
    c.balances[addr] = bal(addr) + amt;
    if (s.amount === 0) delete c.stakes[addr];
    return commit('unstake', { addr, amt });
  }

  // Slashing is reserved for proven abuse (botting, collusion), never for losing a scare.
  function slash(addr, amt, reason) {
    const s = c.stakes[addr];
    if (!s) throw new ChainError('No stake');
    const take = Math.min(s.amount, amt);
    s.amount -= take;
    c.balances['stake:pool'] -= take;
    c.balances.treasury = bal('treasury') + take;
    return commit('slash', { addr, amt: take, reason });
  }

  const stakeOf = (addr) => c.stakes[addr] || { amount: 0, since: null };

  // ---------- NFTs ----------
  function mintNft(kind, owner, meta) {
    const id = `${kind}-${c.nextNft++}`;
    c.nfts[id] = { id, kind, owner, meta, history: [{ owner, time: now(), event: 'mint' }] };
    commit('mint', { id, kind, owner, meta });
    return c.nfts[id];
  }

  function transferNft(id, from, to, event = 'transfer') {
    const n = c.nfts[id];
    if (!n || n.owner !== from) throw new ChainError('Not the owner');
    n.owner = to;
    n.history.push({ owner: to, time: now(), event });
    commit('nft-transfer', { id, from, to });
  }

  const nftsOf = (owner, kind) => Object.values(c.nfts).filter((n) => n.owner === owner && (!kind || n.kind === kind));

  // ---------- marketplace escrow ----------
  function list(id, seller, price) {
    if (!Number.isInteger(price) || price <= 0) throw new ChainError('Price must be a positive whole number');
    transferNft(id, seller, 'escrow', 'listed');
    c.listings[id] = { id, seller, price, time: now() };
    commit('list', { id, seller, price });
  }

  function cancel(id, seller) {
    const l = c.listings[id];
    if (!l || l.seller !== seller) throw new ChainError('Not your listing');
    delete c.listings[id];
    transferNft(id, 'escrow', seller, 'delisted');
  }

  function buy(id, buyer, { fee, feeBurnShare }) {
    const l = c.listings[id];
    if (!l) throw new ChainError('Not for sale');
    if (l.seller === buyer) throw new ChainError('That is your own listing');
    need(buyer, l.price);
    const cut = Math.floor(l.price * fee);
    transfer(buyer, l.seller, l.price - cut, `sale ${id}`);
    if (cut > 0) payWithBurn(buyer, 'treasury', cut, feeBurnShare, `market fee ${id}`);
    delete c.listings[id];
    transferNft(id, 'escrow', buyer, 'sold');
    c.nfts[id].lastPrice = l.price;
    return { price: l.price, fee: cut };
  }

  // ---------- signed reward claims ----------
  // The game server signs a ticket; the chain checks the signature and nonce
  // before paying from a funded vault. The server never holds player funds.
  function signClaim(ticket) {
    return crypto.createHmac('sha256', secret).update(JSON.stringify(ticket)).digest('hex');
  }

  function claim(ticket, sig, from = 'vault:claims') {
    const expected = signClaim(ticket);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new ChainError('Bad claim signature');
    }
    if (c.usedNonces[ticket.nonce]) throw new ChainError('Claim already used');
    c.usedNonces[ticket.nonce] = true;
    transfer(from, ticket.to, ticket.amount, `claim ${ticket.reason}`);
  }

  // ---------- anchors (reputation stats hash, season registry) ----------
  function anchor(kind, hash, meta = {}) {
    c.anchors.unshift({ kind, hash, time: now(), ...meta });
    c.anchors.length = Math.min(c.anchors.length, 50);
    return commit('anchor', { kind, hash, ...meta });
  }

  function verify() {
    for (let i = 1; i < c.blocks.length; i++) {
      const b = c.blocks[i];
      if (b.prev !== c.blocks[i - 1].hash || b.hash !== sha(b.prev + JSON.stringify(b.tx))) return false;
    }
    return true;
  }

  return {
    state: c, bal, transfer, burn, payWithBurn, stake, unstake, slash, stakeOf,
    mintNft, transferNft, nftsOf, list, cancel, buy, signClaim, claim, anchor, verify,
    recent: (n = 30) => c.blocks.slice(-n).reverse(),
  };
}
