// The player's trick-or-treater, built from the hand-made kid models
// (ghost_kid.glb, witch_kid.glb). Both have pivots at the hips and shoulders, so
// they are animated procedurally: idle, walk, run, knock, scared, cheer.
// Costumes reuse the Witch Kid body with a new palette and a few extra pieces.
// The jack-o'-lantern bucket fills up with candy as the bag does.

import * as THREE from 'three';
import { recolor, KID } from './assets.js';

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, flatShading: true, ...opts });

function mesh(geo, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

function pumpkinHead(r) {
  const g = new THREE.Group();
  const p = mesh(new THREE.SphereGeometry(r, 8, 6), mat(0xffb85a, { emissive: 0xbc7500, emissiveIntensity: 0.4 }));
  p.scale.set(1.15, 0.9, 1.1);
  g.add(p);
  const face = new THREE.MeshBasicMaterial({ color: 0xfff193 });
  for (const x of [-0.35, 0.35]) {
    const eye = mesh(new THREE.ConeGeometry(r * 0.18, r * 0.25, 3), face, x * r, r * 0.2, r * 1.0);
    eye.rotation.x = Math.PI / 2;
    g.add(eye);
  }
  g.add(mesh(new THREE.BoxGeometry(r * 0.9, r * 0.14, 0.04), face, 0, -r * 0.3, r * 0.98));
  g.add(mesh(new THREE.CylinderGeometry(r * 0.12, r * 0.15, r * 0.4, 5), mat(0x86a060), 0, r * 0.95, 0));
  return g;
}

// Costume = base model + palette + hidden parts + extras (built at the head / chest).
const COSTUMES = {
  sheet: { base: 'ghostKid' },
  witch: { base: 'witchKid' },
  mummy: { base: 'witchKid', colors: { [KID.robe]: 0xe9e3d0, [KID.skin]: 0xe9e3d0, [KID.hair]: 0xe9e3d0, [KID.legs]: 0xd6cfb8 }, hide: ['hat'], wraps: true },
  werewolf: { base: 'witchKid', colors: { [KID.robe]: 0x7a5a44, [KID.skin]: 0x9a6b4a, [KID.hair]: 0x5a3a28, [KID.legs]: 0x5a3a28 }, hide: ['hat'], ears: 0x5a3a28, snout: 0x6b4426 },
  vampire: { base: 'witchKid', colors: { [KID.robe]: 0x2e2433, [KID.skin]: 0xe8e0ea, [KID.hair]: 0x1d1820, [KID.legs]: 0x2e2433 }, hide: ['hat'], cape: 0x8b1d2c, collar: 0x8b1d2c },
  hunter: { base: 'witchKid', colors: { [KID.robe]: 0x4f7a55, [KID.hat]: 0x3d6b45, [KID.legs]: 0x5a4a38 }, hood: 0x3d6b45, hide: ['hat'] },
  skeleton: { base: 'witchKid', colors: { [KID.robe]: 0x2e2433, [KID.skin]: 0xf2efe4, [KID.hair]: 0xf2efe4, [KID.legs]: 0x2e2433 }, hide: ['hat', 'hair'], ribs: true },
  headless: { base: 'witchKid', colors: { [KID.robe]: 0x2b2440, [KID.legs]: 0x1d1820 }, hide: ['hat', 'hair', 'head', 'eyes'], cape: 0x1d1820, carryPumpkin: true },
  pumpkinking: { base: 'witchKid', colors: { [KID.robe]: 0x4f7a55, [KID.legs]: 0x2e2433 }, hide: ['hat', 'hair', 'head', 'eyes'], pumpkinHead: true, crown: true, cape: 0x6a3d8a },
  banshee: { base: 'ghostKid', colors: { [KID.sheet]: 0xbfe0ff, [KID.ghostLegs]: 0x8fb0d8 }, ghostly: true },
  hazmat: { base: 'witchKid', colors: { [KID.robe]: 0xf2c200, [KID.legs]: 0xd9ad00, [KID.hair]: 0xf2c200 }, hide: ['hat', 'hair'], visor: true },
};

// Find the pivots and parts of a kid model by position and color.
function rig(model) {
  const root = model.children[0] || model; // "GhostKid" / "WitchKid"
  const pivots = root.children.filter((c) => !c.isMesh && c.children.length);
  const pick = (fx, fy) => pivots.find((p) => Math.sign(p.position.x) === fx && (fy === 'leg' ? p.position.y < 0.8 : p.position.y > 0.8));
  const parts = { legL: pick(-1, 'leg'), legR: pick(1, 'leg'), armL: pick(-1, 'arm'), armR: pick(1, 'arm'), meshes: { hat: [], hair: [], head: [], eyes: [] } };
  root.traverse((o) => {
    if (!o.isMesh) return;
    const h = o.material.userData.srcHex;
    const top = new THREE.Box3().setFromObject(o).min.y;
    if (h === KID.hat || (h === KID.orange && top > 1.2)) parts.meshes.hat.push(o);
    if (h === KID.hair) parts.meshes.hair.push(o);
    if (h === KID.skin && top > 0.8) parts.meshes.head.push(o);
    if (h === KID.eyes) parts.meshes.eyes.push(o);
    if (h === KID.orange && top < 0.6) parts.bucket = o;
  });
  return parts;
}

export function createCharacter(assets, costumeId = 'sheet') {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  let parts = null;
  let current = null;
  let extras = {};
  const candies = [];
  const glow = new THREE.PointLight(0xffb060, 1.2, 5, 1.8);

  function build(id) {
    const C = COSTUMES[id] || COSTUMES.sheet;
    body.clear();
    candies.length = 0;
    extras = {};
    const model = recolor(assets[C.base], C.colors || {});
    if (C.ghostly) model.traverse((o) => o.isMesh && Object.assign(o.material, { transparent: true, opacity: 0.8 }));
    body.add(model);
    root.updateMatrixWorld(true);
    parts = rig(model);
    for (const k of C.hide || []) for (const m of parts.meshes[k] || []) m.visible = false;
    const head = new THREE.Group();
    head.position.set(0, 1.12, 0);
    body.add(head);

    if (C.ears) {
      for (const x of [-0.13, 0.13]) head.add(mesh(new THREE.ConeGeometry(0.06, 0.16, 4), mat(C.ears), x, 0.2, 0));
    }
    if (C.snout) head.add(mesh(new THREE.BoxGeometry(0.12, 0.09, 0.1), mat(C.snout), 0, -0.04, 0.2));
    if (C.hood) head.add(mesh(new THREE.SphereGeometry(0.24, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.6), mat(C.hood, { side: THREE.DoubleSide }), 0, 0.03, -0.02));
    if (C.visor) head.add(mesh(new THREE.SphereGeometry(0.17, 10, 6, -Math.PI / 2, Math.PI, Math.PI * 0.25, Math.PI * 0.45), mat(0x88ccff, { metalness: 0.5, roughness: 0.1, transparent: true, opacity: 0.85 }), 0, 0, 0.08));
    if (C.pumpkinHead) head.add(pumpkinHead(0.22));
    if (C.crown) head.add(mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.1, 8, 1, true), mat(0xffd34d, { metalness: 0.6, roughness: 0.3, side: THREE.DoubleSide }), 0, 0.25, 0));
    if (C.cape) {
      const cape = mesh(new THREE.PlaneGeometry(0.6, 0.75, 1, 3), mat(C.cape, { side: THREE.DoubleSide }), 0, 0.62, -0.3);
      cape.rotation.x = 0.1;
      body.add(cape);
      extras.cape = cape;
    }
    if (C.collar) {
      const collar = mesh(new THREE.ConeGeometry(0.28, 0.22, 8, 1, true), mat(C.collar, { side: THREE.DoubleSide }), 0, 0.98, -0.02);
      collar.rotation.x = Math.PI;
      body.add(collar);
    }
    if (C.wraps) {
      for (let i = 0; i < 4; i++) {
        const band = mesh(new THREE.TorusGeometry(0.3 - i * 0.02, 0.018, 3, 12), mat(0xbdb59c), 0, 0.4 + i * 0.13, 0);
        band.rotation.x = Math.PI / 2 + (i % 2 ? 0.2 : -0.2);
        body.add(band);
      }
    }
    if (C.ribs) {
      for (let i = 0; i < 4; i++) body.add(mesh(new THREE.BoxGeometry(0.34 - i * 0.03, 0.03, 0.02), mat(0xf2efe4), 0, 0.75 - i * 0.09, 0.33));
    }
    if (C.carryPumpkin && parts.armL) {
      const held = pumpkinHead(0.13);
      held.position.set(0, -0.62, 0.1);
      parts.armL.add(held);
    }

    // Candy that piles up in the bucket.
    if (parts.bucket && parts.armR) {
      const bb = new THREE.Box3().setFromObject(parts.bucket);
      const top = new THREE.Vector3((bb.min.x + bb.max.x) / 2, bb.max.y, (bb.min.z + bb.max.z) / 2);
      parts.armR.updateWorldMatrix(true, false);
      parts.armR.worldToLocal(top);
      const colors = [0xff93b8, 0x93e9ff, 0xfff193, 0xb6ff8a, 0xc9a8ff];
      for (let i = 0; i < 10; i++) {
        const c = mesh(new THREE.SphereGeometry(0.028, 5, 4), mat(colors[i % colors.length], { emissive: colors[i % colors.length], emissiveIntensity: 0.2 }),
          top.x + Math.cos(i * 2.4) * 0.05 * (i % 3), top.y - 0.03 + Math.floor(i / 4) * 0.035, top.z + Math.sin(i * 2.4) * 0.05 * (i % 3));
        c.visible = false;
        parts.armR.add(c);
        candies.push(c);
      }
      glow.position.copy(top).add(new THREE.Vector3(0, 0.2, 0.2));
      parts.armR.add(glow);
    }
    current = id;
  }

  build(costumeId);

  let phase = 0;
  let action = null;

  function setCostume(id) {
    if (id !== current) {
      const fill = candies.filter((c) => c.visible).length / (candies.length || 1);
      build(id);
      setBucketFill(fill);
    }
  }

  function setBucketFill(frac) {
    const n = Math.round(Math.max(0, Math.min(1, frac)) * candies.length);
    candies.forEach((c, i) => (c.visible = i < n));
  }

  function play(kind, dur = 0.7) {
    action = { kind, t: 0, dur };
  }

  // speed in units/second
  function update(dt, speed) {
    const moving = speed > 0.2;
    phase += dt * (moving ? 3 + speed * 1.6 : 1.6);
    const swing = moving ? Math.min(1, speed / 4) * 0.8 : 0;
    const s = Math.sin(phase);
    const P = parts;
    if (P.legL) P.legL.rotation.x = s * swing;
    if (P.legR) P.legR.rotation.x = -s * swing;
    if (P.armL) P.armL.rotation.set(-s * swing * 0.7, 0, 0);
    if (P.armR) P.armR.rotation.set(s * swing * 0.3, 0, 0); // bucket arm swings gently
    body.position.y = moving ? Math.abs(Math.cos(phase)) * 0.06 * swing : Math.sin(phase * 0.8) * 0.008;
    body.rotation.set(moving ? swing * 0.06 : 0, 0, 0);
    if (extras.cape) extras.cape.rotation.x = 0.1 + swing * 0.6 + Math.sin(phase * 2) * 0.05 * swing;

    if (action) {
      action.t += dt;
      const k = action.t / action.dur;
      if (action.kind === 'knock' && P.armL) {
        P.armL.rotation.x = -1.8 + Math.sin(action.t * 22) * 0.25;
      } else if (action.kind === 'scared') {
        body.position.y = Math.sin(k * Math.PI) * 0.35;
        body.rotation.z = Math.sin(action.t * 40) * 0.12 * (1 - k);
        if (P.armL) P.armL.rotation.z = -1.1;
        if (P.armR) P.armR.rotation.z = 0.6;
      } else if (action.kind === 'cheer') {
        body.position.y = Math.abs(Math.sin(k * Math.PI * 2)) * 0.3;
        if (P.armL) P.armL.rotation.x = -2.8;
      }
      if (action.t >= action.dur) action = null;
    }
  }

  return { root, update, setCostume, setBucketFill, play, get costume() { return current; } };
}
