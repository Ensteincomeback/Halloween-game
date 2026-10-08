// The 3D neighborhood, built from the hand-made models (see assets.js) in the
// style of the Knock street map: sage lawns, lilac sidewalks, pastel houses,
// bare purple trees, iron fences and tombstones.
// NPC homes are lit and lived in. Empty NFT lots are dark and boarded up with a
// FOR SALE sign until someone buys them. House tells are visible from the street.

import * as THREE from 'three';
import { recolor, MANSION, HUT } from './assets.js';

const PALETTE = {
  sky: 0x2a2840, fog: 0x34324f, ground: 0x5c716e, road: 0x696977, sidewalk: 0xa09cab, dash: 0xeee3ad,
  plaza: 0x8f8a9e, iron: 0x5a5363,
};

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...opts });
const glowMat = (color, intensity = 1.6) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.6, flatShading: true });

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function textSprite(lines, { color = '#f1eaff', bg = 'rgba(30,26,48,0.82)', size = 30, width = 512 } = {}) {
  const c = document.createElement('canvas');
  const lh = size * 1.25;
  c.width = width;
  c.height = Math.ceil(lh * lines.length + 20);
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(0, 0, c.width, c.height, 18);
  g.fill();
  g.textAlign = 'center';
  lines.forEach((l, i) => {
    const o = typeof l === 'object' ? l : { text: l };
    g.fillStyle = o.color || color;
    g.font = `${i === 0 ? 'bold ' : ''}${o.size || size}px system-ui, sans-serif`;
    g.fillText(o.text, c.width / 2, 10 + lh * (i + 0.8));
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const scale = 0.009;
  sprite.scale.set(c.width * scale, c.height * scale, 1);
  return sprite;
}

function signBoard(lines, opts) {
  const g = new THREE.Group();
  g.add(box(0.1, 1.2, 0.1, mat(0x72626c), 0, 0.6, 0));
  const tex = textSprite(lines, opts).material.map;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.9), new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.9 }));
  board.position.y = 1.5;
  board.castShadow = true;
  g.add(board);
  return g;
}

function pumpkin(r = 0.3) {
  const g = new THREE.Group();
  const p = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), mat(0xffb85a, { emissive: 0xbc7500, emissiveIntensity: 0.6 }));
  p.scale.set(1.15, 0.85, 1.1);
  p.castShadow = true;
  g.add(p);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.14, 5), mat(0x86a060));
  stem.position.y = r * 0.85;
  g.add(stem);
  return g;
}

// ---------- house variants ----------
// Each type = one of the two house models, recolored and scaled, plus extras.
const VARIANTS = {
  normal: { base: 'mansion', scale: 0.95, colors: { [MANSION.wall]: 0xb3a28c, [MANSION.trim]: 0x6b5a4a, [MANSION.roof]: 0x8a5a52 } },
  haunted: { base: 'mansion', scale: 1.0, colors: {} },
  zombie: { base: 'mansion', scale: 1.0, colors: { [MANSION.wall]: 0x7d9070, [MANSION.trim]: 0x3d4a35, [MANSION.roof]: 0x4c5a44 }, glow: 0xb6ff8a, boards: true },
  vampire: { base: 'mansion', scale: 1.12, colors: { [MANSION.wall]: 0x5b4a5e, [MANSION.trim]: 0x3a2238, [MANSION.roof]: 0x2e2433, [MANSION.door]: 0x6b1f2a }, glow: 0xff5a6a },
  mansion: { base: 'mansion', scale: 1.3, colors: { [MANSION.wall]: 0x6e6a7a, [MANSION.trim]: 0x3d3a4a, [MANSION.roof]: 0x3d3a4a } },
  graveyard: { base: 'mansion', scale: 0.9, colors: { [MANSION.wall]: 0x8d8d9a, [MANSION.trim]: 0x5a5a6a, [MANSION.roof]: 0x5a5a6a }, glow: 0xbfd0ff, graves: true },
  legendary: { base: 'mansion', scale: 1.5, colors: { [MANSION.wall]: 0x3d2d55, [MANSION.trim]: 0x2a1f40, [MANSION.roof]: 0xd9a520 }, glow: 0xffd34d, gold: true },
  witch: { base: 'witchHut', scale: 1.0, colors: {} },
  pumpkin: { base: 'witchHut', scale: 1.05, colors: { [HUT.roof]: 0xff8c2a, [HUT.band]: 0x3d6b22, [HUT.wall]: 0xc7a46a, [HUT.base]: 0x8a7a4a }, pumpkins: true },
  lab: { base: 'witchHut', scale: 1.1, colors: { [HUT.roof]: 0x6f8a96, [HUT.band]: 0x5affd2, [HUT.wall]: 0x9aa6ad, [HUT.base]: 0x5f6b72 }, glow: 0x5affd2, lab: true },
};

const BASE = {
  mansion: { glass: MANSION.glass, hw: 3.9, hd: 2.4, height: 8.3 },
  witchHut: { glass: HUT.glass, hw: 2.7, hd: 2.7, height: 7.6 },
};

export function houseFootprint(type) {
  const v = VARIANTS[type] || VARIANTS.normal;
  const b = BASE[v.base];
  return { hw: b.hw * v.scale, hd: b.hd * v.scale };
}

function buildHouse(assets, view, { dark }) {
  const v = VARIANTS[view.type] || VARIANTS.normal;
  const b = BASE[v.base];
  const colors = { ...v.colors };
  const emissive = {};
  if (dark) {
    // Empty lot: everything dims, windows go black.
    const src = v.base === 'mansion' ? MANSION : HUT;
    for (const h of Object.values(src)) colors[h] = new THREE.Color(colors[h] ?? Number(`0x${h}`)).multiplyScalar(0.5).getHex();
    colors[b.glass] = 0x16141c;
    emissive[b.glass] = 0x000000;
    emissive[HUT.brew] = 0x000000;
    emissive[MANSION.pumpkin] = 0x000000;
  } else if (v.glow) emissive[b.glass] = v.glow;
  const model = recolor(assets[v.base], colors, { emissiveMap: emissive });
  model.scale.setScalar(v.scale);
  const g = new THREE.Group();
  g.add(model);
  const windows = [];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.userData.srcHex === b.glass) windows.push(o);
    if (v.gold && o.material.userData.srcHex === MANSION.roof) Object.assign(o.material, { metalness: 0.6, roughness: 0.35 });
  });
  for (const w of windows) w.material.emissiveIntensity = dark ? 0 : 1.3;
  const front = b.hd * v.scale;

  if ((v.boards || dark) && windows.length) {
    // Boards across the front windows.
    const plank = mat(0x6b4a2a);
    g.updateMatrixWorld(true);
    for (const w of windows) {
      const bb = new THREE.Box3().setFromObject(w);
      if (bb.max.z < front - 0.6 || bb.max.z - bb.min.z > 0.4) continue; // only front-facing panes
      const c = bb.getCenter(new THREE.Vector3());
      const wdt = (bb.max.x - bb.min.x) * 1.2;
      g.add(box(wdt, 0.1, 0.05, plank, c.x, c.y + 0.1, bb.max.z + 0.05).rotateZ(0.45));
      g.add(box(wdt, 0.1, 0.05, plank, c.x, c.y - 0.12, bb.max.z + 0.05).rotateZ(-0.35));
    }
  }
  if (v.graves && assets.tombstone) {
    for (let i = 0; i < 5; i++) {
      const t = assets.tombstone.clone(true);
      const side = i % 2 ? 1 : -1;
      t.position.set(side * (3.6 + (i % 3) * 0.5), 0, front + 0.4 + Math.floor(i / 2) * 1.0);
      t.rotation.y = side * 0.2;
      g.add(t);
    }
  }
  if (v.pumpkins) {
    for (let i = 0; i < 8; i++) {
      const p = pumpkin(0.22 + (i % 3) * 0.08);
      const side = i < 4 ? -1 : 1;
      p.position.set(side * (3.3 + (i % 2) * 0.7), 0.2, front - 1.2 + (i % 4) * 0.8);
      g.add(p);
    }
  }
  if (v.lab && !dark) {
    for (const x of [-3.4, 3.4]) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 2.2, 8), glowMat(0x5affd2, 1.1));
      tube.position.set(x, 1.1, front - 0.8);
      g.add(tube);
    }
  }
  return { group: g, windows, front, height: b.height * v.scale };
}

// Tells: what players can read from the street.
function addTell(house, tell) {
  const t = (tell || '').toLowerCase();
  const fx = {};
  const front = house.front;
  if (t.includes('flicker')) fx.flicker = true;
  if (t.includes('scream')) fx.scream = true;
  if (t.includes('warm porch')) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), glowMat(0xffc46b, 3));
    lamp.position.set(-0.9, 2.3, front + 0.2);
    house.group.add(lamp);
    const light = new THREE.PointLight(0xffb060, 5, 7, 1.8);
    light.position.set(-0.9, 2.0, front + 0.8);
    house.group.add(light);
  }
  if (t.includes('caramel')) {
    fx.puffs = [];
    for (let i = 0; i < 3; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(0.28, 6, 4), new THREE.MeshStandardMaterial({ color: 0xffe0b0, transparent: true, opacity: 0.4, emissive: 0xffa040, emissiveIntensity: 0.3 }));
      puff.position.set(-1, house.height + 0.4, -0.6);
      house.group.add(puff);
      fx.puffs.push(puff);
    }
  }
  if (t.includes('jack-o')) {
    const p = pumpkin(0.4);
    p.position.set(1.3, 0.35, front + 1.0);
    house.group.add(p);
  }
  if (t.includes('bushes')) {
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0), mat(0x3f5a4a));
    bush.position.set(-2.6, 0.7, front + 1.2);
    bush.castShadow = true;
    house.group.add(bush);
    fx.shake = bush;
  }
  if (t.includes('claw')) {
    for (let i = 0; i < 3; i++) {
      const c = box(0.06, 0.8, 0.04, new THREE.MeshBasicMaterial({ color: 0x8a1020 }), 0.8 + i * 0.16, 1.3, front + 0.05);
      c.rotation.z = 0.35;
      house.group.add(c);
    }
  }
  return fx;
}

// Instance every mesh of a multi-mesh prop (tree, lamp) at many spots: one draw call per part.
function instanceProp(scene, proto, matrices) {
  if (!proto || !matrices.length) return;
  proto.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(proto.matrixWorld).invert();
  proto.traverse((o) => {
    if (!o.isMesh) return;
    const local = new THREE.Matrix4().multiplyMatrices(rootInv, o.matrixWorld);
    const inst = new THREE.InstancedMesh(o.geometry, o.material, matrices.length);
    matrices.forEach((m, i) => inst.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(m, local)));
    inst.castShadow = true;
    inst.receiveShadow = true;
    scene.add(inst);
  });
}

const at = (x, z, ry = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)), new THREE.Vector3(s, s, s));

export function createWorld(container, catalog, assets) {
  const L = catalog.layout;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.Fog(PALETTE.fog, 35, 120);

  const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 500);

  // ---- light: pastel moonlit night ----
  scene.add(new THREE.HemisphereLight(0xc9c2ff, 0x3a4440, 1.5));
  const moonLight = new THREE.DirectionalLight(0xdfe4ff, 1.6);
  moonLight.position.set(-30, 60, 25);
  moonLight.castShadow = true;
  moonLight.shadow.mapSize.set(2048, 2048);
  Object.assign(moonLight.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 160 });
  moonLight.shadow.bias = -0.0005;
  scene.add(moonLight, moonLight.target);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(10, 20, 14), new THREE.MeshBasicMaterial({ color: 0xfff3c4, fog: false }));
  moon.position.set(-120, 110, -170);
  scene.add(moon);
  const starPos = [];
  for (let i = 0; i < 900; i++) {
    const th = Math.random() * Math.PI * 2;
    const ph = Math.random() * Math.PI * 0.42;
    starPos.push(Math.cos(th) * Math.sin(ph) * 300, Math.cos(ph) * 300, Math.sin(th) * Math.sin(ph) * 300);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.1, fog: false })));

  // ---- ground, plaza, streets with sidewalks ----
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), mat(PALETTE.ground));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 0.1, 40), mat(PALETTE.plaza));
  plaza.position.y = 0.04;
  plaza.receiveShadow = true;
  scene.add(plaza);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(20, 0.25, 4, 48), mat(PALETTE.sidewalk));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  scene.add(ring);

  const lampSpots = [];
  for (const s of L.streets) {
    const len = Math.hypot(s.to.x - s.from.x, s.to.z - s.from.z);
    const ang = Math.atan2(s.dir.x, s.dir.z);
    const mid = { x: (s.from.x + s.to.x) / 2, z: (s.from.z + s.to.z) / 2 };
    const lat = { x: s.dir.z, z: -s.dir.x };
    const strip = (w, color, off, y) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, len), mat(color));
      m.rotation.y = ang;
      m.position.set(mid.x + lat.x * off, y, mid.z + lat.z * off);
      m.receiveShadow = true;
      scene.add(m);
    };
    strip(6, PALETTE.road, 0, 0.05);
    strip(1.8, PALETTE.sidewalk, 3.9, 0.09);
    strip(1.8, PALETTE.sidewalk, -3.9, 0.09);
    const dashMat = new THREE.MeshBasicMaterial({ color: PALETTE.dash });
    for (let u = 2; u < len; u += 3) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 1.4), dashMat);
      dash.rotation.set(-Math.PI / 2, 0, -ang);
      dash.position.set(s.from.x + s.dir.x * u, 0.11, s.from.z + s.dir.z * u);
      scene.add(dash);
    }
    for (let u = 6, k = 0; u < len - 4; u += 12, k++) {
      const side = k % 2 ? 1 : -1;
      lampSpots.push({ x: s.from.x + s.dir.x * u + lat.x * side * 4.7, z: s.from.z + s.dir.z * u + lat.z * side * 4.7, ry: ang + (side > 0 ? Math.PI : 0) });
    }
  }
  for (let a = 0; a < 8; a++) lampSpots.push({ x: Math.cos((a / 8) * Math.PI * 2 + 0.39) * 18, z: Math.sin((a / 8) * Math.PI * 2 + 0.39) * 18, ry: -((a / 8) * Math.PI * 2) });

  // ---- lamps (from the street map) with a few real lights ----
  instanceProp(scene, assets.lamp, lampSpots.map((p) => at(p.x, p.z, p.ry)));
  lampSpots.forEach((p, i) => {
    if (i % 3) return;
    const l = new THREE.PointLight(0xffe7a0, 9, 13, 1.6);
    l.position.set(p.x, 3.0, p.z);
    scene.add(l);
  });

  // ---- spooky trees around the walkable areas ----
  const inZones = (x, z, pad = 0) => L.zones.some((zn) => x > zn.minX - pad && x < zn.maxX + pad && z > zn.minZ - pad && z < zn.maxZ + pad);
  const spots = [];
  for (const zn of L.zones) {
    for (let x = zn.minX - 3; x <= zn.maxX + 3; x += 5.5) spots.push([x, zn.minZ - 3], [x, zn.maxZ + 3]);
    for (let z = zn.minZ - 3; z <= zn.maxZ + 3; z += 5.5) spots.push([zn.minX - 3, z], [zn.maxX + 3, z]);
  }
  const rnd = (x, z) => (Math.sin(x * 12.9898 + z * 78.233) * 43758.5453) % 1;
  const treeMats = spots.filter(([x, z]) => !inZones(x, z, 1)).map(([x, z]) => at(x + rnd(x, z) * 1.5, z + rnd(z, x) * 1.5, rnd(x, z) * 6, 0.8 + Math.abs(rnd(z, x)) * 0.6));
  instanceProp(scene, assets.tree, treeMats);

  // ---- the Candy Bank ----
  const bank = new THREE.Group();
  bank.position.set(L.bank.x, 0, L.bank.z);
  bank.rotation.y = L.bank.rot;
  bank.add(box(9, 4.6, 6, mat(0xe8d5ee), 0, 2.3, 0));
  bank.add(box(9.8, 0.5, 6.8, mat(0xb07cc6), 0, 4.8, 0));
  const roofShape = new THREE.Shape();
  roofShape.moveTo(-5, 0);
  roofShape.lineTo(5, 0);
  roofShape.lineTo(0, 2);
  roofShape.closePath();
  const roofGeo = new THREE.ExtrudeGeometry(roofShape, { depth: 6.8, bevelEnabled: false });
  roofGeo.translate(0, 0, -3.4);
  const roof = new THREE.Mesh(roofGeo, mat(0xff93b8));
  roof.position.y = 5.05;
  roof.castShadow = true;
  bank.add(roof);
  for (const x of [-3.3, -1.1, 1.1, 3.3]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 4.4, 10), mat(0xfaf9ff));
    col.position.set(x, 2.2, 3.4);
    col.castShadow = true;
    bank.add(col);
  }
  bank.add(box(1.8, 2.8, 0.15, glowMat(0xffd34d, 0.7), 0, 1.4, 3.05));
  bank.add(box(9.8, 0.3, 1.8, mat(PALETTE.sidewalk), 0, 0.15, 3.9));
  const lolly = new THREE.Group();
  lolly.add(box(0.2, 3, 0.2, mat(0xfaf9ff), 0, 1.5, 0));
  const swirl = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.3, 20), glowMat(0xff93b8, 0.5));
  swirl.rotation.x = Math.PI / 2;
  swirl.position.y = 3.4;
  lolly.add(swirl);
  lolly.position.set(0, 6.9, 0);
  bank.add(lolly);
  const bankSign = textSprite([{ text: 'CANDY BANK', color: '#ffb85a', size: 44 }, 'Deposit your candy here'], { width: 560 });
  bankSign.position.set(0, 5.9, 3.6);
  bank.add(bankSign);
  const bankLight = new THREE.PointLight(0xff93b8, 14, 14, 1.5);
  bankLight.position.set(0, 3, 6);
  bank.add(bankLight);
  scene.add(bank);

  // Fountain + giant pumpkin in the square
  const fountain = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.7, 0.7, 16), mat(0x8a8496));
  fountain.position.set(-12, 0.35, 10);
  fountain.castShadow = true;
  scene.add(fountain);
  const giant = pumpkin(1.2);
  giant.position.set(-12, 1.5, 10);
  scene.add(giant);

  // A small fenced graveyard in the square, like the street map's
  const yard = { x: 13, z: 12 };
  const fenceMat = mat(PALETTE.iron);
  for (let i = -4; i <= 4; i++) {
    for (const [fx, fz] of [[yard.x + i, yard.z - 4.5], [yard.x + i, yard.z + 4.5], [yard.x - 4.5, yard.z + i], [yard.x + 4.5, yard.z + i]]) {
      scene.add(box(0.08, 1.2, 0.08, fenceMat, fx, 0.6, fz));
    }
  }
  if (assets.tombstone) instanceProp(scene, assets.tombstone, [[-2, -1], [1, -2], [2.5, 1], [-1.5, 2], [0.5, 1.2], [-3, 0.5]].map(([x, z], i) => at(yard.x + x, yard.z + z, (i - 2) * 0.15)));
  const floater = assets.floatingGhost?.clone(true);
  if (floater) {
    floater.position.set(yard.x, 1.5, yard.z);
    scene.add(floater);
  }

  // ---- houses ----
  const houses = new Map();
  const colliders = [];
  const gateMeshes = new Map();
  const hedgeMeshes = new Map();

  const houseSig = (v) => JSON.stringify([v.type, v.forSale, v.owner?.name, v.tell, v.hot, v.onRoute, v.listing?.price, v.dial, v.pendingDial?.mode, v.lantern]);

  function placeHouse(v) {
    const lay = L.houses[v.id];
    if (!lay) return;
    const prev = houses.get(v.id);
    const sig = houseSig(v);
    if (prev && prev.sig === sig) {
      prev.view = v;
      return;
    }
    if (prev) scene.remove(prev.group);
    const built = buildHouse(assets, v, { dark: v.forSale });
    const g = built.group;
    g.position.set(lay.x, 0, lay.z);
    g.rotation.y = lay.rot;
    // front walk out to the sidewalk
    const walk = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 3.2), mat(0xada8b4));
    walk.position.set(0, 0.04, built.front + 2.4);
    walk.receiveShadow = true;
    g.add(walk);
    const fx = v.forSale ? {} : addTell(built, v.tell);
    const label = [
      { text: `#${v.id} ${v.name}`, size: 32 },
      { text: v.forSale ? `FOR SALE · ${v.price} $BOO` : v.owner ? `Home of ${v.owner.name}` : v.typeName, color: v.forSale ? '#ffd34d' : v.owner ? '#c9a8ff' : '#cfc6e6', size: 24 },
    ];
    if (v.hot) label.push({ text: 'HOT HOUSE · 2x candy', color: '#ffb85a', size: 24 });
    const sprite = textSprite(label, { width: 560 });
    sprite.position.set(0, built.height + 1.2, 0);
    g.add(sprite);
    if (v.forSale) {
      const sign = signBoard([{ text: 'FOR SALE', color: '#ffd34d', size: 40 }, `${v.price} $BOO · NFT deed`], { width: 420, bg: '#3a2a4a' });
      sign.position.set(2.2, 0, built.front + 2.2);
      g.add(sign);
    } else if (v.plot && v.owner) {
      const sign = signBoard([{ text: v.owner.name, color: '#c9a8ff', size: 40 }, v.listing ? `For sale: ${v.listing.price} $BOO` : `Lantern Lv ${v.lantern}`], { width: 420, bg: '#2b2440' });
      sign.position.set(2.2, 0, built.front + 2.2);
      g.add(sign);
      for (let i = 0; i < v.lantern; i++) {
        const lan = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), glowMat(0xff8a3d, 2.5));
        lan.position.set(-1.5 + i * 0.6, 2.6, built.front + 0.3);
        g.add(lan);
      }
    }
    if (v.onRoute) {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), glowMat(0xffd34d, 2));
      star.position.set(0, built.height + 2.6, 0);
      g.add(star);
      fx.star = star;
    }
    scene.add(g);
    const fp = houseFootprint(v.type);
    const turned = Math.abs(Math.sin(lay.rot)) > 0.5;
    const hw = (turned ? fp.hd : fp.hw) + 0.2;
    const hd = (turned ? fp.hw : fp.hd) + 0.2;
    const col = { id: v.id, minX: lay.x - hw, maxX: lay.x + hw, minZ: lay.z - hd, maxZ: lay.z + hd };
    const idx = colliders.findIndex((c) => c.id === v.id);
    if (idx >= 0) colliders[idx] = col;
    else colliders.push(col);
    houses.set(v.id, { group: g, sig, fx, view: v, windows: built.windows, layout: lay, height: built.height });
  }

  colliders.push({ id: 'bank', minX: L.bank.x - 5, maxX: L.bank.x + 5, minZ: L.bank.z - 3.4, maxZ: L.bank.z + 3.5 });
  colliders.push({ id: 'fountain', minX: -14.7, maxX: -9.3, minZ: 7.3, maxZ: 12.7 });
  colliders.push({ id: 'yard', minX: yard.x - 4.6, maxX: yard.x + 4.6, minZ: yard.z - 4.6, maxZ: yard.z + 4.6 });

  function barrier(spec, kind) {
    const g = new THREE.Group();
    g.position.set(spec.x, 0, spec.z);
    g.rotation.y = Math.atan2(spec.along.x, spec.along.z) + Math.PI / 2;
    if (kind === 'gate') {
      const iron = mat(PALETTE.iron, { metalness: 0.4 });
      for (let x = -spec.width / 2; x <= spec.width / 2; x += 0.6) {
        g.add(box(0.08, 2.4, 0.08, iron, x, 1.2, 0));
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.25, 4), iron);
        tip.position.set(x, 2.5, 0);
        g.add(tip);
      }
      g.add(box(spec.width, 0.1, 0.1, iron, 0, 2.1, 0));
      g.add(box(spec.width, 0.1, 0.1, iron, 0, 0.5, 0));
    } else {
      for (let x = -spec.width / 2; x <= spec.width / 2; x += 1.6) {
        const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(1.3, 0), mat(0x3f5a4a));
        bush.position.set(x, 1.1, 0);
        bush.scale.y = 1.5;
        bush.castShadow = true;
        g.add(bush);
      }
    }
    return g;
  }

  function setBarriers(world) {
    for (const gt of L.gates) {
      const hood = world.neighborhoods.find((n) => n.id === gt.hood);
      let entry = gateMeshes.get(gt.hood);
      if (!entry) {
        const g = barrier(gt, 'gate');
        const sign = textSprite([{ text: hood.name, size: 34 }, { text: `Locked · Level ${hood.minLevel} · ${hood.unlockCost} candy`, color: '#ffd34d', size: 24 }], { width: 560 });
        sign.position.set(0, 3.6, 0);
        g.add(sign);
        scene.add(g);
        entry = { group: g, spec: gt };
        gateMeshes.set(gt.hood, entry);
      }
      entry.locked = !hood?.unlocked;
      entry.group.visible = entry.locked;
    }
    for (const hd of L.hedges) {
      let entry = hedgeMeshes.get(hd.house);
      if (!entry) {
        const g = barrier(hd, 'hedge');
        scene.add(g);
        entry = { group: g, spec: hd };
        hedgeMeshes.set(hd.house, entry);
      }
      entry.locked = !world.houses.some((h) => h.id === hd.house);
      entry.group.visible = entry.locked;
    }
  }

  function sync(world) {
    const ids = new Set();
    for (const v of world.houses) {
      placeHouse(v);
      ids.add(v.id);
    }
    for (const [id, h] of houses) {
      if (ids.has(id)) continue;
      scene.remove(h.group);
      houses.delete(id);
      const i = colliders.findIndex((c) => c.id === id);
      if (i >= 0) colliders.splice(i, 1);
    }
    setBarriers(world);
  }

  // ---- collisions + walkable area ----
  const R = 0.4;
  function blocked(x, z) {
    if (!inZones(x, z, -R)) return true;
    for (const c of colliders) if (x > c.minX - R && x < c.maxX + R && z > c.minZ - R && z < c.maxZ + R) return true;
    for (const set of [gateMeshes, hedgeMeshes]) {
      for (const { spec, locked } of set.values()) {
        if (!locked) continue;
        const u = (x - spec.x) * spec.along.x + (z - spec.z) * spec.along.z;
        const w = Math.abs((x - spec.x) * spec.along.z - (z - spec.z) * spec.along.x);
        if (Math.abs(u) < 1.2 && w < spec.width / 2 + 1) return true;
      }
    }
    return false;
  }

  // Is there a building here? (used to keep the camera out of walls)
  function solidAt(x, z) {
    const m = 1.2; // porches and roofs overhang the walls
    for (const c of colliders) if (x > c.minX - m && x < c.maxX + m && z > c.minZ - m && z < c.maxZ + m) return true;
    return false;
  }

  function move(pos, dx, dz) {
    if (!blocked(pos.x + dx, pos.z + dz)) {
      pos.x += dx;
      pos.z += dz;
    } else if (!blocked(pos.x + dx, pos.z)) pos.x += dx;
    else if (!blocked(pos.x, pos.z + dz)) pos.z += dz;
  }

  // ---- floating ghosts drifting over the streets ----
  const ghosts = [];
  if (assets.floatingGhost) {
    for (let i = 0; i < 5; i++) {
      const gh = assets.floatingGhost.clone(true);
      gh.userData = { a: i * 1.3, r: 24 + i * 14, h: 4 + (i % 3) * 1.5 };
      scene.add(gh);
      ghosts.push(gh);
    }
  }

  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 50, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
  beacon.visible = false;
  scene.add(beacon);

  let time = 0;
  function animate(dt, playerPos) {
    time += dt;
    moonLight.position.set(playerPos.x - 30, 60, playerPos.z + 25);
    moonLight.target.position.set(playerPos.x, 0, playerPos.z);
    swirl.rotation.y += dt * 0.8;
    if (floater) floater.position.y = 1.5 + Math.sin(time * 1.4) * 0.25;
    for (const h of houses.values()) {
      const fx = h.fx || {};
      if (fx.flicker) {
        const on = Math.sin(time * 13 + h.view.id) + Math.sin(time * 7.3 + h.view.id * 2) > 0.3;
        for (const w of h.windows) w.material.emissiveIntensity = on ? 1.3 : 0.05;
      }
      if (fx.scream) {
        const flash = (time + h.view.id) % 6 < 0.15;
        for (const w of h.windows) w.material.emissiveIntensity = flash ? 4 : 1.3;
      }
      if (fx.shake) fx.shake.rotation.z = Math.sin(time * 30) * 0.08 * (Math.sin(time * 1.3 + h.view.id) > 0.5 ? 1 : 0);
      if (fx.puffs) fx.puffs.forEach((p, i) => (p.position.y = h.height + 0.4 + ((time * 0.6 + i * 0.8) % 2.4)));
      if (fx.star) fx.star.rotation.y += dt * 1.5;
    }
    ghosts.forEach((gh, i) => {
      const u = gh.userData;
      gh.position.set(Math.cos(time * 0.07 + u.a) * u.r, u.h + Math.sin(time * 1.2 + i) * 0.5, Math.sin(time * 0.07 + u.a) * u.r + 30);
      gh.rotation.y = -(time * 0.07 + u.a);
    });
    if (beacon.visible) beacon.material.opacity = 0.18 + Math.sin(time * 3) * 0.08;
  }

  function setBeacon(id) {
    const lay = id && L.houses[id];
    beacon.visible = !!lay;
    if (lay) beacon.position.set(lay.x, 25, lay.z);
  }

  function resize() {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  }
  window.addEventListener('resize', resize);

  return { scene, camera, renderer, houses, sync, move, blocked, solidAt, animate, setBeacon, layout: L };
}
