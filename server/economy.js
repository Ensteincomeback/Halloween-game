// Candy sinks and token utility: shop, boosts, stat training, neighborhoods,
// cosmetic raffle, monster cards, milestone prizes, banking, missions, claims.

import crypto from 'node:crypto';
import { GameError, MINUTE } from './core.js';

export function installEconomy(ctx) {
  const { season, state, chain, rng } = ctx;
  const now = () => ctx.now();
  const sym = season.token.symbol;

  state.raffle ??= {};
  state.redemptions ??= [];

  // ---------- banking ----------
  // The Candy Bank is a building in the town square: you have to walk there.
  ctx.bank = (p, pos) => {
    if (p.pending) throw new GameError(`Finish the ${p.pending.type} first!`, 409);
    ctx.atSpot(p, ctx.layout.bank.door, pos, season.travel.bankRadius, 'Walk to the Candy Bank in the town square to deposit.');
    const moved = Math.min(p.stashCapacity - p.stash, p.bag);
    p.bag -= moved;
    p.stash += moved;
    p.daily.progress.banked += moved;
    p.nightKnocks = 0;
    return { banked: moved, stashFull: p.bag > 0 };
  };

  // ---------- shop ----------
  ctx.buy = (p, kind, itemId) => {
    if (kind === 'costume') {
      const c = season.costumes[itemId];
      if (!c || c.raffleOnly) throw new GameError('Not for sale', 404);
      if (p.ownedCostumes.includes(itemId)) throw new GameError('Already owned');
      if (c.booPrice) {
        // Premium cosmetics: part burned, the rest is revenue that funds payouts.
        const { paid } = chain.payWithBurn(p.wallet, 'treasury', c.booPrice, season.cosmeticBurnShare, `costume ${itemId}`);
        ctx.revenue(paid);
      } else ctx.spend(p, c.price, 'costume');
      p.ownedCostumes.push(itemId);
      p.costume = itemId;
    } else if (kind === 'upgrade') {
      const u = season.upgrades[itemId];
      if (!u) throw new GameError('No such upgrade', 404);
      if (itemId === 'knocks' && p.knocks >= season.energy.hardCap) throw new GameError('Your knuckles are full of energy already');
      ctx.spend(p, u.price, 'upgrade');
      if (itemId === 'bag') p.bagCapacity += u.amount;
      if (itemId === 'stash') p.stashCapacity += u.amount;
      if (itemId === 'knocks') p.knocks = Math.min(season.energy.hardCap, p.knocks + u.amount);
    } else if (kind === 'boost') {
      const b = season.boosts[itemId];
      if (!b) throw new GameError('No such boost', 404);
      ctx.spend(p, b.price, 'boost');
      if (itemId === 'lollipop') p.boosts.luck += b.knocks;
      if (itemId === 'nightvision') p.boosts.nightvision += b.knocks;
      if (itemId === 'repellent') p.shieldUntil = Math.max(p.shieldUntil, now()) + b.minutes * MINUTE;
    } else throw new GameError('Unknown purchase');
  };

  ctx.equip = (p, costumeId) => {
    if (!p.ownedCostumes.includes(costumeId)) throw new GameError('You do not own that costume');
    p.costume = costumeId;
  };

  // Training costs double each level, capped, so time and candy buy progress,
  // but a whale can't buy unbounded power.
  ctx.trainCost = (p, stat) => season.player.trainBaseCost * 2 ** (p.trained[stat] || 0);
  ctx.train = (p, stat) => {
    if (!(stat in p.trained)) throw new GameError('Unknown stat');
    if (p.trained[stat] >= season.player.maxTrainedStat) throw new GameError('Maxed out');
    ctx.spend(p, ctx.trainCost(p, stat), 'training');
    p.trained[stat] += 1;
  };

  // Gatekeepers guard the upper neighborhoods. Reach the level and they wave
  // you through for free; otherwise a one-time candy bribe does it. Either way
  // it is permanent. You have to be standing at the gate.
  ctx.unlockHood = (p, hoodId, pos) => {
    const hood = ctx.hood(hoodId);
    if (!hood) throw new GameError('No such neighborhood', 404);
    if (p.unlocked.includes(hoodId)) throw new GameError('The gatekeeper already knows you. Go on in.');
    const keeper = ctx.layout.keepers.find((k) => k.hood === hoodId);
    if (keeper) {
      const x = Number(pos?.x);
      const z = Number(pos?.z);
      if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x - keeper.spot.x, z - keeper.spot.z) > season.travel.bankRadius) {
        throw new GameError(`Talk to the gatekeeper at the ${hood.name} gate.`, 403);
      }
      ctx.checkTravel(p, keeper.spot);
      ctx.arrive(p, keeper.spot);
    }
    const free = ctx.level(p) >= hood.minLevel;
    if (!free) ctx.spend(p, hood.unlockCost, 'bribe');
    p.unlocked.push(hoodId);
    ctx.pushFeed('unlock', free ? `The gatekeeper let ${p.name} into ${hood.name}.` : `${p.name} bribed their way into ${hood.name}.`);
    return { bribed: !free, paid: free ? 0 : hood.unlockCost };
  };

  // ---------- cosmetic raffle (prize is a non-transferable costume) ----------
  ctx.buyRaffle = (p, n = 1) => {
    const R = season.raffle;
    n = Math.max(1, Math.round(Number(n)));
    if (p.daily.raffleTickets + n > R.maxTicketsPerDay) throw new GameError(`Max ${R.maxTicketsPerDay} tickets a day`);
    ctx.spend(p, R.ticketPrice * n, 'raffle');
    p.daily.raffleTickets += n;
    const d = ctx.today();
    const pool = (state.raffle[d] ??= {});
    pool[p.id] = (pool[p.id] || 0) + n;
  };

  ctx.drawRaffle = (day) => {
    const pool = state.raffle[day];
    delete state.raffle[day];
    if (!pool) return null;
    const total = Object.values(pool).reduce((a, b) => a + b, 0);
    let r = rng() * total;
    for (const [pid, n] of Object.entries(pool)) {
      if ((r -= n) < 0) {
        const p = state.players[pid];
        const prize = season.raffle.prizeCostume;
        if (!p.ownedCostumes.includes(prize)) p.ownedCostumes.push(prize);
        else ctx.addStash(p, season.raffle.ticketPrice * 5, 'raffle');
        ctx.notify(p, `You won the daily raffle: ${season.costumes[prize].name}!`);
        ctx.pushFeed('raffle', `${p.name} won the daily raffle!`);
        return p.id;
      }
    }
    return null;
  };

  // ---------- monster cards ----------
  ctx.drawCard = (minRarity = null) => {
    const C = season.cards;
    const order = Object.keys(C.rarityWeights);
    const allowed = minRarity ? order.slice(order.indexOf(minRarity)) : order;
    const total = allowed.reduce((s, r) => s + C.rarityWeights[r], 0);
    let x = rng() * total;
    let rarity = allowed[0];
    for (const r of allowed) if ((x -= C.rarityWeights[r]) < 0) {
      rarity = r;
      break;
    }
    return ctx.pick(C.list.filter((c) => c.rarity === rarity));
  };

  // Craft: N duplicates + candy → a card of the next rarity.
  ctx.craft = (p, cardId) => {
    const C = season.cards;
    const card = C.list.find((c) => c.id === cardId);
    if (!card) throw new GameError('No such card', 404);
    if ((p.cards[cardId] || 0) < C.craftDuplicates) throw new GameError(`Needs ${C.craftDuplicates} copies`);
    const order = Object.keys(C.rarityWeights);
    const next = order[order.indexOf(card.rarity) + 1];
    if (!next) throw new GameError('Legendary cards cannot be crafted further');
    ctx.spend(p, C.craftCost, 'craft');
    p.cards[cardId] -= C.craftDuplicates;
    const out = ctx.drawCard(next);
    p.cards[out.id] = (p.cards[out.id] || 0) + 1;
    return out;
  };

  // Epic and Legendary cards can become on-chain collectibles (gas sponsored).
  ctx.mintCard = (p, cardId) => {
    const card = season.cards.list.find((c) => c.id === cardId);
    if (!card || !(p.cards[cardId] > 0)) throw new GameError('You do not have that card');
    if (!['epic', 'legendary'].includes(card.rarity)) throw new GameError('Only Epic and Legendary cards can be minted');
    p.cards[cardId] -= 1;
    return chain.mintNft('card', p.wallet, { cardId, name: card.name, rarity: card.rarity, season: season.id });
  };

  const hasFullDeck = (p) => season.cards.list.every((c) => p.cards[c.id] > 0 || chain.nftsOf(p.wallet, 'card').some((n) => n.meta.cardId === c.id));

  // ---------- real-world prizes: milestones and rank only, never a random roll ----------
  ctx.prizeStatus = (p) => season.prizes.list.map((pr) => {
    const req = pr.requirement;
    let met = false;
    let progress = '';
    if (req.kind === 'fullDeck') {
      const have = season.cards.list.filter((c) => p.cards[c.id] > 0 || chain.nftsOf(p.wallet, 'card').some((n) => n.meta.cardId === c.id)).length;
      met = hasFullDeck(p);
      progress = `${have}/${season.cards.list.length} cards`;
    } else if (req.kind === 'legendaryCount') {
      const n = ctx.seasonStats(p).legendaries;
      met = n >= req.count;
      progress = `${n}/${req.count} legendaries`;
    } else if (req.kind === 'leaderboardRank') {
      const rank = ctx.rankOf(p, req.board);
      met = rank > 0 && rank <= req.rank;
      progress = rank ? `rank #${rank}` : 'unranked';
    }
    return { id: pr.id, name: pr.name, met, progress, requested: !!p.redemptions[`${season.id}:${pr.id}`] };
  });

  ctx.redeemPrize = (p, prizeId) => {
    const st = ctx.prizeStatus(p).find((x) => x.id === prizeId);
    if (!st) throw new GameError('No such prize', 404);
    if (!st.met) throw new GameError('Requirement not met yet');
    if (st.requested) throw new GameError('Already requested this season');
    if (p.trust < season.trust.prizeMinTrust) throw new GameError('This account needs more play history before redeeming prizes');
    const key = `${season.id}:${prizeId}`;
    p.redemptions[key] = { at: now(), status: 'pending review' };
    state.redemptions.push({ playerId: p.id, name: p.name, prizeId, season: season.id, at: now(), status: 'pending review' });
    ctx.pushFeed('prize', `${p.name} earned a real-world prize: ${st.name}!`);
  };

  // ---------- $BOO: claims and devnet faucet ----------
  ctx.claimBoo = (p) => {
    if (!p.claimable) throw new GameError('Nothing to claim');
    const ticket = { to: p.wallet, amount: p.claimable, nonce: crypto.randomBytes(12).toString('hex'), reason: 'rewards' };
    chain.claim(ticket, chain.signClaim(ticket));
    p.claimable = 0;
    return ticket.amount;
  };

  // Devnet only: stands in for buying $BOO on an exchange or with a card.
  ctx.faucet = (p) => {
    const d = ctx.today();
    if (p.faucetDay === d) throw new GameError('Devnet faucet: once a day');
    p.faucetDay = d;
    chain.transfer('liquidity', p.wallet, season.token.devnetFaucet, 'devnet faucet');
    return season.token.devnetFaucet;
  };

  // ---------- missions (handed out by townsfolk) ----------
  const statValue = (p, stat) => {
    const v = p.daily.progress[stat];
    return Array.isArray(v) ? v.length : v;
  };
  // Progress counts from the moment you accepted the mission.
  const missionProgress = (p, entry) => {
    const m = season.missions.find((x) => x.id === entry.id);
    return entry.state === 'offered' ? 0 : Math.max(0, statValue(p, m.stat) - entry.base);
  };
  ctx.missionProgress = missionProgress;

  ctx.missionReward = (entry) => {
    const m = season.missions.find((x) => x.id === entry.id);
    const hood = ctx.hood(season.npcs[entry.giver].hood);
    const mult = hood?.candyMultiplier || 1;
    return { candy: Math.round(m.reward.candy * mult), knocks: m.reward.knocks || 0 };
  };

  function atNpc(p, giver, pos) {
    const n = season.npcs[giver];
    const spot = ctx.layout.npcs.find((x) => x.id === giver)?.spot;
    if (!n || !spot) throw new GameError('Nobody by that name around here', 404);
    if (n.hood && !p.unlocked.includes(n.hood)) throw new GameError(`${n.name} is behind the ${ctx.hood(n.hood).name} gate.`, 403);
    ctx.atSpot(p, spot, pos, season.npcRadius, `Walk over to ${n.name} to talk.`);
    const entry = p.daily.missions.find((e) => e.giver === giver);
    if (!entry) throw new GameError(`${n.name} has nothing for you today.`, 404);
    return entry;
  }

  ctx.acceptMission = (p, giver, pos) => {
    const entry = atNpc(p, giver, pos);
    if (entry.state !== 'offered') throw new GameError('You already took this mission.');
    const m = season.missions.find((x) => x.id === entry.id);
    entry.state = 'active';
    entry.base = statValue(p, m.stat);
    return { mission: entry.id };
  };

  ctx.claimMission = (p, giver, pos) => {
    const entry = atNpc(p, giver, pos);
    const m = season.missions.find((x) => x.id === entry.id);
    if (entry.state === 'offered') throw new GameError('Accept the mission first.');
    if (entry.state === 'claimed') throw new GameError('Already claimed. Come back tomorrow!');
    if (missionProgress(p, entry) < m.goal) throw new GameError('Not done yet');
    entry.state = 'claimed';
    const reward = ctx.missionReward(entry);
    ctx.addStash(p, reward.candy, 'mission');
    p.knocks = Math.min(season.energy.hardCap, p.knocks + reward.knocks);
    return reward;
  };

  ctx.economyReport = () => {
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    const { candyIn, candyOut } = state.economy;
    const c = chain.state;
    return {
      candy: { in: candyIn, out: candyOut, totalIn: sum(candyIn), totalOut: sum(candyOut), sinkRatio: sum(candyIn) ? +(sum(candyOut) / sum(candyIn)).toFixed(2) : null },
      token: {
        symbol: sym, supply: c.supply.total, burned: c.supply.burned,
        treasury: chain.bal('treasury'), rewardsVault: chain.bal('vault:rewards'), claimsVault: chain.bal('vault:claims'), staked: chain.bal('stake:pool'),
        epochRevenue: state.epoch.revenue, epoch: state.epoch.index,
      },
      chain: { height: c.height, head: c.head, valid: chain.verify(), anchors: c.anchors.slice(0, 5) },
    };
  };
}
