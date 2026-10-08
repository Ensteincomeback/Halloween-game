import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, buildOdds, rollOutcome, OUTCOMES } from '../server/game.js';
import { loadSeason } from '../server/config.js';

const SEASON_FILE = new URL('../season/halloween-2026.json', import.meta.url).pathname;
const season = loadSeason(SEASON_FILE);

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

let ipCounter = 0;
function setup({ seed = 1, start = Date.parse('2026-10-08T18:00:00Z'), s = season } = {}) {
  let t = start;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const game = createGame({ season: s, state: {}, now: clock.now, rng: prng(seed) });
  const ctx = game._ctx;
  const login = (name) => {
    const r = game.login(name, `10.0.${ipCounter >> 8}.${ipCounter++ & 255}`);
    return { ...r, p: ctx.state.players[ctx.state.tokens[r.token]] };
  };
  return { game, clock, ctx, login };
}

let jitter = 0;
function knock(env, token, houseId, { scare = 'win', counter } = {}) {
  const { game, clock, ctx } = env;
  clock.advance(900 + ((jitter += 137) % 600));
  const res = game.knock(token, houseId, { holdMs: 120 }).result;
  if (res.scare) {
    clock.advance(res.scare.delayMs + (scare === 'win' ? 300 : 5000));
    return game.resolveScare(token, res.scare.id).result;
  }
  if (res.ambush) {
    const p = ctx.state.players[ctx.state.tokens[token]];
    const pend = p.pending;
    const type = pend.npc ? season.npcMonsters.find((m) => m.id === pend.npc).type : ctx.state.players[ctx.lairById(pend.lairId).monsterId].monster.type;
    return game.resolveAmbush(token, res.ambush.id, counter ?? season.monsterCounters[type]).result;
  }
  return res;
}

const veteran = (p) => {
  p.xp = 2000; // level 15
  p.totalKnocks = 50;
  p.trust = 80;
};

// ---------------- odds ----------------

test('baseline odds: 65% pay out, 35% trick/scare/monster, sums to 100', () => {
  const w = buildOdds(season, { houseType: 'normal', mood: 'balanced' });
  const total = OUTCOMES.reduce((s, o) => s + w[o], 0);
  assert.equal(total, 100);
  assert.equal(w.trick + w.scare + w.ambush, 35);
});

test('every house type, dial and neighborhood stays within protocol caps', () => {
  for (const type of Object.keys(season.houseTypes)) {
    for (const dial of Object.keys(season.houses.dial)) {
      for (const hood of season.neighborhoods) {
        const w = buildOdds(season, { houseType: type, mood: 'spooky', dial, hood, nightfall: 3 });
        for (const o of OUTCOMES) assert.ok(Math.abs(w[o] - season.odds[o]) <= season.caps.maxShiftPerOutcome + 4, `${type}/${dial}/${o}`);
        assert.ok(w.candy >= season.caps.minCandyWeight);
      }
    }
  }
});

test('rollOutcome follows the weights', () => {
  const rng = prng(42);
  const w = buildOdds(season, { houseType: 'normal', mood: 'balanced' });
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  for (let i = 0; i < 60_000; i++) counts[rollOutcome(w, rng)] += 1;
  for (const o of OUTCOMES) assert.ok(Math.abs(counts[o] / 60_000 - w[o] / 100) < 0.01, o);
});

// ---------------- onboarding ----------------

test('new players get a character, knocks, a streak bonus, missions, and a hidden wallet', () => {
  const env = setup();
  const { player } = env.login('Pumpkin');
  assert.equal(player.knocks, season.energy.dailyFree);
  assert.equal(player.stash, season.streak.baseBonus);
  assert.equal(player.missions.length, 3);
  assert.equal(player.wallet, null, 'economy is hidden at first');
  assert.equal(player.deepEconomy, false);
});

test('tutorial: candy, trick, candy, (roll), scare; no ambush in the first knocks', () => {
  const env = setup();
  const { token } = env.login('Kid');
  const out = [];
  for (let i = 0; i < 10; i++) out.push(knock(env, token, 1).outcome);
  assert.deepEqual([out[0], out[1], out[2], out[4]], ['candy', 'trick', 'candy', 'scare']);
  assert.ok(!out.includes('ambush'));
});

test('the deeper economy unlocks at level 3', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  p.xp = 40;
  const me = env.game.me(token).player;
  assert.equal(me.deepEconomy, true);
  assert.match(me.wallet.address, /^boo1/);
});

test('sybil friction: account creation is rate-limited per network', () => {
  const env = setup();
  for (let i = 0; i < season.trust.accountsPerIpPerHour; i++) env.game.login('x', '9.9.9.9');
  assert.throws(() => env.game.login('x', '9.9.9.9'), /Too many/);
});

// ---------------- core loop ----------------

test('pity timer guarantees rare-or-better within the limit', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const env = setup({ seed });
    const { token, p } = env.login('Unlucky');
    let since = 0;
    for (let i = 0; i < 150; i++) {
      p.knocks = 40;
      p.daily.candyEarned = 0;
      const r = knock(env, token, 2);
      if (['rare', 'legendary', 'token', 'secretHouse'].includes(r.outcome)) since = 0;
      else since += 1;
      assert.ok(since < season.pity.rareOrBetterWithin, `seed ${seed}`);
      if (i % 10 === 0) env.game.bank(token);
    }
  }
});

test('scare: early or late fails, in the window wins (server clock)', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  const next = () => {
    for (;;) {
      p.knocks = 40;
      p.items.candle = 0;
      env.clock.advance(1100 + (jitter += 71) % 300);
      const { result } = env.game.knock(token, 4, { holdMs: 90 });
      if (result.scare) return result.scare;
      if (result.ambush) env.game.resolveAmbush(token, result.ambush.id, 'salt');
    }
  };
  let s = next();
  env.clock.advance(s.delayMs - 200);
  assert.equal(env.game.resolveScare(token, s.id).result.won, false);
  s = next();
  env.clock.advance(s.delayMs + s.windowMs + 100);
  assert.equal(env.game.resolveScare(token, s.id).result.won, false);
  s = next();
  env.clock.advance(s.delayMs + 300);
  assert.equal(env.game.resolveScare(token, s.id).result.won, true);
});

test('bag vs stash: banking moves candy home and resets Nightfall; ambush never touches the stash', () => {
  const env = setup({ seed: 5 });
  const { token, p } = env.login('Kid');
  for (let i = 0; i < 20; i++) {
    p.knocks = 40;
    knock(env, token, 1);
  }
  assert.ok(env.game.me(token).player.nightfall >= 1);
  const before = { bag: p.bag, stash: p.stash };
  const r = env.game.bank(token);
  assert.equal(r.banked, before.bag);
  assert.equal(r.player.nightfall, 0);
  assert.equal(r.player.stash, before.stash + before.bag);
});

test('NPC ambush: matchup drives chance; steal capped at 10% of bag; shield after', () => {
  const env = setup({ seed: 7 });
  const { token, p } = env.login('Kid');
  const { ctx } = env;
  assert.equal(ctx.ambushChance(p, 'ghost', 'salt'), 0.5 - 0.2 - 0.02);
  assert.equal(ctx.ambushChance(p, 'ghost', 'garlic'), 0.5 + 0.05 - 0.02);
  assert.ok(Math.abs(ctx.ambushChance(p, 'ghost', 'salt', { bribe: true }) - 0.2) < 1e-9, 'clamped at min');
  for (let i = 0; i < 200; i++) {
    Object.assign(p, { bag: 100, stash: 500, shieldUntil: 0, monsterHits: {} });
    env.clock.advance(1000);
    p.pending = { type: 'ambush', id: 'x' + i, houseId: 8, issuedAt: env.clock.now(), npc: 'wisp' };
    const r = env.game.resolveAmbush(token, 'x' + i, 'garlic').result;
    if (!r.won) {
      assert.equal(r.candy, -10);
      assert.equal(p.stash, 500);
      assert.ok(p.shieldUntil > env.clock.now());
      return;
    }
  }
  assert.fail('monster never succeeded');
});

test('throwing candy at a monster costs candy and lowers its chance', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  p.stash = 100;
  p.pending = { type: 'ambush', id: 'z', houseId: 8, issuedAt: env.clock.now(), npc: 'nibble' };
  env.game.resolveAmbush(token, 'z', 'salt', true);
  assert.ok(p.stash <= 100 - season.ambush.candyThrowCost);
});

// ---------------- monsters (player Scare Actors) ----------------

function makeMonster(env, name = 'Wraith', type = 'ghost') {
  const m = env.login(name);
  veteran(m.p);
  env.ctx.chain.transfer('liquidity', m.p.wallet, 1000, 'test');
  env.game.stake(m.token, season.monster.licenseStake);
  return m;
}

test('monster license: needs a held stake (warm-up blocks flash-loan entry)', () => {
  const env = setup();
  const m = makeMonster(env);
  assert.throws(() => env.game.becomeMonster(m.token, 'ghost'), /settling/);
  env.clock.advance(season.monster.licenseWarmupMs + 1000);
  env.game.becomeMonster(m.token, 'ghost');
  assert.equal(m.p.monster.type, 'ghost');
  // A big top-up pulls the time-weighted age toward now.
  env.ctx.chain.transfer('liquidity', m.p.wallet, 100000, 'test');
  env.game.stake(m.token, 100000);
  assert.equal(env.ctx.licenseStatus(m.p).active, false);
});

test('player monster lair ambush: success steals from bag, taxes the house owner, earns rep', () => {
  const env = setup({ seed: 3 });
  const m = makeMonster(env, 'Wraith', 'vampire');
  env.clock.advance(season.monster.licenseWarmupMs + 1000);
  env.game.becomeMonster(m.token, 'vampire');
  const owner = env.login('Owner');
  veteran(owner.p);
  env.ctx.chain.transfer('liquidity', owner.p.wallet, 1000, 'test');
  env.game.buyDeed(owner.token, 1);
  const v = env.login('Victim');
  veteran(v.p);
  v.p.ipHash = 'different';
  let stole = false;
  for (let i = 0; i < 60 && !stole; i++) {
    m.p.monster.fright = 100;
    m.p.monster.stunnedUntil = 0;
    env.ctx.state.lairs = [];
    env.game.setLair(m.token, 1, 'ambush');
    for (let k = 0; k < 20; k++) {
      Object.assign(v.p, { knocks: 40, bag: 100, shieldUntil: 0, monsterHits: {}, pity: 0 });
      env.clock.advance(1000 + (k % 5) * 77);
      const { result } = env.game.knock(v.token, 1, { holdMs: 100 });
      if (result.scare) {
        env.clock.advance(result.scare.delayMs + 300);
        env.game.resolveScare(v.token, result.scare.id);
        continue;
      }
      if (result.ambush?.player) {
        const r = env.game.resolveAmbush(v.token, result.ambush.id, 'salt').result; // wrong counter
        if (!r.won) {
          const take = -r.candy;
          assert.equal(take, Math.ceil(100 * season.monster.types.vampire.stealShare));
          assert.equal(env.ctx.state.houses[1].till, Math.floor(take * season.monster.houseTax));
          assert.ok(m.p.monster.rep > 50);
          assert.ok(v.p.inbox[0].text.includes('Wraith'), 'revenge notification');
          stole = true;
        }
        break;
      }
      if (result.ambush) env.game.resolveAmbush(v.token, result.ambush.id, 'salt');
    }
  }
  assert.ok(stole, 'player monster never landed a steal');
});

test('failed scare costs the monster Fright, a fine, a stun and rep, never the bond', () => {
  const env = setup();
  const m = makeMonster(env);
  env.clock.advance(season.monster.licenseWarmupMs + 1000);
  env.game.becomeMonster(m.token, 'ghost');
  m.p.stash = 100;
  m.p.monster.pendingBoo = 100;
  env.ctx.chain.transfer('vault:rewards', 'vault:claims', 100, 'test');
  const v = env.login('Hero');
  const h = env.ctx.state.houses[2];
  env.ctx.monsterResult(m.p, v.p, h, false, 0);
  assert.equal(m.p.stash, 100 - season.monster.failFine);
  assert.equal(m.p.monster.pendingBoo, 95);
  assert.ok(m.p.monster.stunnedUntil > env.clock.now());
  assert.equal(env.ctx.chain.stakeOf(m.p.wallet).amount, season.monster.licenseStake);
  assert.throws(() => env.game.setLair(m.token, 3, 'ambush'), /stunned/);
});

test('anti-grief: lairs skip shielded, out-of-bracket, same-network and recently hit victims', () => {
  const env = setup();
  const m = makeMonster(env);
  env.clock.advance(season.monster.licenseWarmupMs + 1000);
  env.game.becomeMonster(m.token, 'ghost');
  env.game.setLair(m.token, 5, 'ambush');
  const h = env.ctx.state.houses[5];
  const newbie = env.login('Newbie');
  assert.equal(env.ctx.eligibleLair(newbie.p, h), null, 'level bracket');
  veteran(newbie.p);
  assert.ok(env.ctx.eligibleLair(newbie.p, h));
  newbie.p.monsterHits[m.p.id] = env.clock.now();
  assert.equal(env.ctx.eligibleLair(newbie.p, h), null, 'same monster cooldown');
  newbie.p.monsterHits = {};
  newbie.p.ipHash = m.p.ipHash;
  assert.equal(env.ctx.eligibleLair(newbie.p, h), null, 'collusion');
  assert.ok(m.p.trust < 80);
});

test('bounties pay out to whoever beats the monster', () => {
  const env = setup();
  const m = makeMonster(env, 'Nasty');
  env.clock.advance(season.monster.licenseWarmupMs + 1000);
  env.game.becomeMonster(m.token, 'ghost');
  const a = env.login('Angry');
  a.p.stash = 100;
  env.game.postBounty(a.token, 'Nasty', 30);
  const hero = env.login('Hero');
  const stash = hero.p.stash;
  assert.equal(env.ctx.collectBounty(hero.p, m.p), 30);
  assert.equal(hero.p.stash, stash + 30);
});

// ---------------- houses ----------------

test('house deeds are NFTs: buy, per-wallet cap, entry fees split to owner and burn', () => {
  const env = setup();
  const o = env.login('Owner');
  veteran(o.p);
  env.ctx.chain.transfer('liquidity', o.p.wallet, 10000, 'test');
  const vampireId = Number(Object.values(env.ctx.state.houses).find((h) => h.type === 'vampire').id);
  o.p.unlocked.push('crypt-row');
  env.game.buyDeed(o.token, vampireId);
  const h = env.ctx.state.houses[vampireId];
  assert.equal(env.ctx.chain.state.nfts[h.deed].owner, o.p.wallet);
  env.game.buyDeed(o.token, 1);
  env.game.buyDeed(o.token, 2);
  assert.throws(() => env.game.buyDeed(o.token, 3), /Max 3/);

  const v = env.login('Visitor');
  veteran(v.p);
  v.p.unlocked.push('crypt-row');
  v.p.stash = 100;
  env.clock.advance(1000);
  const r = env.game.knock(v.token, vampireId, { holdMs: 100 });
  assert.equal(h.till, Math.floor(season.houseTypes.vampire.entryFee * season.houses.entryFeeOwnerShare));
  assert.ok(r.player.stash < 100);
});

test('behavior dial changes are timelocked and logged publicly', () => {
  const env = setup();
  const o = env.login('Owner');
  veteran(o.p);
  env.ctx.chain.transfer('liquidity', o.p.wallet, 1000, 'test');
  env.game.buyDeed(o.token, 1);
  env.game.setDial(o.token, 1, 'haunted');
  const h = env.ctx.state.houses[1];
  assert.equal(h.dial, 'balanced');
  assert.equal(h.log[0].outcome, 'dial');
  env.clock.advance(season.houses.dialTimelockMs + 1);
  env.ctx.tickWorld();
  assert.equal(h.dial, 'haunted');
  const stranger = env.login('Stranger');
  assert.throws(() => env.game.setDial(stranger.token, 1, 'generous'), /do not own/);
});

test('marketplace: escrowed sale pays seller minus fee, fee is part-burned', () => {
  const env = setup();
  const s = env.login('Seller');
  const b = env.login('Buyer');
  env.ctx.chain.transfer('liquidity', s.p.wallet, 1000, 'test');
  env.ctx.chain.transfer('liquidity', b.p.wallet, 2000, 'test');
  env.game.buyDeed(s.token, 1);
  env.game.listHouse(s.token, 1, 1000);
  const burned = env.ctx.chain.state.supply.burned;
  const sellerBefore = env.ctx.chain.bal(s.p.wallet);
  env.game.buyListing(b.token, 1);
  assert.equal(env.ctx.chain.bal(s.p.wallet), sellerBefore + 950);
  assert.equal(env.ctx.chain.state.supply.burned, burned + 25);
  assert.equal(env.ctx.houseOwner(env.ctx.state.houses[1]).id, b.p.id);
});

test('owners earn from the epoch pool by trust-weighted unique visitors, not their own visits', () => {
  const env = setup();
  const o = env.login('Owner');
  env.ctx.chain.transfer('liquidity', o.p.wallet, 1000, 'test');
  env.game.buyDeed(o.token, 1);
  for (let i = 0; i < 3; i++) {
    o.p.knocks = 40;
    knock(env, o.token, 1);
  }
  assert.deepEqual(env.ctx.state.epoch.houses[1] || {}, {}, 'self visits do not count');
  for (let i = 0; i < 5; i++) knock(env, env.login('V' + i).token, 1);
  env.ctx.settleEpoch();
  assert.ok(o.p.claimable > 0);
  const before = env.ctx.chain.bal(o.p.wallet);
  const got = o.p.claimable;
  env.ctx.claimBoo(o.p);
  assert.equal(env.ctx.chain.bal(o.p.wallet), before + got);
});

test('reputation reacts to payouts and one visitor cannot max it', () => {
  const env = setup();
  const h = env.ctx.state.houses[1];
  assert.equal(env.ctx.reputation(h), 50);
  const ev = (good) => Array.from({ length: 20 }, () => ({ at: env.clock.now(), good, w: 0.8, jackpot: 0 }));
  h.visitors.spammer = { events: ev(1) };
  const solo = env.ctx.reputation(h);
  for (let i = 0; i < 10; i++) h.visitors['v' + i] = { events: ev(1).slice(0, 3) };
  const many = env.ctx.reputation(h);
  assert.ok(solo < many && many > 70);
  for (let i = 0; i < 10; i++) h.visitors['b' + i] = { events: ev(0).slice(0, 3) };
  assert.ok(env.ctx.reputation(h) < many);
});

test('house view carries the public stats card', () => {
  const env = setup();
  const { token } = env.login('Kid');
  for (let i = 0; i < 6; i++) knock(env, token, 3);
  const h = env.game.house(3, token);
  for (const k of ['visits', 'candyGiven', 'scared', 'jackpots', 'monsterAttacks']) assert.ok(k in h.totals, k);
  assert.equal(h.totals.visits, 6);
  assert.ok(typeof h.reputation === 'number');
});

// ---------------- neighborhoods, secrets, events ----------------

test('neighborhoods unlock by level and candy', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  const cryptHouse = Object.values(env.ctx.state.houses).find((h) => h.neighborhood === 'crypt-row').id;
  env.clock.advance(1000);
  assert.throws(() => env.game.knock(token, cryptHouse, { holdMs: 100 }), /locked/);
  assert.throws(() => env.game.unlock(token, 'crypt-row'), /level/);
  veteran(p);
  p.stash = 200;
  env.game.unlock(token, 'crypt-row');
  assert.equal(p.stash, 50);
});

test('secret houses are hidden until discovered, and the Legendary Mansion opens for one hour', () => {
  const env = setup({ start: Date.parse('2026-10-08T18:00:00Z') });
  const { token, p } = env.login('Kid');
  assert.throws(() => env.game.house(901, token), /No such house/);
  assert.ok(!env.game.world(token).houses.some((h) => h.id === 901));
  p.discovered[902] = 2;
  assert.ok(env.game.world(token).houses.some((h) => h.id === 902));
  env.clock.advance(5 * 3600_000); // 23:00 UTC
  const w = env.game.world(token);
  assert.ok(w.legendaryEvent.open);
  assert.ok(w.houses.some((h) => h.id === 901));
  assert.ok(env.game.feed().some((f) => f.kind === 'event'));
});

// ---------------- candy sinks ----------------

test('shop: costumes (candy and $BOO), boosts, training, raffle', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  p.stash = 1000;
  env.game.buy(token, 'costume', 'vampire');
  assert.equal(p.costume, 'vampire');
  env.game.buy(token, 'boost', 'lollipop');
  assert.equal(p.boosts.luck, 10);
  env.game.train(token, 'luck');
  env.game.train(token, 'luck');
  assert.equal(p.trained.luck, 2);
  assert.equal(p.stash, 1000 - 150 - 30 - 60 - 120);
  env.ctx.chain.transfer('liquidity', p.wallet, 200, 'test');
  const burned = env.ctx.chain.state.supply.burned;
  env.game.buy(token, 'costume', 'headless');
  assert.equal(env.ctx.chain.state.supply.burned, burned + 60);
  assert.throws(() => env.game.buy(token, 'costume', 'banshee'), /Not for sale/);
  env.game.raffle(token, 3);
  env.clock.advance(86_400_000);
  env.game.me(token);
  assert.ok(p.ownedCostumes.includes('banshee'), 'sole raffle entrant wins');
});

test('cards: craft duplicates up a rarity, mint epics on-chain, full deck unlocks a prize', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  p.stash = 500;
  p.cards = { c01: 3 };
  const { card } = env.game.craft(token, 'c01');
  assert.notEqual(season.cards.list.find((c) => c.id === card.id).rarity, 'common');
  p.cards.c08 = 1;
  const { nft } = env.game.mintCard(token, 'c08');
  assert.equal(nft.owner, p.wallet);
  assert.throws(() => env.game.mintCard(token, 'c01'), /do not have|Only Epic/);
  for (const c of season.cards.list) p.cards[c.id] = 1;
  p.trust = 70;
  env.game.redeemPrize(token, 'deck-print');
  assert.equal(env.game.admin.redemptions().length, 1);
  assert.throws(() => env.game.redeemPrize(token, 'deck-print'), /Already/);
  assert.throws(() => env.game.redeemPrize(token, 'legend-hunter'), /not met/);
});

test('token rewards are trust-gated, capped daily, paid by signed claim from a funded vault', () => {
  const env = setup({ seed: 9 });
  const { token, p } = env.login('Kid');
  veteran(p);
  let boo = 0;
  for (let i = 0; i < 400; i++) {
    p.knocks = 40;
    p.daily.candyEarned = 0;
    const r = knock(env, token, 1);
    boo += r.boo || 0;
    if (i % 10 === 0) env.game.bank(token);
  }
  assert.ok(boo > 0 && boo <= season.rewards.tokenDailyCap);
  const vaultBefore = env.ctx.chain.bal('vault:claims');
  env.game.claimBoo(token);
  assert.equal(env.ctx.chain.bal(p.wallet), boo);
  assert.equal(env.ctx.chain.bal('vault:claims'), vaultBefore - boo);
  assert.throws(() => env.ctx.chain.claim({ to: p.wallet, amount: 5, nonce: 'n', reason: 'x' }, 'f'.repeat(64)), /signature/);
});

// ---------------- chain + economy ----------------

test('chain: genesis allocation, hash-linked blocks, reputation and season anchors', () => {
  const env = setup();
  const c = env.ctx.chain;
  assert.equal(c.state.supply.total, season.token.totalSupply);
  assert.ok(c.verify());
  assert.ok(c.state.anchors.some((a) => a.kind === 'season'));
  env.ctx.settleEpoch();
  assert.ok(c.state.anchors.some((a) => a.kind === 'reputation'));
  c.state.blocks.at(-2).tx.amt = 999999;
  assert.equal(c.verify(), false, 'tampering breaks the chain');
});

test('economy report tracks every faucet and sink', () => {
  const env = setup();
  const { token, p } = env.login('Kid');
  for (let i = 0; i < 15; i++) knock(env, token, 1);
  p.stash = 500;
  env.game.buy(token, 'costume', 'witch');
  const e = env.game.economy();
  assert.ok(e.candy.totalIn > 0 && e.candy.out.costume === 60);
  assert.ok(e.chain.valid);
});

test('leaderboards: all categories, with level divisions', () => {
  const env = setup();
  const { token } = env.login('Leader');
  for (let i = 0; i < 6; i++) knock(env, token, i + 1);
  const lb = env.game.leaderboards();
  for (const k of ['candy', 'houses', 'monstersDefeated', 'playersScared', 'candyStolen', 'valuableHouses', 'legendaries', 'richest', 'richestMonster', 'notorious', 'famousHouses']) assert.ok(lb[k], k);
  assert.equal(lb.candy.rows[0].name, 'Leader');
  assert.equal(env.game.leaderboards('veteran').candy.rows.length, 0);
});

test('Zombie November reskins the season through data alone', () => {
  const zombie = loadSeason(new URL('../season/zombie-november.json', import.meta.url).pathname);
  assert.equal(zombie.name, 'Zombie November');
  assert.equal(zombie.neighborhoods[0].name, 'Hollow Lane (Overrun)');
  assert.equal(zombie.neighborhoods[0].types.length, season.neighborhoods[0].types.length);
  assert.ok(zombie.costumes.hazmat && zombie.costumes.vampire);
  const env = setup({ s: zombie });
  const { token } = env.login('Survivor');
  knock(env, token, 1);
  assert.equal(env.game.world(token).season.name, 'Zombie November');
});
