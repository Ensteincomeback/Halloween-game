// Knock web client. All randomness and rules live on the server; this file
// only renders state and captures player input.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  token: localStorage.getItem('knock.token'),
  player: null, world: null, catalog: null,
  hood: null, selected: null, houseDetail: null,
  tab: 'porch', division: 'all', busy: false, seenInbox: 0, timers: false,
};

const ICON = { candy: '🍬', bigCandy: '🍫', rare: '🍭', collectible: '🃏', token: '🪙', legendary: '👑', jackpot: '🎃', secretHouse: '🗝️', trick: '🐕', scare: '👻', ambush: '🧟', trap: '🪤', dial: '🎛️', sold: '🏷️' };
const LABEL = { candy: 'Candy', bigCandy: 'Big candy', rare: 'Rare candy', collectible: 'Monster card', token: '$BOO', legendary: 'Legendary', secretHouse: 'Secret house', trick: 'Trick', scare: 'Scare', ambush: 'Monster attack', trap: 'Trap', dial: 'Behavior change', sold: 'Sold' };
const sym = () => S.catalog?.token.symbol || 'BOO';

// ---------- API ----------

async function api(path, body) {
  const res = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(data.error || 'Something went bump');
  if (data.player) S.player = data.player;
  return data;
}

function toast(msg, ms = 2800) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- boot ----------

async function boot() {
  S.catalog = await api('catalog');
  if (!S.token) return showLogin();
  try {
    await api('me');
    await startGame();
  } catch {
    showLogin();
  }
}

function showLogin() {
  $('#login').hidden = false;
  $('#game').hidden = true;
}

function logout() {
  localStorage.removeItem('knock.token');
  S.token = null;
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { token, player } = await api('login', { name: $('#login-name').value });
    S.token = token;
    localStorage.setItem('knock.token', token);
    await startGame();
    const costume = S.catalog.costumes[player.costume];
    showModal(`
      <div class="big-icon">${costume.icon}</div>
      <h2>Welcome to the neighborhood, ${esc(player.name)}!</h2>
      <p>You're a kid in a ${esc(costume.name)} costume with an empty bag and a curfew.</p>
      <p class="muted small">Tap a house, then <b>press and release the door</b> to knock.
        Candy in your <b>bag</b> can be lost; walk home to <b>bank</b> it in your stash.</p>
      <div class="actions"><button class="btn primary big" data-close>Let's go</button></div>`);
  } catch (err) {
    toast(err.message);
  }
});

async function startGame() {
  $('#login').hidden = true;
  $('#game').hidden = false;
  S.seenInbox = S.player.inbox[0]?.at || 0;
  S.wasDeep = S.player.deepEconomy;
  await refreshWorld();
  S.hood ??= S.world.neighborhoods[0].id;
  await selectHouse(S.selected || S.world.route[0] || 1);
  renderAll();
  if (S.player.pending) resumePending(S.player.pending);
  if (!S.timers) {
    S.timers = true;
    setInterval(tick, 1000);
    setInterval(() => refreshWorld().then(renderStreet).catch(() => {}), 15000);
  }
}

async function refreshWorld() {
  S.world = await api('world');
}

function tick() {
  const p = S.player;
  if (!p) return;
  if (p.nextRegenMs != null) {
    p.nextRegenMs -= 1000;
    if (p.nextRegenMs <= 0) api('me').then(renderHud).catch(() => {});
  }
  if (p.shieldMs > 0) p.shieldMs = Math.max(0, p.shieldMs - 1000);
  renderHud();
}

// ---------- rendering ----------

function renderAll() {
  renderHud();
  renderStreet();
  renderTab();
}

const fmtMs = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const repClass = (r) => (r >= 65 ? 'good' : r <= 35 ? 'bad' : '');

function renderHud() {
  const p = S.player;
  const costume = S.catalog.costumes[p.costume];
  const mon = p.monster?.type ? ` · ${p.monster.icon} ${p.monster.typeName}` : '';
  $('#hud-player').textContent = `${costume.icon} ${p.name} · Lv ${p.level}${mon}`;
  $('#hud-knocks').textContent = p.knocks;
  $('#hud-regen').textContent = p.nextRegenMs != null ? `+1 in ${fmtMs(p.nextRegenMs)}` : 'full';
  $('#hud-bag').textContent = `${p.bag}/${p.bagCapacity}`;
  $('#hud-bag-bar').style.width = `${(100 * p.bag) / p.bagCapacity}%`;
  $('#hud-stash').textContent = p.stash;
  $('#hud-night').textContent = S.world?.nightfallNames[p.nightfall] ?? '';
  $('#hud-night-bar').style.width = `${(100 * Math.min(p.nightKnocks, 32)) / 32}%`;
  $('#hud-streak').textContent = `🔥 ${p.streak}d`;
  $('#hud-boo-wrap').hidden = !p.wallet;
  if (p.wallet) $('#hud-boo').textContent = p.wallet.boo;
  $('#tab-btn-streets').hidden = !p.deepEconomy;
  $('#btn-home').disabled = p.bag === 0;
  const banners = [];
  if (p.shieldMs > 0) banners.push(`<div class="banner">🛡️ Monsters can't touch you for ${fmtMs(p.shieldMs)}</div>`);
  if (S.world?.legendaryEvent.open) banners.push(`<div class="banner gold">👑 The Legendary Mansion is open to everyone for this hour!</div>`);
  p.discovered.forEach((d) => banners.push(`<div class="banner gold">🗝️ Secret house found: ${esc(d.name)} (${d.knocks} knocks left)</div>`));
  $('#banners').innerHTML = banners.join('');
  checkInbox();
  if (p.deepEconomy && !S.wasDeep) {
    S.wasDeep = true;
    showModal(`<div class="big-icon">🕸️</div><h2>The Haunted Streets</h2>
      <p>You've been out long enough to notice: some houses have <b>owners</b>, some shadows are <b>other players</b>, and a coin called <b>$${sym()}</b> changes hands after dark.</p>
      <p class="muted small">A wallet was made for you when you arrived. Buy a house, become a monster, or just keep knocking. The game plays the same either way.</p>
      <div class="actions"><button class="btn primary" data-close>Show me</button></div>`);
  }
}

function checkInbox() {
  const newest = S.player.inbox[0];
  if (newest && newest.at > S.seenInbox) {
    S.seenInbox = newest.at;
    toast(`📬 ${newest.text}`, 5000);
  }
}

function renderStreet() {
  const w = S.world;
  const p = S.player;
  const hood = w.neighborhoods.find((n) => n.id === S.hood);
  $('#street-name').textContent = `${hood.name} · ${w.season.name}`;
  $('#hoods').innerHTML = w.neighborhoods.map((n) => `
    <button class="hood ${n.id === S.hood ? 'active' : ''} ${n.unlocked ? '' : 'locked'}" data-hood="${n.id}">
      ${n.unlocked ? '' : '🔒 '}${esc(n.name)} ${n.candyMultiplier > 1 ? `<span class="muted">${n.candyMultiplier}× candy</span>` : ''}
    </button>`).join('') + (w.houses.some((h) => h.secret) ? `<button class="hood ${S.hood === 'secret' ? 'active' : ''}" data-hood="secret">🗝️ Secret</button>` : '');
  if (S.hood !== 'secret' && !hood.unlocked) {
    $('#street').innerHTML = `<div class="locked-hood" style="grid-column:1/-1">
      <p>🔒 <b>${esc(hood.name)}</b> needs level ${hood.minLevel} and ${hood.unlockCost} candy. You're level ${p.level}.</p>
      <p class="muted small">Bigger payouts (${hood.candyMultiplier}× candy), nastier houses, more monsters.</p>
      <button class="btn primary" data-unlock="${hood.id}" ${p.level < hood.minLevel ? 'disabled' : ''}>Unlock for ${hood.unlockCost} 🍬</button></div>`;
    return;
  }
  const visited = new Set(p.routeVisited);
  const houses = w.houses.filter((h) => (S.hood === 'secret' ? h.secret : h.neighborhood === S.hood));
  $('#street').innerHTML = houses.map((h) => `
    <button class="house ${h.hot ? 'hot' : ''} ${h.secret ? 'secret' : ''} ${S.selected === h.id ? 'selected' : ''}" data-house="${h.id}">
      <div class="badges">${h.hot ? '<span title="Hot House: 2× candy">🔥</span>' : ''}${h.onRoute ? `<span class="${visited.has(h.id) ? 'done' : ''}" title="Today's route">⭐</span>` : ''}${h.listing ? '<span title="For sale">🏷️</span>' : ''}${h.pendingDial ? '<span title="Behavior change coming">⚠️</span>' : ''}</div>
      <div class="top"><span class="icon">${h.icon}</span></div>
      <div class="num">#${h.id} · ${esc(h.typeName)} <span class="rep ${repClass(h.reputation)}">${h.reputation}</span></div>
      <div class="name">${esc(h.name)}</div>
      <div class="tell">${esc(h.tell)}</div>
      ${h.owner ? `<div class="owner">🏠 ${esc(h.owner.name)}${h.dial !== 'balanced' ? ` · ${esc(h.dialName)}` : ''}</div>` : ''}
      ${h.entryFee ? `<div class="owner">Entry ${h.entryFee} 🍬</div>` : ''}
    </button>`).join('');
}

function renderTab() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${S.tab}`));
  const fn = { porch: renderPorch, missions: renderMissions, shop: renderShop, board: renderBoard, leaders: renderLeaders, feed: renderFeed, me: renderMe, streets: renderStreets }[S.tab];
  Promise.resolve(fn()).catch((e) => toast(e.message));
}

function renderPorch() {
  const h = S.houseDetail;
  if (!h) return;
  const p = S.player;
  const out = p.knocks < 1;
  const T = h.totals;
  const deep = p.deepEconomy;
  const mine = h.owner?.isYou;
  const ownerBlock = !deep ? '' : mine ? `
    <div class="section"><h3>Your house</h3>
      <div class="row-actions">
        <button class="btn small" data-act="till" ${h.till ? '' : 'disabled'}>Collect till (${h.till} 🍬)</button>
        ${h.lanternPrice ? `<button class="btn small" data-act="lantern">🏮 Lantern Lv ${h.lantern + 1} · ${h.lanternPrice} $${sym()}</button>` : '<span class="muted small">🏮 Lantern maxed</span>'}
      </div>
      <div class="inline-form"><select id="dial" class="inp">${Object.entries(S.catalog.dial).map(([k, d]) => `<option value="${k}" ${k === h.dial ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <button class="btn small" data-act="dial">Change behavior</button></div>
      <p class="muted small">Behavior changes take 24h and are posted publicly. Players will notice.</p>
      ${h.listing ? `<div class="row-actions"><span class="muted small">Listed for ${h.listing.price} $${sym()}</span><button class="btn small" data-act="delist">Cancel listing</button></div>`
        : `<div class="inline-form"><input id="list-price" type="number" min="1" placeholder="Price in $${sym()}"><button class="btn small" data-act="list">List for sale</button></div>`}
    </div>` : h.secret ? '' : `
    <div class="section"><h3>Deed</h3>
      ${h.owner ? `<p class="small">Owned by <b>${esc(h.owner.name)}</b>. Value ≈ ${h.value} $${sym()}.</p>` : ''}
      ${h.price ? `<button class="btn small primary" data-act="deed">Buy deed · ${h.price} $${sym()}</button>` : ''}
      ${h.listing ? `<button class="btn small primary" data-act="buylisting">Buy from market · ${h.listing.price} $${sym()}</button>` : ''}
    </div>`;
  const m = p.monster;
  const monsterBlock = m?.type && !h.secret ? `
    <div class="section"><h3>${m.icon} Lurk here</h3>
      <div class="row-actions">
        <button class="btn small" data-act="lair-ambush" ${m.fright < m.ambushCost ? 'disabled' : ''}>Set ambush · ${m.ambushCost} Fright</button>
        <button class="btn small" data-act="lair-trap" ${m.fright < m.trapCost ? 'disabled' : ''}>Set trap · ${m.trapCost} Fright</button>
      </div>
      <p class="muted small">Fright ${m.fright}/${m.frightMax}. Lairs spring on visitors near your level.</p></div>` : '';
  $('#tab-porch').innerHTML = `
    <div class="porch-house">
      <span class="icon">${h.icon}</span>
      <div>
        <div class="muted small">#${h.id} · ${esc(h.typeName)} ${h.hot ? '· 🔥 Hot House' : ''}</div>
        <h2>${esc(h.name)}</h2>
        <div class="tell muted small"><i>${esc(h.tell)}</i>${p.boosts.nightvision ? ' 🥽' : ''}</div>
      </div>
    </div>
    ${h.pendingDial ? `<div class="warn">⚠️ The owner is turning this house <b>${esc(h.pendingDial.name)}</b> in ${fmtMs(h.pendingDial.at - Date.now())}.</div>` : ''}
    ${h.dial !== 'balanced' ? `<div class="${h.dial === 'generous' ? 'ok' : 'warn'}">Behavior: <b>${esc(h.dialName)}</b></div>` : ''}
    <div id="door" class="door ${out ? 'disabled' : ''}">${out ? 'The street is quiet…' : `Press &amp; release to knock${h.entryFee ? ` · ${h.entryFee} 🍬` : ''}`}</div>
    ${out ? '<p class="muted small">Out of knocks. They refill over time, from missions, and every day.</p>' : ''}
    <div class="statcard">
      <div class="row"><span>HOUSE #${h.id}</span><b>${h.owner ? esc(h.owner.name) : 'unowned'}</b></div>
      <div class="row"><span>Visits</span><b>${T.visits.toLocaleString()}</b></div>
      <div class="row"><span>Candy given</span><b>${T.candyGiven.toLocaleString()}</b></div>
      <div class="row"><span>Players scared</span><b>${T.scared.toLocaleString()}</b></div>
      <div class="row"><span>Jackpots found</span><b>${T.jackpots}</b></div>
      <div class="row"><span>Monster attacks</span><b>${T.monsterAttacks}</b></div>
      <div class="row"><span>Reputation</span><b class="rep ${repClass(h.reputation)}">${h.reputation}/100</b></div>
    </div>
    ${ownerBlock}${monsterBlock}
    <h3 class="section">House log</h3>
    <ul class="log">${h.log.length ? h.log.map((e) => `
      <li><span>${esc(e.player)}</span><span class="o-${e.outcome}">${ICON[e.detail?.jackpot ? 'jackpot' : e.outcome] || ''} ${LABEL[e.outcome] || e.outcome}${e.outcome === 'dial' ? `: ${esc(e.detail.mode)}${e.detail.applied ? ' (now)' : ''}` : ''}${e.detail?.won === true ? ' (survived)' : e.detail?.won === false ? ' (lost)' : ''}</span><span class="muted">${timeAgo(e.at)}</span></li>`).join('') : '<li class="muted">Nobody has knocked yet. Be the first.</li>'}
    </ul>`;
  bindDoor();
}

function renderMissions() {
  const p = S.player;
  $('#tab-missions').innerHTML = `
    <h3>Daily missions</h3>
    <div class="list">${p.missions.map((m) => `
      <div class="item"><div style="flex:1">
        <div class="title">${esc(m.text)}</div>
        <div class="muted small">+${m.reward.candy} 🍬 · +${m.reward.knocks} knocks</div>
        <div class="progress"><div style="width:${(100 * m.progress) / m.goal}%"></div></div></div>
        ${m.claimed ? '<span class="muted">✓</span>' : `<button class="btn small ${m.progress >= m.goal ? 'primary' : ''}" data-claim="${m.id}" ${m.progress >= m.goal ? '' : 'disabled'}>${m.progress}/${m.goal}</button>`}
      </div>`).join('')}</div>
    <h3 class="section">Streak</h3>
    <p>🔥 <b>${p.streak} day${p.streak === 1 ? '' : 's'}</b>. Today +${p.streakBonusToday} 🍬, tomorrow <b>+${p.streakBonusTomorrow}</b>. One grace day a week.</p>
    <h3 class="section">Today's route</h3>
    <p class="small">${S.world.route.map((id) => `<span class="chip">${p.routeVisited.includes(id) ? '✓' : '⭐'} #${id}</span>`).join(' ')}</p>
    <h3 class="section">Legendary Mansion</h3>
    <p class="small muted">Opens to everyone daily at ${String(S.world.legendaryEvent.hourUtc).padStart(2, '0')}:00 UTC for one hour.</p>`;
}

function renderShop() {
  const p = S.player;
  const c = S.catalog;
  const total = p.bag + p.stash;
  const boo = p.wallet?.boo ?? 0;
  const statStr = (s) => Object.entries(s).map(([k, v]) => `+${v} ${k}`).join(', ') || 'no stats';
  const costumeRow = ([id, k]) => {
    const owned = p.ownedCostumes.includes(id);
    if (k.raffleOnly && !owned) return '';
    if (k.booPrice && !p.deepEconomy) return '';
    const price = k.booPrice ? `${k.booPrice} $${sym()}` : `${k.price} 🍬`;
    const can = k.booPrice ? boo >= k.booPrice : total >= k.price;
    return `<div class="item"><div><div class="title">${k.icon} ${esc(k.name)}</div>
      <div class="muted small">${statStr(k.stats)}${k.counters ? ` · counters ${k.counters}s` : ''}</div></div>
      ${p.costume === id ? '<span class="muted">Wearing</span>' : owned ? `<button class="btn small" data-equip="${id}">Wear</button>` : `<button class="btn small primary" data-buy="costume:${id}" ${can ? '' : 'disabled'}>${price}</button>`}</div>`;
  };
  $('#tab-shop').innerHTML = `
    <p class="muted small">You have ${total} 🍬 (stash spent first). Spent candy leaves the economy for good.</p>
    <h3>Costumes</h3><div class="list">${Object.entries(c.costumes).map(costumeRow).join('')}</div>
    <h3 class="section">Boosts</h3><div class="list">${Object.entries(c.boosts).map(([id, b]) => `
      <div class="item"><div><div class="title">${b.icon} ${esc(b.name)}</div><div class="muted small">${esc(b.text)}</div></div>
      <button class="btn small primary" data-buy="boost:${id}" ${total < b.price ? 'disabled' : ''}>${b.price} 🍬</button></div>`).join('')}</div>
    <h3 class="section">Upgrades</h3><div class="list">${Object.entries(c.upgrades).map(([id, u]) => `
      <div class="item"><div class="title">${u.icon} ${esc(u.name)}</div>
      <button class="btn small primary" data-buy="upgrade:${id}" ${total < u.price ? 'disabled' : ''}>${u.price} 🍬</button></div>`).join('')}</div>
    <h3 class="section">Daily cosmetic raffle</h3>
    <div class="item"><div><div class="title">${c.costumes[c.raffle.prizeCostume].icon} ${esc(c.costumes[c.raffle.prizeCostume].name)} costume</div>
      <div class="muted small">${p.raffleTickets}/${c.raffle.maxTicketsPerDay} tickets today · drawn at midnight UTC</div></div>
      <button class="btn small primary" data-act="raffle" ${total < c.raffle.ticketPrice || p.raffleTickets >= c.raffle.maxTicketsPerDay ? 'disabled' : ''}>${c.raffle.ticketPrice} 🍬</button></div>`;
}

function renderBoard() {
  const houses = S.world.houses.filter((h) => !h.secret).sort((a, b) => b.jackpotsToday - a.jackpotsToday || b.legendariesToday - a.legendariesToday || b.reputation - a.reputation);
  $('#tab-board').innerHTML = `
    <h3>House Board</h3>
    <p class="muted small">Reputation is earned from trust-weighted visits. ⚠️ means the owner scheduled a behavior change.</p>
    <div class="list">${houses.map((h) => `
      <div class="item" data-house="${h.id}" style="cursor:pointer">
        <div><div class="title">${h.icon} #${h.id} ${esc(h.name)} ${h.hot ? '🔥' : ''}${h.pendingDial ? '⚠️' : ''}</div>
        <div class="muted small">${h.jackpotsToday ? `🎃 ${h.jackpotsToday} jackpot${h.jackpotsToday > 1 ? 's' : ''} today · ` : ''}${h.legendariesToday ? `👑 ${h.legendariesToday} legendary · ` : ''}${h.visitsToday} visits today${h.owner ? ` · ${esc(h.owner.name)}` : ''}</div></div>
        <span class="rep ${repClass(h.reputation)}">${h.reputation}</span></div>`).join('')}</div>`;
}

async function renderLeaders() {
  const lb = await api(`leaderboard?division=${S.division}`);
  const unit = (k) => (['valuableHouses'].includes(k) ? `$${sym()}` : k === 'notorious' ? 'rep' : '');
  const board = (k, b) => `<div class="lb"><h3>${esc(b.title)}</h3>${b.rows.length ? `<ol>${b.rows.map((r) => `<li>${r.icon || S.catalog.costumes[r.costume]?.icon || ''} ${esc(r.name)} ${r.level ? `<span class="muted small">Lv ${r.level}</span>` : ''}${r.owner ? `<span class="muted small"> · ${esc(r.owner)}</span>` : ''}<span>${r.value.toLocaleString()} ${unit(k)}</span></li>`).join('')}</ol>` : '<p class="muted small">No one yet. Could be you.</p>'}</div>`;
  $('#tab-leaders').innerHTML = `
    <div class="inline-form"><select id="division" class="inp">${['all', 'novice', 'regular', 'veteran'].map((d) => `<option value="${d}" ${d === S.division ? 'selected' : ''}>${d === 'all' ? 'All levels' : d[0].toUpperCase() + d.slice(1) + ' division'}</option>`).join('')}</select></div>
    <h3 class="section">Trick-or-Treaters</h3>
    ${['candy', 'houses', 'monstersDefeated', 'scaresSurvived', 'legendaries', 'richest'].map((k) => board(k, lb[k])).join('')}
    <h3 class="section">Monsters</h3>
    ${['playersScared', 'candyStolen', 'richestMonster', 'notorious'].map((k) => board(k, lb[k])).join('')}
    <h3 class="section">Houses</h3>
    ${['famousHouses', 'valuableHouses', 'notoriousHouses'].map((k) => board(k, lb[k])).join('')}`;
  $('#division').onchange = (e) => {
    S.division = e.target.value;
    renderLeaders();
  };
}

async function renderFeed() {
  const feed = await api('feed');
  const p = S.player;
  $('#tab-feed').innerHTML = `
    ${p.inbox.length ? `<h3>Your notifications</h3>${p.inbox.map((n) => `<div class="inbox-item">${esc(n.text)} <span class="muted small">${timeAgo(n.at)}</span></div>`).join('')}` : ''}
    <h3 class="section">Post a bounty</h3>
    <p class="muted small">A monster robbed you? Put candy on their head. Whoever beats their lair collects.</p>
    <div class="inline-form"><input id="bounty-name" placeholder="Monster's name"><input id="bounty-amt" type="number" min="10" value="20" style="max-width:80px"><button class="btn small" data-act="bounty">Post</button></div>
    <h3 class="section">The Street Report</h3>
    <p class="muted small">${S.world.jackpotsLeftToday} Golden Pumpkin${S.world.jackpotsLeftToday === 1 ? '' : 's'} left on the street today.</p>
    ${feed.length ? feed.map((f) => `<div class="feed-item"><time>${timeAgo(f.at)}</time>${esc(f.text)}</div>`).join('') : '<p class="muted">Nothing yet. Go make some noise.</p>'}`;
}

function renderMe() {
  const p = S.player;
  const c = S.catalog;
  const ss = p.seasonStats;
  const owned = c.cards.filter((x) => p.cards[x.id] > 0);
  $('#tab-me').innerHTML = `
    <h3>${c.costumes[p.costume].icon} ${esc(p.name)} · Level ${p.level}</h3>
    <div class="row-actions"><button class="btn small primary" data-act="playercard">📸 Share my player card</button></div>
    <div class="kv">
      ${['courage', 'sneak', 'luck'].map((k) => `<div>${k[0].toUpperCase() + k.slice(1)}<b>${p.stats[k]}</b>${p.trained[k] < 5 ? `<button class="btn small" data-train="${k}">Train · ${p.trainCosts[k]} 🍬</button>` : '<span class="muted small">maxed</span>'}</div>`).join('')}
      <div>Lucky Candles<b>${p.items.candle}</b></div>
      <div>Candy this season<b>${ss.earned}</b></div>
      <div>Houses visited<b>${ss.housesVisited}</b></div>
      <div>Scares survived<b>${ss.scaresSurvived}</b></div>
      <div>Monsters beaten<b>${ss.ambushesWon}</b></div>
      <div>Biggest haul<b>${ss.biggestReward ? `${ss.biggestReward.amount} 🍬` : '—'}</b></div>
      <div>Rare guaranteed in<b>${p.pityLimit - p.pity} knocks</b></div>
    </div>
    <h3 class="section">Monster cards <span class="muted small">(${owned.length}/${c.cards.length})</span></h3>
    <p class="muted small">Original cards. ${c.cardRules.craftDuplicates} copies + ${c.cardRules.craftCost} 🍬 crafts a higher rarity.${p.deepEconomy ? ' Epic and Legendary cards can be minted to your wallet.' : ''}</p>
    <div class="list">${owned.length ? owned.map((x) => `<div class="item small"><span class="r-${x.rarity}">🃏 ${esc(x.name)} ×${p.cards[x.id]}</span><span class="row-actions" style="margin:0">
      ${p.cards[x.id] >= c.cardRules.craftDuplicates && x.rarity !== 'legendary' ? `<button class="btn small" data-craft="${x.id}">Craft</button>` : ''}
      ${p.deepEconomy && ['epic', 'legendary'].includes(x.rarity) ? `<button class="btn small" data-mint="${x.id}">Mint</button>` : ''}</span></div>`).join('') : '<p class="muted small">No cards yet. Some doors have them taped on.</p>'}</div>
    <h3 class="section">Trophies</h3>
    <div class="pill-row">${p.trophies.length ? p.trophies.map((t) => `<span class="chip">🏆 ${esc(t)}</span>`).join('') : '<span class="muted small">None yet.</span>'}</div>
    <h3 class="section">Real-world prizes</h3>
    <p class="muted small">Earned by milestones and season rank, never by a random roll. No purchase necessary.</p>
    <div class="list">${p.prizes.map((pr) => `<div class="item small"><div><div class="title">${esc(pr.name)}</div><div class="muted small">${esc(pr.progress)}</div></div>
      ${pr.requested ? '<span class="muted">Requested</span>' : `<button class="btn small ${pr.met ? 'primary' : ''}" data-prize="${pr.id}" ${pr.met ? '' : 'disabled'}>Redeem</button>`}</div>`).join('')}</div>
    <h3 class="section">Monster field guide</h3>
    <div class="list">${c.npcMonsters.map((m) => `<div class="item small"><span>${esc(m.name)} the ${esc(m.type)}</span><span class="muted">weak to ${c.counters[c.monsterCounters[m.type]].icon} ${esc(c.counters[c.monsterCounters[m.type]].name)}</span></div>`).join('')}</div>
    <p class="section"><button class="btn small" id="btn-logout">Log out</button></p>`;
  $('#btn-logout').onclick = () => confirm('Log out? Your progress is tied to this browser.') && logout();
}

async function renderStreets() {
  const p = S.player;
  if (!p.deepEconomy) return;
  const w = p.wallet;
  const m = p.monster;
  const [market, econ, chain] = await Promise.all([api('market'), api('economy'), api('chain')]);
  const lic = m.license;
  const myHouses = S.world.houses.filter((h) => w.houses.includes(h.id));
  $('#tab-streets').innerHTML = `
    <h3>Wallet</h3>
    <div class="statcard">
      <div class="row"><span>Address</span><span class="mono">${esc(w.address.slice(0, 14))}…</span></div>
      <div class="row"><span>$${sym()}</span><b>${w.boo}</b></div>
      <div class="row"><span>Claimable</span><b>${w.claimable}</b></div>
      <div class="row"><span>Monster bond</span><b>${lic.staked}</b></div>
    </div>
    <div class="row-actions">
      <button class="btn small primary" data-act="claim" ${w.claimable ? '' : 'disabled'}>Claim ${w.claimable} $${sym()}</button>
      <button class="btn small" data-act="faucet" ${w.faucetUsedToday ? 'disabled' : ''}>Get devnet $${sym()}</button>
    </div>
    <p class="muted small">Devnet: $${sym()} here is test currency on a simulated chain.</p>

    <h3 class="section">Become a monster</h3>
    ${m.type ? `
      <div class="statcard">
        <div class="row"><span>${m.icon} ${esc(m.typeName)}</span><b>Rep ${m.rep}/100</b></div>
        <div class="row"><span>Fright</span><b>${m.fright}/${m.frightMax}</b></div>
        <div class="row"><span>Perk</span><span>${esc(m.perk)}</span></div>
        <div class="row"><span>Weak to</span><span>${S.catalog.counters[m.counter].icon} ${esc(S.catalog.counters[m.counter].name)}</span></div>
        <div class="row"><span>Earned (pending)</span><b>${m.pendingBoo} $${sym()}</b></div>
        ${m.bounty ? `<div class="row"><span>Bounty on you</span><b>${m.bounty} 🍬</b></div>` : ''}
      </div>
      ${m.stunnedMs ? `<div class="warn">Stunned for ${fmtMs(m.stunnedMs)} after a failed scare.</div>` : ''}
      <div class="row-actions"><button class="btn small" data-act="mclaim" ${m.pendingBoo ? '' : 'disabled'}>Collect earnings</button></div>
      <p class="small">Lairs (${m.lairs.length}/${m.maxLairs}): ${m.lairs.length ? m.lairs.map((l) => `<span class="chip">${l.kind === 'trap' ? '🪤' : '🧟'} #${l.houseId} · ${fmtMs(l.expiresMs)}</span>`).join(' ') : '<span class="muted">none. Pick a house and lurk from its porch.</span>'}</p>
      <p class="muted small">Failed scares cost Fright, a candy fine and 5% of pending earnings. Your bond is only slashed for cheating.</p>`
    : `
      <p class="small">Stake <b>${lic.required} $${sym()}</b> as a bond to get a Monster License. It's returned when you quit; it's only slashed for botting or collusion.</p>
      ${lic.staked < lic.required ? `<div class="row-actions"><button class="btn small primary" data-act="stake" ${w.boo >= lic.required - lic.staked ? '' : 'disabled'}>Stake ${lic.required - lic.staked} $${sym()}</button></div>`
        : lic.warmupLeftMs ? `<div class="warn">Bond settling: ${fmtMs(lic.warmupLeftMs)} left. Licenses need a held stake, not a borrowed one.</div>` : ''}
      <div class="monster-types">${Object.entries(S.catalog.monsterTypes).map(([id, t]) => `<button class="btn" data-become="${id}" ${lic.active ? '' : 'disabled'}><b>${t.icon} ${esc(t.name)}</b><br><span class="muted small">${esc(t.perk)}</span></button>`).join('')}</div>`}

    <h3 class="section">My houses</h3>
    ${myHouses.length ? `<div class="list">${myHouses.map((h) => `<div class="item" data-house="${h.id}" style="cursor:pointer"><div class="title">${h.icon} #${h.id} ${esc(h.name)}</div><span class="rep ${repClass(h.reputation)}">${h.reputation}</span></div>`).join('')}</div>`
      : '<p class="muted small">No deeds yet. Open any unowned house\'s porch to buy it. Owners earn from real visitor activity, not from new buyers.</p>'}

    <h3 class="section">Market</h3>
    ${market.length ? `<div class="list">${market.map((l) => `<div class="item" data-house="${l.houseId}" style="cursor:pointer"><div><div class="title">${l.icon} #${l.houseId} ${esc(l.name)}</div><div class="muted small">by ${esc(l.seller)} · rep ${l.reputation}</div></div><b>${l.price} $${sym()}</b></div>`).join('')}</div>` : '<p class="muted small">No houses for sale.</p>'}

    <h3 class="section">Economy</h3>
    <div class="statcard">
      <div class="row"><span>Candy in / out</span><b>${econ.candy.totalIn} / ${econ.candy.totalOut}</b></div>
      <div class="row"><span>Sink ratio</span><b>${econ.candy.sinkRatio ?? '—'}</b></div>
      <div class="row"><span>$${sym()} supply</span><b>${econ.token.supply.toLocaleString()}</b></div>
      <div class="row"><span>Burned</span><b>${econ.token.burned.toLocaleString()}</b></div>
      <div class="row"><span>Today's revenue</span><b>${econ.token.epochRevenue}</b></div>
    </div>

    <h3 class="section">Chain <span class="muted small">height ${chain.height} · ${chain.valid ? '✓ valid' : '✗ broken'}</span></h3>
    ${chain.blocks.slice(0, 8).map((b) => `<div class="block mono">#${b.height} ${esc(b.tx.type)} ${b.tx.amt ? `${b.tx.amt} ` : ''}${esc(b.tx.memo || b.tx.kind || b.tx.id || '')}</div>`).join('')}`;
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${Math.max(0, s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---------- interactions ----------

async function selectHouse(id, { scroll = false } = {}) {
  S.selected = id;
  S.houseDetail = await api(`house/${id}`);
  S.tab = 'porch';
  renderStreet();
  renderTab();
  if (scroll && matchMedia('(max-width: 960px)').matches) $('.side').scrollIntoView({ behavior: 'smooth' });
}

async function reloadHouse() {
  await refreshWorld();
  if (S.selected) S.houseDetail = await api(`house/${S.selected}`);
  renderAll();
}

const actions = {
  till: async () => toast(`Collected ${(await api('deed/till', { houseId: S.selected })).claimed} 🍬`),
  lantern: async () => (await api('deed/lantern', { houseId: S.selected }), toast('🏮 Lantern upgraded')),
  dial: async () => (await api('deed/dial', { houseId: S.selected, mode: $('#dial').value }), toast('Behavior change scheduled. It takes 24h.')),
  list: async () => (await api('market/list', { houseId: S.selected, price: Number($('#list-price').value) }), toast('Listed')),
  delist: async () => api('market/cancel', { houseId: S.selected }),
  deed: async () => (await api('deed/buy', { houseId: S.selected }), toast('🏠 You own this house now!')),
  buylisting: async () => (await api('market/buy', { houseId: S.selected }), toast('🏠 Bought!')),
  'lair-ambush': async () => (await api('monster/lair', { houseId: S.selected, kind: 'ambush' }), toast('🧟 Ambush set. Now wait in the bushes...')),
  'lair-trap': async () => (await api('monster/lair', { houseId: S.selected, kind: 'trap' }), toast('🪤 Trap set.')),
  raffle: async () => (await api('raffle', { tickets: 1 }), toast('🎟️ Ticket bought')),
  bounty: async () => (await api('bounty', { monster: $('#bounty-name').value, amount: Number($('#bounty-amt').value) }), toast('Bounty posted')),
  claim: async () => toast(`Claimed ${(await api('claim', {})).claimed} $${sym()}`),
  faucet: async () => toast(`+${(await api('faucet', {})).received} devnet $${sym()}`),
  stake: async () => (await api('monster/stake', { amount: S.player.monster.license.required - S.player.monster.license.staked }), toast('Bond staked. It needs to settle before your license is active.')),
  mclaim: async () => toast(`Moved ${(await api('monster/claim', {})).claimed} $${sym()} to claimable`),
  playercard: async () => showPlayerCard(),
};

document.addEventListener('click', async (e) => {
  const el = (sel) => e.target.closest(sel);
  try {
    let x;
    if ((x = el('[data-house]'))) return await selectHouse(Number(x.dataset.house), { scroll: true });
    if ((x = el('[data-hood]'))) {
      S.hood = x.dataset.hood;
      return renderStreet();
    }
    if ((x = el('[data-tab]'))) {
      S.tab = x.dataset.tab;
      return renderTab();
    }
    if (el('[data-close]')) return closeModal();
    if ((x = el('[data-act]')) && actions[x.dataset.act]) {
      await actions[x.dataset.act]();
    } else if ((x = el('[data-buy]'))) {
      const [kind, itemId] = x.dataset.buy.split(':');
      await api('buy', { kind, itemId });
      toast('Purchased!');
    } else if ((x = el('[data-equip]'))) await api('equip', { costumeId: x.dataset.equip });
    else if ((x = el('[data-claim]'))) {
      const r = await api('mission', { missionId: x.dataset.claim });
      toast(`Mission complete! +${r.reward.candy} 🍬, +${r.reward.knocks} knocks`);
    } else if ((x = el('[data-train]'))) {
      await api('train', { stat: x.dataset.train });
      toast('Training complete!');
    } else if ((x = el('[data-unlock]'))) {
      await api('unlock', { neighborhood: x.dataset.unlock });
      toast('New neighborhood unlocked!');
    } else if ((x = el('[data-craft]'))) {
      const { card } = await api('craft', { cardId: x.dataset.craft });
      toast(`Crafted: ${card.name} (${card.rarity})`);
    } else if ((x = el('[data-mint]'))) {
      const { nft } = await api('mint-card', { cardId: x.dataset.mint });
      toast(`Minted ${nft.meta.name} to your wallet`);
    } else if ((x = el('[data-prize]'))) {
      await api('prize', { prizeId: x.dataset.prize });
      toast('Prize requested! We will be in touch to arrange delivery.');
    } else if ((x = el('[data-become]'))) {
      await api('monster/become', { type: x.dataset.become });
      toast('You are a monster now. Lurk from any porch.');
    } else return;
    await reloadHouse();
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-home').addEventListener('click', async () => {
  try {
    const r = await api('bank', {});
    showModal(`<div class="big-icon">🏡</div><h2>Home sweet home</h2>
      <p>You banked <b>${r.banked} 🍬</b>. It's safe in your stash now.</p>
      ${r.stashFull ? '<p class="muted small">Your stash is full! Buy a Bigger Stash in the shop.</p>' : ''}
      <p class="muted small">The night calms down while you're inside. Danger resets to Dusk.</p>
      <div class="actions"><button class="btn primary" data-close>Back out there</button></div>`);
    renderAll();
  } catch (err) {
    toast(err.message);
  }
});

// The knock gesture: press and release. The server checks the timing.
function bindDoor() {
  const door = $('#door');
  if (!door || door.classList.contains('disabled')) return;
  let down = 0;
  door.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    down = performance.now();
    door.classList.add('pressed');
    door.textContent = 'Knock knock…';
  });
  const release = () => {
    if (!down) return;
    const holdMs = Math.round(performance.now() - down);
    down = 0;
    door.classList.remove('pressed');
    doKnock(holdMs);
  };
  door.addEventListener('pointerup', release);
  door.addEventListener('pointerleave', () => down && release());
}

async function doKnock(holdMs) {
  if (S.busy) return;
  S.busy = true;
  try {
    const { result } = await api('knock', { houseId: S.selected, gesture: { holdMs } });
    renderHud();
    if (result.scare) await runScare(result.scare);
    else if (result.ambush) await runAmbush(result.ambush);
    else showResult(result);
    await reloadHouse();
    if (S.player.gift) toast(`🕯️ ${S.player.gift}`, 5000);
  } catch (err) {
    toast(err.message);
    renderPorch();
  } finally {
    S.busy = false;
  }
}

function resumePending(pend) {
  (pend.type === 'scare' ? runScare(pend) : runAmbush(pend)).then(reloadHouse);
}

function runScare(scare) {
  return new Promise((resolve) => {
    showModal(`<div class="big-icon">🚪</div><h2>Something is behind the door…</h2>
      <p class="muted small">Wait for it… tap the moment it jumps out. Don't flinch!</p>
      <div id="scare-zone" class="scare-zone">…</div>`, { locked: true });
    const zone = $('#scare-zone');
    let sent = false;
    const send = async () => {
      if (sent) return;
      sent = true;
      clearTimeout(goTimer);
      clearTimeout(lateTimer);
      try {
        showResult((await api('scare', { id: scare.id })).result);
      } catch (err) {
        toast(err.message);
        closeModal();
      }
      resolve();
    };
    const goTimer = setTimeout(() => {
      zone.classList.add('go');
      zone.textContent = '👻 BOO! TAP NOW!';
    }, scare.delayMs);
    const lateTimer = setTimeout(send, scare.delayMs + scare.windowMs + 1500);
    zone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      send();
    });
  });
}

function runAmbush(ambush) {
  return new Promise((resolve) => {
    showModal(`<div class="big-icon">${ambush.player ? '😈' : '😱'}</div>
      <h2>${ambush.player ? 'A player monster!' : 'Ambush!'}</h2>
      <p><i>${esc(ambush.clue)}</i></p>
      <p class="muted small">Read the clue. Pick your defense:</p>
      <div class="counters six">${Object.entries(ambush.counters).map(([id, c]) => `<button class="btn" data-counter="${id}">${c.icon}<br>${esc(c.name)}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" id="bribe"> Throw ${ambush.candyThrowCost} candy as a distraction (-15%)</label>`, { locked: true });
    document.querySelectorAll('[data-counter]').forEach((b) => {
      b.addEventListener('click', async () => {
        document.querySelectorAll('[data-counter]').forEach((x) => (x.disabled = true));
        try {
          showResult((await api('ambush', { id: ambush.id, counter: b.dataset.counter, bribe: $('#bribe').checked })).result);
        } catch (err) {
          toast(err.message);
          closeModal();
        }
        resolve();
      });
    });
  });
}

function showResult(r) {
  const jackpot = r.jackpot;
  let icon = ICON[jackpot ? 'jackpot' : r.outcome];
  let title = LABEL[r.outcome];
  if (r.outcome === 'scare') [icon, title] = r.won ? ['😎', 'Scare survived!'] : ['😱', 'Gotcha!'];
  if (r.outcome === 'ambush') [icon, title] = r.won ? ['💪', 'Monster repelled!'] : ['🧟', `Robbed by ${r.monster.name}!`];
  if (r.outcome === 'trap') [icon, title] = r.won ? ['😏', 'Trap dodged!'] : ['🪤', 'SNAP!'];
  if (jackpot) title = 'JACKPOT!';
  const card = r.card && S.catalog.cards.find((c) => c.id === r.card.id);
  const extras = [
    r.spilled ? `<p class="muted small">Bag full: ${r.spilled} candy spilled. Walk home to bank!</p>` : '',
    card ? `<p class="r-${card.rarity}">🃏 <b>${esc(card.name)}</b> (${card.rarity})</p>` : '',
    r.boo ? `<p>🪙 <b>+${r.boo} $${sym()}</b> ${S.player.deepEconomy ? 'added to claimable' : 'saved for you. You\'ll find out what it is soon...'}</p>` : '',
    r.secret ? `<p>🗝️ <b>${esc(r.secret.name)}</b> is yours to visit for ${r.secret.knocks} knocks. Check the Secret street.</p>` : '',
    r.trophy ? `<p>🏆 Trophy: <b>${esc(r.trophy)}</b></p>` : '',
    r.bounty ? `<p>💰 You collected a <b>${r.bounty} candy</b> bounty!</p>` : '',
    r.pity ? '<p class="muted small">Your luck had to turn eventually.</p>' : '',
    r.outcome === 'ambush' ? `<p class="muted small">${esc(r.monster.name)} the ${esc(r.monster.type)}${r.monster.player ? ' (a player!)' : ''} is weak to ${esc(S.catalog.counters[r.monster.counter].name)}. Steal chance was ${r.chance}%.</p>` : '',
    r.shieldMinutes ? `<p class="muted small">🛡️ Shielded from monsters for ${r.shieldMinutes} minutes.</p>` : '',
    r.hot ? '<p class="muted small">🔥 Hot House: double candy!</p>' : '',
  ].join('');
  const delta = r.candy ? `<div class="delta ${r.candy > 0 ? 'pos' : 'neg'}">${r.candy > 0 ? '+' : ''}${r.candy} 🍬</div>` : '';
  const shareworthy = !['candy'].includes(r.outcome) || r.candy >= 30;
  showModal(`<div class="outcome-${jackpot ? 'jackpot' : r.outcome}">
      <div class="big-icon">${icon}</div><h2>${esc(title)}</h2><p>${esc(r.text)}</p>${delta}${extras}
      <div class="actions">${shareworthy ? '<button class="btn" id="btn-share">📸 Share</button>' : ''}<button class="btn primary" data-close>Next door</button></div></div>`);
  if (shareworthy) $('#btn-share').onclick = () => showMomentCard(r, icon, title);
}

// ---------- share cards ----------

function canvasBase() {
  const cv = document.createElement('canvas');
  cv.width = 1200;
  cv.height = 630;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 630);
  grad.addColorStop(0, '#2a1d47');
  grad.addColorStop(1, '#120d1d');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1200, 630);
  g.fillStyle = '#ff8a1f';
  g.font = 'bold 44px system-ui, sans-serif';
  g.fillText('🎃 Knock', 60, 90);
  g.fillStyle = '#a99cc8';
  g.font = '28px system-ui, sans-serif';
  g.fillText('90% Tricks. 10% Treats.', 840, 90);
  return { cv, g };
}

function momentLine(r, title) {
  const at = `House #${r.houseId} ${r.houseName}`;
  if (r.outcome === 'ambush') return r.won ? `I fought off ${r.monster.name} the ${r.monster.type} at ${at}` : `${r.monster.name} stole ${-r.candy} candy from me at ${at}`;
  if (r.outcome === 'trap') return r.won ? `I dodged a monster's trap at ${at}` : `Walked straight into a trap at ${at}`;
  if (r.outcome === 'scare') return r.won ? `I survived ${at}` : `${at} scared the candy out of me`;
  if (r.outcome === 'trick') return `Got tricked at ${at}: ${r.text}`;
  if (r.secret) return `I found a secret house: ${r.secret.name}`;
  if (r.trophy) return `Found a ${r.trophy} at ${at}!`;
  if (r.card) return `Pulled ${r.card.name} at ${at}`;
  return `${title} at ${at}${r.candy > 0 ? `: +${r.candy} candy` : ''}`;
}

function showMomentCard(r, icon, title) {
  const line = momentLine(r, title);
  const { cv, g } = canvasBase();
  g.font = '160px system-ui, sans-serif';
  g.fillText(icon, 60, 340);
  g.fillStyle = '#f1eaff';
  g.font = 'bold 64px system-ui, sans-serif';
  g.fillText(title, 280, 250);
  g.font = '36px system-ui, sans-serif';
  wrap(g, line, 280, 320, 860, 46);
  g.fillStyle = '#a99cc8';
  g.font = '28px system-ui, sans-serif';
  g.fillText(`${S.player.name} · Lv ${S.player.level}`, 60, 570);
  shareModal(cv, `${line} 🎃 #KnockGame`, `knock-${r.outcome}.png`);
}

function showPlayerCard() {
  const p = S.player;
  const ss = p.seasonStats;
  const { cv, g } = canvasBase();
  const costume = S.catalog.costumes[p.costume];
  const role = p.monster?.type ? `${p.monster.typeName} · Monster` : 'Trick-or-Treater';
  g.font = '150px system-ui, sans-serif';
  g.fillText(p.monster?.type ? p.monster.icon : costume.icon, 60, 320);
  g.fillStyle = '#f1eaff';
  g.font = 'bold 60px system-ui, sans-serif';
  g.fillText(p.name, 260, 200);
  g.fillStyle = '#ffb35c';
  g.font = '32px system-ui, sans-serif';
  g.fillText(`${role} · Level ${p.level}${p.rank ? ` · Rank #${p.rank}` : ''}`, 260, 250);
  const rows = [
    ['Candy', ss.earned], ['Houses visited', ss.housesVisited], ['Scares survived', ss.scaresSurvived],
    ['Biggest reward', ss.biggestReward ? `${ss.biggestReward.amount} at #${ss.biggestReward.houseId}` : '—'],
    [p.monster?.type ? 'Players scared' : 'Monsters beaten', p.monster?.type ? ss.scaredPlayers : ss.ambushesWon],
    ['Reputation', p.monster?.type ? `${p.monster.rep}/100` : `${p.trophies.length} trophies`],
  ];
  g.font = '30px system-ui, sans-serif';
  rows.forEach(([k, v], i) => {
    const x = 260 + (i % 2) * 450;
    const y = 330 + Math.floor(i / 2) * 92;
    g.fillStyle = '#a99cc8';
    g.fillText(k, x, y);
    g.fillStyle = '#f1eaff';
    g.font = 'bold 34px system-ui, sans-serif';
    g.fillText(String(v), x, y + 38);
    g.font = '30px system-ui, sans-serif';
  });
  shareModal(cv, `${p.name}: ${role}, ${ss.earned} candy, ${ss.housesVisited} houses. Can you beat me? 🎃 #KnockGame`, 'knock-player-card.png');
}

function shareModal(cv, text, filename) {
  const url = cv.toDataURL('image/png');
  showModal(`<h2>Share it</h2><img class="share-canvas" src="${url}" alt="share card">
    <div class="actions">
      <a class="btn primary" download="${filename}" href="${url}">⬇️ Download</a>
      <a class="btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}">Post to X</a>
      <button class="btn" id="btn-copy">Copy text</button>
      <button class="btn" data-close>Close</button>
    </div>`);
  $('#btn-copy').onclick = () => navigator.clipboard?.writeText(text).then(() => toast('Copied!'));
}

function wrap(g, text, x, y, maxW, lh) {
  let line = '';
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y);
      line = word;
      y += lh;
    } else line = test;
  }
  g.fillText(line, x, y);
}

// ---------- modal ----------

function showModal(html, { locked = false } = {}) {
  $('#modal-card').innerHTML = html;
  $('#modal').hidden = false;
  $('#modal').dataset.locked = locked ? '1' : '';
}
function closeModal() {
  $('#modal').hidden = true;
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' && !$('#modal').dataset.locked) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').dataset.locked) closeModal();
});

boot();
