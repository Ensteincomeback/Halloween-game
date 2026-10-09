// Transaction fees, the Town Raffle and player raffles (the auction house).
//
// Fees: every $BOO or SOL payment carries a fee. It is split into the house
// owners' share, the raffle prize pool, a burn ($BOO only) and the treasury.
// Splits keep fractional carry so small fees still add up exactly.
//
// Town Raffle: a round draws every few minutes. Slots cost candy (a sink), one
// free slot a day. Winners get prizes funded by the fee prize pool; cash and
// stock prizes are reserved from the pool and held as pending redemptions that
// an admin pays out after the winner verifies. Nothing is paid automatically.
//
// Player raffles: list $BOO, a monster card or a card NFT. The item sits in
// escrow, others buy candy slots, and one random slot wins when time runs out.

import crypto from 'node:crypto';
import { GameError, MINUTE } from './core.js';
import { LAMPORTS, toSol } from './chain.js';

export function installRaffle(ctx) {
  const { season, state, chain, rng } = ctx;
  const now = () => ctx.now();
  const F = season.fees;
  const R = season.raffle;
  const A = R.auction;
  const sym = season.token.symbol;

  delete state.raffle; // the old daily costume raffle
  state.fees ??= { carry: {}, totals: {} };
  state.townRaffle ??= null;
  state.auctions ??= {};
  state.auctionHistory ??= [];

  // ---------- fees ----------
  const totals = (cur) => (state.fees.totals[cur] ??= { collected: 0, houseOwners: 0, prizePool: 0, burn: 0, treasury: 0 });

  // Split `fee` (already sitting in `from`) by the season's fee split.
  ctx.routeFee = (currency, from, fee, memo) => {
    if (!(fee > 0)) return;
    const carry = (state.fees.carry[currency] ??= {});
    const T = totals(currency);
    T.collected += fee;
    let left = fee;
    const take = (bucket, share) => {
      const exact = fee * share + (carry[bucket] || 0);
      const amt = Math.min(left, Math.floor(exact));
      carry[bucket] = exact - amt;
      left -= amt;
      T[bucket] += amt;
      return amt;
    };
    const owners = take('houseOwners', F.split.houseOwners);
    const prizes = take('prizePool', F.split.prizePool);
    const burn = currency === 'BOO' ? take('burn', F.split.burn) : 0;
    if (owners) chain.move(currency, from, 'pool:owners', owners, `fee share: owners (${memo})`);
    if (prizes) chain.move(currency, from, 'pool:prizes', prizes, `fee share: prizes (${memo})`);
    if (burn) chain.burn(from, burn, `fee burn (${memo})`);
    if (left > 0) {
      chain.move(currency, from, 'treasury', left, `fee: treasury (${memo})`);
      T.treasury += left;
      if (currency === 'BOO') ctx.revenue(left);
    }
  };

  // A player pays the game. The fee is routed; the rest goes to the treasury
  // ($BOO: part of it burned first) and counts as revenue for payouts.
  ctx.payGame = (p, currency, amount, memo, burnShare = 0) => {
    if (chain.balOf(currency, p.wallet) < amount) throw new GameError(currency === 'SOL' ? 'Not enough SOL' : `Not enough $${sym}`);
    const fee = Math.floor(amount * F.rate);
    if (fee > 0) {
      chain.move(currency, p.wallet, 'fees:incoming', fee, `fee (${memo})`);
      ctx.routeFee(currency, 'fees:incoming', fee, memo);
    }
    const rest = amount - fee;
    if (currency === 'BOO') {
      const { paid } = chain.payWithBurn(p.wallet, 'treasury', rest, burnShare, memo);
      ctx.revenue(paid);
    } else chain.solTransfer(p.wallet, 'treasury', rest, memo);
    return { fee };
  };

  // House owners passively share their slice of every fee, split evenly per house.
  ctx.payOwnerFeeShare = () => {
    const owned = Object.values(state.houses).map((h) => ({ h, owner: ctx.houseOwner(h) })).filter((x) => x.owner);
    const out = { BOO: 0, SOL: 0 };
    if (!owned.length) return out;
    for (const cur of ['BOO', 'SOL']) {
      const each = Math.floor(chain.balOf(cur, 'pool:owners') / owned.length);
      if (each <= 0) continue;
      for (const { h, owner } of owned) {
        chain.move(cur, 'pool:owners', owner.wallet, each, `owner fee share #${h.id}`);
        out[cur] += each;
      }
    }
    const per = { BOO: Math.floor(out.BOO / owned.length), SOL: Math.floor(out.SOL / owned.length) };
    if (per.BOO || per.SOL) {
      for (const { h, owner } of owned) {
        const parts = [per.BOO ? `${per.BOO} $${sym}` : '', per.SOL ? `${toSol(per.SOL)} SOL` : ''].filter(Boolean).join(' + ');
        ctx.notify(owner, `#${h.id} ${h.name} earned ${parts} from its share of transaction fees.`);
      }
    }
    return out;
  };

  // ---------- prize pool (valued in USD at the season's devnet rates) ----------
  const rate = F.usdRate;
  ctx.prizePoolUsd = () => chain.solBal('pool:prizes') / LAMPORTS * rate.SOL + chain.bal('pool:prizes') * rate.BOO;

  // Lock enough of the pool to cover a prize: SOL first, then $BOO.
  function reservePrize(usd) {
    if (ctx.prizePoolUsd() + 1e-9 < usd) return false;
    let owed = usd;
    const sol = Math.min(chain.solBal('pool:prizes'), Math.ceil((owed / rate.SOL) * LAMPORTS));
    if (sol > 0) {
      chain.solTransfer('pool:prizes', 'pool:prizes:reserved', sol, 'raffle prize reserve');
      owed -= (sol / LAMPORTS) * rate.SOL;
    }
    if (owed > 1e-9) {
      const boo = Math.min(chain.bal('pool:prizes'), Math.ceil(owed / rate.BOO));
      if (boo > 0) chain.transfer('pool:prizes', 'pool:prizes:reserved', boo, 'raffle prize reserve');
    }
    return true;
  }

  // ---------- Town Raffle ----------
  const period = () => R.roundMinutes * MINUTE;

  function newRound(prev) {
    const t = now();
    return { round: (prev?.round || 0) + 1, startedAt: t, drawAt: Math.floor(t / period()) * period() + period(), entries: {}, history: prev?.history || [] };
  }
  const round = () => (state.townRaffle ??= newRound(null));

  const freeLeft = (p) => Math.max(0, R.freeSlotsPerDay - (p.daily.freeRaffleSlots || 0));

  ctx.buyRaffle = (p, n = 1, free = false) => {
    if (ctx.level(p) < R.minLevel) throw new GameError(`The Town Raffle opens at level ${R.minLevel}`);
    const r = round();
    const e = (r.entries[p.id] ??= { slots: 0, free: 0 });
    if (free) {
      if (!freeLeft(p)) throw new GameError('Free slot already used today');
      if (e.slots >= R.maxSlots) throw new GameError(`Max ${R.maxSlots} slots per round`);
      p.daily.freeRaffleSlots = (p.daily.freeRaffleSlots || 0) + 1;
      e.slots += 1;
      e.free += 1;
      return { slots: e.slots, round: r.round };
    }
    n = Math.round(Number(n));
    if (!(n >= 1)) throw new GameError('Buy at least one slot');
    if (e.slots + n > R.maxSlots) throw new GameError(`Max ${R.maxSlots} slots per round (you have ${e.slots})`);
    ctx.spend(p, R.slotPrice * n, 'raffle');
    e.slots += n;
    return { slots: e.slots, round: r.round };
  };

  // Weighted by slots, without replacement: one prize per player per round.
  function pickWinners(entries, count) {
    const pool = Object.entries(entries).map(([pid, e]) => ({ pid, w: e.slots })).filter((x) => x.w > 0);
    const out = [];
    while (out.length < count && pool.length) {
      let x = rng() * pool.reduce((s, e) => s + e.w, 0);
      const i = Math.max(0, pool.findIndex((e) => (x -= e.w) < 0));
      out.push(pool[i].pid);
      pool.splice(i, 1);
    }
    return out;
  }

  ctx.drawTownRaffle = () => {
    const r = round();
    const entrants = Object.keys(r.entries).length;
    const slots = Object.values(r.entries).reduce((s, e) => s + e.slots, 0);
    const winnerIds = pickWinners(r.entries, Math.min(R.winners, R.prizes.length));
    const realOk = R.realPrizes && entrants >= R.minEntrantsForRealPrizes;
    const winners = winnerIds.map((pid, i) => {
      const p = state.players[pid];
      const prize = R.prizes[i];
      let label;
      let real = false;
      if (realOk && p.trust >= season.trust.prizeMinTrust && reservePrize(prize.usd)) {
        const id = crypto.randomBytes(6).toString('hex');
        const red = { id, playerId: p.id, name: p.name, source: 'townRaffle', round: r.round, kind: prize.kind, usd: prize.usd, prize: prize.name, at: now(), status: 'pending verification' };
        state.redemptions.push(red);
        p.redemptions[`raffle:${id}`] = red;
        label = prize.name;
        real = true;
        ctx.notify(p, `🎟️ You won ${prize.name} in Town Raffle #${r.round}! Check the Raffle Tent to claim it (age and identity check required).`, { kind: 'raffle' });
      } else if (i === 0 && R.prizeCostume && !p.ownedCostumes.includes(R.prizeCostume)) {
        p.ownedCostumes.push(R.prizeCostume);
        label = `${season.costumes[R.prizeCostume].name} costume`;
        ctx.notify(p, `🎟️ You won the ${label} in Town Raffle #${r.round}!`, { kind: 'raffle' });
      } else {
        const got = ctx.addStash(p, R.consolationCandy, 'raffle');
        label = `${got} candy`;
        ctx.notify(p, `🎟️ You won ${label} in Town Raffle #${r.round}!`, { kind: 'raffle' });
      }
      return { name: p.name, prize: label, real };
    });
    const result = { round: r.round, at: now(), entrants, slots, winners };
    r.history = [result, ...r.history].slice(0, 10);
    if (winners.length) ctx.pushFeed('raffle', `Town Raffle #${r.round}: ${winners.slice(0, 3).map((w) => `${w.name} (${w.prize})`).join(', ')}${winners.length > 3 ? ` and ${winners.length - 3} more` : ''}.`);
    state.townRaffle = newRound(r);
    return result;
  };

  ctx.claimRafflePrize = (p, id, details = {}) => {
    const red = p.redemptions[`raffle:${id}`];
    if (!red) throw new GameError('No such prize', 404);
    if (red.status !== 'pending verification') throw new GameError(`This prize is ${red.status}`);
    if (!details.over18) throw new GameError('You must confirm you are 18 or older');
    const region = String(details.region || '').trim().slice(0, 40);
    if (!region) throw new GameError('Tell us your country/region');
    const contact = String(details.contact || '').trim().slice(0, 120);
    if (!contact) throw new GameError('Add a contact (email) so we can pay you');
    Object.assign(red, { status: 'pending payout', region, contact, claimedAt: now() });
    const global = state.redemptions.find((x) => x.id === id);
    if (global) Object.assign(global, red);
    return { status: red.status };
  };

  // ---------- player raffles (auction house) ----------
  function escrowItem(p, item) {
    if (item.kind === 'boo') {
      const amount = Math.round(Number(item.amount));
      if (!(amount > 0)) throw new GameError('Choose an amount of $' + sym);
      chain.transfer(p.wallet, 'escrow:raffles', amount, 'raffle escrow');
      return { kind: 'boo', amount, name: `${amount} $${sym}` };
    }
    if (item.kind === 'card') {
      const card = season.cards.list.find((c) => c.id === item.cardId);
      if (!card || !(p.cards[card.id] > 0)) throw new GameError('You do not have that card');
      p.cards[card.id] -= 1;
      return { kind: 'card', cardId: card.id, rarity: card.rarity, name: `${card.name} card` };
    }
    if (item.kind === 'nft') {
      const nft = chain.state.nfts[item.nftId];
      if (!nft || nft.owner !== p.wallet) throw new GameError('You do not own that NFT');
      if (nft.kind !== 'card') throw new GameError('Houses are sold on the SOL market, not raffled');
      chain.transferNft(nft.id, p.wallet, 'escrow:raffles', 'raffled');
      return { kind: 'nft', nftId: nft.id, rarity: nft.meta.rarity, name: `${nft.meta.name} (NFT)` };
    }
    throw new GameError('You can raffle $' + sym + ', monster cards or card NFTs');
  }

  function giveItem(item, to) {
    if (item.kind === 'boo') chain.transfer('escrow:raffles', to.wallet, item.amount, 'raffle prize');
    else if (item.kind === 'card') to.cards[item.cardId] = (to.cards[item.cardId] || 0) + 1;
    else if (item.kind === 'nft') chain.transferNft(item.nftId, 'escrow:raffles', to.wallet, 'raffle prize');
  }

  ctx.createAuction = (p, { item, slotPrice, maxSlots, minutes } = {}) => {
    if (ctx.level(p) < R.minLevel) throw new GameError(`Raffles open at level ${R.minLevel}`);
    const mine = Object.values(state.auctions).filter((a) => a.sellerId === p.id);
    if (mine.length >= A.maxActive) throw new GameError(`Max ${A.maxActive} raffles at once`);
    slotPrice = Math.round(Number(slotPrice));
    maxSlots = Math.round(Number(maxSlots));
    minutes = Number(minutes);
    if (!(slotPrice >= A.minSlotPrice && slotPrice <= A.maxSlotPrice)) throw new GameError(`Slot price ${A.minSlotPrice}-${A.maxSlotPrice} candy`);
    if (!(maxSlots >= 2 && maxSlots <= A.maxSlots)) throw new GameError(`Between 2 and ${A.maxSlots} slots`);
    if (!A.durationsMinutes.includes(minutes)) throw new GameError('Pick a listed duration');
    if ((item?.kind === 'boo' || item?.kind === 'nft') && !p.wallet) throw new GameError('No wallet');
    const held = escrowItem(p, item || {});
    const id = crypto.randomBytes(5).toString('hex');
    state.auctions[id] = { id, sellerId: p.id, seller: p.name, item: held, slotPrice, maxSlots, createdAt: now(), endsAt: now() + minutes * MINUTE, entries: {} };
    ctx.pushFeed('auction', `${p.name} is raffling ${held.name}: ${slotPrice} candy a slot.`);
    return { auction: id };
  };

  const sold = (a) => Object.values(a.entries).reduce((s, n) => s + n, 0);

  ctx.enterAuction = (p, id, n = 1) => {
    const a = state.auctions[id];
    if (!a) throw new GameError('That raffle is over', 404);
    if (a.sellerId === p.id) throw new GameError('You cannot enter your own raffle');
    n = Math.round(Number(n));
    if (!(n >= 1)) throw new GameError('Buy at least one slot');
    if (sold(a) + n > a.maxSlots) throw new GameError(`Only ${a.maxSlots - sold(a)} slots left`);
    ctx.spend(p, a.slotPrice * n, 'auctionSlots');
    a.entries[p.id] = (a.entries[p.id] || 0) + n;
    if (sold(a) >= a.maxSlots) a.endsAt = Math.min(a.endsAt, now()); // sold out: draw now
    return { slots: a.entries[p.id] };
  };

  ctx.cancelAuction = (p, id) => {
    const a = state.auctions[id];
    if (!a || a.sellerId !== p.id) throw new GameError('Not your raffle', 404);
    if (sold(a) > 0) throw new GameError('People already bought slots; it has to run');
    giveItem(a.item, p);
    delete state.auctions[id];
  };

  function settleAuction(a) {
    const seller = state.players[a.sellerId];
    delete state.auctions[a.id];
    const total = sold(a);
    if (!total) {
      giveItem(a.item, seller);
      ctx.notify(seller, `Nobody entered your raffle for ${a.item.name}. It's back in your inventory.`);
      return null;
    }
    const [wid] = pickWinners(Object.fromEntries(Object.entries(a.entries).map(([pid, slots]) => [pid, { slots }])), 1);
    const winner = state.players[wid];
    giveItem(a.item, winner);
    const candy = total * a.slotPrice;
    const proceeds = candy - Math.floor(candy * A.candyFee); // the fee stays burned
    seller.stash += proceeds;
    ctx.track('in', 'auctionSales', proceeds);
    ctx.notify(winner, `🎟️ You won ${a.item.name} from ${a.seller}'s raffle!`, { kind: 'raffle' });
    ctx.notify(seller, `Your raffle for ${a.item.name} sold ${total} slots: +${proceeds} candy. Winner: ${winner.name}.`);
    ctx.pushFeed('auction', `${winner.name} won ${a.item.name} from ${a.seller}'s raffle.`);
    const res = { id: a.id, item: a.item.name, seller: a.seller, winner: winner.name, slots: total, at: now() };
    state.auctionHistory = [res, ...state.auctionHistory].slice(0, 20);
    return res;
  }

  ctx.tickRaffles = () => {
    const r = round();
    if (now() >= r.drawAt) ctx.drawTownRaffle();
    for (const a of Object.values(state.auctions)) if (now() >= a.endsAt) settleAuction(a);
  };

  // ---------- views ----------
  ctx.raffleView = (p) => {
    const r = round();
    const e = p && r.entries[p.id];
    return {
      round: r.round, drawAt: r.drawAt, entrants: Object.keys(r.entries).length,
      slots: Object.values(r.entries).reduce((s, x) => s + x.slots, 0),
      yourSlots: e?.slots || 0, freeSlotLeft: p ? freeLeft(p) > 0 : false,
      poolUsd: Math.floor(ctx.prizePoolUsd() * 100) / 100,
      realPrizes: R.realPrizes,
      last: r.history[0] || null,
    };
  };

  ctx.auctionsView = (p) => ({
    open: Object.values(state.auctions).sort((a, b) => a.endsAt - b.endsAt).map((a) => ({
      id: a.id, seller: a.seller, mine: a.sellerId === p?.id, item: a.item, slotPrice: a.slotPrice, maxSlots: a.maxSlots,
      sold: sold(a), yourSlots: (p && a.entries[p.id]) || 0, endsAt: a.endsAt,
    })),
    recent: state.auctionHistory.slice(0, 8),
  });

  ctx.feeReport = () => ({
    rate: F.rate, split: F.split, totals: state.fees.totals,
    ownerPool: { BOO: chain.bal('pool:owners'), SOL: toSol(chain.solBal('pool:owners')) },
    prizePool: { BOO: chain.bal('pool:prizes'), SOL: toSol(chain.solBal('pool:prizes')), usd: Math.floor(ctx.prizePoolUsd() * 100) / 100 },
  });
}
