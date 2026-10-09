// Pixel-art sprite factory. Every sprite is drawn in code at native resolution
// (16 px per tile) onto small offscreen canvases, then scaled up with nearest-
// neighbour filtering. The palette and designs follow the Knock models: pastel
// purple witch huts, teal haunted mansions, sage lawns, ghost and witch kids.

export const T = 16;

export const PAL = {
  outline: '#241c33',
  skin: '#f9e5d0', skinD: '#e2c3a8', eyes: '#3b324f', cheek: '#ff93b8',
  orange: '#ffb85a', orangeD: '#d9822e', candle: '#fff193',
  grass: '#5c716e', grassD: '#536864', grassL: '#67807a', forest: '#3d4c4b', forestD: '#35423f',
  road: '#696977', roadD: '#5e5e6c', dash: '#eee3ad', sidewalk: '#a09cab', sidewalkD: '#8f8b9b',
  plaza: '#8f8a9e', plazaD: '#7d788d', path: '#ada8b4', pathD: '#9a95a3',
  iron: '#3a3442', ironL: '#5a5363',
  wood: '#8a5f45', woodD: '#6b4a2a',
};

const cache = new Map();
export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}
const memo = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

// ---------- drawing primitives (all integer pixels) ----------
export function rect(g, x, y, w, h, col) {
  g.fillStyle = col;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}
function px(g, x, y, col) {
  rect(g, x, y, 1, 1, col);
}
function outlineRect(g, x, y, w, h, fill, line = PAL.outline) {
  rect(g, x, y, w, h, line);
  rect(g, x + 1, y + 1, w - 2, h - 2, fill);
}
// Triangle / trapezoid drawn row by row so edges stay pixel-crisp.
function rows(g, cx, top, h, wTop, wBot, fill, line = PAL.outline) {
  for (let i = 0; i < h; i++) {
    const w = Math.round(wTop + ((wBot - wTop) * i) / Math.max(1, h - 1));
    const x = Math.round(cx - w / 2);
    rect(g, x, top + i, w, 1, line);
    if (i > 0 && i < h - 1 && w > 2) rect(g, x + 1, top + i, w - 2, 1, fill);
  }
}
function line(g, x0, y0, x1, y1, col) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    px(g, x0, y0, col);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
const hash = (a, b = 0) => {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// ---------- tiny 3x5 pixel font for signs ----------
const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', $: '011110010011110', '#': '101111101111101', '.': '000000000000010', '-': '000000111000000',
  '!': '010010010000010', ' ': '000000000000000', "'": '010010000000000', ':': '000010000010000',
};
export function pixelText(g, text, x, y, col) {
  let cx = x;
  for (const ch of String(text).toUpperCase()) {
    const f = FONT[ch] || FONT[' '];
    for (let i = 0; i < 15; i++) if (f[i] === '1') px(g, cx + (i % 3), y + Math.floor(i / 3), col);
    cx += 4;
  }
}
export const textWidth = (t) => String(t).length * 4 - 1;

// ---------- ground tiles ----------
export function groundTile(kind, tx, tz) {
  const v = Math.floor(hash(tx, tz) * 4);
  return memo(`g:${kind}:${v}:${kind === 'road' || kind === 'dash' ? '' : ''}`, () => {
    const [c, g] = canvas(T, T);
    const r = (a, b) => hash(a * 31 + v * 7, b * 17 + v);
    if (kind === 'grass' || kind === 'forest') {
      const base = kind === 'grass' ? PAL.grass : PAL.forest;
      const dark = kind === 'grass' ? PAL.grassD : PAL.forestD;
      rect(g, 0, 0, T, T, base);
      for (let i = 0; i < 10; i++) px(g, Math.floor(r(i, 1) * T), Math.floor(r(i, 2) * T), dark);
      if (kind === 'grass') for (let i = 0; i < 3 + v; i++) {
        const x = Math.floor(r(i, 3) * 14), y = Math.floor(r(i, 4) * 13) + 2;
        px(g, x, y, PAL.grassL);
        px(g, x + 1, y - 1, PAL.grassL);
      }
    } else if (kind === 'road') {
      rect(g, 0, 0, T, T, PAL.road);
      for (let i = 0; i < 6; i++) px(g, Math.floor(r(i, 5) * T), Math.floor(r(i, 6) * T), PAL.roadD);
    } else if (kind === 'sidewalk') {
      rect(g, 0, 0, T, T, PAL.sidewalk);
      rect(g, 0, 0, T, 1, PAL.sidewalkD);
      rect(g, 0, 0, 1, T, PAL.sidewalkD);
      rect(g, 8, 0, 1, T, PAL.sidewalkD);
    } else if (kind === 'plaza') {
      rect(g, 0, 0, T, T, PAL.plaza);
      for (const [x, y, w, h] of [[0, 0, 7, 5], [8, 0, 8, 5], [0, 6, 4, 4], [5, 6, 7, 4], [13, 6, 3, 4], [0, 11, 8, 5], [9, 11, 7, 5]]) {
        rect(g, x, y, w, 1, PAL.plazaD);
        rect(g, x, y, 1, h, PAL.plazaD);
      }
    } else if (kind === 'path') {
      rect(g, 0, 0, T, T, PAL.grass);
      for (const [x, y] of [[2, 2], [9, 1], [4, 9], [11, 8]]) outlineRect(g, x, y, 5, 5, PAL.path, PAL.pathD);
    }
    return c;
  });
}

// ---------- characters ----------
// 16x32 frames, feet at the bottom. dir: 0 down, 1 up, 2 left, 3 right. frame 0 idle, 1/2 walk.
export const COSTUME_STYLE = {
  sheet: { sheet: '#faf9ff', sheetD: '#d9d6ea', legs: '#9484ad' },
  banshee: { sheet: '#bfe0ff', sheetD: '#93b8e0', legs: '#8fb0d8', ghostly: true },
  witch: { robe: '#ad73c5', robeD: '#8a59a0', hair: '#d89a60', hat: 'witch', belt: PAL.orange },
  mummy: { robe: '#e9e3d0', robeD: '#c9c1a8', skin: '#e9e3d0', hair: '#e9e3d0', legs: '#d6cfb8', wraps: true },
  werewolf: { robe: '#7a5a44', robeD: '#5e4433', skin: '#9a6b4a', hair: '#5a3a28', legs: '#5a3a28', wolf: true },
  vampire: { robe: '#2e2433', robeD: '#1d1820', skin: '#e8e0ea', hair: '#1d1820', legs: '#2e2433', cape: '#8b1d2c', collar: true },
  hunter: { robe: '#4f7a55', robeD: '#3d6045', hair: '#8a5f45', legs: '#5a4a38', hat: 'hood', hood: '#3d6b45' },
  skeleton: { robe: '#2e2433', robeD: '#1d1820', skin: '#f2efe4', hair: null, legs: '#2e2433', ribs: true, skull: true },
  headless: { robe: '#2b2440', robeD: '#1d1830', legs: '#1d1820', noHead: true, cape: '#1d1820', carryPumpkin: true },
  pumpkinking: { robe: '#4f7a55', robeD: '#3d6045', legs: '#2e2433', pumpkinHead: true, crown: true, cape: '#6a3d8a' },
  hazmat: { robe: '#f2c200', robeD: '#c99e00', skin: '#f2c200', hair: '#f2c200', legs: '#d9ad00', visor: true },
  hazmatZ: null,
};

function drawBucket(g, x, y, fill) {
  rect(g, x, y, 6, 5, PAL.outline);
  rect(g, x + 1, y + 1, 4, 3, PAL.orange);
  rect(g, x + 1, y + 3, 4, 1, PAL.orangeD);
  px(g, x + 2, y + 2, PAL.candle);
  px(g, x + 3, y + 2, PAL.candle);
  line(g, x, y - 1, x + 2, y - 3, PAL.outline);
  line(g, x + 3, y - 3, x + 5, y - 1, PAL.outline);
  const colors = ['#ff93b8', '#93e9ff', '#fff193', '#b6ff8a'];
  const n = Math.round(fill * 4);
  for (let i = 0; i < n; i++) px(g, x + 1 + i, y - (i % 2), colors[i]);
}

function drawPumpkinHead(g, cx, top, r) {
  rect(g, cx - r, top + 1, r * 2, r * 2 - 1, PAL.outline);
  rect(g, cx - r + 1, top, r * 2 - 2, r * 2 + 1, PAL.outline);
  rect(g, cx - r + 1, top + 1, r * 2 - 2, r * 2 - 1, PAL.orange);
  rect(g, cx - 1, top + 1, 1, r * 2 - 1, PAL.orangeD);
  rect(g, cx - r + 2, top + 3, 2, 2, PAL.candle);
  rect(g, cx + r - 4, top + 3, 2, 2, PAL.candle);
  rect(g, cx - r + 3, top + r + 1, r * 2 - 6, 1, PAL.candle);
  rect(g, cx - 1, top - 2, 2, 2, '#86a060');
}

export function kidFrame(costume, dir, frame, fill = 0) {
  const key = `kid:${costume}:${dir}:${frame}:${Math.round(fill * 4)}`;
  return memo(key, () => {
    const S = COSTUME_STYLE[costume] || COSTUME_STYLE.sheet;
    const [c, g] = canvas(16, 32);
    const bob = frame === 0 ? 0 : 1;
    const legA = frame === 1 ? -1 : 0;
    const legB = frame === 2 ? -1 : 0;
    const side = dir >= 2;
    const flip = dir === 3;
    const skin = S.skin || PAL.skin;
    const legs = S.legs || '#72728e';
    const robe = S.robe;
    const robeD = S.robeD;
    const top = 8 + bob; // head top

    // cape behind (front/side views)
    if (S.cape && dir !== 1) rect(g, side ? 6 : 4, 17 + bob, side ? 6 : 8, 9, S.cape);

    // legs + feet
    if (side) {
      rect(g, 6, 25 + legA, 3, 4 - legA, legs);
      rect(g, 8, 25 + legB, 3, 4 - legB, legs);
      rect(g, 5 + (frame === 1 ? -1 : 0), 29, 4, 2, '#716275');
      rect(g, 8 + (frame === 2 ? 1 : 0), 29, 4, 2, '#716275');
    } else {
      rect(g, 5, 25 + legA, 3, 4 - legA, legs);
      rect(g, 8, 25 + legB, 3, 4 - legB, legs);
      rect(g, 5, 29 + legA, 3, 2, '#716275');
      rect(g, 8, 29 + legB, 3, 2, '#716275');
    }

    if (S.sheet) {
      // A bedsheet ghost: one rounded shape with wavy hem.
      const sx = 3, sw = 10;
      rect(g, sx + 2, top - 1, sw - 4, 1, PAL.outline);
      rect(g, sx + 1, top, sw - 2, 1, PAL.outline);
      rect(g, sx, top + 1, sw, 17, PAL.outline);
      rect(g, sx + 2, top, sw - 4, 1, S.sheet);
      rect(g, sx + 1, top + 1, sw - 2, 16, S.sheet);
      rect(g, sx + sw - 3, top + 4, 2, 12, S.sheetD);
      for (let i = 0; i < sw; i += 2) px(g, sx + i + (frame % 2), top + 17, S.sheet);
      if (dir === 0) {
        rect(g, 5, top + 5, 2, 3, PAL.eyes);
        rect(g, 9, top + 5, 2, 3, PAL.eyes);
        rect(g, 7, top + 9, 2, 1, PAL.eyes);
      } else if (side) rect(g, flip ? 10 : 4, top + 5, 2, 3, PAL.eyes);
      drawBucket(g, flip ? 11 : side ? -1 : 11, 21 + bob, fill);
      if (flip) { /* drawn already */ }
      return S.ghostly ? fade(c, 0.85) : c;
    }

    // robe / torso: trapezoid
    const bodyTop = 17 + bob;
    rows(g, 8, bodyTop, 9, side ? 6 : 8, side ? 8 : 12, robe);
    rect(g, side ? 9 : 10, bodyTop + 2, 2, 6, robeD);
    if (S.belt) rect(g, side ? 5 : 4, bodyTop + 3, side ? 7 : 9, 1, S.belt);
    if (S.ribs && dir === 0) for (let i = 0; i < 3; i++) rect(g, 6, bodyTop + 2 + i * 2, 4, 1, '#f2efe4');
    if (S.wraps) for (let i = 0; i < 4; i++) rect(g, 4, bodyTop + 1 + i * 2, 8, 1, '#bdb59c');
    // arms
    if (!side) {
      rect(g, 2, bodyTop + 1, 2, 6, robe);
      rect(g, 12, bodyTop + 1, 2, 6, robe);
      px(g, 2, bodyTop + 7, skin);
      px(g, 13, bodyTop + 7, skin);
    } else {
      rect(g, flip ? 8 : 6, bodyTop + 1, 2, 6, robeD);
    }
    // bucket
    if (dir === 1) drawBucket(g, 11, 22 + bob, fill);
    else drawBucket(g, flip ? 10 : side ? 0 : 11, 22 + bob, fill);
    if (S.carryPumpkin) drawPumpkinHead(g, dir === 0 ? 3 : flip ? 4 : 12, 21 + bob, 3);

    // head
    if (S.pumpkinHead) drawPumpkinHead(g, 8, top + 2, 5);
    else if (!S.noHead) {
      const hx = side ? 4 : 3;
      const hw = side ? 9 : 10;
      rect(g, hx + 1, top, hw - 2, 1, PAL.outline);
      rect(g, hx, top + 1, hw, 8, PAL.outline);
      rect(g, hx + 1, top + 9, hw - 2, 1, PAL.outline);
      rect(g, hx + 1, top + 1, hw - 2, 8, skin);
      rect(g, hx + hw - 3, top + 2, 2, 6, S.skull ? '#d8d4c4' : PAL.skinD);
      if (dir === 0) {
        rect(g, 5, top + 4, 1, 2, PAL.eyes);
        rect(g, 10, top + 4, 1, 2, PAL.eyes);
        if (!S.skull && !S.visor) { px(g, 4, top + 6, PAL.cheek); px(g, 11, top + 6, PAL.cheek); }
        if (S.skull) rect(g, 6, top + 7, 4, 1, PAL.eyes);
      } else if (side) rect(g, flip ? 10 : 5, top + 4, 1, 2, PAL.eyes);
      // hair
      if (S.hair) {
        rect(g, hx + 1, top + 1, hw - 2, dir === 1 ? 7 : 2, S.hair);
        if (S.hat === 'witch' && dir !== 1) {
          rect(g, hx - 1, top + 3, 2, 3, S.hair);
          rect(g, hx + hw - 1, top + 3, 2, 3, S.hair);
        }
      }
      if (S.visor && dir !== 1) rect(g, side ? (flip ? 8 : 5) : 5, top + 3, side ? 4 : 6, 4, '#88ccff');
      if (S.wolf) {
        rect(g, hx + 1, top - 2, 2, 3, S.hair);
        rect(g, hx + hw - 3, top - 2, 2, 3, S.hair);
        if (dir === 0) rect(g, 6, top + 6, 4, 3, '#6b4426');
        if (side) rect(g, flip ? 12 : 1, top + 5, 3, 3, '#6b4426');
      }
      if (S.collar && dir !== 1) {
        rect(g, 3, top + 9, 3, 3, S.cape);
        rect(g, 10, top + 9, 3, 3, S.cape);
      }
    }
    if (S.cape && dir === 1) rect(g, 4, bodyTop, 8, 9, S.cape);
    // hats
    if (S.hat === 'witch') {
      rect(g, 1, top + 1, 14, 2, PAL.outline);
      rect(g, 2, top + 1, 12, 1, '#5f4d70');
      rows(g, 8, top - 8, 9, 2, 8, '#5f4d70');
      rect(g, 4, top - 1, 8, 1, PAL.orange);
      px(g, flip ? 6 : 10, top - 9, PAL.outline);
    } else if (S.hat === 'hood') {
      rect(g, 3, top - 1, 10, 3, S.hood);
      if (dir === 1) rect(g, 3, top, 10, 9, S.hood);
      else { rect(g, 2, top + 1, 2, 7, S.hood); rect(g, 12, top + 1, 2, 7, S.hood); }
    }
    if (S.crown) {
      rect(g, 5, top - 1, 6, 2, '#ffd34d');
      px(g, 5, top - 2, '#ffd34d'); px(g, 8, top - 2, '#ffd34d'); px(g, 10, top - 2, '#ffd34d');
    }
    return c;
  });
}

function fade(src, a) {
  const [c, g] = canvas(src.width, src.height);
  g.globalAlpha = a;
  g.drawImage(src, 0, 0);
  return c;
}

export function mirror(src) {
  return memo(src, () => {
    const [c, g] = canvas(src.width, src.height);
    g.translate(src.width, 0);
    g.scale(-1, 1);
    g.drawImage(src, 0, 0);
    return c;
  });
}

// ---------- houses ----------
// Every house faces south. Returns { img, ax, ay, lights: [{x,y,r,color,kind}] }
// with ax/ay the anchor (base line, horizontal centre) inside the image.
export const HOUSE_STYLE = {
  normal: { kind: 'manor', w: 6, wall: '#b3a28c', wallD: '#9a8a76', trim: '#6b5a4a', roof: '#8a5a52', roofD: '#704640', glow: '#ffe7a0' },
  haunted: { kind: 'manor', w: 7, wall: '#769393', wallD: '#5f7a7a', trim: '#5a4b6c', roof: '#5a7178', roofD: '#475b61', glow: '#ffefa5', tower: true },
  zombie: { kind: 'manor', w: 7, wall: '#7d9070', wallD: '#677a5c', trim: '#3d4a35', roof: '#4c5a44', roofD: '#3a4634', glow: '#b6ff8a', boards: true },
  vampire: { kind: 'manor', w: 8, wall: '#5b4a5e', wallD: '#4a3b4d', trim: '#3a2238', roof: '#2e2433', roofD: '#221a27', glow: '#ff5a6a', tower: true },
  mansion: { kind: 'manor', w: 9, wall: '#6e6a7a', wallD: '#5a5666', trim: '#3d3a4a', roof: '#3d3a4a', roofD: '#2e2c39', glow: '#ffc070', tower: true, tall: true },
  graveyard: { kind: 'chapel', w: 6, wall: '#8d8d9a', wallD: '#77778a', trim: '#5a5a6a', roof: '#5a5a6a', roofD: '#47475a', glow: '#bfd0ff' },
  legendary: { kind: 'manor', w: 10, wall: '#3d2d55', wallD: '#302344', trim: '#2a1f40', roof: '#d9a520', roofD: '#b08518', glow: '#ffd34d', tower: true, tall: true },
  witch: { kind: 'hut', w: 6, wall: '#97ad83', wallD: '#7f9670', trim: '#71836e', roof: '#ad73c5', roofD: '#8a59a0', glow: '#d5ffe2', band: '#f1d078' },
  pumpkin: { kind: 'hut', w: 6, wall: '#c7a46a', wallD: '#a8894f', trim: '#8a7a4a', roof: '#ff8c2a', roofD: '#d96a14', glow: '#ffd27a', band: '#3d6b22', pumpkins: true },
  lab: { kind: 'hut', w: 6, wall: '#9aa6ad', wallD: '#7f8a91', trim: '#5f6b72', roof: '#6f8a96', roofD: '#566f7a', glow: '#5affd2', band: '#5affd2', tubes: true },
};

const darken = (hex, k = 0.5) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
};

export function houseSprite(type, { dark = false } = {}) {
  return memo(`house:${type}:${dark}`, () => {
    const base = HOUSE_STYLE[type] || HOUSE_STYLE.normal;
    const S = dark ? Object.fromEntries(Object.entries(base).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('#') ? darken(v, 0.55) : v])) : base;
    const glass = dark ? '#16141c' : S.glow;
    const W = S.w * T;
    const extra = S.tower ? 16 : 0;
    const H = S.kind === 'hut' ? 88 : S.tall ? 104 : 88;
    const [c, g] = canvas(W + extra + 8, H + 8);
    const ox = 4; // left margin
    const baseY = H + 4;
    const lights = [];
    const win = (x, y, w, h) => {
      outlineRect(g, x, y, w, h, glass);
      if (w > 4) rect(g, x + Math.floor(w / 2), y + 1, 1, h - 2, PAL.outline);
      if (h > 5) rect(g, x + 1, y + Math.floor(h / 2), w - 2, 1, PAL.outline);
      if (!dark) lights.push({ x: x + w / 2, y: y + h / 2, r: 18, color: S.glow, kind: 'window' });
      if (dark || S.boards) {
        line(g, x - 1, y + 1, x + w, y + h - 3, S.boards && !dark ? '#6b4a2a' : PAL.woodD);
        line(g, x - 1, y + h - 2, x + w, y + 2, S.boards && !dark ? '#6b4a2a' : PAL.woodD);
      }
    };
    const door = (cx, w = 12, h = 18) => {
      outlineRect(g, cx - w / 2, baseY - h, w, h, dark ? '#3a2a1e' : '#a0715a');
      rect(g, cx - w / 2 + 2, baseY - h + 2, w - 4, 1, dark ? '#2a1d14' : '#8a5f45');
      px(g, cx + w / 2 - 3, baseY - h / 2, PAL.candle);
      rect(g, cx - w / 2 - 2, baseY - 2, w + 4, 2, PAL.sidewalkD);
      return { x: cx, y: baseY - h / 2 };
    };

    if (S.kind === 'manor' || S.kind === 'chapel') {
      const wallH = S.tall ? 54 : S.kind === 'chapel' ? 40 : 44;
      const wallTop = baseY - wallH;
      outlineRect(g, ox, wallTop, W, wallH, S.wall);
      for (let x = ox + 4; x < ox + W - 2; x += 5) rect(g, x, wallTop + 2, 1, wallH - 4, S.wallD);
      rect(g, ox - 1, wallTop + (S.tall ? 24 : 20), W + 2, 3, S.trim);
      // gable roof
      const roofH = S.kind === 'chapel' ? 22 : 28;
      rows(g, ox + W / 2, wallTop - roofH + 1, roofH, 4, W + 8, S.roof);
      for (let i = 4; i < roofH - 2; i += 4) {
        const w = 4 + ((W + 4) * i) / roofH;
        for (let x = 0; x < w - 2; x += 4) px(g, Math.round(ox + W / 2 - w / 2 + x + (i % 8 ? 2 : 0)), wallTop - roofH + 1 + i, S.roofD);
      }
      if (S.kind === 'chapel') {
        rect(g, ox + W / 2 - 1, wallTop - roofH - 10, 2, 10, '#c9c9d6');
        rect(g, ox + W / 2 - 4, wallTop - roofH - 7, 8, 2, '#c9c9d6');
      } else {
        outlineRect(g, ox + W - 22, wallTop - roofH + 6, 8, 14, S.trim); // chimney
      }
      // windows
      const cols = S.w >= 9 ? [0.14, 0.32, 0.68, 0.86] : [0.22, 0.78];
      const winY = [baseY - 30];
      if (wallH > 40) winY.push(wallTop + 8);
      for (const y of winY) for (const f of cols) win(ox + W * f - 5, y, 10, 12);
      const d = door(ox + W / 2);
      // porch roof
      rect(g, ox + W / 2 - 11, baseY - 23, 22, 3, S.trim);
      rect(g, ox + W / 2 - 10, baseY - 20, 1, 18, PAL.outline);
      rect(g, ox + W / 2 + 9, baseY - 20, 1, 18, PAL.outline);
      if (S.tower) {
        const tx = ox + W - 2;
        const th = wallH + 16;
        outlineRect(g, tx, baseY - th, 16, th, S.wallD);
        rows(g, tx + 8, baseY - th - 22, 23, 1, 20, S.roof);
        win(tx + 4, baseY - th + 10, 8, 12);
        win(tx + 4, baseY - 26, 8, 12);
      }
      lights.push({ x: d.x, y: baseY - 26, r: 14, color: '#ffd27a', kind: 'porch' });
    } else {
      // hut: stone base, round walls, big witch-hat roof
      const wallH = 30;
      const wallTop = baseY - wallH;
      rows(g, ox + W / 2, wallTop, wallH, W - 14, W - 6, S.wall);
      for (let x = ox + 10; x < ox + W - 10; x += 6) rect(g, x, wallTop + 3, 1, wallH - 6, S.wallD);
      rect(g, ox + 4, baseY - 5, W - 8, 5, S.trim);
      rect(g, ox + 4, baseY - 5, W - 8, 1, PAL.outline);
      // roof: wide brim + cone, tip bent
      rows(g, ox + W / 2, wallTop - 6, 8, W - 2, W + 6, S.roof);
      rows(g, ox + W / 2, wallTop - 44, 40, 4, W - 18, S.roof);
      rect(g, ox + W / 2 - (W - 22) / 2, wallTop - 10, W - 22, 3, S.band);
      for (let i = 0; i < 6; i++) px(g, ox + W / 2 + 3 + i, wallTop - 46 - i, PAL.outline);
      rect(g, ox + W / 2 + 4, wallTop - 48, 6, 3, S.roof);
      // round window
      outlineRect(g, ox + W - 30, wallTop + 6, 10, 10, glass);
      if (!dark) lights.push({ x: ox + W - 25, y: wallTop + 11, r: 18, color: S.glow, kind: 'window' });
      if (dark) line(g, ox + W - 31, wallTop + 7, ox + W - 20, wallTop + 15, PAL.woodD);
      door(ox + W / 2 - 8, 11, 17);
      if (S.tubes) for (const x of [ox + 6, ox + W - 12]) {
        outlineRect(g, x, baseY - 22, 6, 18, dark ? '#223333' : '#5affd2');
        if (!dark) lights.push({ x: x + 3, y: baseY - 13, r: 16, color: '#5affd2', kind: 'window' });
      }
      // cauldron on the porch
      if (!S.tubes) {
        outlineRect(g, ox + W - 14, baseY - 8, 10, 8, '#3a3a46');
        rect(g, ox + W - 13, baseY - 8, 8, 2, dark ? '#2a2a33' : '#7dff6a');
        if (!dark) lights.push({ x: ox + W - 9, y: baseY - 8, r: 12, color: '#7dff6a', kind: 'cauldron' });
      }
    }
    if (S.pumpkins) for (let i = 0; i < 3; i++) pumpkinAt(g, ox + 2 + i * 7, baseY - 6, !dark);
    return { img: c, ax: ox + W / 2, ay: baseY, lights, w: S.w, chimney: { x: ox + W - 18, y: baseY - (S.tall ? 54 : 44) - 22 } };
  });
}

function pumpkinAt(g, x, y, lit) {
  rect(g, x, y + 1, 7, 5, PAL.outline);
  rect(g, x + 1, y, 5, 7, PAL.outline);
  rect(g, x + 1, y + 1, 5, 5, PAL.orange);
  rect(g, x + 3, y + 1, 1, 5, PAL.orangeD);
  rect(g, x + 3, y - 1, 1, 1, '#86a060');
  if (lit) { px(g, x + 2, y + 2, PAL.candle); px(g, x + 4, y + 2, PAL.candle); rect(g, x + 2, y + 4, 3, 1, PAL.candle); }
}

export function pumpkinSprite(lit = true) {
  return memo(`pumpkin:${lit}`, () => {
    const [c, g] = canvas(9, 9);
    pumpkinAt(g, 1, 2, lit);
    return c;
  });
}

// ---------- props ----------
export function treeSprite(v = 0) {
  return memo(`tree:${v}`, () => {
    const [c, g] = canvas(36, 52);
    const trunk = v % 2 ? '#5a4652' : '#6b5560';
    const dark = '#3f3040';
    // bare spooky tree like the street map's
    rows(g, 18, 18, 34, 4, 9, trunk, dark);
    const br = [[18, 26, 6, 10], [18, 22, 30, 8], [17, 30, 3, 20], [19, 28, 33, 18], [18, 20, 14, 2], [18, 20, 23, 3], [9, 13, 4, 6], [27, 12, 32, 6]];
    for (const [x0, y0, x1, y1] of br) {
      line(g, x0, y0, x1, y1, dark);
      line(g, x0 + 1, y0, x1 + 1, y1, trunk);
    }
    if (v % 3 === 0) {
      // a crow
      rect(g, 28, 15, 4, 2, '#1d1820');
      px(g, 31, 14, '#1d1820');
    }
    return c;
  });
}

export function lampSprite() {
  return memo('lamp', () => {
    const [c, g] = canvas(12, 40);
    rect(g, 5, 8, 2, 30, PAL.ironL);
    rect(g, 3, 37, 6, 3, PAL.iron);
    rect(g, 2, 5, 8, 2, PAL.iron);
    rect(g, 3, 1, 6, 5, PAL.iron);
    rect(g, 4, 2, 4, 3, '#ffffb2');
    return c;
  });
}

export function fenceSprite(kind) {
  return memo(`fence:${kind}`, () => {
    if (kind === 'h') {
      const [c, g] = canvas(16, 16);
      rect(g, 0, 7, 16, 1, PAL.iron);
      rect(g, 0, 12, 16, 1, PAL.iron);
      for (const x of [1, 5, 9, 13]) {
        rect(g, x, 4, 1, 12, PAL.ironL);
        px(g, x, 3, PAL.iron);
      }
      return c;
    }
    const [c, g] = canvas(4, 16);
    rect(g, 1, 0, 2, 16, PAL.ironL);
    rect(g, 0, 0, 4, 1, PAL.iron);
    return c;
  });
}

export function gateSprite(locked) {
  return memo(`gate:${locked}`, () => {
    // seen from the south: a gate across an east-west road is drawn as a pillar line
    const [c, g] = canvas(16, 30);
    outlineRect(g, 4, 0, 8, 30, '#4a4452');
    for (let y = 3; y < 28; y += 4) rect(g, 5, y, 6, 1, locked ? PAL.iron : '#6a6472');
    rect(g, 3, 0, 10, 3, PAL.iron);
    return c;
  });
}

export function keeperSprite(frame = 0) {
  return memo(`keeper:${frame}`, () => {
    // the Gatekeeper: a tall cloaked skeleton with a lantern
    const [c, g] = canvas(20, 40);
    const b = frame ? 1 : 0;
    rows(g, 9, 12 + b, 26, 8, 14, '#3a2f4a');
    rect(g, 11, 15 + b, 2, 20, '#2b2238');
    rect(g, 5, 4 + b, 9, 9, PAL.outline);
    rect(g, 6, 5 + b, 7, 7, '#f2efe4');
    rect(g, 7, 7 + b, 2, 2, PAL.eyes);
    rect(g, 10, 7 + b, 2, 2, PAL.eyes);
    rect(g, 8, 10 + b, 3, 1, PAL.eyes);
    rows(g, 9, 1 + b, 6, 6, 12, '#3a2f4a'); // hood
    rect(g, 15, 24, 4, 5, PAL.iron);
    rect(g, 16, 25, 2, 3, '#ffd34d');
    rect(g, 14, 20 + b, 2, 5, '#2b2238');
    return c;
  });
}

export function tombSprite(v = 0) {
  return memo(`tomb:${v}`, () => {
    const [c, g] = canvas(12, 14);
    outlineRect(g, 1, 3, 10, 11, '#9a98a8');
    rect(g, 2, 1, 8, 3, PAL.outline);
    rect(g, 3, 2, 6, 2, '#9a98a8');
    rect(g, 4, 6, 4, 1, '#77768a');
    rect(g, 5, 5, 2, 4, '#77768a');
    if (v) line(g, 8, 4, 6, 9, '#77768a');
    return c;
  });
}

export function hedgeSprite() {
  return memo('hedge', () => {
    const [c, g] = canvas(16, 22);
    rect(g, 0, 4, 16, 18, '#2c4a35');
    for (let i = 0; i < 4; i++) rect(g, i * 4, 2 + (i % 2) * 2, 4, 3, '#2c4a35');
    for (let i = 0; i < 6; i++) rect(g, (i * 5) % 14 + 1, 6 + (i * 3) % 12, 2, 2, '#3f6b4a');
    return c;
  });
}

export function signSprite(lines, { bg = '#3a2a4a', fg = '#ffd34d' } = {}) {
  return memo(`sign:${lines.join('|')}:${bg}:${fg}`, () => {
    const w = Math.max(...lines.map(textWidth)) + 6;
    const h = lines.length * 7 + 4;
    const [c, g] = canvas(w, h + 10);
    outlineRect(g, 0, 0, w, h, bg);
    lines.forEach((l, i) => pixelText(g, l, Math.round((w - textWidth(l)) / 2), 3 + i * 7, i ? '#f1eaff' : fg));
    rect(g, Math.floor(w / 2) - 1, h, 2, 10, PAL.woodD);
    return c;
  });
}

export function bankSprite() {
  return memo('bank', () => {
    const W = 9 * T;
    const [c, g] = canvas(W + 8, 112);
    const ox = 4;
    const baseY = 108;
    outlineRect(g, ox, baseY - 56, W, 56, '#e8d5ee');
    for (let x = ox + 4; x < ox + W - 2; x += 6) rect(g, x, baseY - 54, 1, 52, '#d6c1de');
    rect(g, ox - 2, baseY - 60, W + 4, 6, '#b07cc6');
    rows(g, ox + W / 2, baseY - 92, 33, 6, W + 10, '#ff93b8', PAL.outline);
    for (let i = 6; i < 30; i += 5) rect(g, ox + W / 2 - (i * 2.3), baseY - 92 + i, i * 4.6, 1, '#e87aa0');
    for (const f of [0.12, 0.3, 0.7, 0.88]) {
      outlineRect(g, ox + W * f - 4, baseY - 52, 8, 50, '#faf9ff');
      rect(g, ox + W * f - 5, baseY - 52, 10, 3, '#d6c1de');
    }
    outlineRect(g, ox + W / 2 - 9, baseY - 26, 18, 26, '#ffd34d');
    rect(g, ox + W / 2, baseY - 24, 1, 22, '#d9a520');
    pixelText(g, 'CANDY BANK', ox + Math.round((W - textWidth('CANDY BANK')) / 2), baseY - 72, '#5a2a4a');
    // lollipop on top
    rect(g, ox + W / 2 - 1, 0, 2, 20, '#faf9ff');
    outlineRect(g, ox + W / 2 - 8, 0, 16, 12, '#ff93b8');
    rect(g, ox + W / 2 - 5, 3, 10, 1, '#faf9ff');
    rect(g, ox + W / 2 - 3, 6, 6, 1, '#faf9ff');
    return { img: c, ax: ox + W / 2, ay: baseY };
  });
}

export function fountainSprite(frame = 0) {
  return memo(`fountain:${frame}`, () => {
    const [c, g] = canvas(64, 48);
    rows(g, 32, 26, 22, 56, 64, '#8a8496');
    rect(g, 6, 30, 52, 10, '#6fa3c8');
    for (let i = 0; i < 6; i++) px(g, 10 + i * 8 + frame, 33 + (i % 2), '#b6e0ff');
    // giant pumpkin in the middle
    rect(g, 18, 8, 28, 22, PAL.outline);
    rect(g, 20, 6, 24, 26, PAL.outline);
    rect(g, 20, 8, 24, 22, PAL.orange);
    rect(g, 31, 8, 2, 22, PAL.orangeD);
    rect(g, 23, 13, 5, 4, PAL.candle);
    rect(g, 36, 13, 5, 4, PAL.candle);
    rect(g, 24, 22, 16, 3, PAL.candle);
    rect(g, 30, 2, 4, 5, '#86a060');
    return c;
  });
}

export function ghostSprite(frame = 0) {
  return memo(`ghost:${frame}`, () => {
    const [c, g] = canvas(16, 18);
    g.globalAlpha = 0.7;
    rect(g, 3, 1, 10, 1, PAL.outline);
    rect(g, 2, 2, 12, 13, PAL.outline);
    rect(g, 3, 2, 10, 12, '#e8f0ff');
    for (let i = 0; i < 6; i++) rect(g, 2 + i * 2, 15 + ((i + frame) % 2), 2, 1, '#e8f0ff');
    rect(g, 5, 5, 2, 3, PAL.eyes);
    rect(g, 9, 5, 2, 3, PAL.eyes);
    return c;
  });
}

export function beaconSprite(frame = 0) {
  return memo(`beacon:${frame}`, () => {
    const [c, g] = canvas(11, 14);
    const y = frame % 2;
    rows(g, 5, 0 + y, 8, 10, 2, '#ffd34d', '#a07a10');
    return c;
  });
}

export { hash };

// ---------- town-square shops ----------
export const STORE_STYLE = {
  costumes: { name: 'SPOOKY THREADS', wall: '#5a7178', wallD: '#475b61', roof: '#ad73c5', awning: ['#ad73c5', '#f1d078'], show: 'hats' },
  sweets: { name: 'SUGAR RUSH', wall: '#f2c9d8', wallD: '#e0aec2', roof: '#ff93b8', awning: ['#ff93b8', '#faf9ff'], show: 'lollies' },
  cards: { name: 'CRYPT CARDS', wall: '#4f6a55', wallD: '#3f5545', roof: '#2e3a33', awning: ['#2e3a33', '#d9a520'], show: 'cards' },
  dojo: { name: 'COURAGE DOJO', stall: true, awning: ['#c0392b', '#faf9ff'], show: 'dummy' },
  raffle: { name: 'RAFFLE', stall: true, awning: ['#6a3d8a', '#ffd34d'], show: 'tickets' },
};

export function storeSprite(id, w) {
  return memo(`store:${id}:${w}`, () => {
    const S = STORE_STYLE[id];
    const W = w * T;
    const H = S.stall ? 58 : 84;
    const [c, g] = canvas(W + 8, H + 8);
    const ox = 4;
    const baseY = H + 4;
    const lights = [];
    const stripes = (x, y, wd, h) => {
      for (let i = 0; i < wd; i += 6) rect(g, x + i, y, Math.min(6, wd - i), h, S.awning[(i / 6) % 2]);
      for (let i = 0; i < wd; i += 6) rect(g, x + i + 1, y + h, 4, 2, S.awning[(i / 6) % 2]);
      rect(g, x, y, wd, 1, PAL.outline);
    };
    const showcase = (x, y, wd, h) => {
      outlineRect(g, x, y, wd, h, '#ffe7a0');
      lights.push({ x: x + wd / 2, y: y + h / 2, r: 22, color: '#ffe7a0', kind: 'window' });
      for (let i = 0; i < Math.floor((wd - 4) / 8); i++) {
        const ix = x + 3 + i * 8;
        if (S.show === 'hats') { rows(g, ix + 3, y + h - 12, 7, 1, 7, '#5f4d70'); rect(g, ix, y + h - 6, 7, 1, PAL.outline); }
        if (S.show === 'lollies') { rect(g, ix + 3, y + h - 7, 1, 6, '#faf9ff'); outlineRect(g, ix + 1, y + h - 12, 5, 5, ['#ff93b8', '#93e9ff', '#b6ff8a'][i % 3]); }
        if (S.show === 'cards') outlineRect(g, ix + 1, y + h - 12, 5, 8, ['#c9a8ff', '#ffd34d', '#93e9ff'][i % 3]);
      }
    };
    if (!S.stall) {
      outlineRect(g, ox, baseY - 46, W, 46, S.wall);
      for (let x = ox + 4; x < ox + W - 2; x += 5) rect(g, x, baseY - 44, 1, 42, S.wallD);
      // flat roof with a parapet and a sign board
      outlineRect(g, ox - 2, baseY - 54, W + 4, 9, S.roof);
      const tw = textWidth(S.name);
      outlineRect(g, ox + W / 2 - tw / 2 - 4, baseY - 70, tw + 8, 13, '#2b2238');
      pixelText(g, S.name, Math.round(ox + W / 2 - tw / 2), baseY - 66, '#ffd34d');
      rect(g, ox + W / 2 - tw / 2, baseY - 57, 1, 3, PAL.outline);
      rect(g, ox + W / 2 + tw / 2, baseY - 57, 1, 3, PAL.outline);
      stripes(ox - 1, baseY - 44, W + 2, 6);
      showcase(ox + 5, baseY - 32, W / 2 - 14, 20);
      showcase(ox + W / 2 + 9, baseY - 32, W / 2 - 14, 20);
      outlineRect(g, ox + W / 2 - 7, baseY - 22, 14, 22, '#a0715a');
      px(g, ox + W / 2 + 4, baseY - 11, PAL.candle);
      rect(g, ox + W / 2 - 9, baseY - 2, 18, 2, PAL.sidewalkD);
      lights.push({ x: ox + W / 2, y: baseY - 26, r: 16, color: '#ffd27a', kind: 'porch' });
    } else {
      // market stall: counter + striped canopy on poles
      rect(g, ox + 2, baseY - 40, 2, 40, PAL.woodD);
      rect(g, ox + W - 4, baseY - 40, 2, 40, PAL.woodD);
      stripes(ox, baseY - 46, W, 9);
      outlineRect(g, ox + 1, baseY - 16, W - 2, 16, '#8a5f45');
      rect(g, ox + 2, baseY - 15, W - 4, 2, '#a0715a');
      const tw = textWidth(S.name);
      outlineRect(g, ox + W / 2 - tw / 2 - 3, baseY - 58, tw + 6, 11, '#2b2238');
      pixelText(g, S.name, Math.round(ox + W / 2 - tw / 2), baseY - 55, '#ffd34d');
      if (S.show === 'dummy') {
        // training dummy behind the counter
        rect(g, ox + W / 2 - 1, baseY - 34, 2, 18, PAL.woodD);
        outlineRect(g, ox + W / 2 - 5, baseY - 34, 10, 10, '#e6d193');
        rect(g, ox + W / 2 - 8, baseY - 30, 16, 2, PAL.woodD);
        px(g, ox + W / 2 - 2, baseY - 31, PAL.eyes); px(g, ox + W / 2 + 1, baseY - 31, PAL.eyes);
      } else {
        for (let i = 0; i < 4; i++) outlineRect(g, ox + 10 + i * 12, baseY - 26 + (i % 2) * 2, 9, 6, ['#ffd34d', '#ff93b8', '#93e9ff', '#b6ff8a'][i]);
      }
      lights.push({ x: ox + W / 2, y: baseY - 30, r: 26, color: '#ffd27a', kind: 'porch' });
    }
    return { img: c, ax: ox + W / 2, ay: baseY, lights };
  });
}

// ---------- townsfolk ----------
export function npcSprite(look, frame = 0) {
  return memo(`npc:${look}:${frame}`, () => {
    const [c, g] = canvas(20, 36);
    const b = frame ? 1 : 0;
    const top = 10 + b;
    const head = (skin, x = 5, w = 10) => {
      rect(g, x + 1, top, w - 2, 1, PAL.outline);
      rect(g, x, top + 1, w, 8, PAL.outline);
      rect(g, x + 1, top + 9, w - 2, 1, PAL.outline);
      rect(g, x + 1, top + 1, w - 2, 8, skin);
      rect(g, x + 2, top + 4, 1, 2, PAL.eyes);
      rect(g, x + w - 3, top + 4, 1, 2, PAL.eyes);
    };
    const body = (col, colD, wTop = 10, wBot = 14) => {
      rows(g, 10, 20 + b, 13, wTop, wBot, col);
      rect(g, 13, 22 + b, 2, 9, colD);
      rect(g, 6, 33, 3, 2, '#3b324f');
      rect(g, 11, 33, 3, 2, '#3b324f');
    };
    if (look === 'mayor') {
      body('#2b2238', '#1d1830');
      rect(g, 9, 21 + b, 2, 10, '#c0392b'); // sash
      // pumpkin head + top hat
      rect(g, 4, top + 1, 12, 9, PAL.outline);
      rect(g, 5, top, 10, 11, PAL.outline);
      rect(g, 5, top + 1, 10, 9, PAL.orange);
      rect(g, 9, top + 1, 1, 9, PAL.orangeD);
      rect(g, 6, top + 3, 2, 2, PAL.candle);
      rect(g, 12, top + 3, 2, 2, PAL.candle);
      rect(g, 7, top + 7, 6, 1, PAL.candle);
      rect(g, 3, top - 1, 14, 2, '#1d1820');
      rect(g, 6, top - 8, 8, 7, '#1d1820');
      rect(g, 6, top - 3, 8, 1, '#c0392b');
    } else if (look === 'granny') {
      body('#6a3d8a', '#552f70', 12, 16);
      rect(g, 4, 20 + b, 12, 3, '#9a7ab0'); // shawl
      head('#f2d5bf');
      rect(g, 6, top, 8, 3, '#d8d4e4');
      rect(g, 7, top - 3, 6, 3, '#d8d4e4'); // bun
      rect(g, 6, top + 4, 3, 2, PAL.outline); rect(g, 11, top + 4, 3, 2, PAL.outline); // glasses
      rect(g, 17, 20 + b, 1, 15, PAL.woodD); // cane
    } else if (look === 'digger') {
      body('#6b5a44', '#584835');
      head('#e8c9a8');
      rect(g, 5, top, 10, 3, '#4a4a3a');
      rect(g, 3, top + 2, 14, 1, '#4a4a3a'); // cap
      rect(g, 17, 14 + b, 1, 20, PAL.woodD); // shovel handle
      outlineRect(g, 15, 30, 5, 5, '#9a98a8');
    } else {
      // witch
      body('#4a2a5a', '#3a2048', 12, 16);
      head('#a8d8a0');
      rect(g, 1, top + 1, 18, 2, PAL.outline);
      rect(g, 2, top + 1, 16, 1, '#2b2238');
      rows(g, 10, top - 10, 11, 2, 10, '#2b2238');
      rect(g, 6, top - 1, 8, 1, '#7dff6a');
      rect(g, 1, 22 + b, 1, 13, PAL.woodD); // broom
      rect(g, 0, 32, 3, 3, '#e6d193');
    }
    return c;
  });
}

export function markerSprite(kind) {
  return memo(`marker:${kind}`, () => {
    const [c, g] = canvas(9, 13);
    const col = kind === 'ready' ? '#ffd34d' : kind === 'active' ? '#a99cc8' : '#ffd34d';
    outlineRect(g, 0, 0, 9, 13, '#2b2238');
    if (kind === 'offer') {
      rect(g, 3, 2, 3, 6, col);
      rect(g, 3, 9, 3, 2, col);
    } else {
      rect(g, 2, 2, 5, 2, col);
      rect(g, 5, 4, 2, 2, col);
      rect(g, 3, 6, 3, 2, col);
      rect(g, 3, 9, 3, 2, col);
    }
    return c;
  });
}
