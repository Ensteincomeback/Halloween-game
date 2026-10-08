// Dev build only: a panel to play-test any feature without grinding.
// Opened with ` (backtick) or the DEV button. The server only exposes these
// endpoints when started with `npm run dev`.

export function createDevPanel({ api, S, toast, teleport, refresh, startTutorial, layout }) {
  const el = document.getElementById('devpanel');
  const btn = document.getElementById('btn-dev');
  btn.hidden = false;
  let open = false;

  const call = async (name, args = [], msg) => {
    try {
      await api(`dev/${name}`, { args });
      await refresh();
      toast(`DEV: ${msg || name}`);
    } catch (err) {
      toast(err.message);
    }
  };

  const nearestHouse = () => {
    const p = S.gfx.pos;
    return S.world.houses.filter((h) => h.knockable && layout.houses[h.id])
      .sort((a, b) => Math.hypot(layout.houses[a.id].x - p.x, layout.houses[a.id].z - p.z) - Math.hypot(layout.houses[b.id].x - p.x, layout.houses[b.id].z - p.z))[0];
  };

  const spots = () => {
    const list = [['Town square', layout.spawn], ['Candy Bank', layout.bank.door]];
    for (const k of layout.keepers) list.push([`Gatekeeper: ${S.catalog.neighborhoods.find((n) => n.id === k.hood).name}`, k.spot]);
    for (const n of S.catalog.neighborhoods) {
      const first = Object.values(layout.houses).find((h) => h.hood === n.id && !h.secret);
      if (first) list.push([`${n.name} (first house)`, first.door]);
    }
    for (const s of S.catalog.secretHouses) list.push([`Secret: ${s.name}`, layout.houses[s.id].door]);
    return list;
  };

  function render() {
    const p = S.player;
    el.innerHTML = `
      <div class="dev-head"><b>DEV BUILD</b><button class="btn small" id="dev-close">✕</button></div>
      <p class="muted small">Play-test shortcuts. Not available in production builds.</p>
      <h4>Resources</h4>
      <div class="dev-row">
        <button class="btn small" data-dev="candy" data-args="[10000]">+10k candy</button>
        <button class="btn small" data-dev="candy" data-args="[1000000]">+1M candy</button>
        <button class="btn small" data-dev="fillBucket">Fill bucket</button>
        <button class="btn small" data-dev="boo" data-args="[5000]">+5k $BOO</button>
        <button class="btn small" data-dev="knocks">999 knocks</button>
      </div>
      <div class="dev-row"><label>Level <select id="dev-level">${[1, 3, 4, 5, 8, 10, 15, 20, 30].map((l) => `<option ${l === p.level ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn small" id="dev-set-level">Set level</button></div>
      <h4>Scare Actor</h4>
      <div class="dev-row">${Object.entries(S.catalog.monsterTypes).map(([id, t]) => `<button class="btn small" data-dev="monster" data-args='["${id}"]'>${t.icon} ${t.name}</button>`).join('')}</div>
      <p class="muted small">Skips the stake and bond warm-up; Fright is full.</p>
      <h4>Unlock</h4>
      <div class="dev-row">
        <button class="btn small" data-dev="unlockAll">All neighborhoods</button>
        <button class="btn small" data-dev="costumes">All costumes</button>
        <button class="btn small" data-dev="cards">Monster cards ×3</button>
        <button class="btn small" data-dev="secrets">Reveal secret houses</button>
      </div>
      <h4>Next knock</h4>
      <div class="dev-row"><select id="dev-outcome">${['jackpot', ...S.catalog.outcomes].map((o) => `<option>${o}</option>`).join('')}</select>
        <button class="btn small" id="dev-force">Force</button></div>
      <h4>Encounters</h4>
      <div class="dev-row">
        <button class="btn small" id="dev-rival-ambush">Rival ambush at nearest house</button>
        <button class="btn small" id="dev-rival-trap">Rival trap at nearest house</button>
        <button class="btn small" data-dev="shield">Clear shield</button>
      </div>
      <h4>World</h4>
      <div class="dev-row">
        <button class="btn small" data-dev="event" data-args="[true]">Open Legendary Mansion</button>
        <button class="btn small" data-dev="event" data-args="[false]">Close it</button>
        <button class="btn small" data-dev="epoch">Settle payouts now</button>
        <button class="btn small" data-dev="resetDaily">New day</button>
      </div>
      <h4>Travel</h4>
      <div class="dev-row"><select id="dev-spot">${spots().map(([name], i) => `<option value="${i}">${name}</option>`).join('')}</select>
        <button class="btn small" id="dev-teleport">Teleport</button></div>
      <label class="dev-row small"><input type="checkbox" id="dev-notravel" ${S.devNoTravel ? 'checked' : ''}> Skip the server's travel-speed check</label>
      <h4>Tutorial</h4>
      <div class="dev-row">
        <button class="btn small" id="dev-tut">Run tutorial</button>
        <button class="btn small" id="dev-tut-reset">Reset "seen" flag</button>
      </div>`;
    el.querySelector('#dev-close').onclick = () => toggle(false);
    el.querySelectorAll('[data-dev]').forEach((b) => (b.onclick = () => call(b.dataset.dev, JSON.parse(b.dataset.args || '[]'), b.textContent.trim())));
    el.querySelector('#dev-set-level').onclick = () => call('level', [Number(el.querySelector('#dev-level').value)], `level ${el.querySelector('#dev-level').value}`);
    el.querySelector('#dev-force').onclick = () => call('force', [el.querySelector('#dev-outcome').value], `next knock = ${el.querySelector('#dev-outcome').value}`);
    for (const kind of ['ambush', 'trap']) {
      el.querySelector(`#dev-rival-${kind}`).onclick = () => {
        const h = nearestHouse();
        if (h) call('rival', [h.id, kind], `rival ${kind} waiting at #${h.id} ${h.name}`);
      };
    }
    el.querySelector('#dev-teleport').onclick = async () => {
      const [name, spot] = spots()[Number(el.querySelector('#dev-spot').value)];
      const target = { x: spot.x, z: spot.z - 0.6 };
      teleport(target.x, target.z);
      await call('teleport', [target.x, target.z], `teleported to ${name}`);
    };
    el.querySelector('#dev-notravel').onchange = (e) => {
      S.devNoTravel = e.target.checked;
      call('noTravel', [e.target.checked], `travel check ${e.target.checked ? 'off' : 'on'}`);
    };
    el.querySelector('#dev-tut').onclick = () => {
      toggle(false);
      startTutorial();
    };
    el.querySelector('#dev-tut-reset').onclick = () => {
      localStorage.removeItem('knock.tutorial');
      toast('DEV: tutorial will show next time you press Play');
    };
  }

  function toggle(force) {
    open = force ?? !open;
    el.hidden = !open;
    if (open) render();
  }
  btn.onclick = () => toggle();
  return { toggle };
}
