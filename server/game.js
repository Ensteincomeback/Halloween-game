// Knock: authoritative game logic. Pure with respect to I/O: time, randomness and
// persistence are injected so the rules can be tested deterministically.

import crypto from 'node:crypto';

const HOUR = 3600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

export const OUTCOMES = ['candy', 'rare', 'shard', 'legendary', 'trick', 'scare', 'ambush'];
const REWARD_OUTCOMES = new Set(['candy', 'rare', 'shard', 'legendary']);
const RARE_OR_BETTER = new Set(['rare', 'legendary']);

// Tutorial: the first knocks are scripted so the first minutes teach the loop
// (design doc section 14). null = roll normally.
const TUTORIAL = ['candy', 'trick', 'candy', null, 'scare'];
const NEW_PLAYER_GRACE = 10; // no ambushes during the first knocks

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------- deterministic helpers ----------

export function hashInt(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('|')).digest();
  return h.readUInt32BE(0);
}

function seeded(...parts) {
  // Returns a deterministic [0,1) value for daily rotations (Hot House, tells, route).
  return hashInt(...parts) / 0x1_0000_0000;
}

export function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function randInt(rng, [lo, hi]) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------- odds ----------

// Builds the per-knock weight table: baseline + bounded modifiers.
export function buildOdds(season, { houseType, mood, nightfall = 0, luck = 0, sneak = 0 } = {}) {
  const shift = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const add = (mods) => {
    for (const [k, v] of Object.entries(mods || {})) if (k in shift) shift[k] += v;
  };
  add(season.houseTypes[houseType]?.mods);
  add(season.moods.list[mood]?.mods);
  const nf = season.nightfall.perLevel;
  for (const k of Object.keys(nf)) shift[k] += nf[k] * nightfall;
  shift.rare += 0.5 * luck;
  shift.ambush -= 0.5 * sneak;

  const cap = season.caps.maxShiftPerOutcome;
  const weights = {};
  for (const o of OUTCOMES) {
    weights[o] = Math.max(0, season.odds[o] + clamp(shift[o], -cap, cap));
  }
  weights.candy = Math.max(weights.candy, season.caps.minCandyWeight);
  return weights;
}

export function rollOutcome(weights, rng) {
  const total = OUTCOMES.reduce((s, o) => s + weights[o], 0);
  let r = rng() * total;
  for (const o of OUTCOMES) {
    r -= weights[o];
    if (r < 0) return o;
  }
  return 'candy';
}

// ---------- the game ----------

export function createGame({ season, state, now = () => Date.now(), rng = Math.random, onChange = () => {} }) {
  initWorld();

  function initWorld() {
    state.players ??= {};
    state.tokens ??= {};
    state.feed ??= [];
    state.global ??= { day: null, jackpotsToday: 0 };
    state.houses ??= {};
    const { count, types, names } = season.houses;
    for (let i = 1; i <= count; i++) {
      state.houses[i] ??= {
        id: i,
        type: types[(i - 1) % types.length],
        name: names[(i - 1) % names.length],
        log: [],
        totals: { visits: 0, rewards: 0, jackpots: 0, scares: 0, ambushes: 0, tricks: 0 },
        visitors: {},
      };
    }
  }

  // ----- daily rotation -----

  function today() {
    return dayKey(now());
  }

  function rollDayGlobal() {
    const d = today();
    if (state.global.day !== d) {
      state.global.day = d;
      state.global.jackpotsToday = 0;
    }
  }

  function houseMood(houseId, d = today()) {
    const list = Object.entries(season.moods.list).filter(([k]) => !k.startsWith('_'));
    const total = list.reduce((s, [, m]) => s + m.weight, 0);
    let r = seeded(season.id, 'mood', houseId, d) * total;
    for (const [k, m] of list) {
      r -= m.weight;
      if (r < 0) return k;
    }
    return 'balanced';
  }

  // The tell is what players can see. It is honest most of the time.
  function houseTell(houseId, d = today()) {
    const mood = houseMood(houseId, d);
    const moods = Object.keys(season.moods.list);
    const honest = seeded(season.id, 'honest', houseId, d) < season.moods.tellAccuracy;
    const shown = honest ? mood : moods[hashInt(season.id, 'lie', houseId, d) % moods.length];
    const tells = season.moods.list[shown].tells;
    return tells[hashInt(season.id, 'tell', houseId, d) % tells.length];
  }

  function hotHouse(d = today()) {
    return (hashInt(season.id, 'hot', d) % season.houses.count) + 1;
  }

  function dailyRoute(d = today()) {
    const ids = Object.keys(state.houses).map(Number);
    ids.sort((a, b) => hashInt(season.id, 'route', d, a) - hashInt(season.id, 'route', d, b));
    return ids.slice(0, season.houses.routeLength).sort((a, b) => a - b);
  }

  function dailyMissions(playerId, d = today()) {
    const pool = [...season.missions];
    pool.sort((a, b) => hashInt(playerId, d, a.id) - hashInt(playerId, d, b.id));
    return pool.slice(0, season.missionsPerDay).map((m) => m.id);
  }

  // ----- players -----

  function newPlayer(name) {
    const id = crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    const p = {
      id,
      name: String(name || '').trim().slice(0, 20) || `Kid-${id.slice(0, 4)}`,
      createdAt: now(),
      costume: 'sheet',
      ownedCostumes: ['sheet'],
      bag: 0,
      stash: 0,
      bagCapacity: season.player.bagCapacity,
      stashCapacity: season.player.stashCapacity,
      knocks: season.energy.dailyFree,
      knocksUpdatedAt: now(),
      totalKnocks: 0,
      pity: 0,
      nightKnocks: 0,
      trust: season.trust.start,
      knockTimes: [],
      lastKnockAt: 0,
      shieldUntil: 0,
      monsterHits: {},
      recentResults: [],
      items: { candle: 0 },
      shards: {},
      trophies: [],
      pending: null,
      xp: 0,
      season: { earned: 0, uniqueHouses: [], scaresSurvived: 0, ambushesWon: 0, jackpots: 0 },
      day: null,
      daily: null,
      streak: { count: 0, lastDay: null, graceUsedWeek: null },
      lastEvent: null,
    };
    state.players[id] = p;
    state.tokens[token] = id;
    rollDay(p);
    onChange();
    return { player: p, token };
  }

  function playerByToken(token) {
    const id = state.tokens[token];
    const p = id && state.players[id];
    if (!p) throw new GameError('Not logged in', 401);
    rollDay(p);
    regen(p);
    expirePending(p);
    return p;
  }

  function stats(p) {
    const s = { ...season.player.baseStats };
    for (const [k, v] of Object.entries(season.costumes[p.costume]?.stats || {})) s[k] += v;
    return s;
  }

  function level(p) {
    return Math.floor(Math.sqrt(p.xp / 10)) + 1;
  }

  function regen(p) {
    const { regenMinutes, regenCap } = season.energy;
    const step = regenMinutes * MINUTE;
    const t = now();
    if (p.knocks >= regenCap) {
      p.knocksUpdatedAt = t;
      return;
    }
    const gained = Math.floor((t - p.knocksUpdatedAt) / step);
    if (gained > 0) {
      p.knocks = Math.min(regenCap, p.knocks + gained);
      p.knocksUpdatedAt += gained * step;
    }
  }

  function rollDay(p) {
    const d = today();
    if (p.day === d) return;
    const prev = p.day;
    p.day = d;
    p.knocks = Math.max(p.knocks, season.energy.dailyFree);
    p.knocksUpdatedAt = now();
    p.daily = {
      missions: dailyMissions(p.id, d),
      claimed: [],
      progress: { knocks: 0, scaresWon: 0, banked: 0, typesVisited: [], ambushesWon: 0, hotVisits: 0, earned: 0, routeDone: 0 },
      routeVisited: [],
      candyEarned: 0,
      streakClaimed: false,
    };
    updateStreak(p, prev, d);
  }

  // Forgiving streaks: one missed day per ISO week is covered by grace.
  function updateStreak(p, prev, d) {
    const s = p.streak;
    if (!s.lastDay) {
      s.count = 1;
    } else {
      const gap = Math.round((Date.parse(d) - Date.parse(s.lastDay)) / DAY);
      const week = isoWeek(d);
      if (gap === 1) s.count += 1;
      else if (gap === 2 && s.graceUsedWeek !== week) {
        s.count += 1;
        s.graceUsedWeek = week;
      } else if (gap > 1) s.count = 1;
    }
    s.lastDay = d;
    const days = Math.min(s.count, season.streak.maxDays);
    const bonus = season.streak.baseBonus + season.streak.perDay * (days - 1);
    addStash(p, bonus);
    p.daily.streakBonus = bonus;
  }

  function isoWeek(d) {
    const t = new Date(d + 'T00:00:00Z');
    const day = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - day + 3);
    const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    return `${t.getUTCFullYear()}-${Math.round((t - first) / (7 * DAY))}`;
  }

  // ----- candy movement -----

  function addStash(p, n) {
    p.stash = Math.min(p.stashCapacity, p.stash + n);
  }

  // Applies diminishing returns and trust scaling to a candy faucet, then
  // puts it in the bag. Returns {gained, spilled}.
  function earn(p, raw) {
    let mult = 1;
    const dc = season.dailyCandy;
    if (p.daily.candyEarned >= dc.hardCap) mult *= dc.hardMultiplier;
    else if (p.daily.candyEarned >= dc.softCap) mult *= dc.softMultiplier;
    if (p.trust < season.trust.lowTrust) mult *= season.trust.lowTrustMultiplier;
    const amount = Math.max(raw > 0 ? 1 : 0, Math.round(raw * mult));
    const room = p.bagCapacity - p.bag;
    const gained = Math.min(room, amount);
    p.bag += gained;
    p.daily.candyEarned += gained;
    p.daily.progress.earned += gained;
    p.season.earned += gained;
    return { gained, spilled: amount - gained };
  }

  function lose(p, n) {
    const lost = Math.min(p.bag, n);
    p.bag -= lost;
    return lost;
  }

  function spend(p, price) {
    if (p.stash + p.bag < price) throw new GameError('Not enough candy');
    const fromStash = Math.min(p.stash, price);
    p.stash -= fromStash;
    p.bag -= price - fromStash;
  }

  // ----- anti-bot -----

  // Knocks need a human-ish press. Inhuman cadence lowers trust; varied
  // human timing slowly raises it.
  function checkGesture(p, gesture) {
    const t = now();
    const { minKnockIntervalMs, max } = season.trust;
    if (t - p.lastKnockAt < minKnockIntervalMs) {
      p.trust = Math.max(0, p.trust - 2);
      throw new GameError('Slow down! Knock like a human.', 429);
    }
    const hold = Number(gesture?.holdMs);
    if (!Number.isFinite(hold) || hold < 30 || hold > 5000) {
      p.trust = Math.max(0, p.trust - 3);
      throw new GameError('Knock gesture not recognized. Press and release the door.');
    }
    if (p.lastKnockAt) p.knockTimes.push(t - p.lastKnockAt);
    p.knockTimes = p.knockTimes.slice(-12);
    p.lastKnockAt = t;
    if (p.knockTimes.length >= 10) {
      const mean = p.knockTimes.reduce((a, b) => a + b, 0) / p.knockTimes.length;
      const sd = Math.sqrt(p.knockTimes.reduce((a, b) => a + (b - mean) ** 2, 0) / p.knockTimes.length);
      if (sd < 25) p.trust = Math.max(0, p.trust - 5);
      else if (p.trust < max) p.trust += 1;
    } else if (p.trust < max && rng() < 0.2) {
      p.trust += 1;
    }
  }

  // ----- feed -----

  function pushFeed(kind, text, extra = {}) {
    state.feed.unshift({ at: now(), kind, text, ...extra });
    state.feed.length = Math.min(state.feed.length, 100);
  }

  // ----- houses -----

  function logHouse(house, p, outcome, detail) {
    const t = now();
    house.log.unshift({ at: t, player: p.name, outcome, detail });
    house.log.length = Math.min(house.log.length, 60);
    house.totals.visits += 1;
    if (REWARD_OUTCOMES.has(outcome)) house.totals.rewards += 1;
    if (outcome === 'scare') house.totals.scares += 1;
    if (outcome === 'ambush') house.totals.ambushes += 1;
    if (outcome === 'trick') house.totals.tricks += 1;
    // Trust-weighted visit history for reputation; capped per visitor.
    const v = (house.visitors[p.id] ??= { events: [] });
    v.events.push({ at: t, good: REWARD_OUTCOMES.has(outcome) ? 1 : 0, w: p.trust / 100, jackpot: detail?.jackpot ? 1 : 0 });
    v.events = v.events.slice(-20);
  }

  // Reputation 0-100: payout rate vs. expected for the house type, trust
  // weighted, time decayed (half-life 2 days), capped per visitor, and shrunk
  // toward 50 until there is enough evidence.
  function reputation(house) {
    const t = now();
    const expected = expectedPayout(house.type);
    let wSum = 0;
    let good = 0;
    let jackpots = 0;
    for (const v of Object.values(house.visitors)) {
      let vw = 0;
      let vg = 0;
      for (const e of v.events) {
        const w = e.w * 0.5 ** ((t - e.at) / (2 * DAY));
        vw += w;
        vg += w * e.good;
        jackpots += e.jackpot * w;
      }
      const cap = 3;
      if (vw > cap) {
        vg *= cap / vw;
        vw = cap;
      }
      wSum += vw;
      good += vg;
    }
    if (wSum === 0) return 50;
    const raw = 50 + (good / wSum - expected) * 150 + Math.min(10, jackpots * 5);
    const confidence = Math.min(1, wSum / 8);
    return Math.round(clamp(50 + (raw - 50) * confidence, 0, 100));
  }

  function expectedPayout(type) {
    const w = buildOdds(season, { houseType: type, mood: 'balanced' });
    const total = OUTCOMES.reduce((s, o) => s + w[o], 0);
    return [...REWARD_OUTCOMES].reduce((s, o) => s + w[o], 0) / total;
  }

  function houseDayStats(house) {
    const d = today();
    const todays = house.log.filter((e) => dayKey(e.at) === d);
    return {
      visitsToday: todays.length,
      jackpotsToday: todays.filter((e) => e.detail?.jackpot).length,
      legendariesToday: todays.filter((e) => e.outcome === 'legendary').length,
      scaresToday: todays.filter((e) => e.outcome === 'scare' || e.outcome === 'ambush').length,
    };
  }

  function houseView(house, { withLog = false } = {}) {
    const ht = season.houseTypes[house.type];
    return {
      id: house.id,
      name: house.name,
      type: house.type,
      typeName: ht.name,
      icon: ht.icon,
      tell: houseTell(house.id),
      reputation: reputation(house),
      hot: hotHouse() === house.id,
      onRoute: dailyRoute().includes(house.id),
      totals: house.totals,
      uniqueVisitors: Object.keys(house.visitors).length,
      ...houseDayStats(house),
      ...(withLog ? { log: house.log.slice(0, 30) } : {}),
    };
  }

  // ----- knock -----

  function knock(token, houseId, gesture) {
    const p = playerByToken(token);
    rollDayGlobal();
    const house = state.houses[houseId];
    if (!house) throw new GameError('No such house', 404);
    if (p.pending) throw new GameError(`Finish the ${p.pending.type} first!`, 409);
    if (p.knocks < 1) throw new GameError('Out of knocks. The street is quiet... come back later.', 429);
    checkGesture(p, gesture);

    p.knocks -= 1;
    p.totalKnocks += 1;
    p.xp += 1;
    p.nightKnocks += 1;
    const nf = nightfallLevel(p);
    const st = stats(p);
    const mood = houseMood(house.id);
    const weights = buildOdds(season, { houseType: house.type, mood, nightfall: nf, luck: st.luck - 1, sneak: st.sneak - 1 });

    let outcome = p.totalKnocks <= TUTORIAL.length ? TUTORIAL[p.totalKnocks - 1] : null;
    let pityTriggered = false;
    if (!outcome) {
      if (p.pity + 1 >= season.pity.rareOrBetterWithin) {
        outcome = rollOutcome({ ...zero(), rare: weights.rare, legendary: weights.legendary }, rng);
        pityTriggered = true;
      } else {
        outcome = rollOutcome(weights, rng);
      }
    }

    // Shielded and brand-new players can't be ambushed; the monster just pulls a prank.
    if (outcome === 'ambush' && (now() < p.shieldUntil || p.totalKnocks <= NEW_PLAYER_GRACE)) outcome = 'trick';
    let monster = null;
    if (outcome === 'ambush') {
      monster = chooseMonster(p);
      if (!monster) outcome = 'trick';
    }
    if (outcome === 'legendary' && p.trust < season.trust.legendaryMinTrust) outcome = 'rare';

    p.pity = RARE_OR_BETTER.has(outcome) ? 0 : p.pity + 1;

    // Bookkeeping for missions / leaderboards.
    const prog = p.daily.progress;
    prog.knocks += 1;
    if (!prog.typesVisited.includes(house.type)) prog.typesVisited.push(house.type);
    const isHot = hotHouse() === house.id;
    if (isHot) prog.hotVisits += 1;
    const route = dailyRoute();
    if (route.includes(house.id) && !p.daily.routeVisited.includes(house.id)) {
      p.daily.routeVisited.push(house.id);
      if (p.daily.routeVisited.length === route.length) prog.routeDone = 1;
    }
    if (!p.season.uniqueHouses.includes(house.id)) p.season.uniqueHouses.push(house.id);

    const valueMult = (1 + nf * season.nightfall.candyBonusPerLevel) * (isHot ? 2 : 1);
    const result = resolveOutcome(p, house, outcome, { valueMult, monster, pityTriggered, mood });
    result.nightfall = nightfallLevel(p);
    result.hot = isHot;
    p.lastEvent = result;
    if (result.outcome !== 'scare' && result.outcome !== 'ambush') {
      logHouse(house, p, outcome, result.detail);
      trackResult(p, REWARD_OUTCOMES.has(outcome));
    }
    onChange();
    return { result, player: playerView(p) };
  }

  function zero() {
    return Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  }

  function nightfallLevel(p) {
    return Math.min(season.nightfall.maxLevel, Math.floor(p.nightKnocks / season.nightfall.knocksPerLevel));
  }

  function chooseMonster(p) {
    const cd = season.ambush.sameMonsterCooldownHours * HOUR;
    const ok = season.monsters.filter((m) => now() - (p.monsterHits[m.id] || 0) >= cd);
    return ok.length ? pick(rng, ok) : null;
  }

  function resolveOutcome(p, house, outcome, { valueMult, monster, pityTriggered }) {
    const R = season.rewards;
    const flavor = (k) => pick(rng, season.flavor[k]);
    const res = { outcome, houseId: house.id, houseName: house.name, pity: pityTriggered, detail: {} };

    if (outcome === 'candy') {
      // First knock: guaranteed small reward plus a laugh.
      const msg = p.totalKnocks === 1 ? 'A dog barks, your hat falls off... but you got candy!' : flavor('candy');
      const { gained, spilled } = earn(p, randInt(rng, R.candy) * valueMult);
      Object.assign(res, { text: msg, candy: gained, spilled });
    } else if (outcome === 'rare') {
      const typeMult = season.houseTypes[house.type].rareValueMultiplier || 1;
      const base = randInt(rng, R.candy) * R.rareMultiplier * typeMult;
      const { gained, spilled } = earn(p, base * valueMult);
      Object.assign(res, { text: flavor('rare'), candy: gained, spilled });
    } else if (outcome === 'shard') {
      const shard = pick(rng, season.shards);
      p.shards[shard] = (p.shards[shard] || 0) + 1;
      Object.assign(res, { text: flavor('shard'), shard });
      if (season.shards.every((s) => p.shards[s] > 0)) {
        for (const s of season.shards) p.shards[s] -= 1;
        addStash(p, R.shardSetBonus);
        p.trophies.push('Full Moon Set');
        res.setComplete = { trophy: 'Full Moon Set', candy: R.shardSetBonus };
        pushFeed('set', `${p.name} completed the Full Moon shard set!`);
      }
    } else if (outcome === 'legendary') {
      const g = state.global;
      const jackpot = rng() < R.jackpotShareOfLegendary && g.jackpotsToday < R.jackpotGlobalDailyLimit;
      if (jackpot) {
        g.jackpotsToday += 1;
        p.trophies.push(season.jackpotTrophy);
        p.season.jackpots += 1;
        const { gained, spilled } = earn(p, R.jackpotCandy);
        Object.assign(res, { text: flavor('jackpot'), candy: gained, spilled, trophy: season.jackpotTrophy });
        res.detail.jackpot = true;
        pushFeed('jackpot', `🎃 JACKPOT! ${p.name} found the Golden Pumpkin at #${house.id} ${house.name}!`, { houseId: house.id });
      } else if (rng() < 0.5) {
        const trophy = pick(rng, season.trophies);
        p.trophies.push(trophy);
        const { gained, spilled } = earn(p, R.legendaryTrophyCandy);
        Object.assign(res, { text: flavor('legendary'), candy: gained, spilled, trophy });
        pushFeed('legendary', `${p.name} found a ${trophy} at #${house.id} ${house.name}!`, { houseId: house.id });
      } else {
        const { gained, spilled } = earn(p, randInt(rng, R.legendaryCandy) * valueMult);
        Object.assign(res, { text: flavor('legendary'), candy: gained, spilled });
        pushFeed('legendary', `${p.name} hauled ${gained} candy out of #${house.id} ${house.name}!`, { houseId: house.id });
      }
    } else if (outcome === 'trick') {
      const lost = lose(p, randInt(rng, R.trickLoss));
      Object.assign(res, { text: flavor('trick'), candy: -lost });
    } else if (outcome === 'scare') {
      const sc = season.scare;
      const id = crypto.randomBytes(8).toString('hex');
      const delayMs = randInt(rng, [sc.minDelayMs, sc.maxDelayMs]);
      const windowMs = sc.baseWindowMs + sc.windowPerCourageMs * stats(p).courage;
      p.pending = { type: 'scare', id, houseId: house.id, issuedAt: now(), delayMs, windowMs };
      Object.assign(res, { text: flavor('scare'), scare: { id, delayMs, windowMs } });
    } else if (outcome === 'ambush') {
      const id = crypto.randomBytes(8).toString('hex');
      p.pending = { type: 'ambush', id, houseId: house.id, issuedAt: now(), monster: monster.id };
      Object.assign(res, {
        text: flavor('ambush'),
        ambush: { id, clue: monster.clue, monsterName: monster.name, counters: season.counters },
      });
    }
    return res;
  }

  // Auto-fail pending mini-games that were abandoned.
  function expirePending(p) {
    const pend = p.pending;
    if (!pend) return;
    const limit = pend.type === 'scare' ? season.scare.expireMs : season.ambush.expireMs;
    if (now() - pend.issuedAt > limit) {
      if (pend.type === 'scare') finishScare(p, false, 'You froze and ran away.');
      else finishAmbush(p, null);
    }
  }

  // ----- scare mini-game -----

  // The server owns the clock: reaction = time since the signal it scheduled.
  function resolveScare(token, id) {
    const p = playerByToken(token);
    const pend = p.pending;
    if (!pend || pend.type !== 'scare' || pend.id !== id) throw new GameError('No scare in progress', 409);
    const reaction = now() - pend.issuedAt - pend.delayMs;
    let won;
    let why;
    if (reaction < season.scare.minHumanMs) {
      won = false;
      why = reaction < 0 ? 'You flinched too early!' : 'Too fast to be human...';
    } else if (reaction > pend.windowMs) {
      won = false;
      why = 'Too slow! It got you.';
    } else {
      won = true;
      why = `Dodged in ${reaction}ms!`;
    }
    const result = finishScare(p, won, why, reaction);
    onChange();
    return { result, player: playerView(p) };
  }

  function finishScare(p, won, why, reaction = null) {
    const house = state.houses[p.pending.houseId];
    p.pending = null;
    const R = season.rewards;
    const res = { outcome: 'scare', houseId: house.id, houseName: house.name, won, text: why, reaction };
    if (!won && p.items.candle > 0) {
      p.items.candle -= 1;
      won = true;
      res.won = true;
      res.text = `${why} ...but your Lucky Candle flared and saved you!`;
    }
    if (won) {
      p.daily.progress.scaresWon += 1;
      p.season.scaresSurvived += 1;
      const typeMult = season.houseTypes[house.type].rareValueMultiplier || 1;
      const { gained, spilled } = earn(p, randInt(rng, R.candy) * R.rareMultiplier * typeMult * 0.6);
      Object.assign(res, { candy: gained, spilled, reward: 'rare' });
    } else {
      res.candy = -lose(p, randInt(rng, R.scareLoss));
    }
    logHouse(house, p, 'scare', { won });
    trackResult(p, won);
    p.lastEvent = res;
    return res;
  }

  // ----- ambush mini-game -----

  function ambushChance(p, monster, counter) {
    const a = season.ambush;
    let chance = a.baseSuccess;
    if (counter === monster.counter) chance += a.rightCounter;
    else if (counter) chance += a.wrongCounter;
    if (season.costumes[p.costume]?.counters === monster.id) chance += a.costumeCounter;
    chance += a.perSneak * stats(p).sneak;
    return clamp(chance, a.min, a.max);
  }

  function resolveAmbush(token, id, counter) {
    const p = playerByToken(token);
    const pend = p.pending;
    if (!pend || pend.type !== 'ambush' || pend.id !== id) throw new GameError('No ambush in progress', 409);
    if (!season.counters[counter]) throw new GameError('Unknown item');
    const result = finishAmbush(p, counter);
    onChange();
    return { result, player: playerView(p) };
  }

  function finishAmbush(p, counter) {
    const a = season.ambush;
    const house = state.houses[p.pending.houseId];
    const monster = season.monsters.find((m) => m.id === p.pending.monster);
    p.pending = null;
    const chance = ambushChance(p, monster, counter);
    const stolen = rng() < chance;
    const res = {
      outcome: 'ambush', houseId: house.id, houseName: house.name, counter,
      monster: { name: monster.name, type: monster.type, counter: monster.counter },
      chance: Math.round(chance * 100), won: !stolen,
    };
    if (stolen) {
      const take = lose(p, Math.ceil(p.bag * a.stealShare));
      p.shieldUntil = now() + a.shieldMinutes * MINUTE;
      p.monsterHits[monster.id] = now();
      Object.assign(res, {
        candy: -take,
        text: counter
          ? `${monster.name} the ${monster.type} shrugged off your ${season.counters[counter].name} and swiped ${take} candy!`
          : `You ran. ${monster.name} the ${monster.type} swiped ${take} candy.`,
        shieldMinutes: a.shieldMinutes,
      });
      if (take >= 10) pushFeed('steal', `${monster.name} the ${monster.type} stole ${take} candy from ${p.name} near #${house.id}.`, { houseId: house.id });
    } else {
      p.daily.progress.ambushesWon += 1;
      p.season.ambushesWon += 1;
      const { gained, spilled } = earn(p, randInt(rng, season.rewards.ambushDefendCandy));
      Object.assign(res, {
        candy: gained, spilled,
        text: `Your ${season.counters[counter].name} sent ${monster.name} the ${monster.type} running! It dropped ${gained} candy.`,
      });
    }
    logHouse(house, p, 'ambush', { won: !stolen });
    trackResult(p, !stolen);
    p.lastEvent = res;
    return res;
  }

  // Scared too many times? A free item keeps new players in the game.
  function trackResult(p, good) {
    p.recentResults.push(good ? 1 : 0);
    p.recentResults = p.recentResults.slice(-season.comfort.lossesInLast);
    const losses = p.recentResults.filter((x) => !x).length;
    if (losses >= season.comfort.lossThreshold && p.items.candle === 0) {
      p.items.candle += 1;
      p.recentResults = [];
      p.gift = 'Rough night? Here is a free Lucky Candle. It saves you from your next lost scare.';
    }
  }

  // ----- banking / shop -----

  function bank(token) {
    const p = playerByToken(token);
    if (p.pending) throw new GameError(`Finish the ${p.pending.type} first!`, 409);
    const room = p.stashCapacity - p.stash;
    const moved = Math.min(room, p.bag);
    p.bag -= moved;
    p.stash += moved;
    p.daily.progress.banked += moved;
    p.nightKnocks = 0;
    onChange();
    return { banked: moved, stashFull: p.bag > 0, player: playerView(p) };
  }

  function buy(token, kind, itemId) {
    const p = playerByToken(token);
    if (kind === 'costume') {
      const c = season.costumes[itemId];
      if (!c) throw new GameError('No such costume', 404);
      if (p.ownedCostumes.includes(itemId)) throw new GameError('Already owned');
      spend(p, c.price);
      p.ownedCostumes.push(itemId);
      p.costume = itemId;
    } else if (kind === 'upgrade') {
      const u = season.upgrades[itemId];
      if (!u) throw new GameError('No such upgrade', 404);
      if (itemId === 'knocks' && p.knocks >= season.energy.hardCap) throw new GameError('Your knuckles are full of energy already');
      spend(p, u.price);
      if (itemId === 'bag') p.bagCapacity += u.amount;
      if (itemId === 'stash') p.stashCapacity += u.amount;
      if (itemId === 'knocks') p.knocks = Math.min(season.energy.hardCap, p.knocks + u.amount);
    } else {
      throw new GameError('Unknown purchase');
    }
    onChange();
    return { player: playerView(p) };
  }

  function equip(token, costumeId) {
    const p = playerByToken(token);
    if (!p.ownedCostumes.includes(costumeId)) throw new GameError('You do not own that costume');
    p.costume = costumeId;
    onChange();
    return { player: playerView(p) };
  }

  function claimMission(token, missionId) {
    const p = playerByToken(token);
    const m = season.missions.find((x) => x.id === missionId);
    if (!m || !p.daily.missions.includes(missionId)) throw new GameError('Not one of today\'s missions', 404);
    if (p.daily.claimed.includes(missionId)) throw new GameError('Already claimed');
    if (missionProgress(p, m) < m.goal) throw new GameError('Not done yet');
    p.daily.claimed.push(missionId);
    addStash(p, m.reward.candy);
    p.knocks = Math.min(season.energy.hardCap, p.knocks + (m.reward.knocks || 0));
    onChange();
    return { reward: m.reward, player: playerView(p) };
  }

  function missionProgress(p, m) {
    const v = p.daily.progress[m.stat];
    return Array.isArray(v) ? v.length : v;
  }

  // ----- views -----

  function playerView(p) {
    const gift = p.gift;
    delete p.gift;
    const nextRegenMs = p.knocks >= season.energy.regenCap
      ? null
      : season.energy.regenMinutes * MINUTE - (now() - p.knocksUpdatedAt);
    const streakDays = Math.min(p.streak.count + 1, season.streak.maxDays);
    return {
      id: p.id,
      name: p.name,
      level: level(p),
      costume: p.costume,
      ownedCostumes: p.ownedCostumes,
      stats: stats(p),
      bag: p.bag,
      bagCapacity: p.bagCapacity,
      stash: p.stash,
      stashCapacity: p.stashCapacity,
      knocks: p.knocks,
      nextRegenMs,
      totalKnocks: p.totalKnocks,
      pity: p.pity,
      pityLimit: season.pity.rareOrBetterWithin,
      nightfall: nightfallLevel(p),
      nightKnocks: p.nightKnocks,
      trust: p.trust,
      shieldMs: Math.max(0, p.shieldUntil - now()),
      items: p.items,
      shards: p.shards,
      trophies: p.trophies,
      pending: p.pending && pendingView(p.pending),
      streak: p.streak.count,
      streakBonusToday: p.daily.streakBonus,
      streakBonusTomorrow: season.streak.baseBonus + season.streak.perDay * (streakDays - 1),
      missions: p.daily.missions.map((id) => {
        const m = season.missions.find((x) => x.id === id);
        return { id, text: m.text, goal: m.goal, progress: Math.min(m.goal, missionProgress(p, m)), reward: m.reward, claimed: p.daily.claimed.includes(id) };
      }),
      routeVisited: p.daily.routeVisited,
      seasonStats: { earned: p.season.earned, housesVisited: p.season.uniqueHouses.length, scaresSurvived: p.season.scaresSurvived, ambushesWon: p.season.ambushesWon, jackpots: p.season.jackpots },
      gift,
    };
  }

  function pendingView(pend) {
    if (pend.type === 'scare') {
      const elapsed = now() - pend.issuedAt;
      return { type: 'scare', id: pend.id, delayMs: Math.max(0, pend.delayMs - elapsed), windowMs: pend.windowMs };
    }
    const m = season.monsters.find((x) => x.id === pend.monster);
    return { type: 'ambush', id: pend.id, clue: m.clue, monsterName: m.name, counters: season.counters };
  }

  function worldView() {
    rollDayGlobal();
    return {
      season: { id: season.id, name: season.name, neighborhood: season.neighborhood },
      day: today(),
      hotHouse: hotHouse(),
      route: dailyRoute(),
      houses: Object.values(state.houses).map((h) => houseView(h)),
      nightfallNames: season.nightfall.names,
      jackpotsLeftToday: season.rewards.jackpotGlobalDailyLimit - state.global.jackpotsToday,
    };
  }

  function catalog() {
    const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith('_')));
    return {
      costumes: season.costumes,
      upgrades: season.upgrades,
      counters: season.counters,
      monsters: season.monsters.map(({ id, name, type, counter }) => ({ id, name, type, counter })),
      shards: season.shards,
      odds: strip(season.odds),
      houseTypes: season.houseTypes,
    };
  }

  function house(id) {
    const h = state.houses[id];
    if (!h) throw new GameError('No such house', 404);
    return houseView(h, { withLog: true });
  }

  function leaderboards() {
    const players = Object.values(state.players);
    const top = (fn) => players
      .map((p) => ({ name: p.name, level: level(p), costume: p.costume, value: fn(p) }))
      .filter((x) => x.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
    return {
      candy: top((p) => p.season.earned),
      houses: top((p) => p.season.uniqueHouses.length),
      scares: top((p) => p.season.scaresSurvived),
      notoriousHouses: Object.values(state.houses)
        .map((h) => ({ id: h.id, name: h.name, icon: season.houseTypes[h.type].icon, scares: h.totals.scares + h.totals.ambushes, reputation: reputation(h) }))
        .filter((h) => h.scares > 0)
        .sort((a, b) => b.scares - a.scares)
        .slice(0, 5),
    };
  }

  function feed() {
    return state.feed.slice(0, 30);
  }

  function login(name) {
    const { player, token } = newPlayer(name);
    return { token, player: playerView(player) };
  }

  function me(token) {
    const p = playerByToken(token);
    return { player: playerView(p), lastEvent: p.lastEvent };
  }

  return {
    login, me, knock, resolveScare, resolveAmbush, bank, buy, equip, claimMission,
    worldView, house, leaderboards, feed, catalog,
    // exposed for tests / admin tooling
    _internal: { houseMood, houseTell, hotHouse, dailyRoute, reputation, ambushChance, playerByToken, state },
  };
}
