import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGame, buildOdds, rollOutcome, OUTCOMES } from '../server/game.js';

const season = JSON.parse(fs.readFileSync(new URL('../season/halloween-2026.json', import.meta.url)));

// Deterministic PRNG (mulberry32).
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup({ seed = 1, start = Date.parse('2026-10-08T18:00:00Z') } = {}) {
  let t = start;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const game = createGame({ season, state: {}, now: clock.now, rng: prng(seed) });
  return { game, clock };
}

// Knock with a human-ish varied cadence and resolve any mini-games.
function knockAndResolve(game, clock, token, houseId, { scare = 'win', counter } = {}) {
  clock.advance(900 + Math.floor(Math.random() * 600));
  const r = game.knock(token, houseId, { holdMs: 120 });
  const res = r.result;
  if (res.scare) {
    clock.advance(res.scare.delayMs + (scare === 'win' ? 300 : 5000));
    return game.resolveScare(token, res.scare.id).result;
  }
  if (res.ambush) {
    const monster = season.monsters.find((m) => m.name === res.ambush.monsterName);
    return game.resolveAmbush(token, res.ambush.id, counter ?? monster.counter).result;
  }
  return res;
}

test('baseline odds match the design doc: 64% pay out, 36% trick/scare/ambush', () => {
  const w = buildOdds(season, { houseType: 'normal', mood: 'balanced' });
  const total = OUTCOMES.reduce((s, o) => s + w[o], 0);
  assert.equal(total, 100);
  assert.equal(w.candy + w.rare + w.shard + w.legendary, 64);
  assert.equal(w.trick + w.scare + w.ambush, 36);
});

test('modifiers shift the table within protocol caps', () => {
  const w = buildOdds(season, { houseType: 'witch', mood: 'spooky', nightfall: 3 });
  for (const o of OUTCOMES) {
    assert.ok(Math.abs(w[o] - season.odds[o]) <= season.caps.maxShiftPerOutcome, `${o} shifted too far`);
  }
  assert.ok(w.candy >= season.caps.minCandyWeight);
});

test('rollOutcome follows weights over many rolls', () => {
  const rng = prng(42);
  const w = buildOdds(season, { houseType: 'normal', mood: 'balanced' });
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  const n = 50_000;
  for (let i = 0; i < n; i++) counts[rollOutcome(w, rng)] += 1;
  for (const o of OUTCOMES) assert.ok(Math.abs(counts[o] / n - w[o] / 100) < 0.01, o);
});

test('new players get a character, daily knocks, a streak bonus and 3 missions', () => {
  const { game } = setup();
  const { token, player } = game.login('Pumpkin');
  assert.ok(token);
  assert.equal(player.name, 'Pumpkin');
  assert.equal(player.knocks, season.energy.dailyFree);
  assert.equal(player.stash, season.streak.baseBonus);
  assert.equal(player.missions.length, 3);
});

test('tutorial: first knock is candy, second a trick, fifth a scare', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  const outcomes = [];
  for (let i = 0; i < 5; i++) {
    clock.advance(1000 + i * 37);
    const { result } = game.knock(token, 1, { holdMs: 100 });
    outcomes.push(result.outcome);
    if (result.scare) {
      clock.advance(result.scare.delayMs + 250);
      assert.equal(game.resolveScare(token, result.scare.id).result.won, true);
    }
  }
  assert.equal(outcomes[0], 'candy');
  assert.equal(outcomes[1], 'trick');
  assert.equal(outcomes[2], 'candy');
  assert.equal(outcomes[4], 'scare');
});

test('knocks spend energy and run out', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  for (let i = 0; i < season.energy.dailyFree; i++) knockAndResolve(game, clock, token, (i % 30) + 1);
  // regen may have added a few while knocking; drain them too
  let p = game.me(token).player;
  while (p.knocks > 0) {
    knockAndResolve(game, clock, token, 1);
    p = game.me(token).player;
  }
  clock.advance(1000);
  assert.throws(() => game.knock(token, 1, { holdMs: 100 }), /Out of knocks/);
});

test('knocks regenerate over time and refill daily', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  for (let i = 0; i < 10; i++) knockAndResolve(game, clock, token, 1);
  const before = game.me(token).player.knocks;
  clock.advance(season.energy.regenMinutes * 60_000 * 2);
  assert.equal(game.me(token).player.knocks, Math.min(season.energy.regenCap, before + 2));
});

test('pity timer guarantees rare-or-better within the limit', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { game, clock } = setup({ seed });
    const { token } = game.login('Unlucky');
    let since = 0;
    for (let i = 0; i < 120; i++) {
      // keep the player stocked with knocks
      game._internal.playerByToken(token).knocks = 40;
      const r = knockAndResolve(game, clock, token, 2);
      if (r.outcome === 'rare' || r.outcome === 'legendary') since = 0;
      else since += 1;
      assert.ok(since < season.pity.rareOrBetterWithin, `seed ${seed}: ${since} knocks without rare`);
    }
  }
});

test('scare: tapping early or late fails, inside the window wins', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  const p = game._internal.playerByToken(token);
  const scareAt = () => {
    for (;;) {
      p.knocks = 40;
      p.items.candle = 0; // the comfort candle would rescue failed scares
      clock.advance(1100);
      const { result } = game.knock(token, 4, { holdMs: 90 });
      if (result.scare) return result.scare;
      if (result.ambush) game.resolveAmbush(token, result.ambush.id, 'salt');
    }
  };
  let s = scareAt();
  clock.advance(s.delayMs - 200);
  assert.equal(game.resolveScare(token, s.id).result.won, false);

  s = scareAt();
  clock.advance(s.delayMs + 20);
  assert.equal(game.resolveScare(token, s.id).result.won, false, 'too fast to be human');

  s = scareAt();
  clock.advance(s.delayMs + s.windowMs + 100);
  assert.equal(game.resolveScare(token, s.id).result.won, false);

  s = scareAt();
  clock.advance(s.delayMs + 300);
  assert.equal(game.resolveScare(token, s.id).result.won, true);
});

test('cannot knock while a mini-game is pending', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  for (let i = 0; i < 4; i++) knockAndResolve(game, clock, token, 1);
  clock.advance(1000);
  const { result } = game.knock(token, 1, { holdMs: 100 });
  assert.equal(result.outcome, 'scare');
  clock.advance(1000);
  assert.throws(() => game.knock(token, 1, { holdMs: 100 }), /Finish the scare/);
});

test('ambush: matchup drives chance, steals at most 10% of the bag, never the stash, then shields', () => {
  const { game, clock } = setup({ seed: 7 });
  const { token } = game.login('Kid');
  const p = game._internal.playerByToken(token);
  const ghost = season.monsters.find((m) => m.id === 'ghost');
  assert.equal(game._internal.ambushChance(p, ghost, 'salt'), 0.5 - 0.15 - 0.02);
  assert.equal(game._internal.ambushChance(p, ghost, 'garlic'), 0.5 + 0.05 - 0.02);
  p.costume = 'witch'; // counters ghost
  assert.ok(Math.abs(game._internal.ambushChance(p, ghost, 'salt') - (0.5 - 0.15 - 0.1 - 0.02)) < 1e-9);
  p.costume = 'sheet';

  // Force ambushes until one steals.
  for (let i = 0; i < 200; i++) {
    p.knocks = 40;
    p.bag = 100;
    p.stash = 500;
    p.shieldUntil = 0;
    p.monsterHits = {};
    p.pity = 0;
    clock.advance(1000 + (i % 7) * 50);
    p.pending = { type: 'ambush', id: 'x' + i, houseId: 8, issuedAt: clock.now(), monster: 'ghost' };
    const r = game.resolveAmbush(token, 'x' + i, 'garlic').result;
    if (!r.won) {
      assert.equal(r.candy, -10);
      assert.equal(p.stash, 500);
      assert.ok(game.me(token).player.shieldMs > 0);
      return;
    }
  }
  assert.fail('monster never succeeded');
});

test('shielded players are never ambushed', () => {
  const { game, clock } = setup({ seed: 3 });
  const { token } = game.login('Kid');
  const p = game._internal.playerByToken(token);
  for (let i = 0; i < 300; i++) {
    p.knocks = 40;
    p.shieldUntil = clock.now() + 3600_000;
    const r = knockAndResolve(game, clock, token, 8);
    assert.notEqual(r.outcome, 'ambush');
  }
});

test('banking moves the bag to the stash and resets Nightfall', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  for (let i = 0; i < 20; i++) {
    game._internal.playerByToken(token).knocks = 40;
    knockAndResolve(game, clock, token, 1);
  }
  const before = game.me(token).player;
  assert.ok(before.nightfall >= 1);
  const { banked, player } = game.bank(token);
  assert.equal(banked, before.bag);
  assert.equal(player.bag, 0);
  assert.equal(player.stash, before.stash + before.bag);
  assert.equal(player.nightfall, 0);
});

test('bag capacity spills extra candy', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  const p = game._internal.playerByToken(token);
  p.bag = p.bagCapacity;
  clock.advance(1000);
  const { result } = game.knock(token, 1, { holdMs: 100 });
  assert.equal(result.candy, 0);
  assert.ok(result.spilled > 0);
});

test('shop: buying a costume spends candy and changes stats', () => {
  const { game } = setup();
  const { token } = game.login('Kid');
  assert.throws(() => game.buy(token, 'costume', 'skeleton'), /Not enough candy/);
  const p = game._internal.playerByToken(token);
  p.stash = 200;
  const { player } = game.buy(token, 'costume', 'vampire');
  assert.equal(player.stash, 50);
  assert.equal(player.costume, 'vampire');
  assert.equal(player.stats.courage, 3);
  assert.throws(() => game.buy(token, 'costume', 'vampire'), /Already owned/);
  assert.equal(game.equip(token, 'sheet').player.costume, 'sheet');
});

test('anti-bot: rapid knocks are rejected and robotic cadence lowers trust', () => {
  const { game, clock } = setup();
  const { token } = game.login('Bot');
  clock.advance(1000);
  game.knock(token, 1, { holdMs: 100 });
  clock.advance(50);
  assert.throws(() => game.knock(token, 1, { holdMs: 100 }), /Slow down/);
  assert.throws(() => (clock.advance(1000), game.knock(token, 1, {})), /gesture/);

  const p = game._internal.playerByToken(token);
  const start = p.trust;
  for (let i = 0; i < 25; i++) {
    p.knocks = 40;
    p.pending = null;
    clock.advance(1000); // perfectly regular
    game.knock(token, 1, { holdMs: 100 });
  }
  assert.ok(p.trust < start, `trust ${p.trust} should fall below ${start}`);
});

test('missions can be claimed once complete', () => {
  const { game, clock } = setup();
  const { token } = game.login('Kid');
  const p = game._internal.playerByToken(token);
  const id = p.daily.missions[0];
  assert.throws(() => game.claimMission(token, id), /Not done/);
  const m = season.missions.find((x) => x.id === id);
  p.daily.progress[m.stat] = Array.isArray(p.daily.progress[m.stat]) ? ['a', 'b', 'c'] : m.goal;
  const stash = p.stash;
  const { player } = game.claimMission(token, id);
  assert.equal(player.stash, stash + m.reward.candy);
  assert.throws(() => game.claimMission(token, id), /Already claimed/);
  clock.advance(0);
});

test('streaks continue across days with one grace day per week', () => {
  const { game, clock } = setup({ start: Date.parse('2026-10-05T12:00:00Z') }); // Monday
  const { token } = game.login('Kid');
  clock.advance(86_400_000);
  assert.equal(game.me(token).player.streak, 2);
  clock.advance(2 * 86_400_000); // skipped a day: grace
  assert.equal(game.me(token).player.streak, 3);
  clock.advance(2 * 86_400_000); // skipped again in the same week: reset
  assert.equal(game.me(token).player.streak, 1);
});

test('daily rotation: hot house, route and tells are stable within a day', () => {
  const { game, clock } = setup();
  const w1 = game.worldView();
  clock.advance(3600_000);
  const w2 = game.worldView();
  assert.equal(w1.hotHouse, w2.hotHouse);
  assert.deepEqual(w1.route, w2.route);
  assert.equal(w1.route.length, season.houses.routeLength);
  assert.deepEqual(w1.houses.map((h) => h.tell), w2.houses.map((h) => h.tell));
  assert.equal(w1.houses.length, 30);
});

test('tells are honest most of the time', () => {
  const { game } = setup();
  const { houseMood, houseTell } = game._internal;
  let honest = 0;
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    const day = `2026-10-${String(d).padStart(2, '0')}`;
    for (let h = 1; h <= 30; h++) {
      const tell = houseTell(h, day);
      if (season.moods.list[houseMood(h, day)].tells.includes(tell)) honest += 1;
      n += 1;
    }
  }
  assert.ok(honest / n > 0.7, `only ${honest / n} honest`);
});

test('house reputation reacts to payouts and is capped per visitor', () => {
  const { game, clock } = setup();
  const h = game._internal.state.houses[1];
  assert.equal(game._internal.reputation(h), 50);
  // One visitor spamming good results cannot max the reputation alone.
  h.visitors.spammer = { events: Array.from({ length: 20 }, () => ({ at: clock.now(), good: 1, w: 0.8, jackpot: 0 })) };
  const solo = game._internal.reputation(h);
  for (let i = 0; i < 10; i++) {
    h.visitors['v' + i] = { events: Array.from({ length: 3 }, () => ({ at: clock.now(), good: 1, w: 0.8, jackpot: 0 })) };
  }
  const many = game._internal.reputation(h);
  assert.ok(solo < many, `${solo} < ${many}`);
  assert.ok(many > 70);
  for (let i = 0; i < 10; i++) {
    h.visitors['b' + i] = { events: Array.from({ length: 3 }, () => ({ at: clock.now(), good: 0, w: 0.8, jackpot: 0 })) };
  }
  assert.ok(game._internal.reputation(h) < many);
});

test('jackpots are rate-limited globally per day', () => {
  const { game, clock } = setup({ seed: 11 });
  const st = game._internal.state;
  let jackpots = 0;
  for (let k = 0; k < 40; k++) {
    const { token } = game.login('K' + k);
    const p = game._internal.playerByToken(token);
    p.totalKnocks = 10;
    p.trust = 80;
    for (let i = 0; i < 200; i++) {
      p.knocks = 40;
      p.daily.candyEarned = 0;
      const r = knockAndResolve(game, clock, token, 16);
      if (r.trophy === season.jackpotTrophy) jackpots += 1;
      if (i % 20 === 0) game.bank(token);
    }
    if (st.global.day !== '2026-10-08') break;
  }
  assert.ok(jackpots <= season.rewards.jackpotGlobalDailyLimit * 2, `${jackpots} jackpots`);
});

test('leaderboards and feed report activity', () => {
  const { game, clock } = setup();
  const { token } = game.login('Leader');
  for (let i = 0; i < 6; i++) knockAndResolve(game, clock, token, i + 1);
  const lb = game.leaderboards();
  assert.equal(lb.candy[0].name, 'Leader');
  assert.equal(lb.houses[0].value, 6);
  const house = game.house(1);
  assert.equal(house.log[0].player, 'Leader');
  assert.ok(Array.isArray(game.feed()));
});
