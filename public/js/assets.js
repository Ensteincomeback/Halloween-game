// Loads the hand-made GLB models (kids, houses, street props) once, and makes
// recolored variants of them. Every house type and costume is one of these
// models with a different palette plus a few extra pieces, so the whole world
// keeps the same pastel low-poly look.

import * as THREE from 'three';
import { GLTFLoader } from '/vendor/addons/loaders/GLTFLoader.js';

const FILES = {
  ghostKid: '/models/ghost_kid.glb',
  witchKid: '/models/witch_kid.glb',
  witchHut: '/models/witch_hut.glb',
  mansion: '/models/haunted_mansion.glb',
  props: '/models/props.glb',
};

export async function loadAssets(onProgress = () => {}) {
  const loader = new GLTFLoader();
  const out = {};
  let done = 0;
  await Promise.all(Object.entries(FILES).map(async ([key, url]) => {
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene;
    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
      // Baked lights from the source files would multiply per house; we light the scene ourselves.
      if (o.isLight) o.visible = false;
    });
    out[key] = root;
    onProgress(++done / Object.keys(FILES).length);
  }));
  const props = out.props;
  out.tree = props.getObjectByName('Tree');
  out.tombstone = props.getObjectByName('Tombstone');
  out.floatingGhost = props.getObjectByName('FloatingGhost');
  out.lamp = props.getObjectByName('Lamp');
  return out;
}

export const hex = (m) => m.color.getHexString();

// Deep-clone a model with its own materials, swapping colors by hex.
export function recolor(src, map = {}, { emissiveMap = {} } = {}) {
  const obj = src.clone(true);
  const cache = new Map();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const old = o.material;
    if (!cache.has(old)) {
      const m = old.clone();
      const h = hex(old);
      m.userData.srcHex = h;
      if (map[h] !== undefined) m.color.setHex(map[h]);
      if (emissiveMap[h] !== undefined) m.emissive.setHex(emissiveMap[h]);
      cache.set(old, m);
    }
    o.material = cache.get(old);
  });
  return obj;
}

// Original colors in the models (see the source GLBs).
export const MANSION = { wall: '769393', trim: '5a4b6c', roof: '5a7178', door: 'a0715a', frame: '4b3d5d', glass: '715a00', pumpkin: 'ffb85a', path: 'ada8b4', post: '72626c', sign: '725f88' };
export const HUT = { base: '71836e', wall: '97ad83', roof: 'ad73c5', band: 'f1d078', chimney: '72626c', door: '93715a', glass: '5a5a00', frame: '4b3d5d', cauldron: '5a5a66', brew: '4f834f', pumpkin: 'ffb85a', path: 'ada8b4', sign: '725f88' };
export const KID = { robe: 'ad73c5', skin: 'f9e5d0', legs: '72728e', feet: '716275', orange: 'ffb85a', handle: '5a5363', hair: 'd89a60', eyes: '3b324f', hat: '5f4d70', sheet: 'faf9ff', ghostLegs: '9484ad' };
