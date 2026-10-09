// Knock client: a top-down pixel-art neighborhood. All randomness and rules
// live on the server; this file draws the world, moves your trick-or-treater
// and handles menus, the tutorial, help and (in dev builds) the dev panel.

import { createWorld } from './pixel/world2d.js';
import { createActor } from './pixel/actor.js';
import { kidFrame, npcSprite } from './pixel/sprites.js';
import { createInput } from './input.js';
import { helpHtml } from './ui/help.js';
import { createDevPanel } from './ui/dev.js';
import { listWallets, connectWallet, onWalletsChanged, getSolBalance, explorerUrl, base58Encode, INSTALL_LINKS } from './wallet.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const S = {
  token: localStorage.getItem('knock.token'),
  player: null, world: null, catalog: null,
  selected: null, houseDetail: null,
  tab: 'porch', division: 'all', busy: false, seenInbox: 0, timers: false,
  gfx: null, near: null, actionDownAt: 0, drawer: false, tut: null,
};
window.__knock = S; // handy for debugging and browser tests

const ICON = { candy: '🍬', bigCandy: '🍫', rare: '🍭', collectible: '🃏', token: '🪙', legendary: '👑', jackpot: '🎃', secretHouse: '🗝️', trick: '🐕', scare: '👻', ambush: '🧟', trap: '🪤', dial: '🎛️', sold: '🏷️' };
const LABEL = { candy: 'Candy', bigCandy: 'Big candy', rare: 'Rare candy', collectible: 'Monster card', token: '$BOO', legendary: 'Legendary', secretHouse: 'Secret house', trick: 'Trick', scare: 'Scare', ambush: 'Monster attack', trap: 'Trap', dial: 'Behavior change', sold: 'Sold' };
const sym = () => S.catalog?.token.symbol || 'BOO';

// Shops in the town square. Each opens the matching shop sections.
const STORES = {
  costumes: { name: 'Spooky Threads', icon: '🎭', sub: 'Costumes', hello: 'Looking for a new look? Every costume scares off one kind of monster.', sections: ['costumes'] },
  sweets: { name: 'Sugar Rush', icon: '🍭', sub: 'Boosts & upgrades', hello: 'Sweets for the sweet! Boosts for tonight, upgrades for good.', sections: ['boosts', 'upgrades'] },
  cards: { name: 'Crypt Cards', icon: '🃏', sub: 'Monster cards & crafting', hello: 'Three of a kind? I can turn them into something rarer.', sections: ['cards'] },
  dojo: { name: 'Courage Dojo', icon: '🥋', sub: 'Train your stats', hello: 'Train hard, knock harder. Each level costs double the last.', sections: ['training'] },
  raffle: { name: 'Raffle Tent', icon: '🎟️', sub: 'Town Raffle & player raffles', hello: 'Step right up! A draw every five minutes, and you can raffle off your own loot too.', sections: ['townRaffle', 'auctions'] },
};
const STAT_ICON = { courage: '🦁', sneak: '🥷', luck: '🍀' };

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

// ---------- start menu ----------

const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;

async function boot() {
  S.catalog = await api('catalog');
  if (S.catalog.dev) document.body.classList.add('dev-build');
  if (S.token) {
    try {
      await api('me');
    } catch {
      S.token = null;
    }
  }
  showStart();
}

function showStart() {
  $('#start').hidden = false;
  $('#game').hidden = true;
  const known = S.token && S.player;
  $('#start-name').value = known ? S.player.name : localStorage.getItem('knock.name') || '';
  $('#start-name').disabled = !!known;
  $('#start-returning').hidden = !known;
  $('#start-returning-name').textContent = known ? `Level ${S.player.level} · ${S.catalog.costumes[S.player.costume].name}` : '';
  $('#btn-play').textContent = known ? '▶ Continue' : '▶ Play';
  $('#dev-badge').hidden = !S.catalog.dev;
  renderWallet();
  animatePreview();
}

function animatePreview() {
  const cv = $('#start-preview');
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  const costumes = ['sheet', 'witch', 'vampire', 'pumpkinking', 'werewolf', 'skeleton'];
  let t = 0;
  clearInterval(animatePreview.timer);
  animatePreview.timer = setInterval(() => {
    if ($('#start').hidden) return clearInterval(animatePreview.timer);
    t += 1;
    const costume = S.player ? S.player.costume : costumes[Math.floor(t / 12) % costumes.length];
    g.clearRect(0, 0, cv.width, cv.height);
    g.drawImage(kidFrame(costume, 0, t % 2 ? 1 : 2, 0.6), 0, 0, cv.width, cv.height);
  }, 260);
}

// ---------- real Solana wallet (Sign in with Solana) ----------
// The linked wallet is the player's identity: it signs one free message to
// prove ownership, and can sign back into the same character on any device.
const cluster = () => S.catalog?.solana?.cluster || 'devnet';

async function refreshSolBalance() {
  const sol = S.player?.solana;
  if (!sol) return;
  try {
    // With the real-Solana bridge on, the server reads the chain (works for the local chain too).
    const bal = onchainOn() && S.token ? (await api('onchain')).wallet?.sol : await getSolBalance(S.catalog.solana.rpcUrl, sol.address);
    S.solBalance = { address: sol.address, sol: bal ?? null };
  } catch {
    S.solBalance = { address: sol.address, sol: null };
  }
  renderWallet();
}

function walletLineHtml() {
  const sol = S.player.solana;
  const bal = S.solBalance?.address === sol.address ? S.solBalance.sol : undefined;
  return `<span>◎ <b>${shortAddr(sol.address)}</b> <span class="muted small">${esc(sol.wallet)}</span></span>
    <span class="badge">${esc(cluster())}${bal === undefined ? '' : bal === null ? ' · balance unavailable' : ` · ${bal.toFixed(3)} SOL`}</span>`;
}

function renderWallet() {
  const linked = S.player?.solana;
  $('#wallet-connected').hidden = !linked;
  $('#btn-wallet').hidden = !!linked;
  $('#btn-wallet').textContent = S.token ? '◎ Connect wallet' : '◎ Sign in with a Solana wallet';
  $('#wallet-hint').textContent = linked ? 'Linked: sign in with this wallet on any device.'
    : S.token ? 'Link a wallet to keep this character and play it anywhere.' : 'Already linked a wallet? Connect it to load your character.';
  if (linked) {
    $('#wallet-line').innerHTML = walletLineHtml();
    if (S.solBalance?.address !== linked.address) refreshSolBalance();
  }
}

function showWalletPicker() {
  const draw = () => {
    if (!S.pickingWallet) return;
    const wallets = listWallets();
    showModal(`<h2>Connect a Solana wallet</h2>
      <p class="muted small">Your wallet signs one free message to prove it's yours. It's <b>not a transaction</b>: no fees, nothing leaves your wallet. Use <b>${esc(cluster())}</b>.</p>
      ${wallets.length ? `<div class="list">${wallets.map((w, i) => `<button class="btn wallet-choice" data-wallet-i="${i}">${w.icon ? `<img src="${esc(w.icon)}" alt="" class="wallet-icon">` : '◎'} ${esc(w.name)}</button>`).join('')}</div>`
        : `<p>No Solana wallet found in this browser. Install one, then reload:</p>
           <div class="row-actions">${INSTALL_LINKS.map(([n, url]) => `<a class="btn small" href="${url}" target="_blank" rel="noopener">${n}</a>`).join('')}</div>
           <p class="muted small">On a phone, open this page inside your wallet app's browser.</p>`}
      <div class="actions"><button class="btn" data-close>Cancel</button></div>`);
    document.querySelectorAll('[data-wallet-i]').forEach((b) => (b.onclick = () => signInWithWallet(wallets[Number(b.dataset.walletI)])));
  };
  S.pickingWallet = true;
  draw();
  // Wallets can register a moment after the page loads.
  const off = onWalletsChanged(draw);
  const stop = new MutationObserver(() => {
    if ($('#modal').hidden) {
      S.pickingWallet = false;
      off();
      stop.disconnect();
    }
  });
  stop.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
}

async function signInWithWallet(entry) {
  S.pickingWallet = false;
  showModal(`<h2>${esc(entry.name)}</h2><p>Approve the connection, then sign the message in your wallet.</p><p class="muted small">It's free and isn't a transaction.</p>`, { locked: true });
  try {
    const w = await connectWallet(entry);
    const ch = await api('wallet/challenge', { address: w.address });
    const sig = await w.signMessage(ch.message);
    const name = S.token ? undefined : $('#start-name').value.trim();
    const r = await api('wallet/verify', { nonce: ch.nonce, signature: base58Encode(sig), walletName: w.name, name });
    if (r.token) {
      S.token = r.token;
      localStorage.setItem('knock.token', r.token);
    }
    S.walletConn?.off?.();
    S.walletConn = { ...w, off: w.onChange(() => toast('Your wallet switched accounts. Reconnect to link the new one.', 5000)) };
    closeModal();
    toast(r.signedIn ? `◎ Welcome back, ${r.player.name}!` : r.created ? `◎ ${r.player.name} is linked to your wallet` : '◎ Wallet linked to this character');
    if ($('#game').hidden) showStart();
    else renderAll();
    refreshSolBalance();
  } catch (err) {
    closeModal();
    const msg = /reject|denied|cancel/i.test(err.message) ? 'Cancelled in the wallet.' : err.message;
    toast(msg, 5000);
  }
}

async function unlinkWallet() {
  if (!confirm('Unlink this wallet? You will need this browser login (or to link it again) to get back to this character.')) return;
  try {
    await api('wallet/unlink', {});
    await S.walletConn?.disconnect?.();
    S.walletConn = null;
    toast('Wallet unlinked');
    if ($('#game').hidden) showStart();
    else showSettings();
  } catch (err) {
    toast(err.message);
  }
}

// ---------- real Solana: wallet-signed transactions, deposits, withdrawals ----------
const onchainOn = () => !!S.catalog?.solana?.onchain;
function addrLink(addr, label = `◎ ${shortAddr(addr)}`, cls = 'mono') {
  const url = explorerUrl(addr, cluster());
  return url ? `<a class="${cls}" href="${url}" target="_blank" rel="noopener" title="View on Solana Explorer">${label}</a>` : `<span class="${cls}" title="${esc(addr)}">${label}</span>`;
}

// Reconnect to the linked wallet (after a reload the page has no live connection).
async function ensureWallet() {
  const want = S.player?.solana?.address;
  if (!want) throw new Error('Connect your Solana wallet first (Settings → Solana wallet).');
  if (S.walletConn?.address === want && S.walletConn.signTransaction) return S.walletConn;
  const wallets = listWallets();
  const entry = wallets.find((w) => w.name === S.player.solana.wallet) || wallets[0];
  if (!entry) throw new Error('No Solana wallet found in this browser.');
  const w = await connectWallet(entry);
  if (w.address !== want) throw new Error(`Switch ${w.name} to your linked account ${shortAddr(want)} and try again.`);
  S.walletConn?.off?.();
  S.walletConn = { ...w, off: w.onChange(() => (S.walletConn = null)) };
  return S.walletConn;
}

// The server built a transaction: the wallet signs it, the server checks it's
// unchanged and sends it. Anything without a transaction passes straight through.
async function runIntent(r) {
  if (!r?.transaction) return r;
  const w = await ensureWallet();
  toast(`✍️ Approve in ${w.name}: ${r.summary}`, 8000);
  let signed;
  try {
    signed = await w.signTransaction(r.transaction, r.cluster || cluster());
  } catch (err) {
    throw new Error(/reject|denied|cancel/i.test(err.message) ? 'Cancelled in the wallet.' : err.message);
  }
  toast('⛓ Sending to Solana…', 10000);
  const out = await api('onchain/submit', { intent: r.intent, transaction: signed });
  toast('✅ Confirmed on Solana', 3500);
  return out;
}

const opLabel = (o) => ({
  withdraw: `⬆ Withdraw ${o.amount} ${o.currency === 'SOL' ? 'SOL' : `$${sym()}`}`,
  mintNft: '✨ Minting an NFT', sendNft: '📦 Delivering an NFT', burn: `🔥 Burning $${sym()}`,
})[o.kind] || o.kind;

async function showChainWallet() {
  if (!onchainOn()) return;
  let v;
  try {
    v = await api('onchain');
  } catch (err) {
    return toast(err.message);
  }
  const w = v.wallet;
  showModal(`<h2>◎ Wallet &amp; chain</h2>
    <p class="muted small">Solana <b>${esc(cluster())}</b> · $${sym()} token ${addrLink(v.booMint)}</p>
    <div class="statcard">
      <div class="row"><span>Game balance</span><b>${v.game.boo} $${sym()} · ${v.game.sol} SOL</b></div>
      ${w ? `<div class="row"><span>Your wallet ${addrLink(w.address)}</span><b>${w.boo} $${sym()} · ${w.sol} SOL</b></div>` : ''}
    </div>
    ${w ? `<h4>Move funds</h4>
      <div class="auction-form">
        <label>Currency <select id="cw-cur" class="inp"><option value="SOL">SOL</option><option value="BOO">$${sym()}</option></select></label>
        <label>Amount <input id="cw-amt" type="number" min="0" step="0.01" value="0.5"></label>
        <button class="btn small primary" id="cw-dep">⬇ Deposit to game</button>
        <button class="btn small" id="cw-wd">⬆ Withdraw to wallet</button>
      </div>
      <p class="muted small">Deposits: your wallet signs and Knock pays the network fee. Withdrawals are sent by the game and land in seconds. Houses are bought with your game SOL.</p>
      ${cluster() !== 'mainnet-beta' ? '<button class="btn small" id="cw-air">🪂 Get 2 test SOL in my wallet</button>' : ''}`
    : '<p>Link a Solana wallet in Settings to deposit, withdraw and receive your NFTs.</p>'}
    <h4>Your NFTs</h4>
    ${v.nfts.length ? `<div class="list">${v.nfts.map((n) => `<div class="item small"><span>${n.kind === 'house' ? '🏠' : '🃏'} ${esc(n.name)}</span>
      <span class="muted small">${n.mint ? `${n.inWallet ? 'in your wallet' : 'held by Knock'} · ${addrLink(n.mint, 'view')}` : 'minting…'}</span></div>`).join('')}</div>`
      : '<p class="muted small">None yet. House deeds and minted Epic/Legendary cards become real NFTs in your wallet.</p>'}
    ${v.pending.length ? `<h4>On the way</h4><div class="list">${v.pending.map((o) => `<div class="item small"><span>${opLabel(o)}</span><span class="muted small">${esc(o.status)}${o.error ? `: ${esc(o.error)}` : ''}</span></div>`).join('')}</div>` : ''}
    <div class="actions"><button class="btn" id="cw-refresh">↻ Refresh</button><button class="btn primary" data-close>Close</button></div>`, { wide: true });
  const amount = () => ({ currency: $('#cw-cur').value, amount: Number($('#cw-amt').value) });
  const run = (fn) => async () => {
    try {
      await fn();
      await reloadHouse();
      showChainWallet();
    } catch (err) {
      toast(err.message, 6000);
    }
  };
  $('#cw-refresh').onclick = run(async () => {});
  if (w) {
    $('#cw-dep').onclick = run(async () => runIntent(await api('onchain/deposit', amount())));
    $('#cw-wd').onclick = run(async () => {
      await api('onchain/withdraw', amount());
      toast('⬆ Withdrawal queued. It lands in your wallet in a few seconds.', 5000);
    });
    if ($('#cw-air')) $('#cw-air').onclick = run(async () => toast(`🪂 +${(await api('onchain/airdrop', { sol: 2 })).airdropped} test SOL in your wallet`));
  }
}

$('#btn-wallet').addEventListener('click', () => showWalletPicker());
$('#btn-wallet-disconnect').addEventListener('click', () => unlinkWallet());
$('#btn-new-character').addEventListener('click', (e) => {
  e.preventDefault();
  if (!confirm('Start a new character? Your current one stays tied to its own login.')) return;
  logout(false);
  showStart();
});
$('#btn-start-help').addEventListener('click', () => showHelp());

$('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    if (!S.token) {
      const name = $('#start-name').value.trim();
      if (!name) return toast('Pick a name for your trick-or-treater');
      localStorage.setItem('knock.name', name);
      const { token } = await api('login', { name });
      S.token = token;
      localStorage.setItem('knock.token', token);
    }
    $('#start').hidden = true;
    await startGame();
    if (localStorage.getItem('knock.tutorial') !== 'done') startTutorial();
  } catch (err) {
    toast(err.message);
  }
});

function logout(show = true) {
  S.walletConn?.off?.();
  S.walletConn?.disconnect?.();
  S.walletConn = null;
  S.solBalance = null;
  localStorage.removeItem('knock.token');
  localStorage.removeItem('knock.pos');
  S.token = null;
  S.player = null;
  if (show) showStart();
}

async function startGame() {
  $('#game').hidden = false;
  S.seenInbox = S.player.inbox[0]?.at || 0;
  S.wasDeep = S.player.deepEconomy;
  await refreshWorld();
  if (!S.gfx) init2D();
  else S.gfx.world.sync(S.world);
  S.gfx.input.state.enabled = true;
  $('#controls-hint').hidden = localStorage.getItem('knock.hint') === 'off';
  S.selected ??= S.world.route[0] || 1;
  S.houseDetail = await api(`house/${S.selected}`);
  renderAll();
  if (S.player.pending) resumePending(S.player.pending);
  if (!S.timers) {
    S.timers = true;
    setInterval(tick, 1000);
    setInterval(() => refreshWorld().then(() => S.gfx.world.sync(S.world)).catch(() => {}), 15000);
  }
}

// ---------- the 2D world ----------

const RUN_SPEED = 7;
const WALK_SPEED = 4;
const REACH = 2.1;

function init2D() {
  const world = createWorld($('#stage'), S.catalog);
  world.sync(S.world);
  const hero = createActor(S.player.costume);
  const L = S.catalog.layout;
  const pos = { x: L.spawn.x, z: L.spawn.z };
  try {
    const saved = JSON.parse(localStorage.getItem('knock.pos') || 'null');
    if (saved && !world.blocked(saved.x, saved.z)) Object.assign(pos, saved);
  } catch {}
  const input = createInput($('#stage'), {
    onActionDown, onActionUp,
    onMenu: () => toggleDrawer(),
    onHelp: () => showHelp(),
    onDev: () => S.dev?.toggle(),
    onBag: () => openBag(),
  });
  S.gfx = { world, hero, input, pos, last: performance.now(), lastSave: 0, lastMap: 0 };
  world.setZoomBias(Number(localStorage.getItem('knock.zoom') || 0));
  if (S.catalog.dev) S.dev = createDevPanel({ api, S, toast, teleport, refresh: reloadHouse, startTutorial, layout: L });
  requestAnimationFrame(loop);
}

const modalOpen = () => !$('#modal').hidden;

function loop(now) {
  requestAnimationFrame(loop);
  const g = S.gfx;
  const dt = Math.min(0.1, (now - g.last) / 1000);
  g.last = now;
  const m = modalOpen() ? { x: 0, z: 0, run: false } : g.input.movement();
  const amount = Math.min(1, Math.hypot(m.x, m.z));
  const speed = (m.run ? RUN_SPEED : WALK_SPEED) * amount;
  const before = { x: g.pos.x, z: g.pos.z };
  if (amount > 0.05) {
    const len = Math.hypot(m.x, m.z);
    g.world.move(g.pos, (m.x / len) * speed * dt, (m.z / len) * speed * dt);
  }
  const step = Math.hypot(g.pos.x - before.x, g.pos.z - before.z);
  g.hero.update(dt, dt ? step / dt : 0, m.x, m.z);
  if (S.tut) tutorialMoved(step);
  g.world.render(dt, g.pos, g.hero, { bank: true, stores: STORES });
  updateNearby(g.pos);
  if (now - g.lastMap > 150) {
    g.lastMap = now;
    drawMinimap(g.pos);
  }
  if (now - g.lastSave > 2000) {
    g.lastSave = now;
    try {
      localStorage.setItem('knock.pos', JSON.stringify(g.pos));
    } catch {}
  }
}

function teleport(x, z) {
  Object.assign(S.gfx.pos, { x, z });
}

// What can the player interact with right now?
function updateNearby(pos) {
  const L = S.catalog.layout;
  let best = null;
  const consider = (kind, id, spot) => {
    const d = Math.hypot(spot.x - pos.x, spot.z - pos.z);
    if (d < REACH && (!best || d < best.d)) best = { kind, id, d };
  };
  consider('bank', 'bank', L.bank.door);
  for (const k of L.keepers) consider('keeper', k.hood, k.spot);
  for (const st of L.stores) consider('store', st.id, st.door);
  for (const n of L.npcs) consider('npc', n.id, n.spot);
  for (const h of S.world.houses) if (L.houses[h.id]) consider('house', h.id, L.houses[h.id].door);
  const key = best ? `${best.kind}:${best.id}` : null;
  if (key !== S.nearKey || S.actionDownAt) {
    S.nearKey = key;
    S.near = best;
    renderPrompt();
  }
  if (S.tut?.step === 'gate' && L.keepers.some((k) => Math.hypot(k.x - pos.x, k.z - pos.z) < 4)) tutorialEvent('keeper');
}

function renderPrompt() {
  const el = $('#prompt');
  const btn = $('#btn-action');
  const n = S.near;
  if (!n || modalOpen()) {
    el.hidden = true;
    btn.hidden = true;
    return;
  }
  el.hidden = false;
  btn.hidden = false;
  if (n.kind === 'bank') {
    el.innerHTML = `<kbd>E</kbd> Deposit <b>${S.player.bag} 🍬</b> at the Candy Bank`;
    btn.textContent = '🏦 Deposit';
    return;
  }
  if (n.kind === 'store') {
    el.innerHTML = `<kbd>E</kbd> Enter <b>${STORES[n.id].icon} ${STORES[n.id].name}</b> · ${STORES[n.id].sub}`;
    btn.textContent = '🚪 Enter';
    return;
  }
  if (n.kind === 'npc') {
    const npc = S.catalog.npcs[n.id];
    const m = S.player.missions.find((x) => x.giver === n.id);
    const what = !m ? '' : m.state === 'offered' ? ' · <span class="gold">has a mission!</span>' : m.state === 'active' && m.progress >= m.goal ? ' · <span class="gold">reward ready!</span>' : m.state === 'active' ? ` · ${m.progress}/${m.goal}` : ' · done for today';
    el.innerHTML = `<kbd>E</kbd> Talk to <b>${esc(npc.name)}</b>${what}`;
    btn.textContent = '💬 Talk';
    return;
  }
  if (n.kind === 'keeper') {
    const hood = S.world.neighborhoods.find((x) => x.id === n.id);
    el.innerHTML = `<kbd>E</kbd> Talk to the Gatekeeper of <b>${esc(hood.name)}</b>${hood.unlocked ? ' · <span class="ok-text">you may pass</span>' : ''}`;
    btn.textContent = '💬 Talk';
    return;
  }
  const h = S.world.houses.find((x) => x.id === n.id);
  if (!h) return;
  if (h.forSale) {
    el.innerHTML = `<kbd>E</kbd> Empty ${esc(h.typeName)} · <b class="gold">FOR SALE ${h.price} $${sym()}</b>`;
    btn.textContent = '🏷️ Deed';
  } else if (S.actionDownAt) {
    el.innerHTML = 'Knock knock… <span class="muted">(release)</span>';
  } else {
    el.innerHTML = `<kbd>E</kbd> Hold &amp; release to knock · <b>#${h.id} ${esc(h.name)}</b>${h.entryFee ? ` · ${h.entryFee} 🍬` : ''}<br><i class="muted">${esc(h.tell)}</i>`;
    btn.textContent = '✊ Knock';
  }
}

function onActionDown() {
  if (modalOpen() || S.busy || !S.near) return;
  S.actionDownAt = performance.now();
  const h = S.near.kind === 'house' && S.world.houses.find((x) => x.id === S.near.id);
  if (h && !h.forSale) S.gfx.hero.play('knock', 0.8);
  renderPrompt();
}

async function onActionUp() {
  if (!S.actionDownAt) return;
  const holdMs = Math.round(performance.now() - S.actionDownAt);
  S.actionDownAt = 0;
  const n = S.near;
  renderPrompt();
  if (!n) return;
  if (n.kind === 'bank') return doBank();
  if (n.kind === 'keeper') return talkToKeeper(n.id);
  if (n.kind === 'store') return openStore(n.id);
  if (n.kind === 'npc') return talkToNpc(n.id);
  const h = S.world.houses.find((x) => x.id === n.id);
  if (h?.forSale) return selectHouse(h.id, { open: true });
  S.selected = n.id;
  doKnock(holdMs);
}

// ---------- gatekeepers ----------

function talkToKeeper(hoodId) {
  const hood = S.world.neighborhoods.find((x) => x.id === hoodId);
  const p = S.player;
  const total = p.bag + p.stash;
  let body;
  if (hood.unlocked) body = `<p>"Ah, you again. Go on through, little one."</p><div class="actions"><button class="btn primary" data-close>Thanks!</button></div>`;
  else if (p.level >= hood.minLevel) body = `<p>"You look brave enough for ${esc(hood.name)}. In you go."</p>
      <div class="actions"><button class="btn primary" id="btn-keeper-enter">Enter ${esc(hood.name)}</button><button class="btn" data-close>Not yet</button></div>`;
  else body = `<p>"Nobody below <b>level ${hood.minLevel}</b> gets past me..."</p>
      <p>"...unless something <i>sweet</i> changes my mind. <b>${hood.unlockCost} candy</b>, and I'll forget I ever saw you. Once paid, I never ask again."</p>
      <p class="muted small">You're level ${p.level} with ${total} 🍬.</p>
      <div class="actions"><button class="btn primary" id="btn-keeper-enter" ${total < hood.unlockCost ? 'disabled' : ''}>Bribe ${hood.unlockCost} 🍬</button><button class="btn" data-close>Leave</button></div>`;
  showModal(`<div class="big-icon">💀</div><h2>The Gatekeeper</h2><p class="muted small">Guardian of ${esc(hood.name)} · ${hood.candyMultiplier}× candy inside</p>${body}`);
  const enter = $('#btn-keeper-enter');
  if (enter) enter.onclick = async () => {
    try {
      const pos = S.gfx.pos;
      const r = await api('unlock', { neighborhood: hoodId, pos: { x: pos.x, z: pos.z } });
      closeModal();
      toast(r.bribed ? `The gatekeeper pockets ${r.paid} candy and swings the gate open.` : 'The gate creaks open.');
      await reloadHouse();
    } catch (err) {
      toast(err.message);
    }
  };
}

function toggleDrawer(force) {
  S.drawer = force ?? !S.drawer;
  $('#drawer').classList.toggle('open', S.drawer);
  if (S.drawer) {
    renderTab();
    tutorialEvent('menu');
  }
}

function setBeaconHouse(id) {
  const lay = id && S.catalog.layout.houses[id];
  S.beacon = id;
  S.gfx?.world.setBeacon(lay ? { x: lay.x, z: lay.z, h: 120 } : null);
}

// ---------- help ----------

function showHelp() {
  showModal(helpHtml(S.catalog), { wide: true });
}

// ---------- tutorial ----------

const TUTORIAL = [
  { id: 'welcome', title: 'Welcome to Hollow Lane!', text: 'You are a trick-or-treater with a jack-o\'-lantern bucket. Tonight, every door is a surprise.', next: true },
  { id: 'move', title: 'Walk around', text: 'Use <kbd>W A S D</kbd> or the arrow keys to walk (joystick on phones). Hold <kbd>Shift</kbd> to run.' },
  { id: 'quest', title: 'Meet the townsfolk', text: 'People with a <b class="gold">!</b> over their head have missions. Walk to <b>Mayor Gourd</b> and press <kbd>E</kbd> to take one. Come back to them when it\'s done.', beacon: 'mayor' },
  { id: 'knock', title: 'Knock on a door', text: 'Follow the gold arrow to a door, then <b>hold &amp; release <kbd>E</kbd></b> to knock.', beacon: 'house' },
  { id: 'more', title: 'Every door is different', text: 'Candy, tricks, scares and monsters! Read each house\'s clue before you knock. Knock on <b>2 more doors</b>.' },
  { id: 'bank', title: 'Bank your candy', text: 'Monsters steal from your bucket. Carry it to the <b>Candy Bank</b> (pink roof, follow the arrow) and press <kbd>E</kbd>.', beacon: 'bank' },
  { id: 'menu', title: 'Your menu', text: 'Press <kbd>Tab</kbd> or ☰ Menu for missions, the shop, the house board and leaderboards.' },
  { id: 'gate', title: 'Gatekeepers', text: 'The upper neighborhoods are fenced off. Walk over to a <b>Gatekeeper</b>: they let you in at a high enough level, or for a one-time candy bribe.', beacon: 'keeper', next: true },
  { id: 'done', title: 'Happy haunting!', text: 'Dark houses with FOR SALE signs can be bought later. Press <kbd>H</kbd> any time for How to Play. Now... one more door?', next: true, finish: true },
];

function startTutorial() {
  S.tut = { i: 0, moved: 0, knocks: 0 };
  renderTutorial();
}

function endTutorial(skipped = false) {
  S.tut = null;
  localStorage.setItem('knock.tutorial', 'done');
  $('#tutorial').hidden = true;
  setBeaconHouse(null);
  if (skipped) toast('Tutorial skipped. Press H any time for How to Play.');
}

function renderTutorial() {
  const step = TUTORIAL[S.tut.i];
  S.tut.step = step.id;
  const el = $('#tutorial');
  el.hidden = false;
  el.innerHTML = `
    <div class="tut-head"><span class="tut-count">Tutorial ${S.tut.i + 1}/${TUTORIAL.length}</span><button class="btn small" id="btn-tut-skip">Skip tutorial</button></div>
    <h3>${step.title}</h3><p>${step.text}</p>
    ${step.id === 'more' ? `<div class="progress"><div style="width:${(S.tut.knocks / 2) * 100}%"></div></div>` : ''}
    ${step.next ? `<div class="actions"><button class="btn primary small" id="btn-tut-next">${step.finish ? 'Start playing' : 'Next'}</button></div>` : ''}`;
  $('#btn-tut-skip').onclick = () => endTutorial(true);
  const next = $('#btn-tut-next');
  if (next) next.onclick = () => (step.finish ? endTutorial() : advanceTutorial());
  // point the way
  const L = S.catalog.layout;
  if (step.beacon === 'bank') S.gfx.world.setBeacon({ x: L.bank.x, z: L.bank.z, h: 128 });
  else if (step.beacon === 'mayor') {
    const n = L.npcs.find((x) => x.id === 'mayor');
    S.gfx.world.setBeacon({ x: n.x, z: n.z, h: 62 });
  }
  else if (step.beacon === 'keeper' && L.keepers[0]) {
    const pos = S.gfx.pos;
    const k = [...L.keepers].sort((a, b) => Math.hypot(a.x - pos.x, a.z - pos.z) - Math.hypot(b.x - pos.x, b.z - pos.z))[0];
    S.gfx.world.setBeacon({ x: k.x, z: k.z, h: 56 });
  } else if (step.beacon === 'house') {
    const pos = S.gfx.pos;
    const near = S.world.houses.filter((h) => h.knockable && !h.secret && L.houses[h.id])
      .sort((a, b) => Math.hypot(L.houses[a.id].x - pos.x, L.houses[a.id].z - pos.z) - Math.hypot(L.houses[b.id].x - pos.x, L.houses[b.id].z - pos.z))[0];
    if (near) setBeaconHouse(near.id);
  } else setBeaconHouse(S.beacon && !S.tut ? S.beacon : null);
}

function advanceTutorial() {
  if (!S.tut) return;
  S.tut.i += 1;
  if (S.tut.i >= TUTORIAL.length) return endTutorial();
  renderTutorial();
}

function tutorialMoved(step) {
  if (S.tut.step !== 'move') return;
  S.tut.moved += step;
  if (S.tut.moved > 4) advanceTutorial();
}

function tutorialEvent(kind) {
  if (!S.tut) return;
  const id = S.tut.step;
  if (kind === 'knock' && id === 'knock') advanceTutorial();
  else if (kind === 'knock' && id === 'more') {
    S.tut.knocks += 1;
    if (S.tut.knocks >= 2) advanceTutorial();
    else renderTutorial();
  } else if (kind === 'deposit' && id === 'bank') advanceTutorial();
  else if (kind === 'menu' && id === 'menu') advanceTutorial();
  else if (kind === 'keeper' && id === 'gate') advanceTutorial();
  else if (kind === 'accept' && id === 'quest') advanceTutorial();
}

// ---------- minimap ----------
function drawMinimap(pos) {
  const cv = $('#minimap');
  const g = cv.getContext('2d');
  const W = cv.width;
  const scale = W / 150;
  const L = S.catalog.layout;
  const X = (x) => W / 2 + (x - pos.x) * scale;
  const Y = (z) => W / 2 - (z - pos.z) * scale;
  g.clearRect(0, 0, W, W);
  g.fillStyle = '#1e1830';
  g.fillRect(0, 0, W, W);
  g.fillStyle = '#3d5552';
  for (const zn of L.zones) g.fillRect(X(zn.minX), Y(zn.maxZ), (zn.maxX - zn.minX) * scale, (zn.maxZ - zn.minZ) * scale);
  g.fillStyle = '#6e6a80';
  for (const r of L.roads) g.fillRect(X(r.minX), Y(r.maxZ), (r.maxX - r.minX) * scale, (r.maxZ - r.minZ) * scale);
  const dot = (x, z, color, r = 2.5) => {
    g.fillStyle = color;
    g.fillRect(Math.round(X(x) - r), Math.round(Y(z) - r), r * 2, r * 2);
  };
  dot(L.bank.x, L.bank.z + 1.5, '#ff4fa3', 4);
  for (const st of L.stores) dot(st.x, st.z + 1, '#93e9ff', 3);
  const marks = npcMarkers();
  for (const n of L.npcs) dot(n.x, n.z, marks[n.id] === 'offer' || marks[n.id] === 'ready' ? '#ffd34d' : '#c9a8ff', 3);
  for (const k of L.keepers) {
    const open = S.world.neighborhoods.find((n) => n.id === k.hood)?.unlocked;
    dot(k.x, k.z, open ? '#6ee7a0' : '#ffd34d', 3);
  }
  for (const h of S.world.houses) {
    const lay = L.houses[h.id];
    if (!lay) continue;
    const color = h.forSale ? '#ffd34d' : h.hot ? '#ff8a1f' : h.owner ? '#b48cff' : h.secret ? '#ffe680' : S.player.routeVisited.includes(h.id) ? '#555' : h.onRoute ? '#fff4b0' : '#a59fb5';
    dot(lay.x, lay.z + 1.5, color, h.onRoute || h.hot ? 3 : 2.5);
  }
  if (S.beacon && L.houses[S.beacon]) {
    g.strokeStyle = '#ffd34d';
    g.lineWidth = 2;
    g.strokeRect(X(L.houses[S.beacon].x) - 6, Y(L.houses[S.beacon].z + 1.5) - 6, 12, 12);
  }
  // player
  const d = S.gfx.hero.dir;
  g.fillStyle = '#6ee7a0';
  g.beginPath();
  const pts = { 0: [[0, 6], [-5, -4], [5, -4]], 1: [[0, -6], [-5, 4], [5, 4]], 2: [[-6, 0], [4, -5], [4, 5]], 3: [[6, 0], [-4, -5], [-4, 5]] }[d];
  g.moveTo(W / 2 + pts[0][0], W / 2 + pts[0][1]);
  g.lineTo(W / 2 + pts[1][0], W / 2 + pts[1][1]);
  g.lineTo(W / 2 + pts[2][0], W / 2 + pts[2][1]);
  g.fill();
  g.strokeStyle = '#4a4458';
  g.lineWidth = 2;
  g.strokeRect(1, 1, W - 2, W - 2);
}

async function refreshWorld() {
  S.world = await api('world');
  S.skew = S.world.serverTime - Date.now();
  checkWorldEvents();
}

const serverNow = () => Date.now() + (S.skew || 0);

// ---------- notifications ----------
// Event notifications slide in on the side, disappear after 15 seconds, and
// can be closed early with ✕. Each one is shown once.
const NOTE_MS = 15000;
function note(key, html, { gold = false, ms = NOTE_MS, onClick = null } = {}) {
  S.notesSeen ??= new Set();
  if (S.notesSeen.has(key)) return;
  S.notesSeen.add(key);
  const box = $('#notes');
  const el = document.createElement('div');
  el.className = `note${gold ? ' gold' : ''}${onClick ? ' clickable' : ''}`;
  el.innerHTML = `<div class="note-body">${html}</div><button class="note-x" title="Dismiss" aria-label="Dismiss">✕</button><div class="note-timer" style="animation-duration:${ms}ms"></div>`;
  const close = () => {
    if (el.classList.contains('out')) return;
    el.classList.add('out');
    setTimeout(() => el.remove(), 250);
  };
  el.querySelector('.note-x').onclick = (e) => {
    e.stopPropagation();
    close();
  };
  if (onClick) el.querySelector('.note-body').onclick = () => (onClick(), close());
  setTimeout(close, ms);
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild.remove();
}

// New things in the world: the Legendary Mansion opening and raffle results.
function checkWorldEvents() {
  const w = S.world;
  if (!w || $('#game').hidden) return;
  const le = w.legendaryEvent;
  if (le.open) {
    const mins = le.closesAt ? Math.max(1, Math.round((le.closesAt - serverNow()) / 60000)) : null;
    note(`legend:${le.openedAt}:${le.closesAt ?? 'dev'}`, `👑 <b>The Legendary Mansion has appeared!</b><br>Open to everyone${mins ? ` for about ${mins} min` : ''}. Click to follow the beacon.`, { gold: true, onClick: () => setBeaconHouse(le.houseId) });
  }
  const last = w.raffle?.last;
  if (last) {
    if (S.lastRaffleSeen == null) S.lastRaffleSeen = last.round; // don't replay old draws on load
    else if (last.round > S.lastRaffleSeen) {
      S.lastRaffleSeen = last.round;
      const mine = last.winners.find((x) => x.name === S.player.name);
      const names = last.winners.slice(0, 3).map((x) => esc(x.name)).join(', ');
      // Winners hear about it from their inbox (fetched right away); everyone else gets the results.
      if (mine) api('me').then(renderAll).catch(() => {});
      else note(`raffle-result:${last.round}`, `🎟️ Town Raffle #${last.round} drawn${last.winners.length ? `: ${names}${last.winners.length > 3 ? ` +${last.winners.length - 3} more` : ''} won` : ' (nobody entered)'}.`, { onClick: () => openStore('raffle') });
    }
  }
}

// Small always-on countdown to the next Town Raffle draw.
function renderRaffleWidget() {
  const w = $('#raffle-widget');
  const r = S.world?.raffle;
  if (!r || !S.player || S.player.level < S.catalog.raffle.minLevel) {
    w.hidden = true;
    return;
  }
  const left = r.drawAt - serverNow();
  w.hidden = false;
  w.classList.toggle('soon', left > 0 && left < 30000);
  w.innerHTML = `<span class="rw-title">🎟️ RAFFLE #${r.round}</span><b class="rw-time">${left > 0 ? fmtMs(left) : 'DRAWING…'}</b>
    <span class="rw-sub">${r.yourSlots ? `${r.yourSlots} slot${r.yourSlots > 1 ? 's' : ''}` : r.freeSlotLeft ? 'free slot ready' : 'no slots'} · $${r.poolUsd.toFixed(2)} pool</span>`;
  if (left > 0 && left < 60000) note(`raffle-soon:${r.round}`, `🎟️ Town Raffle #${r.round} draws in under a minute!${r.yourSlots ? ` You have ${r.yourSlots} slot${r.yourSlots > 1 ? 's' : ''}.` : ' Grab a slot at the Raffle Tent.'}`, { onClick: () => openStore('raffle') });
  if (left <= -1500 && !S.raffleFetching) {
    S.raffleFetching = true;
    refreshWorld().then(() => {
      if (S.openStore === 'raffle') loadAuctions().then(renderStoreModal);
    }).catch(() => {}).finally(() => (S.raffleFetching = false));
  }
}

// Live countdowns inside open panels ([data-ends] = a server timestamp).
function updateCountdowns() {
  document.querySelectorAll('[data-ends]').forEach((el) => {
    const left = Number(el.dataset.ends) - serverNow();
    el.textContent = left > 0 ? fmtMs(left) : 'now';
  });
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
  renderRaffleWidget();
  updateCountdowns();
}

// ---------- rendering ----------

function renderAll() {
  renderHud();
  if (S.gfx) {
    S.gfx.world.sync(S.world);
    S.gfx.hero.setCostume(S.player.costume);
    S.gfx.hero.setBucketFill(S.player.bag / S.player.bagCapacity);
    S.gfx.world.setNpcs(npcMarkers(), S.catalog.npcs);
  }
  if (S.openStore && modalOpen()) renderStoreModal();
  if (S.drawer) renderTab();
  renderPrompt();
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
  $('#hud-sol-wrap').hidden = !p.wallet;
  if (p.wallet) {
    $('#hud-boo').textContent = p.wallet.boo;
    $('#hud-sol').textContent = p.wallet.sol;
  }
  $('#tab-btn-streets').hidden = !p.deepEconomy;
  // One-time notifications (they fade after 15s) instead of permanent banners.
  if (p.shieldMs > 0 && !S.shieldOn) note(`shield:${Date.now()}`, `🛡️ Monsters can't touch you for ${fmtMs(p.shieldMs)}.`);
  S.shieldOn = p.shieldMs > 0;
  p.discovered.forEach((d) => note(`secret:${d.id}`, `🗝️ <b>Secret house found:</b> ${esc(d.name)} (${d.knocks} knocks left). Click to follow the beacon.`, { gold: true, onClick: () => setBeaconHouse(d.id) }));
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
    if (newest.kind === 'raffle') note(`inbox:${newest.at}`, esc(newest.text), { gold: true, onClick: () => openBag() });
    else toast(`📬 ${newest.text}`, 5000);
  }
}

function renderTab() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === S.tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${S.tab}`));
  const fn = { porch: renderPorch, missions: renderMissions, bag: renderBag, shop: renderShop, board: renderBoard, leaders: renderLeaders, feed: renderFeed, me: renderMe, streets: renderStreets }[S.tab];
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
      <p class="muted small">💰 Passive income: +${S.catalog.houseRules.visitCandy} 🍬 to your till for each new visitor a day, plus a share of ${Math.round(S.catalog.houseRules.ownerFeeShare * 100)}% of every $${sym()} and SOL transaction fee in the game (paid daily to your wallet).</p>
      ${h.listing ? `<div class="row-actions"><span class="muted small">Listed for ${h.listing.price} ${h.listing.currency === 'SOL' ? 'SOL' : `$${sym()}`}</span><button class="btn small" data-act="delist">Cancel listing</button></div>`
        : `<div class="inline-form"><input id="list-price" type="number" min="0.01" step="0.01" placeholder="Price in SOL"><button class="btn small" data-act="list">List for sale</button></div>`}
    </div>` : h.secret ? '' : `
    <div class="section"><h3>Deed</h3>
      ${h.owner ? `<p class="small">Owned by <b>${esc(h.owner.name)}</b>. Value ≈ ${h.value} SOL.</p>` : ''}
      ${h.price ? `<button class="btn small primary" data-act="deed" ${(p.wallet?.sol ?? 0) >= h.price || (onchainOn() && p.solana) ? '' : 'disabled'}>Buy deed · ${h.price} SOL</button>
        <p class="muted small">Houses are bought with SOL (game balance: ${p.wallet?.sol ?? 0}).${onchainOn() ? ' The deed is minted as a real NFT into your wallet.' : ''} Owners earn candy from visitors and a share of transaction fees.</p>` : ''}
      ${h.deedMint ? `<p class="muted small">Deed NFT: ${addrLink(h.deedMint)}</p>` : ''}
      ${h.externalOwner ? `<p class="muted small">This deed was sold outside Knock and is held by ${addrLink(h.externalOwner)}.</p>` : ''}
      ${h.listing ? `<button class="btn small primary" data-act="buylisting">Buy from market · ${h.listing.price} ${h.listing.currency === 'SOL' ? 'SOL' : `$${sym()}`}</button>` : ''}
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
    ${h.forSale ? `<div class="ok">🏷️ This house is empty. Its deed is an NFT: <b>${h.price} SOL</b>.${p.deepEconomy ? '' : ' Keep playing to unlock the Haunted Streets and buy houses.'}</div>`
      : `<p class="muted small">🚶 Walk to this door${S.beacon === h.id ? ' (follow the gold beacon)' : ''} and hold &amp; release <kbd>E</kbd> to knock.${h.entryFee ? ` Entry: ${h.entryFee} 🍬.` : ''}</p>`}
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
}

function npcMarkers() {
  const out = {};
  for (const m of S.player?.missions || []) {
    out[m.giver] = m.state === 'offered' ? 'offer' : m.state === 'active' ? (m.progress >= m.goal ? 'ready' : 'active') : null;
  }
  return out;
}

const whereIs = (giver) => {
  const hood = S.catalog.npcs[giver].hood;
  return hood ? S.world.neighborhoods.find((n) => n.id === hood)?.name : 'Town square';
};

function renderMissions() {
  const p = S.player;
  const badge = (m) => m.state === 'offered' ? '<span class="badge gold-badge">! New</span>' : m.state === 'claimed' ? '<span class="badge">✓ Done</span>' : m.progress >= m.goal ? '<span class="badge gold-badge">? Reward ready</span>' : '<span class="badge">In progress</span>';
  $('#tab-missions').innerHTML = `
    <h3>Quest log</h3>
    <p class="muted small">Townsfolk around the map hand out one mission a day. Walk up to someone with a <b class="gold">!</b> to accept, and return when it shows <b class="gold">?</b> to collect.</p>
    <div class="list">${p.missions.map((m) => `
      <div class="item"><div style="flex:1">
        <div class="title">${esc(m.giverName)} ${badge(m)}</div>
        <div class="small">${m.state === 'offered' ? '<i class="muted">Talk to them to find out</i>' : esc(m.text)}</div>
        <div class="muted small">📍 ${esc(whereIs(m.giver))}${m.locked ? ' (behind a gate)' : ''} · +${m.reward.candy} 🍬 · +${m.reward.knocks} knocks</div>
        ${m.state === 'active' ? `<div class="progress"><div style="width:${(100 * m.progress) / m.goal}%"></div></div>` : ''}</div>
        ${m.state !== 'claimed' ? `<button class="btn small" data-track="${m.giver}">📍 Track</button>` : ''}
      </div>`).join('')}</div>
    <h3 class="section">Streak</h3>
    <p>🔥 <b>${p.streak} day${p.streak === 1 ? '' : 's'}</b>. Today +${p.streakBonusToday} 🍬, tomorrow <b>+${p.streakBonusTomorrow}</b>. One grace day a week.</p>
    <h3 class="section">Today's route</h3>
    <p class="small">${S.world.route.map((id) => `<span class="chip">${p.routeVisited.includes(id) ? '✓' : '⭐'} #${id}</span>`).join(' ')}</p>
    <h3 class="section">Legendary Mansion</h3>
    <p class="small ${S.world.legendaryEvent.open ? 'gold' : 'muted'}">${S.world.legendaryEvent.open ? `👑 It's open right now! ${S.world.legendaryEvent.closesAt ? `Closes in <span data-ends="${S.world.legendaryEvent.closesAt}">${fmtMs(S.world.legendaryEvent.closesAt - serverNow())}</span>.` : ''}`
      : `Appears at a random time every ${S.catalog.legendaryRules.minGapMinutes}-${S.catalog.legendaryRules.maxGapMinutes} minutes and stays open for ${S.catalog.legendaryRules.openMinutes}. Nobody knows exactly when, so keep knocking and watch for the notification.`}</p>`;
}

function trackNpc(giver) {
  const n = S.catalog.layout.npcs.find((x) => x.id === giver);
  S.beacon = null;
  S.gfx.world.setBeacon({ x: n.x, z: n.z, h: 62 });
  toggleDrawer(false);
  toast(`Follow the gold arrow to ${S.catalog.npcs[giver].name}`);
}

// ---------- townsfolk ----------
function talkToNpc(giver) {
  const npc = S.catalog.npcs[giver];
  const m = S.player.missions.find((x) => x.giver === giver);
  let body;
  if (!m) body = '<p>"Nothing for you today, friend."</p><div class="actions"><button class="btn primary" data-close>Bye!</button></div>';
  else if (m.state === 'offered') body = `<p>"${esc(npc.hello)}"</p>
      <div class="quest-card"><b>${esc(m.text)}</b><div class="muted small">Reward: +${m.reward.candy} 🍬 · +${m.reward.knocks} knocks</div></div>
      <div class="actions"><button class="btn primary" id="btn-npc-go" data-mode="accept">Accept mission</button><button class="btn" data-close>Maybe later</button></div>`;
  else if (m.state === 'active' && m.progress >= m.goal) body = `<p>"You did it! I knew you had it in you."</p>
      <div class="quest-card"><b>${esc(m.text)}</b> ✓</div>
      <div class="actions"><button class="btn primary" id="btn-npc-go" data-mode="claim">Collect +${m.reward.candy} 🍬 +${m.reward.knocks} knocks</button></div>`;
  else if (m.state === 'active') body = `<p>"How's it going? Come back when it's done."</p>
      <div class="quest-card"><b>${esc(m.text)}</b><div class="progress"><div style="width:${(100 * m.progress) / m.goal}%"></div></div><div class="muted small">${m.progress}/${m.goal}</div></div>
      <div class="actions"><button class="btn primary" data-close>On it!</button></div>`;
  else body = '<p>"Thanks again! Come see me tomorrow for something new."</p><div class="actions"><button class="btn primary" data-close>Bye!</button></div>';
  showModal(`<canvas class="npc-portrait" id="npc-portrait" width="60" height="108"></canvas><h2>${esc(npc.name)}</h2><p class="muted small">${esc(npc.title)}</p>${body}`);
  const g = $('#npc-portrait').getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(npcSprite(npc.look, 0), 0, 0, 60, 108);
  const go = $('#btn-npc-go');
  if (go) go.onclick = async () => {
    try {
      const pos = S.gfx.pos;
      if (go.dataset.mode === 'accept') {
        await api('npc/accept', { giver, pos: { x: pos.x, z: pos.z } });
        tutorialEvent('accept');
        toast(`Mission accepted: ${m.text}`);
      } else {
        const r = await api('npc/claim', { giver, pos: { x: pos.x, z: pos.z } });
        S.gfx.hero.play('cheer', 0.9);
        toast(`Mission complete! +${r.reward.candy} 🍬 +${r.reward.knocks} knocks`);
      }
      closeModal();
      await reloadHouse();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- shops (shared by the menu and the physical stores) ----------
function shopSection(kind) {
  const p = S.player;
  const c = S.catalog;
  const total = p.bag + p.stash;
  const boo = p.wallet?.boo ?? 0;
  const statStr = (st) => Object.entries(st).map(([k, v]) => `+${v} ${k}`).join(', ') || 'no stats';
  if (kind === 'costumes') {
    const costumeRow = ([id, k]) => {
      const owned = p.ownedCostumes.includes(id);
      if (k.raffleOnly && !owned) return '';
      if (k.booPrice && !p.deepEconomy) return '';
      const price = k.booPrice ? `${k.booPrice} $${sym()}` : `${k.price} 🍬`;
      const can = k.booPrice ? boo >= k.booPrice : total >= k.price;
      return `<div class="item"><div><div class="title">${k.icon} ${esc(k.name)}</div>
        <div class="muted small">${statStr(k.stats)}${k.counters ? ` · scares off ${k.counters}s` : ''}</div></div>
        ${p.costume === id ? '<span class="muted">Wearing</span>' : owned ? `<button class="btn small" data-equip="${id}">Wear</button>` : `<button class="btn small primary" data-buy="costume:${id}" ${can ? '' : 'disabled'}>${price}</button>`}</div>`;
    };
    return `<h3>Costumes</h3><p class="muted small">Costume stats add to your Courage / Sneak / Luck (the Courage Dojo explains each one).</p><div class="list">${Object.entries(c.costumes).map(costumeRow).join('')}</div>`;
  }
  if (kind === 'boosts') return `<h3>Boosts</h3><div class="list">${Object.entries(c.boosts).map(([id, b]) => `
      <div class="item"><div><div class="title">${b.icon} ${esc(b.name)}</div><div class="muted small">${esc(b.text)}</div></div>
      <button class="btn small primary" data-buy="boost:${id}" ${total < b.price ? 'disabled' : ''}>${b.price} 🍬</button></div>`).join('')}</div>`;
  if (kind === 'upgrades') return `<h3>Upgrades</h3><div class="list">${Object.entries(c.upgrades).map(([id, u]) => `
      <div class="item"><div class="title">${u.icon} ${esc(u.name)}</div>
      <button class="btn small primary" data-buy="upgrade:${id}" ${total < u.price ? 'disabled' : ''}>${u.price} 🍬</button></div>`).join('')}</div>`;
  if (kind === 'raffle' || kind === 'townRaffle') return townRaffleHtml();
  if (kind === 'auctions') return auctionsHtml();
  if (kind === 'training') return `<h3>Train your stats</h3>${statsHtml(true)}`;
  if (kind === 'cards') {
    const owned = c.cards.filter((x) => p.cards[x.id] > 0);
    return `<h3>Monster cards <span class="muted small">(${owned.length}/${c.cards.length})</span></h3>
    <p class="muted small">Original cards. ${c.cardRules.craftDuplicates} copies + ${c.cardRules.craftCost} 🍬 crafts a higher rarity.${p.deepEconomy ? ' Epic and Legendary cards can be minted to your wallet.' : ''}</p>
    <div class="list">${owned.length ? owned.map((x) => `<div class="item small"><span class="r-${x.rarity}">🃏 ${esc(x.name)} ×${p.cards[x.id]}</span><span class="row-actions" style="margin:0">
      ${p.cards[x.id] >= c.cardRules.craftDuplicates && x.rarity !== 'legendary' ? `<button class="btn small" data-craft="${x.id}">Craft</button>` : ''}
      ${p.deepEconomy && ['epic', 'legendary'].includes(x.rarity) ? `<button class="btn small" data-mint="${x.id}">Mint</button>` : ''}</span></div>`).join('') : '<p class="muted small">No cards yet. Some doors have them taped on.</p>'}</div>`;
  }
  return '';
}

// Courage / Sneak / Luck, with what each one actually does.
function statsHtml(trainable) {
  const p = S.player;
  const info = S.catalog.statInfo || {};
  return `<div class="stat-list">${['courage', 'sneak', 'luck'].map((k) => `
    <div class="stat-card">
      <div class="stat-top"><span class="stat-name">${STAT_ICON[k]} ${k[0].toUpperCase() + k.slice(1)}</span><b class="stat-num">${p.stats[k]}</b>
        <span class="info" tabindex="0" title="${esc(info[k] || '')}">ⓘ</span></div>
      <p class="muted small">${esc(info[k] || '')}</p>
      <div class="stat-foot"><span class="muted small">Trained ${p.trained[k]}/5 · costume and boosts add more</span>
      ${trainable ? (p.trained[k] < 5 ? `<button class="btn small primary" data-train="${k}" ${p.bag + p.stash < p.trainCosts[k] ? 'disabled' : ''}>Train · ${p.trainCosts[k]} 🍬</button>` : '<span class="muted small">Maxed</span>') : ''}</div>
    </div>`).join('')}</div>`;
}

function openStore(id) {
  S.openStore = id;
  renderStoreModal();
  if (id === 'raffle') loadAuctions().then(() => S.openStore === 'raffle' && renderStoreModal()).catch(() => {});
}

async function loadAuctions() {
  S.auctions = await api('auctions');
}

// ---------- raffles ----------
function townRaffleHtml() {
  const p = S.player;
  const R = S.catalog.raffle;
  const r = S.world.raffle;
  if (p.level < R.minLevel) return `<h3>🎟️ Town Raffle</h3><p class="muted small">Opens at level ${R.minLevel}. Keep knocking!</p>`;
  const total = p.bag + p.stash;
  const room = R.maxSlots - r.yourSlots;
  const share = r.slots ? (100 * r.yourSlots) / r.slots : 0;
  const last = r.last;
  const prizes = p.rafflePrizes || [];
  const buy = (n, label) => `<button class="btn small primary" data-raffle="${n}" ${n > room || total < n * R.slotPrice ? 'disabled' : ''}>${label} · ${n * R.slotPrice} 🍬</button>`;
  return `<h3>🎟️ Town Raffle #${r.round}</h3>
    <p class="muted small">Draws every ${R.roundMinutes} minutes. ${R.winners} winners each round. Slots cost ${R.slotPrice} 🍬, up to ${R.maxSlots} per round.</p>
    <div class="statcard">
      <div class="row"><span>Next draw in</span><b data-ends="${r.drawAt}">${fmtMs(r.drawAt - serverNow())}</b></div>
      <div class="row"><span>Your slots</span><b>${r.yourSlots}/${R.maxSlots}</b></div>
      <div class="row"><span>All slots · players</span><b>${r.slots} · ${r.entrants}</b></div>
      <div class="row"><span>Your share of slots</span><b>${share.toFixed(1)}%</b></div>
      <div class="row"><span>Prize pool (from transaction fees)</span><b>$${r.poolUsd.toFixed(2)}</b></div>
    </div>
    <div class="row-actions">
      ${r.freeSlotLeft ? `<button class="btn small" data-raffle-free ${room < 1 ? 'disabled' : ''}>🎁 Free daily slot</button>` : ''}
      ${buy(1, '+1')}${buy(10, '+10')}${room > 0 ? buy(room, `+${room} (max)`) : ''}
    </div>
    <h4>Prizes this round</h4>
    <div class="pill-row">${R.prizes.map((pz, i) => `<span class="chip">${i + 1}. ${pz.kind === 'stock' ? '📈' : '💵'} ${esc(pz.name)}</span>`).join('')}</div>
    <p class="muted small">Cash and stock prizes are paid only from what the prize pool holds; if it runs short, winners get ${R.consolationCandy} 🍬 (and the first winner the ${esc(S.catalog.costumes[R.prizeCostume]?.name || '')} costume) instead. Winners verify age (18+), region and contact before payout. No purchase necessary: one free slot every day.</p>
    ${prizes.length ? `<h4>Your prizes</h4><div class="list">${prizes.map((z) => `<div class="item small"><div><div class="title">${z.kind === 'stock' ? '📈' : '💵'} ${esc(z.prize)}</div><div class="muted small">Round #${z.round} · ${esc(z.status)}</div></div>
      ${z.status === 'pending verification' ? `<button class="btn small primary" data-claim-prize="${z.id}">Claim</button>` : '<span class="muted small">✓</span>'}</div>`).join('')}</div>` : ''}
    ${last ? `<h4>Last draw (#${last.round})</h4>${last.winners.length ? `<ol class="small">${last.winners.map((x) => `<li>${esc(x.name)} · ${esc(x.prize)}</li>`).join('')}</ol>` : '<p class="muted small">Nobody entered.</p>'}` : ''}`;
}

const itemIcon = (it) => (it.kind === 'boo' ? '🪙' : it.kind === 'nft' ? '💎' : '🃏');

function auctionsHtml() {
  const p = S.player;
  const A = S.catalog.raffle.auction;
  const data = S.auctions;
  if (p.level < S.catalog.raffle.minLevel) return '';
  if (!data) return '<h3>Player raffles</h3><p class="muted small">Loading…</p>';
  const total = p.bag + p.stash;
  const cards = S.catalog.cards.filter((x) => p.cards[x.id] > 0);
  const nfts = p.wallet?.cards || [];
  const options = [
    p.wallet ? `<option value="boo">🪙 $${sym()} (you have ${p.wallet.boo})</option>` : '',
    ...cards.map((x) => `<option value="card:${x.id}">🃏 ${esc(x.name)} (${x.rarity}) ×${p.cards[x.id]}</option>`),
    ...nfts.map((n) => `<option value="nft:${n.id}">💎 ${esc(n.name)} NFT (${n.rarity})</option>`),
  ].filter(Boolean);
  const row = (a) => {
    const left = a.maxSlots - a.sold;
    return `<div class="item"><div style="flex:1"><div class="title"><span class="r-${a.item.rarity || ''}">${itemIcon(a.item)} ${esc(a.item.name)}</span></div>
      <div class="muted small">by ${esc(a.seller)} · ${a.slotPrice} 🍬/slot · ${a.sold}/${a.maxSlots} sold · ends in <span data-ends="${a.endsAt}">${fmtMs(a.endsAt - serverNow())}</span>${a.yourSlots ? ` · you: ${a.yourSlots}` : ''}</div>
      <div class="progress"><div style="width:${(100 * a.sold) / a.maxSlots}%"></div></div></div>
      <span class="row-actions" style="margin:0">${a.mine ? (a.sold ? '<span class="muted small">Yours</span>' : `<button class="btn small" data-auction-cancel="${a.id}">Cancel</button>`)
        : [1, 5].map((n) => `<button class="btn small primary" data-auction-enter="${a.id}" data-n="${n}" ${left < n || total < n * a.slotPrice ? 'disabled' : ''}>+${n}</button>`).join('')}</span></div>`;
  };
  return `<h3>Player raffles</h3>
    <p class="muted small">Like an auction house, but with luck: put up $${sym()}, a monster card or a card NFT, set a slot price, and one random slot wins it. You get the candy (minus ${Math.round(A.candyFee * 100)}%, which is burned). No entries? You get it back.</p>
    <div class="list">${data.open.length ? data.open.map(row).join('') : '<p class="muted small">No raffles running. Start one!</p>'}</div>
    <h4>Raffle something off</h4>
    ${options.length ? `<div class="auction-form">
      <label>Item <select id="au-item" class="inp">${options.join('')}</select></label>
      <label id="au-amount-wrap">$${sym()} amount <input id="au-amount" type="number" min="1" value="100"></label>
      <label>Slot price 🍬 <input id="au-price" type="number" min="${A.minSlotPrice}" max="${A.maxSlotPrice}" value="10"></label>
      <label>Slots <input id="au-slots" type="number" min="2" max="${A.maxSlots}" value="20"></label>
      <label>Runs for <select id="au-mins" class="inp">${A.durationsMinutes.map((m) => `<option value="${m}" ${m === 15 ? 'selected' : ''}>${m} min</option>`).join('')}</select></label>
      <button class="btn small primary" data-act="auction-create">Start raffle</button></div>`
      : '<p class="muted small">Nothing to raffle yet: collect monster cards, or unlock your wallet for $BOO and NFTs.</p>'}
    ${data.recent.length ? `<h4>Recent winners</h4><ul class="small">${data.recent.map((r) => `<li>${esc(r.winner)} won ${esc(r.item)} from ${esc(r.seller)} (${r.slots} slots)</li>`).join('')}</ul>` : ''}`;
}

function claimPrizeForm(id) {
  const z = S.player.rafflePrizes.find((x) => x.id === id);
  showModal(`<h2>Claim ${esc(z.prize)}</h2>
    <p class="muted small">Real-world prizes are paid out by hand after a quick check. We only use this to contact you about this prize.</p>
    <label class="set-row"><input type="checkbox" id="cp-18"> I am 18 or older</label>
    <label class="set-row">Country / region <input id="cp-region" placeholder="e.g. Canada"></label>
    <label class="set-row">Email <input id="cp-contact" type="email" placeholder="you@example.com"></label>
    <div class="actions"><button class="btn primary" id="cp-go">Submit claim</button><button class="btn" data-close>Later</button></div>`);
  $('#cp-go').onclick = async () => {
    try {
      await api('raffle/claim', { id, details: { over18: $('#cp-18').checked, region: $('#cp-region').value, contact: $('#cp-contact').value } });
      closeModal();
      toast('Claim submitted! Payouts are reviewed by hand.');
      renderAll();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- inventory ----------
function openBag() {
  if (S.drawer && S.tab === 'bag') return toggleDrawer(false);
  S.tab = 'bag';
  if (S.drawer) renderTab();
  else toggleDrawer(true);
}

function renderBag() {
  const p = S.player;
  const c = S.catalog;
  const w = p.wallet;
  const cards = c.cards.filter((x) => p.cards[x.id] > 0);
  const nfts = w?.cards || [];
  const costumes = Object.entries(c.costumes).filter(([id]) => p.ownedCostumes.includes(id));
  const r = S.world.raffle;
  if (!S.auctions) loadAuctions().then(() => S.tab === 'bag' && renderBag()).catch(() => {});
  const myAuctions = (S.auctions?.open || []).filter((a) => a.mine);
  const cell = (icon, name, sub = '', cls = '') => `<div class="inv-cell ${cls}"><span class="inv-icon">${icon}</span><span class="inv-name">${name}</span>${sub ? `<span class="inv-sub">${sub}</span>` : ''}</div>`;
  $('#tab-bag').innerHTML = `
    <h3>🎒 Inventory</h3>
    <div class="inv-grid">
      ${cell('🪣', `${p.bag}/${p.bagCapacity}`, 'candy in bucket')}
      ${cell('🏦', `${p.stash}/${p.stashCapacity}`, 'candy in bank')}
      ${cell('🍬', p.bag + p.stash, 'total candy')}
      ${w ? cell('🪙', w.boo, `$${sym()}${w.claimable ? ` · +${w.claimable} to claim` : ''}`) : ''}
      ${w ? cell('◎', w.sol, 'SOL') : ''}
      ${cell('✊', p.knocks, 'knocks')}
    </div>
    ${w ? '' : '<p class="muted small">Your wallet ($BOO and SOL) shows up once you have played a while.</p>'}
    ${onchainOn() && w ? `<div class="row-actions"><button class="btn small primary" data-act="chainwallet">◎ Wallet &amp; chain: deposit, withdraw, NFTs</button></div>` : ''}

    <h3 class="section">Costumes <span class="muted small">(${costumes.length}/${Object.keys(c.costumes).length})</span></h3>
    <div class="inv-grid">${costumes.map(([id, k]) => `<div class="inv-cell ${p.costume === id ? 'on' : ''}"><span class="inv-icon">${k.icon}</span><span class="inv-name">${esc(k.name)}</span>
      ${p.costume === id ? '<span class="inv-sub">wearing</span>' : `<button class="btn small" data-equip="${id}">Wear</button>`}</div>`).join('')}</div>

    <h3 class="section">Monster cards <span class="muted small">(${cards.length}/${c.cards.length} kinds)</span></h3>
    ${cards.length || nfts.length ? `<div class="inv-grid">${cards.map((x) => cell('🃏', `<span class="r-${x.rarity}">${esc(x.name)}</span>`, `${x.rarity} ×${p.cards[x.id]}`)).join('')}
      ${nfts.map((n) => cell('💎', `<span class="r-${n.rarity}">${esc(n.name)}</span>`, `NFT · ${n.rarity}`)).join('')}</div>`
      : '<p class="muted small">No cards yet. Some doors have them taped on.</p>'}

    <h3 class="section">Items &amp; boosts</h3>
    <div class="inv-grid">
      ${cell('🕯️', p.items.candle, 'Lucky Candles')}
      ${cell('🍭', p.boosts.luck, 'lucky knocks left')}
      ${cell('🥽', p.boosts.nightvision, 'night-vision knocks')}
      ${cell('🛡️', p.shieldMs > 0 ? fmtMs(p.shieldMs) : '—', 'monster repellent')}
    </div>

    <h3 class="section">Houses</h3>
    ${p.ownedHouses.length ? `<div class="inv-grid">${p.ownedHouses.map((h) => `<div class="inv-cell" data-house="${h.id}" style="cursor:pointer"><span class="inv-icon">${h.icon}</span><span class="inv-name">#${h.id} ${esc(h.name)}</span><span class="inv-sub">till ${h.till} 🍬</span></div>`).join('')}</div>`
      : '<p class="muted small">No houses. Empty lots with FOR SALE signs can be bought with SOL.</p>'}

    <h3 class="section">Keys &amp; trophies</h3>
    <div class="pill-row">${p.discovered.map((d) => `<span class="chip gold">🗝️ ${esc(d.name)} · ${d.knocks} knocks</span>`).join('')}
      ${p.trophies.map((t) => `<span class="chip">🏆 ${esc(t)}</span>`).join('')}
      ${!p.discovered.length && !p.trophies.length ? '<span class="muted small">None yet.</span>' : ''}</div>

    <h3 class="section">Raffles</h3>
    <div class="inv-grid">
      ${r ? cell('🎟️', r.yourSlots, `slots in round #${r.round}`) : ''}
      ${myAuctions.map((a) => cell(itemIcon(a.item), esc(a.item.name), `your raffle · ${a.sold}/${a.maxSlots} sold`)).join('')}
    </div>
    ${p.rafflePrizes.length ? `<div class="list">${p.rafflePrizes.map((z) => `<div class="item small"><div><div class="title">${z.kind === 'stock' ? '📈' : '💵'} ${esc(z.prize)}</div><div class="muted small">Town Raffle #${z.round} · ${esc(z.status)}</div></div>
      ${z.status === 'pending verification' ? `<button class="btn small primary" data-claim-prize="${z.id}">Claim</button>` : ''}</div>`).join('')}</div>` : ''}
    <p class="muted small section">Press <kbd>I</kbd> to open or close your bag.</p>`;
}

function renderStoreModal() {
  const st = STORES[S.openStore];
  const p = S.player;
  const id = S.openStore;
  showModal(`<div class="store-head"><span class="big-icon">${st.icon}</span><div><h2>${st.name}</h2><p class="muted small">"${st.hello}"</p></div></div>
    <p class="muted small">You have ${p.bag + p.stash} 🍬 (bank spent first).</p>
    ${st.sections.map(shopSection).join('<div class="section"></div>')}
    <div class="actions"><button class="btn primary" data-close>Leave shop</button></div>`, { wide: true });
  S.openStore = id;
}

function renderShop() {
  $('#tab-shop').innerHTML = `
    <p class="muted small">You have ${S.player.bag + S.player.stash} 🍬. Prefer browsing in person? The shops in the town square sell the same things.</p>
    ${['costumes', 'boosts', 'upgrades', 'training', 'cards', 'townRaffle'].map(shopSection).join('<div class="section"></div>')}
    <p class="muted small">Player raffles (raffle off your own loot) are at the Raffle Tent in the town square.</p>
    <h3 class="section">Neighborhoods</h3>
    <div class="list">${S.world.neighborhoods.map((n) => `<div class="item"><div><div class="title">${n.unlocked ? '🔓' : '🔒'} ${esc(n.name)}</div>
      <div class="muted small">Level ${n.minLevel} · ${n.candyMultiplier}× candy</div></div>
      ${n.unlocked ? '<span class="muted">Open</span>' : `<span class="muted small">Gatekeeper: level ${n.minLevel} or ${n.unlockCost} 🍬 bribe</span>`}</div>`).join('')}</div>`;
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
  const unit = (k) => (k === 'valuableHouses' ? 'SOL' : k === 'notorious' ? 'rep' : '');
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
  $('#tab-me').innerHTML = `
    <h3>${c.costumes[p.costume].icon} ${esc(p.name)} · Level ${p.level}</h3>
    <div class="row-actions"><button class="btn small primary" data-act="playercard">📸 Share my player card</button></div>
    <h3 class="section">Stats</h3>
    ${statsHtml(true)}
    <div class="kv">
      <div>Lucky Candles<b>${p.items.candle}</b></div>
      <div>Candy this season<b>${ss.earned}</b></div>
      <div>Houses visited<b>${ss.housesVisited}</b></div>
      <div>Scares survived<b>${ss.scaresSurvived}</b></div>
      <div>Monsters beaten<b>${ss.ambushesWon}</b></div>
      <div>Biggest haul<b>${ss.biggestReward ? `${ss.biggestReward.amount} 🍬` : '—'}</b></div>
      <div>Rare guaranteed in<b>${p.pityLimit - p.pity} knocks</b></div>
    </div>
    <div class="section"></div>${shopSection('cards')}
    <h3 class="section">Trophies</h3>
    <div class="pill-row">${p.trophies.length ? p.trophies.map((t) => `<span class="chip">🏆 ${esc(t)}</span>`).join('') : '<span class="muted small">None yet.</span>'}</div>
    <h3 class="section">Milestone prizes</h3>
    <p class="muted small">Earned by milestones and season rank. (Town Raffle prizes are in your 🎒 bag and at the Raffle Tent.)</p>
    <div class="list">${p.prizes.map((pr) => `<div class="item small"><div><div class="title">${esc(pr.name)}</div><div class="muted small">${esc(pr.progress)}</div></div>
      ${pr.requested ? '<span class="muted">Requested</span>' : `<button class="btn small ${pr.met ? 'primary' : ''}" data-prize="${pr.id}" ${pr.met ? '' : 'disabled'}>Redeem</button>`}</div>`).join('')}</div>
    <h3 class="section">Monster field guide</h3>
    <div class="list">${c.npcMonsters.map((m) => `<div class="item small"><span>${esc(m.name)} the ${esc(m.type)}</span><span class="muted">weak to ${c.counters[c.monsterCounters[m.type]].icon} ${esc(c.counters[c.monsterCounters[m.type]].name)}</span></div>`).join('')}</div>
    <p class="section row-actions"><button class="btn small" id="btn-help">❔ How to play</button><button class="btn small" id="btn-open-settings">⚙ Settings</button></p>`;
  $('#btn-help').onclick = () => showHelp();
  $('#btn-open-settings').onclick = () => showSettings();
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
      <div class="row"><span>Game wallet</span><span class="mono">${esc(w.address.slice(0, 14))}…</span></div>
      <div class="row"><span>Your Solana wallet</span>${p.solana ? addrLink(p.solana.address) : '<span class="muted">not linked (Settings)</span>'}</div>
      <div class="row"><span>$${sym()}</span><b>${w.boo}</b></div>
      <div class="row"><span>SOL</span><b>${w.sol}</b></div>
      <div class="row"><span>Claimable</span><b>${w.claimable}</b></div>
      <div class="row"><span>Monster bond</span><b>${lic.staked}</b></div>
    </div>
    <div class="row-actions">
      <button class="btn small primary" data-act="claim" ${w.claimable ? '' : 'disabled'}>Claim ${w.claimable} $${sym()}</button>
      <button class="btn small" data-act="faucet" ${w.faucetUsedToday ? 'disabled' : ''}>Get devnet $${sym()}</button>
      ${onchainOn() ? '<button class="btn small primary" data-act="chainwallet">◎ Deposit / withdraw</button>' : `<button class="btn small" data-act="solfaucet" ${w.solFaucetUsedToday ? 'disabled' : ''}>Get devnet SOL</button>`}
    </div>
    <p class="muted small">${onchainOn() ? `Live on Solana ${esc(cluster())}: game balances are backed 1:1 by the game vault. Deposit from and withdraw to your own wallet; deeds and minted cards are real NFTs.` : `$${sym()} and SOL here are test currency on a simulated chain. Houses are bought and sold in SOL.`}</p>

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
      : '<p class="muted small">No deeds yet. Walk to an empty lot with a FOR SALE sign to buy it with SOL. Owners earn candy from visitors and a share of every transaction fee.</p>'}

    <h3 class="section">Market</h3>
    ${market.length ? `<div class="list">${market.map((l) => `<div class="item" data-house="${l.houseId}" style="cursor:pointer"><div><div class="title">${l.icon} #${l.houseId} ${esc(l.name)}</div><div class="muted small">by ${esc(l.seller)} · rep ${l.reputation}</div></div><b>${l.price} ${l.currency === 'SOL' ? 'SOL' : `$${sym()}`}</b></div>`).join('')}</div>` : '<p class="muted small">No houses for sale.</p>'}

    <h3 class="section">Economy</h3>
    <div class="statcard">
      <div class="row"><span>Candy in / out</span><b>${econ.candy.totalIn} / ${econ.candy.totalOut}</b></div>
      <div class="row"><span>Sink ratio</span><b>${econ.candy.sinkRatio ?? '—'}</b></div>
      <div class="row"><span>$${sym()} supply</span><b>${econ.token.supply.toLocaleString()}</b></div>
      <div class="row"><span>Burned</span><b>${econ.token.burned.toLocaleString()}</b></div>
      <div class="row"><span>Today's revenue</span><b>${econ.token.epochRevenue}</b></div>
      <div class="row"><span>Fee rate</span><b>${Math.round(econ.fees.rate * 100)}% on every $${sym()} / SOL payment</b></div>
      <div class="row"><span>House owners' fee pool</span><b>${econ.fees.ownerPool.BOO} $${sym()} · ${econ.fees.ownerPool.SOL} SOL</b></div>
      <div class="row"><span>Raffle prize pool</span><b>$${econ.fees.prizePool.usd}</b></div>
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

async function selectHouse(id, { open = true } = {}) {
  S.selected = id;
  S.houseDetail = await api(`house/${id}`);
  S.tab = 'porch';
  setBeaconHouse(id);
  if (open) toggleDrawer(true);
  else renderTab();
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
  list: async () => {
    // On-chain: the deed NFT moves from the wallet into escrow first (wallet-signed).
    await runIntent(await api('market/list', { houseId: S.selected, price: Number($('#list-price').value) }));
    toast('🏷️ Listed');
  },
  delist: async () => api('market/cancel', { houseId: S.selected }),
  deed: async () => {
    const h = S.houseDetail;
    const have = S.player.wallet?.sol ?? 0;
    if (onchainOn() && have < h.price) {
      const need = Math.ceil((h.price - have) * 1000) / 1000;
      if (!confirm(`This deed costs ${h.price} SOL and your game balance is ${have} SOL.\nDeposit ${need} SOL from your wallet now?`)) return;
      await runIntent(await api('onchain/deposit', { currency: 'SOL', amount: need }));
    }
    await api('deed/buy', { houseId: S.selected });
    toast(onchainOn() ? '🏠 You own this house! Its deed NFT is being minted to your wallet.' : '🏠 You own this house now!', 5000);
  },
  buylisting: async () => (await api('market/buy', { houseId: S.selected }), toast('🏠 Bought!')),
  'lair-ambush': async () => (await api('monster/lair', { houseId: S.selected, kind: 'ambush' }), toast('🧟 Ambush set. Now wait in the bushes...')),
  'lair-trap': async () => (await api('monster/lair', { houseId: S.selected, kind: 'trap' }), toast('🪤 Trap set.')),
  solfaucet: async () => toast(`+${(await api('sol-faucet', {})).received} devnet SOL`),
  chainwallet: async () => showChainWallet(),
  'auction-create': async () => {
    const [kind, id] = $('#au-item').value.split(':');
    const item = kind === 'boo' ? { kind, amount: Number($('#au-amount').value) } : kind === 'card' ? { kind, cardId: id } : { kind, nftId: id };
    await runIntent(await api('auction/create', { item, slotPrice: Number($('#au-price').value), maxSlots: Number($('#au-slots').value), minutes: Number($('#au-mins').value) }));
    await loadAuctions();
    toast('🎟️ Your raffle is live!');
  },
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
    if ((x = el('[data-house]'))) return await selectHouse(Number(x.dataset.house));
    if (el('#btn-menu')) return toggleDrawer();
    if (el('#btn-help-hud')) return showHelp();
    if (el('#btn-bag')) return openBag();
    if (el('#raffle-widget')) return openStore('raffle');
    if (el('#btn-settings')) return showSettings();
    if (el('#btn-close-drawer')) return toggleDrawer(false);
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
    } else if ((x = el('[data-equip]'))) {
      await api('equip', { costumeId: x.dataset.equip });
    } else if ((x = el('[data-track]'))) {
      return trackNpc(x.dataset.track);
    } else if ((x = el('[data-train]'))) {
      await api('train', { stat: x.dataset.train });
      toast('Training complete!');
    } else if ((x = el('[data-craft]'))) {
      const { card } = await api('craft', { cardId: x.dataset.craft });
      toast(`Crafted: ${card.name} (${card.rarity})`);
    } else if ((x = el('[data-mint]'))) {
      const { nft } = await api('mint-card', { cardId: x.dataset.mint });
      toast(`Minted ${nft.meta.name} to your wallet`);
    } else if ((x = el('[data-raffle]'))) {
      const r = await api('raffle', { slots: Number(x.dataset.raffle) });
      toast(`🎟️ You have ${r.slots} slot${r.slots > 1 ? 's' : ''} in this round`);
    } else if ((x = el('[data-raffle-free]'))) {
      await api('raffle', { slots: 1, free: true });
      toast('🎁 Free slot entered. Good luck!');
    } else if ((x = el('[data-claim-prize]'))) {
      return claimPrizeForm(x.dataset.claimPrize);
    } else if ((x = el('[data-auction-enter]'))) {
      await api('auction/enter', { id: x.dataset.auctionEnter, slots: Number(x.dataset.n) });
      await loadAuctions();
      toast('🎟️ Slots bought');
    } else if ((x = el('[data-auction-cancel]'))) {
      await api('auction/cancel', { id: x.dataset.auctionCancel });
      await loadAuctions();
      toast('Raffle cancelled; the item is back in your bag');
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

async function doBank() {
  if (S.busy) return;
  S.busy = true;
  try {
    const pos = S.gfx.pos;
    const r = await api('bank', { pos: { x: pos.x, z: pos.z } });
    tutorialEvent('deposit');
    S.gfx.hero.play('cheer', 0.9);
    showModal(`<div class="big-icon">🏦</div><h2>Candy Bank</h2>
      <p>You deposited <b>${r.banked} 🍬</b>. It's safe from monsters now.</p>
      ${r.stashFull ? '<p class="muted small">Your stash is full! Buy a Bigger Stash in the shop.</p>' : ''}
      <p class="muted small">The night calms down after a trip to the bank. Danger resets to Dusk.</p>
      <div class="actions"><button class="btn primary" data-close>Back out there</button></div>`);
    renderAll();
  } catch (err) {
    toast(err.message);
  } finally {
    S.busy = false;
  }
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
  } finally {
    S.busy = false;
  }
}

function react(r) {
  if (!r || !S.gfx) return;
  const bad = r.candy < 0 || r.won === false || r.outcome === 'trick';
  const great = ['rare', 'legendary', 'token', 'secretHouse', 'collectible', 'bigCandy'].includes(r.outcome) || r.won === true;
  if (bad) S.gfx.hero.play('scared', 0.7);
  else if (great) S.gfx.hero.play('cheer', 0.9);
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
  S.lastResult = r;
  react(r);
  tutorialEvent('knock');
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

function showModal(html, { locked = false, wide = false } = {}) {
  $('#modal-card').innerHTML = html;
  $('#modal-card').classList.toggle('wide', wide);
  $('#modal').hidden = false;
  $('#modal').dataset.locked = locked ? '1' : '';
}
function closeModal() {
  $('#modal').hidden = true;
  S.openStore = null;
}
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' && !$('#modal').dataset.locked) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) {
    if (!$('#modal').dataset.locked) closeModal();
  } else if (S.drawer) toggleDrawer(false);
  else if (!$('#game').hidden) showSettings();
});

// ---------- settings ----------
function showSettings() {
  const zoom = Number(localStorage.getItem('knock.zoom') || 0);
  const hint = localStorage.getItem('knock.hint') !== 'off';
  showModal(`<h2>⚙ Settings</h2>
    <div class="settings">
      <div class="setting-row"><span>Zoom</span><span class="row-actions" style="margin:0"><button class="btn small" id="set-zoom-out">−</button><b>${zoom >= 0 ? '+' : ''}${zoom}</b><button class="btn small" id="set-zoom-in">+</button></span></div>
      <label class="setting-row"><span>Show controls hint</span><input type="checkbox" id="set-hint" ${hint ? 'checked' : ''}></label>
      <div class="setting-row"><span>Tutorial</span><button class="btn small" id="set-tutorial">🎓 Replay</button></div>
      <div class="setting-row"><span>How to play</span><button class="btn small" id="set-help">❔ Open</button></div>
      <div class="setting-row"><span>Solana wallet</span>${S.player.solana
        ? `<span class="row-actions" style="margin:0">${addrLink(S.player.solana.address, `◎ ${shortAddr(S.player.solana.address)}`, 'btn small')}${onchainOn() ? '<button class="btn small" data-act="chainwallet">Funds</button>' : ''}<button class="btn small" id="set-unlink">Unlink</button></span>`
        : '<button class="btn small wallet-btn" id="set-wallet">◎ Connect</button>'}</div>
      ${S.catalog.dev ? '<div class="setting-row"><span>Dev panel</span><button class="btn small dev-btn" id="set-dev">DEV</button></div>' : ''}
    </div>
    <div class="actions">
      <button class="btn primary" data-close>▶ Resume</button>
      <button class="btn" id="set-main-menu">🏠 Main menu</button>
      <button class="btn" id="set-logout">Log out</button>
    </div>
    <p class="muted small">Your progress is saved on the server as you play.</p>`);
  const setZoom = (d) => {
    const z = Math.max(-1, Math.min(3, zoom + d));
    localStorage.setItem('knock.zoom', z);
    S.gfx.world.setZoomBias(z);
    showSettings();
  };
  $('#set-zoom-out').onclick = () => setZoom(-1);
  $('#set-zoom-in').onclick = () => setZoom(1);
  $('#set-hint').onchange = (e) => {
    localStorage.setItem('knock.hint', e.target.checked ? 'on' : 'off');
    $('#controls-hint').hidden = !e.target.checked;
  };
  $('#set-tutorial').onclick = () => {
    closeModal();
    startTutorial();
  };
  $('#set-help').onclick = () => showHelp();
  if ($('#set-dev')) $('#set-dev').onclick = () => {
    closeModal();
    S.dev?.toggle(true);
  };
  $('#set-main-menu').onclick = () => backToMainMenu();
  if ($('#set-wallet')) $('#set-wallet').onclick = () => showWalletPicker();
  if ($('#set-unlink')) $('#set-unlink').onclick = () => unlinkWallet();
  $('#set-logout').onclick = () => {
    if (!confirm(S.player.solana ? 'Log out? Connect your wallet again to come back to this character.' : 'Log out? Without a linked wallet, your progress is tied to this browser login.')) return;
    backToMainMenu();
    logout();
  };
}

function backToMainMenu() {
  closeModal();
  toggleDrawer(false);
  if (S.tut) endTutorial();
  S.dev?.toggle(false);
  if (S.gfx) S.gfx.input.state.enabled = false;
  $('#game').hidden = true;
  showStart();
}


boot();
