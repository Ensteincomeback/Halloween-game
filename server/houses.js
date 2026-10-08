// Houses: neighborhoods, daily moods and tells, reputation, deeds (NFTs),
// the owner's Behavior Dial, owner revenue, and the daily payout epoch.

import { GameError, hashInt, seeded, dayKey, clamp, DAY } from './core.js';

export const REWARD_OUTCOMES = new Set(['candy', 'bigCandy', 'rare', 'collectible', 'token', 'legendary', 'secretHouse']);

export function installHouses(ctx) {
  const { season, state, chain } = ctx;
  const now = () => ctx.now();
  const H = season.houses;

  // ---------- world ----------
  state.houses ??= {};
  let nextId = 1;
  for (const hood of season.neighborhoods) {
    hood.types.forEach((type, i) => {
      const id = nextId++;
      const h = (state.houses[id] ??= blankHouse(id, type, hood.names[i % hood.names.length]));
      h.neighborhood = hood.id; // a new season may rename or reskin; ids stay
      h.name = hood.names[i % hood.names.length];
    });
  }
  for (const s of season.secretHouses) {
    const h = (state.houses[s.id] ??= blankHouse(s.id, s.type, s.name));
    h.secret = true;
    h.neighborhood = null;
  }

  function blankHouse(id, type, name) {
    return {
      id, type, name, log: [], visitors: {},
      totals: { visits: 0, candyGiven: 0, scared: 0, jackpots: 0, monsterAttacks: 0, tricks: 0, rewards: 0, legendaries: 0 },
      deed: null, dial: 'balanced', pendingDial: null, lantern: 0, till: 0,
    };
  }

  ctx.house = (id) => {
    const h = state.houses[id];
    if (!h) throw new GameError('No such house', 404);
    return h;
  };

  ctx.hood = (id) => season.neighborhoods.find((n) => n.id === id);

  // ---------- ownership (truth lives on the chain) ----------
  ctx.houseOwner = (h) => {
    if (!h.deed) return null;
    const nft = chain.state.nfts[h.deed];
    const addr = nft.owner === 'escrow' ? chain.state.listings[h.deed]?.seller : nft.owner;
    return ctx.playerByWallet(addr) || null;
  };

  // ---------- daily rotation ----------
  ctx.houseMood = (id, d = ctx.today()) => {
    const list = Object.entries(season.moods.list);
    let r = seeded(season.id, 'mood', id, d) * list.reduce((s, [, m]) => s + m.weight, 0);
    for (const [k, m] of list) if ((r -= m.weight) < 0) return k;
    return 'balanced';
  };

  ctx.houseTell = (id, d = ctx.today(), honestOnly = false) => {
    const mood = ctx.houseMood(id, d);
    const moods = Object.keys(season.moods.list);
    const honest = honestOnly || seeded(season.id, 'honest', id, d) < season.moods.tellAccuracy;
    const shown = honest ? mood : moods[hashInt(season.id, 'lie', id, d) % moods.length];
    const tells = season.moods.list[shown].tells;
    return tells[hashInt(season.id, 'tell', id, d) % tells.length];
  };

  const publicIds = () => Object.values(state.houses).filter((h) => !h.secret).map((h) => h.id);

  ctx.hotHouse = (d = ctx.today()) => {
    const ids = publicIds().filter((id) => state.houses[id].neighborhood === season.neighborhoods[0].id);
    return ids[hashInt(season.id, 'hot', d) % ids.length];
  };

  // Lanterns make a house more likely to land on the daily route (a traffic boost).
  ctx.dailyRoute = (d = ctx.today()) => {
    const ids = publicIds().filter((id) => state.houses[id].neighborhood === season.neighborhoods[0].id);
    const score = (id) => hashInt(season.id, 'route', d, id) / (1 + 0.5 * state.houses[id].lantern);
    return [...ids].sort((a, b) => score(a) - score(b)).slice(0, H.routeLength).sort((a, b) => a - b);
  };

  ctx.legendaryEventOpen = () => new Date(now()).getUTCHours() === season.legendaryEvent.hourUtc;

  // ---------- reputation ----------
  // 0-100: payout rate vs. expected for the type, trust weighted, time decayed
  // (half-life 2 days), capped per visitor, owner visits excluded, shrunk to 50
  // until there is evidence. Jackpots add fame.
  ctx.reputation = (h) => {
    const t = now();
    const expected = expectedPayout(h.type);
    let wSum = 0;
    let good = 0;
    let jackpots = 0;
    for (const v of Object.values(h.visitors)) {
      let vw = 0;
      let vg = 0;
      for (const e of v.events) {
        const w = e.w * 0.5 ** ((t - e.at) / (2 * DAY));
        vw += w;
        vg += w * e.good;
        jackpots += e.jackpot * w;
      }
      if (vw > 3) {
        vg *= 3 / vw;
        vw = 3;
      }
      wSum += vw;
      good += vg;
    }
    if (wSum === 0) return 50;
    const raw = 50 + (good / wSum - expected) * 150 + Math.min(10, jackpots * 5);
    return Math.round(clamp(50 + (raw - 50) * Math.min(1, wSum / 8), 0, 100));
  };

  const expectedCache = {};
  function expectedPayout(type) {
    if (expectedCache[type] == null) {
      const w = ctx.buildOdds({ houseType: type });
      const total = Object.values(w).reduce((a, b) => a + b, 0);
      expectedCache[type] = [...REWARD_OUTCOMES].reduce((s, o) => s + w[o], 0) / total;
    }
    return expectedCache[type];
  }

  // ---------- house log + stats ----------
  ctx.logHouse = (h, p, outcome, detail = {}) => {
    const t = now();
    h.log.unshift({ at: t, player: p.name, outcome, detail });
    h.log.length = Math.min(h.log.length, 60);
    const T = h.totals;
    T.visits += 1;
    const good = REWARD_OUTCOMES.has(outcome) || detail.won === true;
    if (REWARD_OUTCOMES.has(outcome)) T.rewards += 1;
    if (detail.candy > 0) T.candyGiven += detail.candy;
    if ((outcome === 'scare' || outcome === 'ambush' || outcome === 'trap') && !detail.won) T.scared += 1;
    if (outcome === 'ambush' || outcome === 'trap') T.monsterAttacks += 1;
    if (outcome === 'trick') T.tricks += 1;
    if (outcome === 'legendary') T.legendaries += 1;
    if (detail.jackpot) T.jackpots += 1;
    const owner = ctx.houseOwner(h);
    if (owner?.id === p.id) return; // owners can't farm their own reputation or revenue
    const v = (h.visitors[p.id] ??= { events: [] });
    v.events.push({ at: t, good: good ? 1 : 0, w: p.trust / 100, jackpot: detail.jackpot ? 1 : 0 });
    v.events = v.events.slice(-20);
    epochVisit(h, p);
  };

  // ---------- Behavior Dial (24h timelock, publicly logged) ----------
  ctx.applyDial = (h) => {
    if (h.pendingDial && now() >= h.pendingDial.at) {
      h.dial = h.pendingDial.mode;
      h.pendingDial = null;
      h.log.unshift({ at: now(), player: 'Owner', outcome: 'dial', detail: { mode: h.dial, applied: true } });
    }
  };

  function requireOwner(p, h) {
    if (ctx.houseOwner(h)?.id !== p.id) throw new GameError('You do not own this house', 403);
  }

  ctx.setDial = (p, houseId, mode) => {
    const h = ctx.house(houseId);
    requireOwner(p, h);
    if (!H.dial[mode]) throw new GameError('Unknown behavior');
    if (mode === h.dial && !h.pendingDial) throw new GameError('Already set');
    h.pendingDial = { mode, at: now() + H.dialTimelockMs };
    h.log.unshift({ at: now(), player: 'Owner', outcome: 'dial', detail: { mode, at: h.pendingDial.at } });
    ctx.pushFeed('dial', `#${h.id} ${h.name} will turn ${H.dial[mode].name} in ${Math.round(H.dialTimelockMs / 3600_000)}h. You've been warned.`, { houseId: h.id });
  };

  // ---------- deeds: primary sale, lanterns, till, marketplace ----------
  function housesOwnedBy(p) {
    return Object.values(state.houses).filter((h) => ctx.houseOwner(h)?.id === p.id);
  }
  ctx.housesOwnedBy = housesOwnedBy;

  ctx.buyDeed = (p, houseId) => {
    const h = ctx.house(houseId);
    const ht = season.houseTypes[h.type];
    if (h.secret || !ht.price) throw new GameError('This house is not for sale');
    if (h.deed) throw new GameError('Already owned. Check the market.');
    if (housesOwnedBy(p).length >= H.maxPerWallet) throw new GameError(`Max ${H.maxPerWallet} houses per wallet`);
    chain.transfer(p.wallet, 'treasury', ht.price, `deed #${h.id}`);
    ctx.revenue(ht.price);
    const nft = chain.mintNft('house', p.wallet, { houseId: h.id, name: h.name, type: h.type });
    h.deed = nft.id;
    h.lastPrice = ht.price;
    ctx.pushFeed('deed', `${p.name} bought the deed to #${h.id} ${h.name}.`, { houseId: h.id });
  };

  ctx.buyLantern = (p, houseId) => {
    const h = ctx.house(houseId);
    requireOwner(p, h);
    const L = H.lantern;
    if (h.lantern >= L.maxLevel) throw new GameError('Lantern is already max level');
    const price = L.prices[h.lantern];
    const { paid } = chain.payWithBurn(p.wallet, 'treasury', price, L.burnShare, `lantern #${h.id}`);
    ctx.revenue(paid);
    h.lantern += 1;
  };

  ctx.claimTill = (p, houseId) => {
    const h = ctx.house(houseId);
    requireOwner(p, h);
    // Till candy was counted as it came in (fees, monster tax); moving it is not a new faucet.
    const moved = Math.min(p.stashCapacity - p.stash, h.till);
    p.stash += moved;
    h.till -= moved;
    return moved;
  };

  // Entry fees: half burned (sink), half to the owner's till. Unowned → all burned.
  ctx.chargeEntry = (p, h, fee) => {
    if (!fee) return;
    ctx.spend(p, fee, 'entryFee');
    const owner = ctx.houseOwner(h);
    if (owner && owner.id !== p.id) {
      const share = Math.floor(fee * H.entryFeeOwnerShare);
      h.till += share;
      ctx.track('in', 'houseTill', share);
    }
  };

  ctx.listHouse = (p, houseId, price) => {
    const h = ctx.house(houseId);
    requireOwner(p, h);
    chain.list(h.deed, p.wallet, Math.round(Number(price)));
    ctx.pushFeed('market', `#${h.id} ${h.name} is for sale for ${price} $${season.token.symbol}.`, { houseId: h.id });
  };

  ctx.cancelListing = (p, houseId) => chain.cancel(ctx.house(houseId).deed, p.wallet);

  ctx.buyListing = (p, houseId) => {
    const h = ctx.house(houseId);
    if (!h.deed || !chain.state.listings[h.deed]) throw new GameError('Not for sale');
    if (housesOwnedBy(p).length >= H.maxPerWallet) throw new GameError(`Max ${H.maxPerWallet} houses per wallet`);
    const { price, fee } = chain.buy(h.deed, p.wallet, { fee: H.marketFee, feeBurnShare: H.marketFeeBurnShare });
    ctx.revenue(fee - Math.floor(fee * H.marketFeeBurnShare));
    h.lastPrice = price;
    h.log.unshift({ at: now(), player: p.name, outcome: 'sold', detail: { price } });
    ctx.pushFeed('market', `${p.name} bought #${h.id} ${h.name} for ${price} $${season.token.symbol}.`, { houseId: h.id });
  };

  ctx.houseValue = (h) => h.lastPrice || Math.round((season.houseTypes[h.type].price || 0) * (0.5 + ctx.reputation(h) / 100));

  // ---------- epoch: real revenue funds owner and monster payouts ----------
  state.epoch ??= { day: null, index: 0, revenue: 0, houses: {}, monsters: {} };

  ctx.revenue = (boo) => {
    state.epoch.revenue += boo;
  };

  function epochVisit(h, p) {
    if (!h.deed) return;
    const e = (state.epoch.houses[h.id] ??= {});
    e[p.id] = Math.max(e[p.id] || 0, p.trust / 100);
  }

  ctx.epochMonsterWin = (m) => {
    state.epoch.monsters[m.id] = (state.epoch.monsters[m.id] || 0) + 1;
  };

  // Pays out the closing epoch: shares of that epoch's revenue (plus a small,
  // declining bootstrap from the rewards vault) go to house owners by
  // trust-weighted unique visitors and to monsters by successful scares, both on
  // concave (square-root) curves so whales can't scale linearly.
  ctx.settleEpoch = () => {
    const E = state.epoch;
    const T = season.token.epoch;
    const bootstrap = Math.floor(T.bootstrap * T.bootstrapDecay ** E.index);
    const fund = (share) => Math.floor(E.revenue * share);
    const pay = (from, amt, memo) => {
      const a = Math.min(amt, chain.bal(from));
      if (a > 0) chain.transfer(from, 'vault:claims', a, memo);
      return a;
    };
    const hauntPool = pay('treasury', fund(T.hauntPoolShare), 'haunt pool') + pay('vault:rewards', bootstrap, 'bootstrap');
    const monsterPool = pay('treasury', fund(T.monsterPoolShare), 'monster pool');
    if (fund(T.vaultRefillShare) > 0) pay('treasury', fund(T.vaultRefillShare), 'vault refill');

    const houseWeights = Object.entries(E.houses).map(([id, visitors]) => {
      const h = state.houses[id];
      const w = Math.sqrt(Object.values(visitors).reduce((a, b) => a + b, 0)) * (1 + H.lantern.poolWeightPerLevel * h.lantern);
      return { owner: ctx.houseOwner(h), w, h };
    }).filter((x) => x.owner);
    distribute(hauntPool, houseWeights, (x, amt) => {
      x.owner.claimable += amt;
      ctx.notify(x.owner, `#${x.h.id} ${x.h.name} earned ${amt} $${season.token.symbol} from yesterday's visitors.`);
    });

    const monsterWeights = Object.entries(E.monsters)
      .map(([pid, wins]) => ({ m: state.players[pid], w: Math.sqrt(wins) }))
      .filter((x) => x.m?.monster);
    distribute(monsterPool, monsterWeights, (x, amt) => {
      x.m.monster.pendingBoo += amt;
      ctx.notify(x.m, `Your scares earned ${amt} $${season.token.symbol}. Failed scares forfeit a slice, so keep it clean.`);
    });

    // Anchor a hash of every house's public stats so history can't be rewritten.
    const stats = Object.values(state.houses).map((h) => [h.id, h.totals, ctx.reputation(h)]);
    chain.anchor('reputation', hashStats(stats), { epoch: E.index, day: E.day });
    Object.assign(E, { index: E.index + 1, revenue: 0, houses: {}, monsters: {} });
    return { hauntPool, monsterPool, bootstrap };
  };

  function distribute(pool, weights, give) {
    const total = weights.reduce((s, x) => s + x.w, 0);
    if (!pool || !total) return;
    for (const x of weights) {
      const amt = Math.floor((pool * x.w) / total);
      if (amt > 0) give(x, amt);
    }
  }

  function hashStats(obj) {
    return hashInt(JSON.stringify(obj)).toString(16) + ':' + JSON.stringify(obj).length;
  }

  // ---------- world clock ----------
  ctx.tickWorld = () => {
    const d = ctx.today();
    const g = state.global;
    if (g.day !== d) {
      if (g.day) {
        ctx.settleEpoch();
        ctx.drawRaffle?.(g.day);
      }
      g.day = d;
      g.jackpotsToday = 0;
      state.epoch.day = d;
    }
    for (const h of Object.values(state.houses)) ctx.applyDial(h);
    const hourKey = `${d}:${new Date(now()).getUTCHours()}`;
    if (ctx.legendaryEventOpen() && g.legendaryAnnounced !== hourKey) {
      g.legendaryAnnounced = hourKey;
      const lh = state.houses[season.legendaryEvent.houseId];
      ctx.pushFeed('event', `The ${lh.name} has appeared! Open to everyone for one hour. Entry: ${season.legendaryEvent.entryFee} candy.`, { houseId: lh.id });
    }
  };

  // ---------- views ----------
  ctx.houseView = (h, p, { withLog = false } = {}) => {
    const ht = season.houseTypes[h.type];
    const owner = ctx.houseOwner(h);
    const listing = h.deed && chain.state.listings[h.deed];
    const d = ctx.today();
    const todays = h.log.filter((e) => dayKey(e.at) === d);
    return {
      id: h.id, name: h.name, type: h.type, typeName: ht.name, icon: ht.icon, neighborhood: h.neighborhood, secret: !!h.secret,
      tell: ctx.houseTell(h.id, d, p?.boosts?.nightvision > 0),
      reputation: ctx.reputation(h),
      hot: ctx.hotHouse() === h.id,
      onRoute: ctx.dailyRoute().includes(h.id),
      entryFee: h.id === season.legendaryEvent.houseId && ctx.legendaryEventOpen() ? season.legendaryEvent.entryFee : ht.entryFee || 0,
      totals: h.totals,
      uniqueVisitors: Object.keys(h.visitors).length,
      visitsToday: todays.filter((e) => e.outcome !== 'dial').length,
      jackpotsToday: todays.filter((e) => e.detail?.jackpot).length,
      legendariesToday: todays.filter((e) => e.outcome === 'legendary').length,
      owner: owner ? { name: owner.name, isYou: owner.id === p?.id } : null,
      price: !h.deed && !h.secret ? ht.price : null,
      listing: listing ? { price: listing.price } : null,
      value: ctx.houseValue(h),
      dial: h.dial, dialName: H.dial[h.dial].name,
      pendingDial: h.pendingDial && { mode: h.pendingDial.mode, name: H.dial[h.pendingDial.mode].name, at: h.pendingDial.at },
      lantern: h.lantern,
      lanternPrice: h.lantern < H.lantern.maxLevel ? H.lantern.prices[h.lantern] : null,
      till: owner?.id === p?.id ? h.till : undefined,
      ...(withLog ? { log: h.log.slice(0, 30), deedHistory: h.deed ? chain.state.nfts[h.deed].history : [] } : {}),
    };
  };
}
