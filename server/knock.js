// The knock: odds, outcomes, scare mini-game, monster encounters (NPC and
// player Scare Actors) and traps. All randomness is server-side.

import crypto from 'node:crypto';
import { GameError, HOUR, MINUTE, clamp } from './core.js';
import { REWARD_OUTCOMES } from './houses.js';

export const OUTCOMES = ['candy', 'bigCandy', 'rare', 'collectible', 'token', 'legendary', 'secretHouse', 'trick', 'scare', 'ambush'];
const RARE_OR_BETTER = new Set(['rare', 'legendary', 'token', 'secretHouse']);

// Tutorial: scripted first knocks teach the loop. null = roll normally.
const TUTORIAL = ['candy', 'trick', 'candy', null, 'scare'];

export function buildOdds(season, { houseType, mood, dial, hood, nightfall = 0, luck = 0, sneak = 0 } = {}) {
  const shift = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const add = (mods) => {
    for (const [k, v] of Object.entries(mods || {})) if (k in shift) shift[k] += v;
  };
  add(season.houseTypes[houseType]?.mods);
  add(season.moods.list[mood]?.mods);
  add(season.houses.dial[dial]?.mods);
  add(hood?.mods);
  for (const [k, v] of Object.entries(season.nightfall.perLevel)) shift[k] += v * nightfall;
  shift.rare += 0.5 * luck;
  shift.ambush -= 0.5 * sneak;
  const cap = season.caps.maxShiftPerOutcome;
  const w = {};
  for (const o of OUTCOMES) w[o] = Math.max(0, (season.odds[o] || 0) + clamp(shift[o], -cap, cap));
  w.candy = Math.max(w.candy, season.caps.minCandyWeight);
  return w;
}

export function rollOutcome(weights, rng) {
  const total = OUTCOMES.reduce((s, o) => s + (weights[o] || 0), 0);
  let r = rng() * total;
  for (const o of OUTCOMES) if ((r -= weights[o] || 0) < 0) return o;
  return 'candy';
}

export function installKnock(ctx) {
  const { season, state, rng, chain } = ctx;
  const now = () => ctx.now();
  const R = season.rewards;
  const A = season.ambush;
  const M = season.monster;
  const flavor = (k) => ctx.pick(season.flavor[k]);

  ctx.buildOdds = (opts) => buildOdds(season, opts);

  const nightfallLevel = (p) => Math.min(season.nightfall.maxLevel, Math.floor(p.nightKnocks / season.nightfall.knocksPerLevel));
  ctx.nightfallLevel = nightfallLevel;

  function canVisit(p, h) {
    if (h.secret) {
      const eventOpen = h.id === season.legendaryEvent.houseId && ctx.legendaryEventOpen();
      if (!eventOpen && !(p.discovered[h.id] > 0)) throw new GameError('You have not found this house... yet.', 403);
      return eventOpen && !(p.discovered[h.id] > 0) ? season.legendaryEvent.entryFee : 0;
    }
    if (!p.unlocked.includes(h.neighborhood)) throw new GameError(`${ctx.hood(h.neighborhood).name} is locked. Unlock it in the shop.`, 403);
    return season.houseTypes[h.type].entryFee || 0;
  }

  // ---------- knock ----------
  ctx.knock = (p, houseId, gesture) => {
    const h = ctx.house(houseId);
    if (p.pending) throw new GameError(`Finish the ${p.pending.type} first!`, 409);
    if (p.knocks < 1) throw new GameError('Out of knocks. The street is quiet... come back later.', 429);
    const fee = canVisit(p, h);
    if (fee && p.stash + p.bag < fee) throw new GameError(`Entry costs ${fee} candy`);
    ctx.checkGesture(p, gesture);
    ctx.chargeEntry(p, h, fee);

    p.knocks -= 1;
    p.totalKnocks += 1;
    p.xp += 1;
    p.nightKnocks += 1;
    if (h.secret && p.discovered[h.id] > 0) p.discovered[h.id] -= 1;
    const nf = nightfallLevel(p);
    const st = ctx.stats(p);
    const base = season.player.baseStats;
    const weights = buildOdds(season, {
      houseType: h.type, mood: ctx.houseMood(h.id), dial: h.dial, hood: ctx.hood(h.neighborhood),
      nightfall: nf, luck: st.luck - base.luck, sneak: st.sneak - base.sneak,
    });
    if (p.boosts.luck > 0) p.boosts.luck -= 1;
    if (p.boosts.nightvision > 0) p.boosts.nightvision -= 1;

    let outcome = p.totalKnocks <= TUTORIAL.length ? TUTORIAL[p.totalKnocks - 1] : null;
    let pity = false;
    if (!outcome) {
      if (p.pity + 1 >= season.pity.rareOrBetterWithin) {
        outcome = rollOutcome({ rare: weights.rare, legendary: weights.legendary }, rng);
        pity = true;
      } else outcome = rollOutcome(weights, rng);
    }

    const shielded = now() < p.shieldUntil || p.totalKnocks <= A.newPlayerGraceKnocks;
    // A player monster's lair can spring on any knock at its house.
    let lair = null;
    if (!pity && !shielded && p.totalKnocks > TUTORIAL.length) {
      lair = ctx.eligibleLair(p, h);
      if (lair && outcome !== 'ambush' && rng() >= M.lairTriggerChance) lair = null;
    }
    let npc = null;
    if (!lair && outcome === 'ambush') {
      npc = shielded ? null : chooseNpc(p);
      if (!npc) outcome = 'trick';
    }
    if (outcome === 'legendary' && p.trust < season.trust.legendaryMinTrust) outcome = 'rare';
    if (outcome === 'secretHouse' && !unfoundSecret(p)) outcome = 'rare';
    if (lair) outcome = lair.kind === 'trap' ? 'trap' : 'ambush';

    p.pity = RARE_OR_BETTER.has(outcome) ? 0 : p.pity + 1;

    // missions + season stats
    const prog = p.daily.progress;
    prog.knocks += 1;
    if (!prog.typesVisited.includes(h.type)) prog.typesVisited.push(h.type);
    const isHot = ctx.hotHouse() === h.id;
    if (isHot) prog.hotVisits += 1;
    const route = ctx.dailyRoute();
    if (route.includes(h.id) && !p.daily.routeVisited.includes(h.id)) {
      p.daily.routeVisited.push(h.id);
      if (p.daily.routeVisited.length === route.length) prog.routeDone = 1;
    }
    const ss = ctx.seasonStats(p);
    if (!ss.uniqueHouses.includes(h.id)) ss.uniqueHouses.push(h.id);

    const hoodMult = h.secret ? 2 : ctx.hood(h.neighborhood).candyMultiplier;
    const valueMult = (1 + nf * season.nightfall.candyBonusPerLevel) * (isHot ? 2 : 1) * hoodMult;
    const res = resolve(p, h, outcome, { valueMult, npc, lair, pity });
    res.nightfall = nightfallLevel(p);
    res.hot = isHot;
    if (res.candy > 0) ctx.recordBiggest(p, res.candy, res.title || outcome, h.id);
    if (!p.pending) {
      ctx.logHouse(h, p, outcome, { candy: res.candy, jackpot: res.jackpot, won: res.won });
      ctx.trackResult(p, REWARD_OUTCOMES.has(outcome) || res.won === true);
    }
    p.lastEvent = res;
    return res;
  };

  function unfoundSecret(p) {
    const ids = season.secretHouses.map((s) => s.id).filter((id) => !(p.discovered[id] > 0));
    return ids.length ? ctx.pick(ids) : null;
  }

  function chooseNpc(p) {
    const cd = A.sameMonsterCooldownHours * HOUR;
    const ok = season.npcMonsters.filter((m) => now() - (p.monsterHits[`npc:${m.id}`] || 0) >= cd);
    return ok.length ? ctx.pick(ok) : null;
  }

  function resolve(p, h, outcome, { valueMult, npc, lair, pity }) {
    const res = { outcome, houseId: h.id, houseName: h.name, pity };
    const typeRare = season.houseTypes[h.type].rareValueMultiplier || 1;
    const earn = (raw, src) => {
      const { gained, spilled } = ctx.earn(p, raw, src);
      res.candy = gained;
      res.spilled = spilled;
    };
    switch (outcome) {
      case 'candy':
        res.text = p.totalKnocks === 1 ? 'A dog barks, your hat falls off... but you got candy!' : flavor('candy');
        earn(ctx.randInt(R.candy) * valueMult, 'knock');
        break;
      case 'bigCandy':
        res.text = flavor('bigCandy');
        earn(ctx.randInt(R.candy) * R.bigCandyMultiplier * valueMult, 'knock');
        break;
      case 'rare':
        res.text = flavor('rare');
        earn(ctx.randInt(R.candy) * R.rareMultiplier * typeRare * valueMult, 'knock');
        break;
      case 'collectible': {
        const card = ctx.drawCard();
        p.cards[card.id] = (p.cards[card.id] || 0) + 1;
        Object.assign(res, { text: flavor('collectible'), card });
        if (card.rarity === 'legendary') ctx.pushFeed('card', `${p.name} pulled the legendary ${card.name} card at #${h.id}!`, { houseId: h.id });
        break;
      }
      case 'token': {
        const amt = ctx.randInt(R.token);
        const room = R.tokenDailyCap - p.daily.booEarned;
        if (p.trust < R.tokenMinTrust || room <= 0 || chain.bal('vault:rewards') < amt) {
          res.outcome = 'rare';
          res.text = flavor('rare');
          earn(ctx.randInt(R.candy) * R.rareMultiplier * valueMult, 'knock');
        } else {
          const got = Math.min(amt, room);
          p.daily.booEarned += got;
          chain.transfer('vault:rewards', 'vault:claims', got, 'knock reward');
          p.claimable += got;
          Object.assign(res, { text: flavor('token'), boo: got });
        }
        break;
      }
      case 'legendary':
        legendary(p, h, res, valueMult);
        break;
      case 'secretHouse': {
        const id = unfoundSecret(p);
        p.discovered[id] = R.secretHouseKnocks;
        const sh = state.houses[id];
        Object.assign(res, { text: flavor('secretHouse'), secret: { id, name: sh.name, knocks: R.secretHouseKnocks } });
        ctx.pushFeed('secret', `${p.name} found a secret house: ${sh.name}!`, { houseId: id });
        break;
      }
      case 'trick':
        res.text = flavor('trick');
        res.candy = -ctx.lose(p, ctx.randInt(R.trickLoss), 'trick');
        break;
      case 'trap':
        trap(p, h, res, lair);
        break;
      case 'scare': {
        const sc = season.scare;
        const id = crypto.randomBytes(8).toString('hex');
        const delayMs = ctx.randInt([sc.minDelayMs, sc.maxDelayMs]);
        const windowMs = sc.baseWindowMs + sc.windowPerCourageMs * ctx.stats(p).courage;
        p.pending = { type: 'scare', id, houseId: h.id, issuedAt: now(), delayMs, windowMs };
        Object.assign(res, { text: flavor('scare'), scare: { id, delayMs, windowMs } });
        break;
      }
      case 'ambush': {
        const id = crypto.randomBytes(8).toString('hex');
        const m = lair ? ctx.lairMonsterView(lair) : { name: npc.name, type: npc.type, clue: npc.clue };
        p.pending = { type: 'ambush', id, houseId: h.id, issuedAt: now(), npc: npc?.id, lairId: lair?.id };
        Object.assign(res, { text: flavor('ambush'), ambush: ambushPrompt(id, m, !!lair) });
        break;
      }
    }
    return res;
  }

  function ambushPrompt(id, m, player) {
    return { id, clue: m.clue, monsterName: player ? null : m.name, player, counters: season.counters, candyThrowCost: A.candyThrowCost };
  }

  function legendary(p, h, res, valueMult) {
    const g = state.global;
    const ss = ctx.seasonStats(p);
    ss.legendaries += 1;
    if (rng() < R.jackpotShareOfLegendary && g.jackpotsToday < R.jackpotGlobalDailyLimit) {
      g.jackpotsToday += 1;
      p.trophies.push(season.jackpotTrophy);
      ss.jackpots += 1;
      const { gained, spilled } = ctx.earn(p, R.jackpotCandy, 'jackpot');
      Object.assign(res, { text: flavor('jackpot'), candy: gained, spilled, trophy: season.jackpotTrophy, jackpot: true, title: 'JACKPOT' });
      ctx.pushFeed('jackpot', `JACKPOT! ${p.name} found the Golden Pumpkin at #${h.id} ${h.name}!`, { houseId: h.id });
      return;
    }
    if (rng() < 0.5) {
      const trophy = ctx.pick(season.trophies);
      p.trophies.push(trophy);
      const { gained, spilled } = ctx.earn(p, R.legendaryTrophyCandy, 'knock');
      Object.assign(res, { text: flavor('legendary'), candy: gained, spilled, trophy });
      ctx.pushFeed('legendary', `${p.name} found a ${trophy} at #${h.id} ${h.name}!`, { houseId: h.id });
    } else {
      const { gained, spilled } = ctx.earn(p, ctx.randInt(R.legendaryCandy) * valueMult, 'knock');
      Object.assign(res, { text: flavor('legendary'), candy: gained, spilled });
      ctx.pushFeed('legendary', `${p.name} hauled ${gained} candy out of #${h.id} ${h.name}!`, { houseId: h.id });
    }
  }

  // ---------- traps (witch-style player monsters) ----------
  function trap(p, h, res, lair) {
    const m = state.players[lair.monsterId];
    ctx.consumeLair(lair);
    const avoid = M.trapAvoidBase + M.trapAvoidPerSneak * ctx.stats(p).sneak;
    if (rng() < avoid) {
      Object.assign(res, { won: true, text: `You spot a tripwire on the porch and step right over it. ${m.name}'s trap fails!` });
      ctx.monsterResult(m, p, h, false, 0);
      return;
    }
    const type = M.types[m.monster.type];
    const loss = ctx.lose(p, ctx.randInt(M.trapLoss) + (type.trapBonus || 0), 'trap', false);
    ctx.monsterResult(m, p, h, true, loss);
    Object.assign(res, { won: false, candy: -loss, text: `SNAP! A ${type.name.toLowerCase()}'s trap! ${m.name} made off with ${loss} candy.`, monster: { name: m.name, type: type.name, player: true } });
    ctx.notify(p, `${m.name} caught you in a trap at #${h.id} and took ${loss} candy. Revenge? Post a bounty.`, { monsterId: m.id });
  }

  // ---------- scare mini-game: the server owns the clock ----------
  ctx.resolveScare = (p, id) => {
    const pend = p.pending;
    if (!pend || pend.type !== 'scare' || pend.id !== id) throw new GameError('No scare in progress', 409);
    const reaction = now() - pend.issuedAt - pend.delayMs;
    let won = true;
    let why = `Dodged in ${reaction}ms!`;
    if (reaction < season.scare.minHumanMs) [won, why] = [false, reaction < 0 ? 'You flinched too early!' : 'Too fast to be human...'];
    else if (reaction > pend.windowMs) [won, why] = [false, 'Too slow! It got you.'];
    return finishScare(p, won, why, reaction);
  };

  function finishScare(p, won, why, reaction = null) {
    const h = state.houses[p.pending.houseId];
    p.pending = null;
    const res = { outcome: 'scare', houseId: h.id, houseName: h.name, won, text: why, reaction };
    if (!won && p.items.candle > 0) {
      p.items.candle -= 1;
      won = res.won = true;
      res.text = `${why} ...but your Lucky Candle flared and saved you!`;
    }
    if (won) {
      p.daily.progress.scaresWon += 1;
      ctx.seasonStats(p).scaresSurvived += 1;
      const typeRare = season.houseTypes[h.type].rareValueMultiplier || 1;
      const { gained, spilled } = ctx.earn(p, ctx.randInt(R.candy) * R.rareMultiplier * typeRare * 0.6, 'scare');
      Object.assign(res, { candy: gained, spilled });
      ctx.recordBiggest(p, gained, 'Survived a scare', h.id);
    } else res.candy = -ctx.lose(p, ctx.randInt(R.scareLoss), 'scare');
    ctx.logHouse(h, p, 'scare', { won, candy: res.candy });
    ctx.trackResult(p, won);
    p.lastEvent = res;
    return res;
  }

  // ---------- ambush: read the clue, pick the counter ----------
  ctx.ambushChance = (p, monsterType, counter, { player = null, bribe = false, h = null } = {}) => {
    let chance = player ? A.playerBaseSuccess : A.npcBaseSuccess;
    const right = season.monsterCounters[monsterType];
    if (counter === right) chance += A.rightCounter;
    else if (counter) chance += A.wrongCounter;
    if (season.costumes[p.costume]?.counters === monsterType) chance += A.costumeCounter;
    chance += A.perSneak * ctx.stats(p).sneak;
    if (bribe) chance += A.candyThrow;
    if (player) {
      chance += M.types[player.monster.type].successBonus || 0;
      chance += Math.min(0.05, Math.max(0, (player.monster.rep - 50) / 1000));
      if (h && ctx.houseOwner(h)?.id === player.id) chance += A.homeTurf;
    }
    return clamp(chance, A.min, A.max);
  };

  ctx.resolveAmbush = (p, id, counter, bribe = false) => {
    const pend = p.pending;
    if (!pend || pend.type !== 'ambush' || pend.id !== id) throw new GameError('No ambush in progress', 409);
    if (counter && !season.counters[counter]) throw new GameError('Unknown item');
    if (bribe) {
      if (p.stash + p.bag < A.candyThrowCost) throw new GameError('Not enough candy to throw');
      ctx.spend(p, A.candyThrowCost, 'candyThrow');
    }
    return finishAmbush(p, counter, bribe);
  };

  function finishAmbush(p, counter, bribe = false) {
    const pend = p.pending;
    const h = state.houses[pend.houseId];
    p.pending = null;
    const lair = pend.lairId ? ctx.lairById(pend.lairId) : null;
    const m = lair ? state.players[lair.monsterId] : null;
    const npc = pend.npc ? season.npcMonsters.find((x) => x.id === pend.npc) : null;
    const mType = m ? m.monster.type : npc.type;
    const mName = m ? m.name : npc.name;
    const typeName = m ? M.types[mType].name : npc.type[0].toUpperCase() + npc.type.slice(1);
    const chance = ctx.ambushChance(p, mType, counter, { player: m, bribe, h });
    const stolen = rng() < chance;
    if (lair) ctx.consumeLair(lair);
    const res = {
      outcome: 'ambush', houseId: h.id, houseName: h.name, counter, won: !stolen, chance: Math.round(chance * 100),
      monster: { name: mName, type: typeName, counter: season.monsterCounters[mType], player: !!m },
    };
    const item = counter ? season.counters[counter].name : null;
    if (stolen) {
      const share = m ? M.types[mType].stealShare || A.stealShare : A.stealShare;
      const take = ctx.lose(p, Math.ceil(p.bag * share), 'ambush', !m);
      p.shieldUntil = now() + A.shieldMinutes * MINUTE;
      p.monsterHits[m ? m.id : `npc:${npc.id}`] = now();
      Object.assign(res, {
        candy: -take, shieldMinutes: A.shieldMinutes,
        text: item ? `${mName} the ${typeName} shrugged off your ${item} and swiped ${take} candy!` : `You ran. ${mName} the ${typeName} swiped ${take} candy.`,
      });
      if (m) {
        ctx.monsterResult(m, p, h, true, take);
        ctx.notify(p, `${mName} the ${typeName} stole ${take} candy from you at #${h.id}. Revenge? Post a bounty.`, { monsterId: m.id });
      } else if (take >= 10) ctx.pushFeed('steal', `${mName} the ${typeName} stole ${take} candy from ${p.name} near #${h.id}.`, { houseId: h.id });
    } else {
      p.daily.progress.ambushesWon += 1;
      ctx.seasonStats(p).ambushesWon += 1;
      const { gained, spilled } = ctx.earn(p, ctx.randInt(R.ambushDefendCandy), 'ambush');
      Object.assign(res, { candy: gained, spilled, text: `Your ${item || 'candy toss'} sent ${mName} the ${typeName} running! It dropped ${gained} candy.` });
      if (m) {
        ctx.monsterResult(m, p, h, false, 0);
        const bounty = ctx.collectBounty(p, m);
        if (bounty) res.bounty = bounty;
      }
    }
    ctx.logHouse(h, p, 'ambush', { won: !stolen, candy: res.candy });
    ctx.trackResult(p, !stolen);
    p.lastEvent = res;
    return res;
  }

  // Abandoned mini-games auto-resolve as a loss.
  ctx.expirePending = (p) => {
    const pend = p.pending;
    if (!pend) return;
    const limit = pend.type === 'scare' ? season.scare.expireMs : A.expireMs;
    if (now() - pend.issuedAt <= limit) return;
    if (pend.type === 'scare') finishScare(p, false, 'You froze and ran away.');
    else finishAmbush(p, null);
  };

  ctx.pendingView = (pend) => {
    if (pend.type === 'scare') return { type: 'scare', id: pend.id, delayMs: Math.max(0, pend.delayMs - (now() - pend.issuedAt)), windowMs: pend.windowMs };
    const lair = pend.lairId && ctx.lairById(pend.lairId);
    const npc = pend.npc && season.npcMonsters.find((x) => x.id === pend.npc);
    const m = lair ? ctx.lairMonsterView(lair) : npc;
    return { type: 'ambush', ...ambushPrompt(pend.id, m, !!lair) };
  };
}
