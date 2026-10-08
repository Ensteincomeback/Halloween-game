// Knock: authoritative game server logic. Composes the modules over one shared
// context. Time, randomness and persistence are injected so rules are testable.

import crypto from 'node:crypto';
import { installCore, GameError } from './core.js';
import { installHouses } from './houses.js';
import { installKnock, buildOdds, rollOutcome, OUTCOMES } from './knock.js';
import { installMonsters } from './monsters.js';
import { installEconomy } from './economy.js';
import { createChain } from './chain.js';
import { seasonHash } from './config.js';
import { buildLayout } from './layout.js';

export { GameError, buildOdds, rollOutcome, OUTCOMES };

const DIVISIONS = { all: [1, Infinity], novice: [1, 4], regular: [5, 9], veteran: [10, Infinity] };

export function createGame({ season, state, now = () => Date.now(), rng = Math.random, onChange = () => {} }) {
  state.serverSecret ??= crypto.randomBytes(32).toString('hex');
  const chain = createChain({ state, token: season.token, now, secret: state.serverSecret });
  const layout = buildLayout(season);
  const ctx = { season, state, now, rng, chain, changed: onChange, layout };

  installCore(ctx);
  installKnock(ctx);
  installHouses(ctx);
  installMonsters(ctx);
  installEconomy(ctx);

  // Season registry: the active Season Pack's hash is anchored on-chain.
  const hash = seasonHash(season);
  if (state.seasonHash !== hash) {
    state.seasonHash = hash;
    chain.anchor('season', hash, { season: season.id });
  }
  ctx.tickWorld();

  // ---------- views ----------
  function playerView(p) {
    const gift = p.gift;
    delete p.gift;
    const E = season.energy;
    const ss = ctx.seasonStats(p);
    const days = Math.min(p.streak.count + 1, season.streak.maxDays);
    const deep = ctx.deepEconomy(p);
    return {
      id: p.id, name: p.name, level: ctx.level(p), xp: p.xp,
      costume: p.costume, ownedCostumes: p.ownedCostumes, stats: ctx.stats(p), trained: p.trained,
      trainCosts: Object.fromEntries(Object.keys(p.trained).map((k) => [k, ctx.trainCost(p, k)])),
      bag: p.bag, bagCapacity: p.bagCapacity, stash: p.stash, stashCapacity: p.stashCapacity,
      knocks: p.knocks, nextRegenMs: p.knocks >= E.regenCap ? null : E.regenMinutes * 60_000 - (now() - p.knocksUpdatedAt),
      totalKnocks: p.totalKnocks, pity: p.pity, pityLimit: season.pity.rareOrBetterWithin,
      nightfall: ctx.nightfallLevel(p), nightKnocks: p.nightKnocks, trust: p.trust,
      shieldMs: Math.max(0, p.shieldUntil - now()), boosts: p.boosts, items: p.items,
      cards: p.cards, trophies: p.trophies,
      pending: p.pending && ctx.pendingView(p.pending),
      streak: p.streak.count, streakBonusToday: p.daily.streakBonus,
      streakBonusTomorrow: season.streak.baseBonus + season.streak.perDay * (days - 1),
      missions: p.daily.missions.map((id) => {
        const m = season.missions.find((x) => x.id === id);
        return { id, text: m.text, goal: m.goal, progress: Math.min(m.goal, ctx.missionProgress(p, m)), reward: m.reward, claimed: p.daily.claimed.includes(id) };
      }),
      routeVisited: p.daily.routeVisited, raffleTickets: p.daily.raffleTickets,
      unlocked: p.unlocked,
      discovered: Object.entries(p.discovered).filter(([, n]) => n > 0).map(([id, n]) => ({ id: Number(id), knocks: n, name: state.houses[id].name })),
      seasonStats: { ...ss, uniqueHouses: undefined, housesVisited: ss.uniqueHouses.length },
      rank: ctx.rankOf(p, 'candy'),
      inbox: p.inbox.slice(0, 10),
      deepEconomy: deep,
      // The economy layer stays hidden until the player has played a while.
      wallet: deep ? {
        address: p.wallet, boo: chain.bal(p.wallet), claimable: p.claimable,
        houses: ctx.housesOwnedBy(p).map((h) => h.id),
        cards: chain.nftsOf(p.wallet, 'card').map((n) => ({ id: n.id, ...n.meta })),
        faucetUsedToday: p.faucetDay === ctx.today(),
      } : null,
      monster: deep ? ctx.monsterView(p) : null,
      prizes: ctx.prizeStatus(p),
      gift,
    };
  }

  function worldView(p) {
    const houses = Object.values(state.houses)
      .filter((h) => !h.secret || (p && p.discovered[h.id] > 0) || (h.id === season.legendaryEvent.houseId && ctx.legendaryEventOpen()))
      .map((h) => ctx.houseView(h, p));
    return {
      season: { id: season.id, name: season.name, tagline: season.tagline, hash: state.seasonHash },
      day: ctx.today(),
      hotHouse: ctx.hotHouse(),
      route: ctx.dailyRoute(),
      neighborhoods: season.neighborhoods.map(({ id, name, minLevel, unlockCost, candyMultiplier }) => ({ id, name, minLevel, unlockCost, candyMultiplier, unlocked: !!p?.unlocked.includes(id) })),
      houses,
      legendaryEvent: { open: ctx.legendaryEventOpen(), hourUtc: season.legendaryEvent.hourUtc, houseId: season.legendaryEvent.houseId },
      nightfallNames: season.nightfall.names,
      jackpotsLeftToday: season.rewards.jackpotGlobalDailyLimit - state.global.jackpotsToday,
    };
  }

  function catalog() {
    const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
    return {
      token: { symbol: season.token.symbol, name: season.token.name, allocation: season.token.allocation },
      costumes: season.costumes, upgrades: season.upgrades, boosts: season.boosts, counters: season.counters,
      monsterCounters: season.monsterCounters,
      npcMonsters: season.npcMonsters.map(({ id, name, type }) => ({ id, name, type })),
      monsterTypes: season.monster.types, monsterRules: { licenseStake: season.monster.licenseStake, warmupMs: season.monster.licenseWarmupMs },
      cards: season.cards.list, cardRules: { craftCost: season.cards.craftCost, craftDuplicates: season.cards.craftDuplicates },
      odds: strip(season.odds), houseTypes: season.houseTypes, dial: season.houses.dial,
      raffle: season.raffle, trophies: season.trophies,
      layout, travel: season.travel,
    };
  }

  // ---------- leaderboards ----------
  const BOARDS = {
    candy: { title: 'Most Candy Collected', fn: (p) => ctx.seasonStats(p).earned },
    houses: { title: 'Most Houses Visited', fn: (p) => ctx.seasonStats(p).uniqueHouses.length },
    monstersDefeated: { title: 'Most Monsters Defeated', fn: (p) => ctx.seasonStats(p).ambushesWon },
    scaresSurvived: { title: 'Most Scares Survived', fn: (p) => ctx.seasonStats(p).scaresSurvived },
    legendaries: { title: 'Most Legendary Rewards', fn: (p) => ctx.seasonStats(p).legendaries },
    richest: { title: 'Richest Trick-or-Treater', fn: (p) => p.bag + p.stash },
    playersScared: { title: 'Most Players Scared', fn: (p) => ctx.seasonStats(p).scaredPlayers, monster: true },
    candyStolen: { title: 'Most Candy Stolen', fn: (p) => ctx.seasonStats(p).stolen, monster: true },
    richestMonster: { title: 'Richest Monster', fn: (p) => (p.monster ? p.monster.pendingBoo + ctx.seasonStats(p).stolen : 0), monster: true },
    notorious: { title: 'Most Notorious Monster', fn: (p) => (p.monster ? p.monster.rep : 0), monster: true },
  };

  function rank(board, division = 'all') {
    const [lo, hi] = DIVISIONS[division] || DIVISIONS.all;
    const B = BOARDS[board];
    return Object.values(state.players)
      .filter((p) => (!B.monster || p.monster) && ctx.level(p) >= lo && ctx.level(p) <= hi)
      .map((p) => ({ id: p.id, name: p.name, level: ctx.level(p), costume: p.costume, monster: p.monster?.type || null, value: B.fn(p) }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value);
  }

  ctx.rankOf = (p, board) => rank(board).findIndex((x) => x.id === p.id) + 1;

  function leaderboards(division = 'all') {
    const out = {};
    for (const [k, B] of Object.entries(BOARDS)) out[k] = { title: B.title, rows: rank(k, division).slice(0, 10).map(({ id, ...r }) => r) };
    const houses = Object.values(state.houses).filter((h) => !h.secret && ctx.knockable(h));
    const houseRow = (h, value) => ({ id: h.id, name: h.name, icon: season.houseTypes[h.type].icon, owner: ctx.houseOwner(h)?.name || null, value });
    out.valuableHouses = { title: 'Most Valuable House', rows: houses.filter((h) => h.plot).map((h) => houseRow(h, ctx.houseValue(h))).sort((a, b) => b.value - a.value).slice(0, 10) };
    out.famousHouses = {
      title: 'Most Famous House',
      rows: houses.filter((h) => h.totals.visits).map((h) => houseRow(h, Math.round(ctx.reputation(h) * Math.log10(h.totals.visits + 10)))).sort((a, b) => b.value - a.value).slice(0, 10),
    };
    out.notoriousHouses = {
      title: 'Most Notorious House',
      rows: houses.filter((h) => h.totals.scared).map((h) => houseRow(h, h.totals.scared)).sort((a, b) => b.value - a.value).slice(0, 10),
    };
    return out;
  }

  // ---------- public API (token → player) ----------
  const withPlayer = (fn) => (token, ...args) => {
    const p = ctx.playerByToken(token);
    const result = fn(p, ...args);
    onChange();
    return { ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }), player: playerView(p) };
  };

  return {
    login(name, ip) {
      const { player, token } = ctx.newPlayer(name, ip);
      return { token, player: playerView(player) };
    },
    me: withPlayer((p) => ({ lastEvent: p.lastEvent })),
    knock: withPlayer((p, houseId, gesture) => ({ result: ctx.knock(p, Number(houseId), gesture) })),
    resolveScare: withPlayer((p, id) => ({ result: ctx.resolveScare(p, id) })),
    resolveAmbush: withPlayer((p, id, counter, bribe) => ({ result: ctx.resolveAmbush(p, id, counter, !!bribe) })),
    bank: withPlayer((p, pos) => ctx.bank(p, pos)),
    buy: withPlayer((p, kind, itemId) => ctx.buy(p, kind, itemId)),
    equip: withPlayer((p, id) => ctx.equip(p, id)),
    train: withPlayer((p, stat) => ctx.train(p, stat)),
    unlock: withPlayer((p, hoodId) => ctx.unlockHood(p, hoodId)),
    raffle: withPlayer((p, n) => ctx.buyRaffle(p, n)),
    craft: withPlayer((p, cardId) => ({ card: ctx.craft(p, cardId) })),
    mintCard: withPlayer((p, cardId) => ({ nft: ctx.mintCard(p, cardId) })),
    redeemPrize: withPlayer((p, prizeId) => ctx.redeemPrize(p, prizeId)),
    claimMission: withPlayer((p, id) => ({ reward: ctx.claimMission(p, id) })),
    claimBoo: withPlayer((p) => ({ claimed: ctx.claimBoo(p) })),
    faucet: withPlayer((p) => ({ received: ctx.faucet(p) })),
    buyDeed: withPlayer((p, houseId) => ctx.buyDeed(p, Number(houseId))),
    setDial: withPlayer((p, houseId, mode) => ctx.setDial(p, Number(houseId), mode)),
    buyLantern: withPlayer((p, houseId) => ctx.buyLantern(p, Number(houseId))),
    claimTill: withPlayer((p, houseId) => ({ claimed: ctx.claimTill(p, Number(houseId)) })),
    listHouse: withPlayer((p, houseId, price) => ctx.listHouse(p, Number(houseId), price)),
    cancelListing: withPlayer((p, houseId) => ctx.cancelListing(p, Number(houseId))),
    buyListing: withPlayer((p, houseId) => ctx.buyListing(p, Number(houseId))),
    stake: withPlayer((p, amount) => ctx.stake(p, amount)),
    unstake: withPlayer((p, amount) => ctx.unstake(p, amount)),
    becomeMonster: withPlayer((p, type) => ctx.becomeMonster(p, type)),
    setLair: withPlayer((p, houseId, kind) => ctx.setLair(p, Number(houseId), kind)),
    claimMonsterBoo: withPlayer((p) => ({ claimed: ctx.claimMonsterBoo(p) })),
    postBounty: withPlayer((p, monsterName, amount) => ctx.postBounty(p, monsterName, amount)),

    world(token) {
      const p = token && state.tokens[token] ? ctx.playerByToken(token) : null;
      if (!p) ctx.tickWorld();
      return worldView(p);
    },
    house(id, token) {
      const p = token && state.tokens[token] ? ctx.playerByToken(token) : null;
      const h = ctx.house(Number(id));
      if (h.secret && !(p?.discovered[h.id] > 0) && !(h.id === season.legendaryEvent.houseId && ctx.legendaryEventOpen())) throw new GameError('No such house', 404);
      return ctx.houseView(h, p, { withLog: true });
    },
    market() {
      return Object.values(chain.state.listings).map((l) => {
        const h = Object.values(state.houses).find((x) => x.deed === l.id);
        return { houseId: h.id, name: h.name, type: h.type, icon: season.houseTypes[h.type].icon, price: l.price, seller: ctx.playerByWallet(l.seller)?.name, reputation: ctx.reputation(h) };
      });
    },
    leaderboards,
    feed: () => state.feed.slice(0, 40),
    catalog,
    economy: () => ctx.economyReport(),
    chain: () => ({ height: chain.state.height, head: chain.state.head, valid: chain.verify(), blocks: chain.recent(25) }),
    admin: {
      settleEpoch: () => ctx.settleEpoch(),
      slash: (playerId, amount, reason) => chain.slash(state.players[playerId].wallet, amount, reason),
      redemptions: () => state.redemptions,
    },
    _ctx: ctx,
  };
}
