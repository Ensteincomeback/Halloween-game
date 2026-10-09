// Dev build only (DEV=1): shortcuts for play-testing every feature without the
// grind. None of this is reachable unless the server is started in dev mode.

import crypto from 'node:crypto';
import { GameError, HOUR } from './core.js';
import { OUTCOMES } from './knock.js';
import { toLamports } from './chain.js';

export function installDev(ctx) {
  const { season, state, chain } = ctx;
  const now = () => ctx.now();

  const dev = {
    candy(p, amount = 10000) {
      const n = Math.max(0, Math.round(Number(amount)));
      p.stashCapacity = Math.max(p.stashCapacity, p.stash + n);
      p.stash += n;
      return { stash: p.stash };
    },
    fillBucket(p) {
      p.bag = p.bagCapacity;
    },
    boo(p, amount = 5000) {
      chain.transfer('liquidity', p.wallet, Math.max(1, Math.round(Number(amount))), 'dev grant');
    },
    level(p, level = 10) {
      const lv = Math.max(1, Math.min(99, Math.round(Number(level))));
      p.xp = (lv - 1) ** 2 * 10;
      p.trust = Math.max(p.trust, 80);
    },
    knocks(p) {
      p.knocks = 999;
    },
    monster(p, type = 'ghost') {
      if (!season.monster.types[type]) throw new GameError('Unknown monster type');
      const need = season.monster.licenseStake - chain.stakeOf(p.wallet).amount;
      if (need > 0) {
        if (chain.bal(p.wallet) < need) chain.transfer('liquidity', p.wallet, need, 'dev grant');
        chain.stake(p.wallet, need);
      }
      chain.state.stakes[p.wallet].since = now() - season.monster.licenseWarmupMs - 1000; // skip the bond warm-up
      if (ctx.level(p) < season.player.deepEconomyLevel) dev.level(p, season.player.deepEconomyLevel);
      ctx.becomeMonster(p, type);
      Object.assign(p.monster, { fright: season.monster.frightMax, stunnedUntil: 0 });
    },
    unlockAll(p) {
      p.unlocked = season.neighborhoods.map((h) => h.id);
    },
    costumes(p) {
      p.ownedCostumes = Object.keys(season.costumes);
    },
    cards(p) {
      for (const c of season.cards.list) p.cards[c.id] = (p.cards[c.id] || 0) + 3;
    },
    secrets(p) {
      for (const s of season.secretHouses) p.discovered[s.id] = 5;
    },
    // The next knock lands on this outcome ('jackpot' forces a Golden Pumpkin).
    force(p, outcome) {
      if (outcome !== 'jackpot' && !OUTCOMES.includes(outcome)) throw new GameError('Unknown outcome');
      p.devForce = outcome;
      p.totalKnocks = Math.max(p.totalKnocks, 10); // past the tutorial script
    },
    noTravel(p, on = true) {
      p.devNoTravel = !!on;
    },
    teleport(p, x, z) {
      p.lastPos = { x: Number(x), z: Number(z), t: now() };
    },
    shield(p) {
      p.shieldUntil = 0;
      p.monsterHits = {};
    },
    resetDaily(p) {
      p.day = null;
      ctx.rollDay(p);
      p.knocks = Math.max(p.knocks, season.energy.dailyFree);
    },
    epoch() {
      return ctx.settleEpoch();
    },
    event(p, open = true) {
      state.global.devEvent = !!open;
      ctx.tickWorld();
    },
    // Make the Legendary Mansion's random schedule fire in a few seconds.
    eventSoon() {
      state.global.devEvent = false;
      const L = ctx.legendarySchedule();
      L.openUntil = 0;
      L.nextAt = now() + 3000;
    },
    sol(p, amount = 10) {
      chain.solTransfer('faucet', p.wallet, toLamports(Math.max(0.001, Number(amount))), 'dev grant');
    },
    // Draw the current Town Raffle round right now (with a few bot entrants so
    // there are enough players for real prizes).
    drawRaffle(p, withBots = true) {
      const r = ctx.raffleView(p);
      if (withBots) {
        for (let i = 0; i < 3; i++) {
          let bot = Object.values(state.players).find((x) => x.devBot === i);
          if (!bot) {
            bot = ctx.newPlayer(`Raffle Bot ${i + 1}`, `dev-${crypto.randomBytes(4).toString('hex')}`).player;
            bot.devBot = i;
          }
          bot.xp = Math.max(bot.xp, 100);
          bot.trust = 80;
          state.townRaffle.entries[bot.id] ??= { slots: 1 + i, free: 0 };
        }
      }
      return { round: r.round, result: ctx.drawTownRaffle() };
    },
    // Seed the prize pool so funded prizes can be tested.
    fundPrizes(p, usd = 50) {
      const lamports = toLamports(Number(usd) / season.fees.usdRate.SOL);
      chain.solTransfer('faucet', 'pool:prizes', lamports, 'dev prize pool seed');
    },
    // End all running player raffles now.
    endAuctions() {
      for (const a of Object.values(state.auctions)) a.endsAt = now();
      ctx.tickRaffles();
    },
    // A rival player-monster with a lair on a house, so you can be its victim.
    rival(p, houseId, kind = 'ambush') {
      let bot = Object.values(state.players).find((x) => x.devRival);
      if (!bot) {
        bot = ctx.newPlayer('Dev Ghoul', `dev-${crypto.randomBytes(4).toString('hex')}`).player;
        bot.devRival = true;
        dev.monster(bot, 'vampire');
      }
      bot.xp = p.xp;
      bot.monster.fright = season.monster.frightMax;
      bot.monster.stunnedUntil = 0;
      p.monsterHits = {};
      p.shieldUntil = 0;
      p.totalKnocks = Math.max(p.totalKnocks, season.ambush.newPlayerGraceKnocks + 1);
      state.lairs = state.lairs.filter((l) => l.monsterId !== bot.id);
      const h = ctx.house(Number(houseId));
      state.lairs.push({ id: crypto.randomBytes(6).toString('hex'), monsterId: bot.id, houseId: h.id, kind, setAt: now(), expiresAt: now() + HOUR, used: false, devAlways: true });
      return { house: h.id, monster: bot.name };
    },
  };
  return dev;
}
