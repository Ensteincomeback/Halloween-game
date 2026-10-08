// Shared game context: helpers, players, energy, candy movement, trust, feed.

import crypto from 'node:crypto';

export const HOUR = 3600_000;
export const MINUTE = 60_000;
export const DAY = 24 * HOUR;

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function hashInt(...parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}
export const seeded = (...parts) => hashInt(...parts) / 0x1_0000_0000;
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function installCore(ctx) {
  const { season, state, rng } = ctx;
  const now = () => ctx.now();

  state.players ??= {};
  state.tokens ??= {};
  state.wallets ??= {};
  state.feed ??= [];
  state.global ??= { day: null, jackpotsToday: 0 };
  state.economy ??= { candyIn: {}, candyOut: {}, booBurned: 0 };
  state.signups ??= {};

  ctx.randInt = (range) => range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
  ctx.pick = (list) => list[Math.floor(rng() * list.length)];
  ctx.today = () => dayKey(now());

  // ---------- economy telemetry: every faucet and sink is counted ----------
  ctx.track = (dir, source, n) => {
    if (!n) return;
    const book = dir === 'in' ? state.economy.candyIn : state.economy.candyOut;
    book[source] = (book[source] || 0) + n;
  };

  // ---------- feed + inbox ----------
  ctx.pushFeed = (kind, text, extra = {}) => {
    state.feed.unshift({ at: now(), kind, text, ...extra });
    state.feed.length = Math.min(state.feed.length, 100);
  };
  ctx.notify = (p, text, extra = {}) => {
    p.inbox.unshift({ at: now(), text, ...extra });
    p.inbox.length = Math.min(p.inbox.length, 30);
  };

  // ---------- players ----------
  function newSeasonStats() {
    return {
      earned: 0, uniqueHouses: [], scaresSurvived: 0, ambushesWon: 0, jackpots: 0, legendaries: 0,
      biggestReward: null, scaredPlayers: 0, stolen: 0, monsterFails: 0,
    };
  }

  ctx.seasonStats = (p) => (p.seasons[season.id] ??= newSeasonStats());

  ctx.newPlayer = (name, ip = '') => {
    const ipHash = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16);
    const hourKey = `${ipHash}:${Math.floor(now() / HOUR)}`;
    if ((state.signups[hourKey] || 0) >= season.trust.accountsPerIpPerHour) {
      throw new GameError('Too many new characters from your network. Try again later.', 429);
    }
    state.signups[hourKey] = (state.signups[hourKey] || 0) + 1;

    const id = crypto.randomBytes(6).toString('hex');
    const token = crypto.randomBytes(24).toString('hex');
    // Embedded wallet: created silently, shown only once the player finds the deeper economy.
    const wallet = `boo1${crypto.randomBytes(16).toString('hex')}`;
    const p = {
      id, name: String(name || '').trim().slice(0, 20) || `Kid-${id.slice(0, 4)}`,
      createdAt: now(), ipHash, wallet,
      costume: 'sheet', ownedCostumes: ['sheet'],
      bag: 0, stash: 0, bagCapacity: season.player.bagCapacity, stashCapacity: season.player.stashCapacity,
      trained: { courage: 0, sneak: 0, luck: 0 },
      knocks: season.energy.dailyFree, knocksUpdatedAt: now(), totalKnocks: 0, pity: 0, nightKnocks: 0,
      trust: season.trust.start, knockTimes: [], lastKnockAt: 0,
      shieldUntil: 0, monsterHits: {}, recentResults: [], items: { candle: 0 }, boosts: { luck: 0, nightvision: 0 },
      cards: {}, trophies: [], pending: null, xp: 0,
      seasons: {}, day: null, daily: null, streak: { count: 0, lastDay: null, graceUsedWeek: null },
      lastEvent: null, discovered: {}, unlocked: [season.neighborhoods[0].id], inbox: [],
      claimable: 0, monster: null, redemptions: {},
      lastPos: ctx.layout ? { ...ctx.layout.spawn, t: now() } : null,
    };
    state.players[id] = p;
    state.tokens[token] = id;
    state.wallets[wallet] = id;
    rollDay(p);
    ctx.changed();
    return { player: p, token };
  };

  ctx.playerByToken = (token) => {
    const id = state.tokens[token];
    const p = id && state.players[id];
    if (!p) throw new GameError('Not logged in', 401);
    ctx.tickWorld();
    rollDay(p);
    regen(p);
    ctx.monsterTick?.(p);
    ctx.expirePending(p);
    return p;
  };

  ctx.playerByWallet = (addr) => state.players[state.wallets[addr]];

  ctx.stats = (p) => {
    const s = { ...season.player.baseStats };
    for (const k of Object.keys(s)) s[k] += p.trained[k] || 0;
    for (const [k, v] of Object.entries(season.costumes[p.costume]?.stats || {})) s[k] += v;
    if (p.boosts.luck > 0) s.luck += season.boosts.lollipop.luck;
    return s;
  };

  ctx.level = (p) => Math.floor(Math.sqrt(p.xp / 10)) + 1;
  ctx.deepEconomy = (p) => ctx.level(p) >= season.player.deepEconomyLevel;

  function regen(p) {
    const { regenMinutes, regenCap } = season.energy;
    const step = regenMinutes * MINUTE;
    if (p.knocks >= regenCap) {
      p.knocksUpdatedAt = now();
      return;
    }
    const gained = Math.floor((now() - p.knocksUpdatedAt) / step);
    if (gained > 0) {
      p.knocks = Math.min(regenCap, p.knocks + gained);
      p.knocksUpdatedAt += gained * step;
    }
  }

  function dailyMissions(pid, d) {
    const pool = [...season.missions];
    pool.sort((a, b) => hashInt(pid, d, a.id) - hashInt(pid, d, b.id));
    return pool.slice(0, season.missionsPerDay).map((m) => m.id);
  }

  function rollDay(p) {
    const d = ctx.today();
    if (p.day === d) return;
    p.day = d;
    p.knocks = Math.max(p.knocks, season.energy.dailyFree);
    p.knocksUpdatedAt = now();
    p.daily = {
      missions: dailyMissions(p.id, d), claimed: [],
      progress: { knocks: 0, scaresWon: 0, banked: 0, typesVisited: [], ambushesWon: 0, hotVisits: 0, earned: 0, routeDone: 0 },
      routeVisited: [], candyEarned: 0, booEarned: 0, raffleTickets: 0,
    };
    updateStreak(p, d);
  }

  function isoWeek(d) {
    const t = new Date(d + 'T00:00:00Z');
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    return `${t.getUTCFullYear()}-${Math.round((t - first) / (7 * DAY))}`;
  }

  // Forgiving streak: one missed day per week is covered by grace.
  function updateStreak(p, d) {
    const s = p.streak;
    if (!s.lastDay) s.count = 1;
    else {
      const gap = Math.round((Date.parse(d) - Date.parse(s.lastDay)) / DAY);
      if (gap === 1) s.count += 1;
      else if (gap === 2 && s.graceUsedWeek !== isoWeek(d)) {
        s.count += 1;
        s.graceUsedWeek = isoWeek(d);
      } else if (gap > 1) s.count = 1;
    }
    s.lastDay = d;
    const days = Math.min(s.count, season.streak.maxDays);
    const bonus = season.streak.baseBonus + season.streak.perDay * (days - 1);
    ctx.addStash(p, bonus, 'streak');
    p.daily.streakBonus = bonus;
  }

  // ---------- candy movement ----------
  ctx.addStash = (p, n, source) => {
    const added = Math.max(0, Math.min(p.stashCapacity - p.stash, n));
    p.stash += added;
    ctx.track('in', source, added);
    return added;
  };

  // Faucet into the bag with diminishing returns and trust scaling.
  ctx.earn = (p, raw, source) => {
    let mult = 1;
    const dc = season.dailyCandy;
    if (p.daily.candyEarned >= dc.hardCap) mult *= dc.hardMultiplier;
    else if (p.daily.candyEarned >= dc.softCap) mult *= dc.softMultiplier;
    if (p.trust < season.trust.lowTrust) mult *= season.trust.lowTrustMultiplier;
    const amount = Math.max(raw > 0 ? 1 : 0, Math.round(raw * mult));
    const gained = Math.min(p.bagCapacity - p.bag, amount);
    p.bag += gained;
    p.daily.candyEarned += gained;
    p.daily.progress.earned += gained;
    ctx.seasonStats(p).earned += gained;
    ctx.track('in', source, gained);
    return { gained, spilled: amount - gained };
  };

  // Candy taken out of a bag (tricks, scares). `sink` false = it moves to someone else.
  ctx.lose = (p, n, source, sink = true) => {
    const lost = Math.min(p.bag, Math.max(0, n));
    p.bag -= lost;
    if (sink) ctx.track('out', source, lost);
    return lost;
  };

  // Spending: stash first, then bag.
  ctx.spend = (p, price, source) => {
    if (p.stash + p.bag < price) throw new GameError('Not enough candy');
    const fromStash = Math.min(p.stash, price);
    p.stash -= fromStash;
    p.bag -= price - fromStash;
    ctx.track('out', source, price);
  };

  // ---------- anti-teleport: actions happen at places in the 3D world ----------
  // The client moves freely, but the server knows where every door and the
  // bank are. Two actions further apart than a running player could cover in
  // the time between them are rejected.
  ctx.checkTravel = (p, to) => {
    const T = season.travel;
    const from = p.lastPos;
    if (!from || !T) return;
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    const reach = (T.maxSpeed * (now() - from.t + T.graceMs)) / 1000;
    if (dist > reach) {
      p.trust = Math.max(0, p.trust - 3);
      throw new GameError("You can't get there that fast. Walk!", 429);
    }
  };
  ctx.arrive = (p, at) => {
    p.lastPos = { x: at.x, z: at.z, t: now() };
  };

  // ---------- anti-bot: the knock gesture ----------
  ctx.checkGesture = (p, gesture) => {
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
    } else if (p.trust < max && rng() < 0.2) p.trust += 1;
  };

  // Scared too many times? A free Lucky Candle keeps new players in the game.
  ctx.trackResult = (p, good) => {
    p.recentResults.push(good ? 1 : 0);
    p.recentResults = p.recentResults.slice(-season.comfort.lossesInLast);
    if (p.recentResults.filter((x) => !x).length >= season.comfort.lossThreshold && p.items.candle === 0) {
      p.items.candle += 1;
      p.recentResults = [];
      p.gift = 'Rough night? Here is a free Lucky Candle. It saves you from your next lost scare.';
    }
  };

  ctx.recordBiggest = (p, amount, label, houseId) => {
    const s = ctx.seasonStats(p);
    if (amount > 0 && (!s.biggestReward || amount > s.biggestReward.amount)) s.biggestReward = { amount, label, houseId };
  };

  ctx.rollDay = rollDay;
  ctx.regen = regen;
}
