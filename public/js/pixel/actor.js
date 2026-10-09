// The player's pixel-art trick-or-treater: 4 directions × walk frames per
// costume, a candy bucket that fills up, and little knock / scared / cheer moves.

import { kidFrame, mirror, canvas } from './sprites.js';

export function createActor(costume = 'sheet') {
  let current = costume;
  let dir = 0; // 0 down, 1 up, 2 left, 3 right
  let phase = 0;
  let moving = false;
  let fill = 0;
  let action = null;

  function update(dt, speed, vx, vz) {
    moving = speed > 0.1;
    if (moving) {
      if (Math.abs(vx) > Math.abs(vz)) dir = vx > 0 ? 3 : 2;
      else dir = vz > 0 ? 1 : 0;
      phase += dt * (3 + speed * 1.4);
    } else phase = 0;
    if (action) {
      action.t += dt;
      if (action.t >= action.dur) action = null;
    }
  }

  function frame() {
    let f = moving ? 1 + (Math.floor(phase) % 2) : 0;
    let d = dir;
    if (action?.kind === 'knock') {
      d = 1; // face the door
      f = Math.floor(action.t * 10) % 2 ? 1 : 0;
    }
    const src = kidFrame(current, d === 3 ? 2 : d, f, fill);
    let img = d === 3 ? mirror(src) : src;
    if (action && action.kind !== 'knock') img = bounce(img, action);
    return img;
  }

  // scared = shake + hop, cheer = hop
  function bounce(src, a) {
    const k = a.t / a.dur;
    const hop = Math.round(Math.sin(k * Math.PI * (a.kind === 'cheer' ? 2 : 1)) * (a.kind === 'cheer' ? 5 : 4));
    const shake = a.kind === 'scared' ? Math.round(Math.sin(a.t * 60) * (1 - k) * 2) : 0;
    const [c, g] = canvas(src.width, src.height);
    g.drawImage(src, shake, -Math.abs(hop));
    return c;
  }

  return {
    update,
    frame,
    play: (kind, dur = 0.7) => (action = { kind, t: 0, dur }),
    setCostume: (id) => (current = id),
    setBucketFill: (f) => (fill = Math.max(0, Math.min(1, f))),
    get dir() { return dir; },
    get costume() { return current; },
  };
}
