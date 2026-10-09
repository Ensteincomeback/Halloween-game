// Scare Actors: players who stake a $BOO bond to play monsters. The bond is
// slashed only for proven abuse. Failing a scare costs Fright, a candy fine
// and a slice of unclaimed monster earnings, so the role is a game, not a yield.

import crypto from 'node:crypto';
import { GameError, HOUR, MINUTE } from './core.js';

export function installMonsters(ctx) {
  const { season, state, chain } = ctx;
  const now = () => ctx.now();
  const M = season.monster;
  const A = season.ambush;
  const sym = season.token.symbol;

  state.lairs ??= [];
  state.bounties ??= {};

  // ---------- license ----------
  ctx.licenseStatus = (p) => {
    const s = chain.stakeOf(p.wallet);
    const heldMs = s.since ? now() - s.since : 0;
    return {
      staked: s.amount,
      required: M.licenseStake,
      warmupLeftMs: s.amount >= M.licenseStake ? Math.max(0, M.licenseWarmupMs - heldMs) : null,
      active: s.amount >= M.licenseStake && heldMs >= M.licenseWarmupMs,
    };
  };

  ctx.stake = (p, amount) => chain.stake(p.wallet, Math.round(Number(amount)));

  ctx.unstake = (p, amount) => {
    if (p.monster && activeLairs(p).length) throw new GameError('Clear your lairs before withdrawing your bond');
    chain.unstake(p.wallet, Math.round(Number(amount)));
  };

  ctx.becomeMonster = (p, type) => {
    if (!M.types[type]) throw new GameError('Unknown monster type');
    const lic = ctx.licenseStatus(p);
    if (!lic.active) {
      throw new GameError(lic.staked < M.licenseStake
        ? `Stake ${M.licenseStake} $${sym} for a Monster License`
        : 'Your bond is still settling. Licenses need a held stake, not a borrowed one.');
    }
    if (p.monster) {
      p.monster.type = type;
      return;
    }
    p.monster = { type, fright: M.frightMax, frightAt: now(), rep: 50, stunnedUntil: 0, pendingBoo: 0, forfeited: 0 };
    ctx.pushFeed('monster', `A new ${M.types[type].name} haunts the neighborhood: ${p.name}.`);
  };

  ctx.monsterTick = (p) => {
    const m = p.monster;
    if (!m) return;
    const step = M.frightRegenMinutes * MINUTE;
    const gained = Math.floor((now() - m.frightAt) / step);
    if (m.fright >= M.frightMax) m.frightAt = now();
    else if (gained > 0) {
      m.fright = Math.min(M.frightMax, m.fright + gained);
      m.frightAt += gained * step;
    }
  };

  // ---------- lairs ----------
  const activeLairs = (p) => state.lairs.filter((l) => l.monsterId === p.id && !l.used && l.expiresAt > now());
  ctx.lairsAt = (houseId) => state.lairs.filter((l) => l.houseId === houseId && !l.used && l.expiresAt > now());
  ctx.lairById = (id) => state.lairs.find((l) => l.id === id);

  ctx.setLair = (p, houseId, kind) => {
    const m = p.monster;
    if (!m) throw new GameError('Only Scare Actors can set lairs', 403);
    if (!ctx.licenseStatus(p).active) throw new GameError('Your Monster License is not active');
    if (now() < m.stunnedUntil) throw new GameError('You are still stunned from your last failed scare');
    const h = ctx.house(houseId);
    if (h.secret) throw new GameError('Monsters cannot find this house');
    if (!['ambush', 'trap'].includes(kind)) throw new GameError('Unknown lair');
    if (activeLairs(p).length >= M.maxLairs) throw new GameError(`Max ${M.maxLairs} active lairs`);
    if (ctx.lairsAt(houseId).some((l) => l.monsterId === p.id)) throw new GameError('You already lurk here');
    const cost = kind === 'trap' ? M.types[m.type].trapFright || M.trapFright : M.ambushFright;
    if (m.fright < cost) throw new GameError(`Needs ${cost} Fright (you have ${m.fright})`);
    m.fright -= cost;
    state.lairs.push({ id: crypto.randomBytes(6).toString('hex'), monsterId: p.id, houseId, kind, setAt: now(), expiresAt: now() + M.lairHours * HOUR, used: false });
    state.lairs = state.lairs.filter((l) => !l.used && l.expiresAt > now() - HOUR);
  };

  ctx.consumeLair = (lair) => {
    lair.used = true;
  };

  // Anti-grief + anti-collusion: shields, per-target cooldown, level bracket,
  // never your own lair, never someone on your own network.
  ctx.eligibleLair = (p, h) => {
    const lv = ctx.level(p);
    for (const l of ctx.lairsAt(h.id)) {
      const m = state.players[l.monsterId];
      if (!m?.monster || m.id === p.id) continue;
      if (now() - (p.monsterHits[m.id] || 0) < A.sameMonsterCooldownHours * HOUR) continue;
      if (Math.abs(ctx.level(m) - lv) > M.levelBracket) continue;
      if (m.ipHash === p.ipHash) {
        m.trust = Math.max(0, m.trust - 5);
        p.trust = Math.max(0, p.trust - 5);
        continue;
      }
      return l;
    }
    return null;
  };

  ctx.lairMonsterView = (lair) => {
    const m = state.players[lair.monsterId];
    const t = M.types[m.monster.type];
    const clue = season.npcMonsters.find((n) => n.type === m.monster.type)?.clue || 'Something is watching you...';
    return { name: m.name, type: m.monster.type, clue: `${clue} (A player monster!)`, typeName: t.name };
  };

  // Outcome bookkeeping for a player monster. Success: candy (minus the house
  // owner's tax) and reputation. Failure: fine, forfeit, stun, reputation hit.
  ctx.monsterResult = (m, victim, h, success, take) => {
    const mon = m.monster;
    const ss = ctx.seasonStats(m);
    const T = M.types[mon.type];
    if (success) {
      const owner = ctx.houseOwner(h);
      const tax = owner && owner.id !== m.id ? Math.floor(take * M.houseTax) : 0;
      if (tax) h.till += tax;
      m.stash = Math.min(m.stashCapacity, m.stash + take - tax);
      ss.stolen += take;
      ss.scaredPlayers += 1;
      mon.rep = Math.min(100, mon.rep + 2);
      ctx.epochMonsterWin(m);
      ctx.notify(m, `Your ${T.name.toLowerCase()} lair at #${h.id} got ${victim.name}: +${take - tax} candy${tax ? ` (${tax} to the house owner)` : ''}.`);
      if (take >= 20) ctx.pushFeed('steal', `${m.name} the ${T.name} stole ${take} candy from ${victim.name} at #${h.id}!`, { houseId: h.id });
    } else {
      const mult = T.failMultiplier || 1;
      const fine = Math.min(m.stash, Math.round(M.failFine * mult));
      m.stash -= fine;
      ctx.track('out', 'monsterFine', fine);
      const forfeit = Math.floor(mon.pendingBoo * M.failForfeitShare * mult);
      if (forfeit) {
        mon.pendingBoo -= forfeit;
        mon.forfeited += forfeit;
        chain.transfer('vault:claims', 'treasury', forfeit, 'monster forfeit');
      }
      mon.stunnedUntil = now() + M.stunMinutes * MINUTE;
      mon.rep = Math.max(0, mon.rep - 1);
      ss.monsterFails += 1;
      ctx.notify(m, `${victim.name} beat your lair at #${h.id}. -${fine} candy${forfeit ? `, -${forfeit} $${sym} pending` : ''}, stunned ${M.stunMinutes}m.`);
    }
  };

  // ---------- bounties: revenge arcs ----------
  ctx.postBounty = (p, monsterName, amount) => {
    const amt = Math.round(Number(amount));
    if (!(amt >= M.bountyMin)) throw new GameError(`Minimum bounty is ${M.bountyMin} candy`);
    const m = Object.values(state.players).find((x) => x.monster && x.name.toLowerCase() === String(monsterName).toLowerCase());
    if (!m) throw new GameError('No monster by that name');
    if (m.id === p.id) throw new GameError('You cannot put a bounty on yourself');
    ctx.spend(p, amt, 'bountyEscrow');
    state.bounties[m.id] = (state.bounties[m.id] || 0) + amt;
    ctx.pushFeed('bounty', `${p.name} put a ${amt} candy bounty on ${m.name}! Beat their lair to collect.`);
  };

  ctx.collectBounty = (p, m) => {
    const amt = state.bounties[m.id];
    if (!amt) return 0;
    delete state.bounties[m.id];
    const added = ctx.addStash(p, amt, 'bounty');
    ctx.pushFeed('bounty', `${p.name} collected the ${amt} candy bounty on ${m.name}!`);
    return added;
  };

  ctx.claimMonsterBoo = (p) => {
    const amt = p.monster?.pendingBoo || 0;
    if (!amt) throw new GameError('Nothing to claim');
    p.monster.pendingBoo = 0;
    p.claimable += amt;
    return amt;
  };

  ctx.monsterView = (p) => {
    const m = p.monster;
    const lic = ctx.licenseStatus(p);
    if (!m) return { license: lic };
    const T = M.types[m.type];
    return {
      license: lic, type: m.type, typeName: T.name, icon: T.icon, perk: T.perk, counter: T.counter,
      fright: m.fright, frightMax: M.frightMax, rep: m.rep, pendingBoo: m.pendingBoo, forfeited: m.forfeited,
      stunnedMs: Math.max(0, m.stunnedUntil - now()),
      ambushCost: M.ambushFright, trapCost: T.trapFright || M.trapFright, maxLairs: M.maxLairs,
      bounty: state.bounties[p.id] || 0,
      lairs: activeLairs(p).map((l) => ({ id: l.id, houseId: l.houseId, house: state.houses[l.houseId].name, kind: l.kind, expiresMs: l.expiresAt - now() })),
    };
  };
}
