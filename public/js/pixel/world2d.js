// The top-down pixel-art neighborhood. World units are tiles (16 px); +z is
// north, drawn up the screen. Draws the ground in cached chunks, then every
// sprite sorted by its base line (so you can walk behind houses), then a night
// lighting pass: darkness with holes cut by lamps, windows and your candle.
//
// Fences are drawn exactly on the edges of the walkable area, so what you see
// is what blocks you. Locked neighborhoods have a gate and a gatekeeper.

import {
  T, PAL, canvas, groundTile, houseSprite, HOUSE_STYLE, treeSprite, lampSprite, fenceSprite, gateSprite, keeperSprite,
  tombSprite, hedgeSprite, signSprite, bankSprite, fountainSprite, ghostSprite, beaconSprite, pumpkinSprite, hash,
  storeSprite, STORE_STYLE, npcSprite, markerSprite,
} from './sprites.js';

const CHUNK = 32; // tiles per ground chunk
const R = 0.32; // player collision radius (tiles)
const HOUSE_DEPTH = 3; // house footprint depth in tiles, north of the base line

export function createWorld(container, catalog) {
  const L = catalog.layout;
  const view = document.createElement('canvas');
  view.className = 'pixel-view';
  container.appendChild(view);
  const ctx = view.getContext('2d');
  const light = document.createElement('canvas');
  const lctx = light.getContext('2d');

  let W = 0;
  let H = 0;
  let zoom = 3;
  let zoomBias = 0;
  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.floor(container.clientWidth * dpr);
    H = Math.floor(container.clientHeight * dpr);
    view.width = light.width = W;
    view.height = light.height = H;
    view.style.width = `${container.clientWidth}px`;
    view.style.height = `${container.clientHeight}px`;
    zoom = Math.max(1, Math.round(Math.min(W / 440, H / 280)) + zoomBias);
    ctx.imageSmoothingEnabled = false;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- walkable area ----------
  const inRect = (r, x, z, pad = 0) => x > r.minX + pad && x < r.maxX - pad && z > r.minZ + pad && z < r.maxZ - pad;
  const walkable = (x, z, pad = 0) => L.zones.some((zn) => inRect(zn, x, z, pad));

  // ---------- ground ----------
  const roadAt = (x, z) => L.roads.find((r) => inRect(r, x, z));
  function tileKind(tx, tz) {
    const x = tx + 0.5;
    const z = tz + 0.5;
    const r = roadAt(x, z);
    if (r) return r.kind === 'plaza' ? 'plaza' : r.kind === 'path' ? 'path' : 'road';
    if (!walkable(x, z)) return 'forest';
    // sidewalk: a tile next to a road
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const n = roadAt(x + dx, z + dz);
      if (n && n.kind === 'road') return 'sidewalk';
    }
    return 'grass';
  }
  const chunks = new Map();
  function chunk(cx, cz) {
    const key = `${cx},${cz}`;
    if (chunks.has(key)) return chunks.get(key);
    const [c, g] = canvas(CHUNK * T, CHUNK * T);
    for (let i = 0; i < CHUNK; i++) {
      for (let j = 0; j < CHUNK; j++) {
        const tx = cx * CHUNK + i;
        const tz = cz * CHUNK + (CHUNK - 1 - j); // row j=0 is the chunk's north edge
        const kind = tileKind(tx, tz);
        g.drawImage(groundTile(kind, tx, tz), i * T, j * T);
        if (kind === 'road') {
          // centre-line dashes on east-west roads
          const r = roadAt(tx + 0.5, tz + 0.5);
          const mid = (r.minZ + r.maxZ) / 2;
          if (r.maxX - r.minX > r.maxZ - r.minZ && tz <= mid && mid < tz + 1 && tx % 3 === 0) {
            g.fillStyle = PAL.dash;
            g.fillRect(i * T + 3, j * T + Math.min(14, Math.round((tz + 1 - mid) * T) - 1), 10, 2);
          }
        }
      }
    }
    chunks.set(key, c);
    return c;
  }

  // ---------- static props ----------
  const props = []; // { x, z, img, ax, ay, kind, light? }
  const add = (o) => props.push(o);
  const colliders = []; // axis-aligned boxes in tiles: { minX, maxX, minZ, maxZ }
  const circles = []; // { x, z, r }

  // Fences on every boundary of the walkable area, with openings where areas connect.
  const fence = [];
  for (const zn of L.zones) {
    for (let x = Math.ceil(zn.minX); x < zn.maxX; x++) {
      for (const [z, out] of [[zn.minZ, -0.5], [zn.maxZ, 0.5]]) {
        // a fence where walkable ground meets the forest; none where areas connect
        if (walkable(x + 0.5, z - out) && !walkable(x + 0.5, z + out)) fence.push({ x: x + 0.5, z, kind: 'h' });
      }
    }
    for (let z = Math.ceil(zn.minZ); z < zn.maxZ; z++) {
      for (const [x, out] of [[zn.minX, -0.5], [zn.maxX, 0.5]]) {
        if (walkable(x - out, z + 0.5) && !walkable(x + out, z + 0.5)) fence.push({ x, z: z + 0.5, kind: 'v' });
      }
    }
  }
  const seen = new Set();
  for (const f of fence) {
    const k = `${f.kind}:${f.x}:${f.z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const img = fenceSprite(f.kind);
    add({ x: f.x, z: f.z, img, ax: img.width / 2, ay: img.height - (f.kind === 'h' ? 3 : 0), kind: 'fence' });
  }

  // Trees: a spooky forest beyond the fences.
  const B = L.bounds;
  for (let x = B.minX; x < B.maxX; x += 3) {
    for (let z = B.minZ; z < B.maxZ; z += 3) {
      const jx = x + hash(x, z) * 2.4;
      const jz = z + hash(z, x) * 2.4;
      if (walkable(jx, jz, -2.2)) continue;
      // keep it dense near the edges and sparse far away
      const near = L.zones.some((zn) => inRect(zn, jx, jz, -14));
      if (!near && hash(x * 3, z * 7) > 0.25) continue;
      const img = treeSprite(Math.floor(hash(x, z * 3) * 6));
      add({ x: jx, z: jz, img, ax: 18, ay: 51, kind: 'tree' });
    }
  }

  // Street lamps along the roads (south side, so they never block a door).
  const lamp = lampSprite();
  for (const r of L.roads) {
    if (r.kind !== 'road') continue;
    const wide = r.maxX - r.minX > r.maxZ - r.minZ;
    if (wide) {
      for (let x = r.minX + 4; x < r.maxX - 2; x += 12) {
        const z = r.minZ - 1.2;
        if (!walkable(x, z, 0.4)) continue;
        add({ x, z, img: lamp, ax: 6, ay: 39, kind: 'lamp', light: { r: 64, color: '#ffe7a0', oy: 36 } });
        circles.push({ x, z, r: 0.25 });
      }
    } else {
      for (let z = r.minZ + 5; z < r.maxZ - 3; z += 12) {
        const x = r.maxX + 1;
        if (!walkable(x, z, 0.4)) continue;
        add({ x, z, img: lamp, ax: 6, ay: 39, kind: 'lamp', light: { r: 64, color: '#ffe7a0', oy: 36 } });
        circles.push({ x, z, r: 0.25 });
      }
    }
  }
  for (const [x, z] of [[-21, -15], [21, -15], [-21, 11.5], [21, 11.5], [-4, 3], [4, 3]]) {
    add({ x, z, img: lamp, ax: 6, ay: 39, kind: 'lamp', light: { r: 64, color: '#ffe7a0', oy: 36 } });
    circles.push({ x, z, r: 0.25 });
  }

  // Candy Bank + fountain in the square.
  const bank = bankSprite();
  add({ x: L.bank.x, z: L.bank.z, img: bank.img, ax: bank.ax, ay: bank.ay, kind: 'bank', light: { r: 60, color: '#ff93b8', oy: 14 } });
  colliders.push({ minX: L.bank.x - L.bank.w / 2, maxX: L.bank.x + L.bank.w / 2, minZ: L.bank.z, maxZ: L.bank.z + 3.4 });
  const fountainProp = { x: L.fountain.x, z: L.fountain.z - 1, img: fountainSprite(0), ax: 32, ay: 46, kind: 'fountain', light: { r: 46, color: '#ffb85a', oy: 26 } };
  add(fountainProp);
  circles.push({ x: L.fountain.x, z: L.fountain.z, r: L.fountain.r });

  // A small graveyard and pumpkins for atmosphere.
  for (const [x, z, v] of [[-60, 44, 0], [-57, 45, 1], [-63, 46, 1], [60, 44, 0], [63, 45, 1], [57, 46, 0], [114, -30, 1], [-114, -30, 0]]) {
    if (!walkable(x, z, 0.5)) continue;
    add({ x, z, img: tombSprite(v), ax: 6, ay: 13, kind: 'tomb' });
    circles.push({ x, z: z + 0.2, r: 0.4 });
  }
  // Shops around the square
  for (const st of L.stores) {
    const sp = storeSprite(st.id, st.w);
    add({ x: st.x, z: st.z, img: sp.img, ax: sp.ax, ay: sp.ay, kind: 'store', lights: sp.lights, id: st.id });
    colliders.push({ minX: st.x - st.w / 2, maxX: st.x + st.w / 2, minZ: st.z, maxZ: st.z + (STORE_STYLE[st.id].stall ? 1.2 : 2.6) });
  }
  for (const n of L.npcs) circles.push({ x: n.x, z: n.z, r: 0.45 });
  for (const [x, z] of [[-3, -5], [3, -5], [-3, 12], [3, 12], [-21, -17], [21, -17]]) add({ x, z, img: pumpkinSprite(true), ax: 4, ay: 8, kind: 'pumpkin', light: { r: 16, color: '#ffb85a', oy: 4 } });

  // ---------- dynamic: houses, gates, keepers, hedges ----------
  const houses = new Map(); // id → { prop, sig, view, sprite }
  const gateProps = new Map();
  const keeperProps = new Map();
  const hedgeProps = new Map();
  let houseColliders = new Map();
  let npcState = {}; // id → 'offer' | 'active' | 'ready' | null
  let npcInfo = {};
  const setNpcs = (state, info) => {
    npcState = state;
    npcInfo = info;
  };

  function houseSig(v) {
    return JSON.stringify([v.type, v.forSale, v.owner?.name, v.tell, v.hot, v.onRoute, v.listing?.price, v.dial, v.lantern]);
  }

  function placeHouse(v) {
    const lay = L.houses[v.id];
    if (!lay) return;
    const prev = houses.get(v.id);
    const sig = houseSig(v);
    if (prev && prev.sig === sig) {
      prev.view = v;
      return;
    }
    const sp = houseSprite(v.type, { dark: v.forSale });
    const extras = [];
    if (v.forSale) {
      const s = signSprite(['FOR SALE', `PRICE ${v.price}`]);
      extras.push({ x: lay.x + 3.2, z: lay.z - 1.4, img: s, ax: Math.floor(s.width / 2), ay: s.height - 1, kind: 'sign' });
    } else if (v.plot && v.owner) {
      const s = signSprite([v.owner.name.slice(0, 12), v.listing ? `SALE ${v.listing.price}` : `LANTERN ${v.lantern}`], { bg: '#2b2440', fg: '#c9a8ff' });
      extras.push({ x: lay.x + 3.2, z: lay.z - 1.4, img: s, ax: Math.floor(s.width / 2), ay: s.height - 1, kind: 'sign' });
    }
    const tell = (v.tell || '').toLowerCase();
    if (!v.forSale && tell.includes('jack-o')) extras.push({ x: lay.x + 1.4, z: lay.z - 0.4, img: pumpkinSprite(true), ax: 4, ay: 8, kind: 'pumpkin', light: { r: 18, color: '#ffb85a', oy: 4 } });
    houses.set(v.id, {
      prop: { x: lay.x, z: lay.z, img: sp.img, ax: sp.ax, ay: sp.ay, kind: 'house', lights: sp.lights, id: v.id },
      extras, sig, view: v, sprite: sp,
      tell: v.forSale ? '' : tell,
    });
    const w = HOUSE_STYLE[v.type]?.w || 6;
    const extra = HOUSE_STYLE[v.type]?.tower ? 1 : 0;
    houseColliders.set(v.id, { minX: lay.x - w / 2, maxX: lay.x + w / 2 + extra, minZ: lay.z, maxZ: lay.z + HOUSE_DEPTH });
  }

  function sync(world) {
    const ids = new Set(world.houses.map((h) => h.id));
    for (const v of world.houses) placeHouse(v);
    for (const id of [...houses.keys()]) if (!ids.has(id)) {
      houses.delete(id);
      houseColliders.delete(id);
    }
    for (const g of L.gates) {
      const hood = world.neighborhoods.find((n) => n.id === g.hood);
      const locked = !hood?.unlocked;
      gateProps.set(g.hood, { spec: g, locked, hood });
    }
    for (const k of L.keepers) keeperProps.set(k.hood, k);
    for (const h of L.hedges) hedgeProps.set(h.house, { spec: h, locked: !world.houses.some((x) => x.id === h.house) });
  }

  // ---------- collisions ----------
  function blocked(x, z) {
    if (!walkable(x, z, R)) return true;
    const hit = (c) => x > c.minX - R && x < c.maxX + R && z > c.minZ - R && z < c.maxZ + R;
    for (const c of colliders) if (hit(c)) return true;
    for (const c of houseColliders.values()) if (hit(c)) return true;
    for (const c of circles) if (Math.hypot(x - c.x, z - c.z) < c.r + R) return true;
    for (const k of keeperProps.values()) if (Math.hypot(x - k.x, z - k.z) < 0.5 + R) return true;
    for (const { spec, locked } of gateProps.values()) {
      if (locked && Math.abs(x - spec.x) < 0.6 + R && Math.abs(z - spec.z) < spec.span / 2 + 0.6) return true;
    }
    for (const { spec, locked } of hedgeProps.values()) {
      if (!locked) continue;
      if (spec.z !== undefined && Math.abs(z - spec.z) < 0.7 + R && x > spec.x1 && x < spec.x2) return true;
      if (spec.x !== undefined && Math.abs(x - spec.x) < 0.7 + R && z > spec.z1 && z < spec.z2) return true;
    }
    return false;
  }

  function move(pos, dx, dz) {
    if (!blocked(pos.x + dx, pos.z + dz)) {
      pos.x += dx;
      pos.z += dz;
      return true;
    }
    let moved = false;
    if (dx && !blocked(pos.x + dx, pos.z)) { pos.x += dx; moved = true; }
    if (dz && !blocked(pos.x, pos.z + dz)) { pos.z += dz; moved = true; }
    return moved;
  }

  // ---------- beacon + ambient ----------
  let beacon = null;
  const setBeacon = (target) => (beacon = target);
  const ghosts = [0, 1, 2, 3].map((i) => ({ a: i * 1.7, r: 30 + i * 18, cz: 30 }));

  // ---------- render ----------
  let time = 0;
  const LABEL_FONT = 'bold 13px ui-monospace, Menlo, monospace';

  function render(dt, focus, actor, labels = {}) {
    time += dt;
    const scale = zoom;
    const camX = Math.round(focus.x * T * scale - W / 2);
    const camY = Math.round(-focus.z * T * scale - H / 2);
    const sx = (x) => Math.round(x * T * scale - camX);
    const sy = (z) => Math.round(-z * T * scale - camY);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PAL.forest;
    ctx.fillRect(0, 0, W, H);

    // ground chunks in view
    const minTx = Math.floor(camX / scale / T);
    const maxTx = Math.ceil((camX + W) / scale / T);
    const maxTz = Math.ceil(-camY / scale / T);
    const minTz = Math.floor(-(camY + H) / scale / T);
    for (let cx = Math.floor(minTx / CHUNK); cx <= Math.floor(maxTx / CHUNK); cx++) {
      for (let cz = Math.floor(minTz / CHUNK); cz <= Math.floor(maxTz / CHUNK); cz++) {
        const img = chunk(cx, cz);
        ctx.drawImage(img, sx(cx * CHUNK), sy((cz + 1) * CHUNK), CHUNK * T * scale, CHUNK * T * scale);
      }
    }

    // collect visible sprites
    const vis = [];
    const onScreen = (x, z, pad = 8) => x > minTx - pad && x < maxTx + pad && z > minTz - pad && z < maxTz + pad + 6;
    for (const p of props) if (onScreen(p.x, p.z)) vis.push(p);
    for (const h of houses.values()) {
      if (!onScreen(h.prop.x, h.prop.z, 12)) continue;
      vis.push(h.prop, ...h.extras);
    }
    for (const { spec, locked } of gateProps.values()) {
      if (!locked) continue;
      const img = gateSprite(true);
      for (let z = spec.z - spec.span / 2 + 0.5; z < spec.z + spec.span / 2; z += 1) vis.push({ x: spec.x, z, img, ax: 8, ay: 29, kind: 'gate' });
    }
    for (const n of L.npcs) {
      if (!onScreen(n.x, n.z)) continue;
      const look = npcInfo[n.id]?.look || 'mayor';
      vis.push({ x: n.x, z: n.z, img: npcSprite(look, Math.floor(time * 1.6 + n.x) % 2), ax: 10, ay: 35, kind: 'npc' });
      const mk = npcState[n.id];
      if (mk) vis.push({ x: n.x, z: n.z - 0.01, img: markerSprite(mk), ax: 4, ay: 46 + Math.round(Math.sin(time * 4) * 2), kind: 'marker' });
    }
    for (const k of keeperProps.values()) vis.push({ x: k.x, z: k.z, img: keeperSprite(Math.floor(time * 1.5) % 2), ax: 10, ay: 39, kind: 'keeper', light: { r: 30, color: '#ffd34d', oy: 12 } });
    for (const { spec, locked } of hedgeProps.values()) {
      if (!locked) continue;
      const img = hedgeSprite();
      if (spec.z !== undefined) for (let x = spec.x1 + 0.5; x < spec.x2; x += 1) vis.push({ x, z: spec.z, img, ax: 8, ay: 21, kind: 'hedge' });
      else for (let z = spec.z1 + 0.5; z < spec.z2; z += 1) vis.push({ x: spec.x, z, img, ax: 8, ay: 21, kind: 'hedge' });
    }
    if (actor) vis.push({ x: focus.x, z: focus.z, img: actor.frame(), ax: 8, ay: 31, kind: 'player', light: { r: 46, color: '#ffb060', oy: 8 } });
    fountainProp.img = fountainSprite(Math.floor(time * 2) % 2);

    vis.sort((a, b) => b.z - a.z);
    for (const p of vis) {
      ctx.drawImage(p.img, sx(p.x) - p.ax * scale, sy(p.z) - p.ay * scale, p.img.width * scale, p.img.height * scale);
    }

    // floating ghosts over the streets
    ghosts.forEach((g, i) => {
      const gx = Math.cos(time * 0.05 + g.a) * g.r;
      const gz = g.cz + Math.sin(time * 0.05 + g.a) * g.r * 0.6;
      const img = ghostSprite(Math.floor(time * 3) % 2);
      ctx.globalAlpha = 0.55;
      ctx.drawImage(img, sx(gx) - 8 * scale, sy(gz) - (24 + Math.sin(time * 2 + i) * 3) * scale, 16 * scale, 18 * scale);
      ctx.globalAlpha = 1;
    });

    // beacon
    if (beacon) {
      const img = beaconSprite(Math.floor(time * 4) % 2);
      ctx.drawImage(img, sx(beacon.x) - 5 * scale, sy(beacon.z) - (beacon.h || 120) * scale, 11 * scale, 14 * scale);
    }

    // ---------- lighting ----------
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, W, H);
    lctx.fillStyle = 'rgba(14, 8, 36, 0.58)';
    lctx.fillRect(0, 0, W, H);
    lctx.globalCompositeOperation = 'destination-out';
    const glows = [];
    const hole = (x, y, r, a = 1) => {
      const grad = lctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, `rgba(0,0,0,${a})`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      lctx.fillStyle = grad;
      lctx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    for (const p of vis) {
      if (p.light) {
        const x = sx(p.x);
        const y = sy(p.z) - p.light.oy * scale;
        hole(x, y, p.light.r * scale, 0.95);
        glows.push([x, y, p.light.r * scale * 0.6, p.light.color, 0.18]);
      }
      if (p.kind === 'store') {
        for (const l of p.lights) {
          const x = sx(p.x) + (l.x - p.ax) * scale;
          const y = sy(p.z) + (l.y - p.ay) * scale;
          hole(x, y, l.r * scale, 0.9);
          glows.push([x, y, l.r * scale * 0.7, l.color, 0.2]);
        }
      }
      if (p.kind === 'house') {
        const h = houses.get(p.id);
        const flicker = h?.tell.includes('flicker') ? Math.sin(time * 13 + p.id) + Math.sin(time * 7.3 + p.id * 2) > 0.3 : true;
        const scream = h?.tell.includes('scream') && (time + p.id) % 6 < 0.15;
        for (const l of p.lights) {
          if (!flicker && l.kind === 'window') continue;
          const x = sx(p.x) + (l.x - p.ax) * scale;
          const y = sy(p.z) + (l.y - p.ay) * scale;
          const warm = l.kind === 'porch' && h?.tell.includes('warm porch');
          const r = (warm ? l.r * 2.6 : scream ? l.r * 2 : l.r) * scale;
          hole(x, y, r, 0.9);
          glows.push([x, y, r * 0.7, warm ? '#ffb060' : l.color, scream ? 0.5 : 0.22]);
        }
      }
    }
    lctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(light, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    for (const [x, y, r, color, a] of glows) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, hexA(color, a));
      grad.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // house tells that move: caramel steam, rustling bushes, claw marks
    for (const h of houses.values()) {
      if (!h.tell || !onScreen(h.prop.x, h.prop.z, 4)) continue;
      const bx = sx(h.prop.x);
      const by = sy(h.prop.z);
      if (h.tell.includes('caramel')) {
        for (let i = 0; i < 3; i++) {
          const k = ((time * 0.5 + i / 3) % 1);
          ctx.fillStyle = `rgba(255,224,176,${0.5 * (1 - k)})`;
          ctx.fillRect(bx + (h.sprite.chimney.x - h.prop.ax) * scale + Math.sin(time + i) * 2 * scale, by + (h.sprite.chimney.y - h.prop.ay - k * 18) * scale, 4 * scale, 4 * scale);
        }
      }
      if (h.tell.includes('bushes')) {
        const shake = Math.sin(time * 1.3 + h.prop.id) > 0.5 ? Math.round(Math.sin(time * 30)) : 0;
        ctx.fillStyle = '#2c4a35';
        ctx.fillRect(bx - (h.prop.ax - 2 + shake) * scale, by - 12 * scale, 12 * scale, 12 * scale);
        ctx.fillStyle = '#3f6b4a';
        ctx.fillRect(bx - (h.prop.ax - 5 + shake) * scale, by - 10 * scale, 3 * scale, 3 * scale);
      }
      if (h.tell.includes('claw')) {
        ctx.fillStyle = '#b01828';
        for (let i = 0; i < 3; i++) ctx.fillRect(bx + (4 + i * 2) * scale, by - (14 - i) * scale, scale, 6 * scale);
      }
    }

    // labels for nearby houses + gatekeepers
    ctx.font = LABEL_FONT.replace('13px', `${Math.max(11, Math.round(scale * 4.5))}px`);
    ctx.textAlign = 'center';
    for (const h of houses.values()) {
      const d = Math.hypot(h.prop.x - focus.x, h.prop.z - focus.z);
      if (d > 11) continue;
      const v = h.view;
      const x = sx(h.prop.x);
      const y = sy(h.prop.z) - (h.prop.ay + 6) * scale;
      const top = `#${v.id} ${v.name}`;
      const sub = v.forSale ? `FOR SALE · ${v.price} $BOO` : v.owner ? `Home of ${v.owner.name}` : v.typeName;
      label(x, y, [top, sub, v.hot ? 'HOT HOUSE · 2x candy' : null], v.forSale ? '#ffd34d' : v.owner ? '#c9a8ff' : '#cfc6e6', Math.max(0.35, 1 - d / 11));
    }
    for (const g of gateProps.values()) {
      const k = keeperProps.get(g.spec.hood);
      if (!k || Math.hypot(k.x - focus.x, k.z - focus.z) > 9) continue;
      label(sx(k.x), sy(k.z) - 46 * scale, [`Gatekeeper of ${g.hood.name}`, g.locked ? `Level ${g.hood.minLevel} or a ${g.hood.unlockCost} candy bribe` : 'You may pass'], g.locked ? '#ffd34d' : '#6ee7a0', 1);
    }
    for (const st of L.stores) {
      if (Math.hypot(st.x - focus.x, st.z - focus.z) > 7) continue;
      const info = labels.stores?.[st.id];
      if (info) label(sx(st.x), sy(st.z) - ((STORE_STYLE[st.id].stall ? 64 : 90) * scale), [info.name, info.sub], '#ffd34d', 1);
    }
    for (const n of L.npcs) {
      if (Math.hypot(n.x - focus.x, n.z - focus.z) > 6) continue;
      const info = npcInfo[n.id];
      if (info) label(sx(n.x), sy(n.z) - 50 * scale, [info.name, info.title], '#c9a8ff', 1);
    }
    if (labels.bank && Math.hypot(L.bank.x - focus.x, L.bank.z - focus.z) < 12) label(sx(L.bank.x), sy(L.bank.z) - 116 * scale, ['Candy Bank', 'Deposit your bucket here'], '#ff93b8', 1);
  }

  function label(x, y, lines, color, alpha) {
    const list = lines.filter(Boolean);
    const lh = Math.round(parseInt(ctx.font.match(/(\d+)px/)[1], 10) * 1.25);
    const w = Math.max(...list.map((l) => ctx.measureText(l).width)) + 14;
    const h = lh * list.length + 8;
    const topSafe = (window.innerWidth < 760 ? 150 : 80) * dpr; // keep labels clear of the HUD
    if (y - h < topSafe) y = topSafe + h;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(20,14,34,0.82)';
    ctx.fillRect(Math.round(x - w / 2), Math.round(y - h), Math.round(w), h);
    list.forEach((l, i) => {
      ctx.fillStyle = i === 0 ? '#f1eaff' : color;
      ctx.fillText(l, x, y - h + lh * (i + 1));
    });
    ctx.globalAlpha = 1;
  }

  const setZoomBias = (b) => {
    zoomBias = b;
    resize();
  };
  return { canvas: view, sync, move, blocked, render, setBeacon, setNpcs, setZoomBias, layout: L, houses, keepers: keeperProps };
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
