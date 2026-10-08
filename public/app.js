// Knock web client. All randomness and rules live on the server; this file
// only renders state and captures player input.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  token: localStorage.getItem('knock.token'),
  player: null,
  world: null,
  catalog: null,
  selected: null,
  houseDetail: null,
  tab: 'porch',
  busy: false,
};

const OUTCOME_ICON = { candy: '🍬', rare: '🍭', shard: '💎', legendary: '👑', jackpot: '🎃', trick: '🐕', scare: '👻', ambush: '🧟' };
const OUTCOME_LABEL = { candy: 'Candy', rare: 'Rare candy', shard: 'Shard', legendary: 'Legendary', trick: 'Trick', scare: 'Scare', ambush: 'Ambush' };

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
  return data;
}

function toast(msg, ms = 2600) {
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
    const me = await api('me');
    S.player = me.player;
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
  const { token, player } = await api('login', { name: $('#login-name').value });
  S.token = token;
  localStorage.setItem('knock.token', token);
  S.player = player;
  await startGame();
  const costume = S.catalog.costumes[player.costume];
  showModal(`
    <div class="big-icon">${costume.icon}</div>
    <h2>Welcome to Hollow Lane, ${esc(player.name)}!</h2>
    <p>You're a kid in a ${esc(costume.name)} costume with a bag and a curfew.</p>
    <p class="muted small">Tap a house, then <b>press and release the door</b> to knock.
      Candy in your <b>bag</b> can be lost; walk home to <b>bank</b> it in your stash.</p>
    <div class="actions"><button class="btn primary big" data-close>Let's go 🎃</button></div>`);
});

async function startGame() {
  $('#login').hidden = true;
  $('#game').hidden = false;
  await refreshWorld();
  if (!S.selected) S.selected = S.world.route[0] || 1;
  await selectHouse(S.selected);
  renderAll();
  if (S.player.pending) resumePending(S.player.pending);
  setInterval(tick, 1000);
  setInterval(() => refreshWorld().then(renderStreet), 15000);
}

async function refreshWorld() {
  S.world = await api('world');
}

function tick() {
  if (!S.player) return;
  if (S.player.nextRegenMs != null) {
    S.player.nextRegenMs -= 1000;
    if (S.player.nextRegenMs <= 0) api('me').then((m) => { S.player = m.player; renderHud(); });
  }
  if (S.player.shieldMs > 0) S.player.shieldMs = Math.max(0, S.player.shieldMs - 1000);
  renderHud();
}

// ---------- rendering ----------

function renderAll() {
  renderHud();
  renderStreet();
  renderTab();
}

function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderHud() {
  const p = S.player;
  const costume = S.catalog.costumes[p.costume];
  $('#hud-player').textContent = `${costume.icon} ${p.name} · Lv ${p.level}`;
  $('#hud-knocks').textContent = p.knocks;
  $('#hud-regen').textContent = p.nextRegenMs != null ? `+1 in ${fmtMs(p.nextRegenMs)}` : 'full';
  $('#hud-bag').textContent = `${p.bag}/${p.bagCapacity}`;
  $('#hud-bag-bar').style.width = `${(100 * p.bag) / p.bagCapacity}%`;
  $('#hud-stash').textContent = `${p.stash}`;
  $('#hud-night').textContent = S.world?.nightfallNames[p.nightfall] ?? '';
  $('#hud-night-bar').style.width = `${(100 * Math.min(p.nightKnocks, 32)) / 32}%`;
  $('#hud-streak').textContent = `🔥 ${p.streak}d`;
  const banner = $('#shield-banner');
  banner.hidden = !(p.shieldMs > 0);
  banner.textContent = `🛡️ Shielded from monsters for ${fmtMs(p.shieldMs)}`;
  $('#btn-home').disabled = p.bag === 0;
}

function repClass(r) {
  return r >= 65 ? 'good' : r <= 35 ? 'bad' : '';
}

function renderStreet() {
  const w = S.world;
  $('#street-name').textContent = `${w.season.neighborhood} · ${w.season.name}`;
  const visited = new Set(S.player.routeVisited);
  $('#street').innerHTML = w.houses.map((h) => `
    <button class="house ${h.hot ? 'hot' : ''} ${S.selected === h.id ? 'selected' : ''}" data-house="${h.id}">
      <div class="badges">${h.hot ? '<span title="Hot House: 2× candy">🔥</span>' : ''}${h.onRoute ? `<span class="${visited.has(h.id) ? 'done' : ''}" title="Today's route">⭐</span>` : ''}</div>
      <div class="top"><span class="icon">${h.icon}</span></div>
      <div class="num">#${h.id} · ${esc(h.typeName)} <span class="rep ${repClass(h.reputation)}">${h.reputation}</span></div>
      <div class="name">${esc(h.name)}</div>
      <div class="tell">${esc(h.tell)}</div>
    </button>`).join('');
}

function renderTab() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${S.tab}`));
  ({ porch: renderPorch, missions: renderMissions, shop: renderShop, board: renderBoard, leaders: renderLeaders, feed: renderFeed, me: renderMe })[S.tab]();
}

function renderPorch() {
  const h = S.houseDetail;
  if (!h) return;
  const p = S.player;
  const out = p.knocks < 1;
  $('#tab-porch').innerHTML = `
    <div class="porch-house">
      <span class="icon">${h.icon}</span>
      <div>
        <div class="muted small">#${h.id} · ${esc(h.typeName)} ${h.hot ? '· 🔥 Hot House' : ''}</div>
        <h2>${esc(h.name)}</h2>
        <div class="tell muted small"><i>${esc(h.tell)}</i></div>
      </div>
    </div>
    <div id="door" class="door ${out ? 'disabled' : ''}">${out ? 'The street is quiet…' : 'Press &amp; release to knock'}</div>
    ${out ? '<p class="muted small">Out of knocks. They refill over time, from missions, and every day. Come back at Nightfall!</p>' : ''}
    <div class="kv">
      <div>Reputation<b class="rep ${repClass(h.reputation)}">${h.reputation}/100</b></div>
      <div>Visits today<b>${h.visitsToday}</b></div>
      <div>Jackpots today<b>${h.jackpotsToday}</b></div>
      <div>Scares today<b>${h.scaresToday}</b></div>
      <div>Unique visitors<b>${h.uniqueVisitors}</b></div>
      <div>All-time visits<b>${h.totals.visits}</b></div>
    </div>
    <h3>House log</h3>
    <ul class="log">${h.log.length ? h.log.map((e) => `
      <li><span>${esc(e.player)}</span><span class="o-${e.outcome}">${OUTCOME_ICON[e.detail?.jackpot ? 'jackpot' : e.outcome]} ${OUTCOME_LABEL[e.outcome]}${e.detail?.won === true ? ' (survived)' : e.detail?.won === false ? ' (lost)' : ''}</span><span class="muted">${timeAgo(e.at)}</span></li>`).join('') : '<li class="muted">Nobody has knocked yet today. Be the first.</li>'}
    </ul>`;
  bindDoor();
}

function renderMissions() {
  const p = S.player;
  $('#tab-missions').innerHTML = `
    <h3>Daily missions</h3>
    <div class="list">${p.missions.map((m) => `
      <div class="item">
        <div style="flex:1">
          <div class="title">${esc(m.text)}</div>
          <div class="muted small">+${m.reward.candy} 🍬 to stash · +${m.reward.knocks} knocks</div>
          <div class="progress"><div style="width:${(100 * m.progress) / m.goal}%"></div></div>
        </div>
        ${m.claimed ? '<span class="muted">✓ Done</span>' : `<button class="btn small ${m.progress >= m.goal ? 'primary' : ''}" data-claim="${m.id}" ${m.progress >= m.goal ? '' : 'disabled'}>${m.progress}/${m.goal}</button>`}
      </div>`).join('')}
    </div>
    <h3 style="margin-top:16px">Streak</h3>
    <p>🔥 <b>${p.streak} day${p.streak === 1 ? '' : 's'}</b>. Today's bonus: +${p.streakBonusToday} 🍬. Come back tomorrow for <b>+${p.streakBonusTomorrow}</b>.</p>
    <p class="muted small">Missed a day? One grace day per week keeps your streak alive.</p>
    <h3 style="margin-top:16px">Today's route</h3>
    <p class="small">${S.world.route.map((id) => `<span class="chip">${S.player.routeVisited.includes(id) ? '✓' : '⭐'} #${id}</span>`).join(' ')}</p>`;
}

function renderShop() {
  const p = S.player;
  const c = S.catalog;
  const total = p.bag + p.stash;
  const statStr = (s) => Object.entries(s).map(([k, v]) => `+${v} ${k}`).join(', ') || 'no stat bonus';
  const monsterName = (id) => c.monsters.find((m) => m.id === id)?.type;
  $('#tab-shop').innerHTML = `
    <p class="muted small">You have ${total} 🍬 (stash spent first). Candy spent here leaves the economy for good.</p>
    <h3>Costumes</h3>
    <div class="list">${Object.entries(c.costumes).map(([id, k]) => {
      const owned = p.ownedCostumes.includes(id);
      const worn = p.costume === id;
      return `<div class="item">
        <div><div class="title">${k.icon} ${esc(k.name)}</div>
        <div class="muted small">${statStr(k.stats)}${k.counters ? ` · scares off ${monsterName(k.counters)}s` : ''}</div></div>
        ${worn ? '<span class="muted">Wearing</span>' : owned ? `<button class="btn small" data-equip="${id}">Wear</button>` : `<button class="btn small primary" data-buy="costume:${id}" ${total < k.price ? 'disabled' : ''}>${k.price} 🍬</button>`}
      </div>`;
    }).join('')}</div>
    <h3 style="margin-top:16px">Upgrades</h3>
    <div class="list">${Object.entries(c.upgrades).map(([id, u]) => `
      <div class="item"><div class="title">${u.icon} ${esc(u.name)}</div>
      <button class="btn small primary" data-buy="upgrade:${id}" ${total < u.price ? 'disabled' : ''}>${u.price} 🍬</button></div>`).join('')}
    </div>`;
}

function renderBoard() {
  const houses = [...S.world.houses].sort((a, b) => b.jackpotsToday - a.jackpotsToday || b.legendariesToday - a.legendariesToday || b.reputation - a.reputation);
  $('#tab-board').innerHTML = `
    <h3>House Board</h3>
    <p class="muted small">Reputation is earned from trust-weighted visits. Watch the log: houses can turn.</p>
    <div class="list">${houses.map((h) => `
      <div class="item" data-house="${h.id}" style="cursor:pointer">
        <div><div class="title">${h.icon} #${h.id} ${esc(h.name)} ${h.hot ? '🔥' : ''}</div>
        <div class="muted small">${h.jackpotsToday ? `🎃 ${h.jackpotsToday} jackpot${h.jackpotsToday > 1 ? 's' : ''} today · ` : ''}${h.legendariesToday ? `👑 ${h.legendariesToday} legendary · ` : ''}${h.visitsToday} visits today</div></div>
        <span class="rep ${repClass(h.reputation)}">${h.reputation}</span>
      </div>`).join('')}
    </div>`;
}

async function renderLeaders() {
  const lb = await api('leaderboard');
  const list = (title, rows, unit) => `
    <div class="lb"><h3>${title}</h3>${rows.length ? `<ol>${rows.map((r) => `<li>${S.catalog.costumes[r.costume]?.icon ?? ''} ${esc(r.name)} <span class="muted small">Lv ${r.level}</span><span>${r.value} ${unit}</span></li>`).join('')}</ol>` : '<p class="muted small">No one yet. Could be you.</p>'}</div>`;
  $('#tab-leaders').innerHTML =
    list('🍬 Most candy collected', lb.candy, '') +
    list('🏠 Most houses visited', lb.houses, '') +
    list('👻 Most scares survived', lb.scares, '') +
    `<div class="lb"><h3>☠️ Most Notorious houses</h3>${lb.notoriousHouses.length ? `<ol>${lb.notoriousHouses.map((h) => `<li>${h.icon} #${h.id} ${esc(h.name)}<span>${h.scares} scares</span></li>`).join('')}</ol>` : '<p class="muted small">Quiet night so far.</p>'}</div>`;
}

async function renderFeed() {
  const feed = await api('feed');
  $('#tab-feed').innerHTML = `
    <h3>The Street Report</h3>
    <p class="muted small">${S.world.jackpotsLeftToday} Golden Pumpkin${S.world.jackpotsLeftToday === 1 ? '' : 's'} left on the street today.</p>
    ${feed.length ? feed.map((f) => `<div class="feed-item"><time>${timeAgo(f.at)}</time>${esc(f.text)}</div>`).join('') : '<p class="muted">Nothing yet. Go make some noise.</p>'}`;
}

function renderMe() {
  const p = S.player;
  const c = S.catalog;
  $('#tab-me').innerHTML = `
    <h3>${c.costumes[p.costume].icon} ${esc(p.name)} · Level ${p.level}</h3>
    <div class="kv">
      <div>Courage<b>${p.stats.courage}</b></div>
      <div>Sneak<b>${p.stats.sneak}</b></div>
      <div>Luck<b>${p.stats.luck}</b></div>
      <div>Lucky Candles<b>${p.items.candle}</b></div>
      <div>Candy this season<b>${p.seasonStats.earned}</b></div>
      <div>Houses visited<b>${p.seasonStats.housesVisited}</b></div>
      <div>Scares survived<b>${p.seasonStats.scaresSurvived}</b></div>
      <div>Monsters repelled<b>${p.seasonStats.ambushesWon}</b></div>
      <div>Rare guaranteed in<b>${p.pityLimit - p.pity} knocks</b></div>
      <div>Bag / Stash cap<b>${p.bagCapacity} / ${p.stashCapacity}</b></div>
    </div>
    <h3>Shards <span class="muted small">(collect all 5 for the Full Moon Set)</span></h3>
    <div class="pill-row">${c.shards.map((s) => `<span class="chip" style="opacity:${p.shards[s] ? 1 : 0.4}">💎 ${esc(s)} ×${p.shards[s] || 0}</span>`).join('')}</div>
    <h3 style="margin-top:14px">Trophies</h3>
    <div class="pill-row">${p.trophies.length ? p.trophies.map((t) => `<span class="chip">🏆 ${esc(t)}</span>`).join('') : '<span class="muted small">None yet. Legendary doors are out there.</span>'}</div>
    <h3 style="margin-top:14px">Monster field guide</h3>
    <div class="list">${c.monsters.map((m) => `<div class="item small"><span>${esc(m.name)} the ${esc(m.type)}</span><span class="muted">weak to ${c.counters[m.counter].icon} ${esc(c.counters[m.counter].name)}</span></div>`).join('')}</div>
    <p style="margin-top:16px"><button class="btn small" id="btn-logout">Log out</button></p>`;
  $('#btn-logout').onclick = () => {
    if (confirm('Log out? Your progress is tied to this browser.')) logout();
  };
}

function timeAgo(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---------- interactions ----------

async function selectHouse(id, { scroll = false } = {}) {
  S.selected = id;
  S.houseDetail = await api(`house/${id}`);
  if (S.tab !== 'porch') S.tab = 'porch';
  renderStreet();
  renderTab();
  // On phones the porch sits below the street; bring the door into view.
  if (scroll && matchMedia('(max-width: 960px)').matches) $('.side').scrollIntoView({ behavior: 'smooth' });
}

document.addEventListener('click', async (e) => {
  const houseEl = e.target.closest('[data-house]');
  const tabEl = e.target.closest('[data-tab]');
  const buyEl = e.target.closest('[data-buy]');
  const equipEl = e.target.closest('[data-equip]');
  const claimEl = e.target.closest('[data-claim]');
  try {
    if (houseEl) await selectHouse(Number(houseEl.dataset.house), { scroll: true });
    else if (tabEl) {
      S.tab = tabEl.dataset.tab;
      renderTab();
    } else if (buyEl) {
      const [kind, itemId] = buyEl.dataset.buy.split(':');
      const r = await api('buy', { kind, itemId });
      S.player = r.player;
      toast(kind === 'costume' ? `Now wearing: ${S.catalog.costumes[itemId].name}` : 'Upgrade purchased!');
      renderAll();
    } else if (equipEl) {
      S.player = (await api('equip', { costumeId: equipEl.dataset.equip })).player;
      renderAll();
    } else if (claimEl) {
      const r = await api('mission', { missionId: claimEl.dataset.claim });
      S.player = r.player;
      toast(`Mission complete! +${r.reward.candy} 🍬, +${r.reward.knocks} knocks`);
      renderAll();
    } else if (e.target.closest('[data-close]')) {
      closeModal();
    }
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-home').addEventListener('click', async () => {
  try {
    const r = await api('bank', {});
    S.player = r.player;
    showModal(`
      <div class="big-icon">🏡</div>
      <h2>Home sweet home</h2>
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
  door.addEventListener('pointerleave', () => {
    if (down) release();
  });
}

async function doKnock(holdMs) {
  if (S.busy) return;
  S.busy = true;
  try {
    const { result, player } = await api('knock', { houseId: S.selected, gesture: { holdMs } });
    S.player = player;
    renderHud();
    if (result.scare) await runScare(result.scare, result);
    else if (result.ambush) await runAmbush(result.ambush);
    else showResult(result);
    await refreshAfterAction();
  } catch (err) {
    toast(err.message);
    renderPorch();
  } finally {
    S.busy = false;
  }
}

async function refreshAfterAction() {
  await refreshWorld();
  S.houseDetail = await api(`house/${S.selected}`);
  renderAll();
  if (S.player.gift) {
    toast(`🕯️ ${S.player.gift}`, 5000);
    S.player.gift = null;
  }
}

function resumePending(pend) {
  if (pend.type === 'scare') runScare(pend, {}).then(refreshAfterAction);
  else runAmbush(pend).then(refreshAfterAction);
}

// Scare mini-game: wait for the BOO, then tap. Tapping early = flinch.
function runScare(scare) {
  return new Promise((resolve) => {
    showModal(`
      <div class="big-icon">🚪</div>
      <h2>Something is behind the door…</h2>
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
        const { result, player } = await api('scare', { id: scare.id });
        S.player = player;
        showResult(result);
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

// Ambush: read the clue, pick the right counter.
function runAmbush(ambush) {
  return new Promise((resolve) => {
    showModal(`
      <div class="big-icon">😱</div>
      <h2>Ambush!</h2>
      <p><i>${esc(ambush.clue)}</i></p>
      <p class="muted small">Your costume may help. Pick your defense:</p>
      <div class="counters">${Object.entries(ambush.counters).map(([id, c]) => `<button class="btn" data-counter="${id}">${c.icon} ${esc(c.name)}</button>`).join('')}</div>`, { locked: true });
    document.querySelectorAll('[data-counter]').forEach((b) => {
      b.addEventListener('click', async () => {
        document.querySelectorAll('[data-counter]').forEach((x) => (x.disabled = true));
        try {
          const { result, player } = await api('ambush', { id: ambush.id, counter: b.dataset.counter });
          S.player = player;
          showResult(result);
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
  const jackpot = r.trophy && r.trophy === 'Golden Pumpkin';
  let icon = OUTCOME_ICON[jackpot ? 'jackpot' : r.outcome];
  let title = OUTCOME_LABEL[r.outcome];
  if (r.outcome === 'scare') {
    icon = r.won ? '😎' : '😱';
    title = r.won ? 'Scare survived!' : 'Gotcha!';
  }
  if (r.outcome === 'ambush') {
    icon = r.won ? '💪' : '🧟';
    title = r.won ? 'Monster repelled!' : `Robbed by ${r.monster.name}!`;
  }
  if (jackpot) title = 'JACKPOT!';
  const delta = r.candy ? `<div class="delta ${r.candy > 0 ? 'pos' : 'neg'}">${r.candy > 0 ? '+' : ''}${r.candy} 🍬</div>` : '';
  const extras = [
    r.spilled ? `<p class="muted small">Your bag is full: ${r.spilled} candy spilled on the sidewalk. Walk home to bank!</p>` : '',
    r.shard ? `<p>💎 You found a <b>${esc(r.shard)}</b>.</p>` : '',
    r.setComplete ? `<p>🌕 Full Moon Set complete! +${r.setComplete.candy} 🍬 to stash.</p>` : '',
    r.trophy ? `<p>🏆 Trophy: <b>${esc(r.trophy)}</b></p>` : '',
    r.pity ? '<p class="muted small">Your luck had to turn eventually. (Pity timer)</p>' : '',
    r.outcome === 'ambush' ? `<p class="muted small">It was ${esc(r.monster.name)} the ${esc(r.monster.type)} (weak to ${esc(S.catalog.counters[r.monster.counter].name)}). Steal chance was ${r.chance}%.</p>` : '',
    r.shieldMinutes ? `<p class="muted small">🛡️ You're shielded from monsters for ${r.shieldMinutes} minutes.</p>` : '',
    r.hot ? '<p class="muted small">🔥 Hot House bonus: double candy!</p>' : '',
  ].join('');
  const shareworthy = ['rare', 'legendary', 'trick'].includes(r.outcome) || r.outcome === 'scare' || r.outcome === 'ambush' || r.shard;
  showModal(`
    <div class="outcome-${jackpot ? 'jackpot' : r.outcome}">
      <div class="big-icon">${icon}</div>
      <h2>${esc(title)}</h2>
      <p>${esc(r.text)}</p>
      ${delta}${extras}
      <div class="actions">
        ${shareworthy ? '<button class="btn" id="btn-share">📸 Share</button>' : ''}
        <button class="btn primary" data-close>Next door</button>
      </div>
    </div>`);
  const share = $('#btn-share');
  if (share) share.onclick = () => showShareCard(r, icon, title);
}

// ---------- share cards ----------

function shareLine(r, title) {
  const at = `House #${r.houseId} ${r.houseName}`;
  if (r.outcome === 'ambush') return r.won ? `I fought off ${r.monster.name} the ${r.monster.type} at ${at}` : `${r.monster.name} the ${r.monster.type} stole ${-r.candy} candy from me at ${at}`;
  if (r.outcome === 'scare') return r.won ? `I survived ${at}` : `${at} scared the candy out of me`;
  if (r.outcome === 'trick') return `Got tricked at ${at}: ${r.text}`;
  if (r.trophy) return `Found a ${r.trophy} at ${at}!`;
  return `${title} at ${at}: ${r.candy > 0 ? '+' + r.candy + ' candy' : ''}`;
}

function showShareCard(r, icon, title) {
  const line = shareLine(r, title);
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
  g.font = '160px system-ui, sans-serif';
  g.fillText(icon, 60, 330);
  g.fillStyle = '#f1eaff';
  g.font = 'bold 64px system-ui, sans-serif';
  g.fillText(title, 280, 250);
  g.font = '36px system-ui, sans-serif';
  wrap(g, line, 280, 320, 860, 46);
  g.fillStyle = '#a99cc8';
  g.font = '28px system-ui, sans-serif';
  g.fillText(`${S.player.name} · Lv ${S.player.level} · ${S.world.season.neighborhood}`, 60, 560);
  g.fillText('90% Tricks. 10% Treats.', 840, 560);
  const url = cv.toDataURL('image/png');
  const text = `${line} 🎃 #KnockGame`;
  showModal(`
    <h2>Share your night</h2>
    <img class="share-canvas" src="${url}" alt="${esc(line)}">
    <div class="actions">
      <a class="btn primary" download="knock-${r.outcome}.png" href="${url}">⬇️ Download card</a>
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
