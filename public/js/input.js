// Player input: WASD / arrows to move, Shift to run, drag to look, wheel to
// zoom, hold-and-release E (or the action button) to knock. Touch devices get
// a joystick and drag-to-look.

export function createInput(canvas, { onActionDown, onActionUp, onMenu }) {
  const keys = new Set();
  const state = { yaw: Math.PI, pitch: 0.38, dist: 7, joy: { x: 0, y: 0 }, enabled: true };

  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  window.addEventListener('keydown', (e) => {
    if (typing() || !state.enabled) return;
    const k = e.key.toLowerCase();
    if (k === 'e' || k === ' ') {
      if (!e.repeat) onActionDown();
      e.preventDefault();
      return;
    }
    if (k === 'tab' || k === 'm') {
      e.preventDefault();
      onMenu();
      return;
    }
    keys.add(k);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if ((k === 'e' || k === ' ') && !typing()) onActionUp();
    keys.delete(k);
  });
  window.addEventListener('blur', () => keys.clear());

  // ---- mouse look ----
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerType === 'touch') return;
    state.yaw -= (e.clientX - drag.x) * 0.006;
    state.pitch = Math.min(1.2, Math.max(0.12, state.pitch + (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('wheel', (e) => {
    state.dist = Math.min(18, Math.max(3, state.dist + e.deltaY * 0.01));
    e.preventDefault();
  }, { passive: false });

  // ---- touch: joystick (left) + look (right) ----
  const joy = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  let joyId = null;
  let joyOrigin = null;
  let lookId = null;
  let lookLast = null;
  canvas.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (t.clientX < window.innerWidth / 2 && joyId === null) {
        joyId = t.identifier;
        joyOrigin = { x: t.clientX, y: t.clientY };
        joy.style.left = `${t.clientX - 60}px`;
        joy.style.top = `${t.clientY - 60}px`;
        joy.hidden = false;
      } else if (lookId === null) {
        lookId = t.identifier;
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        const dx = t.clientX - joyOrigin.x;
        const dy = t.clientY - joyOrigin.y;
        const len = Math.min(50, Math.hypot(dx, dy));
        const a = Math.atan2(dy, dx);
        state.joy = { x: (Math.cos(a) * len) / 50, y: (Math.sin(a) * len) / 50 };
        knob.style.transform = `translate(${Math.cos(a) * len}px, ${Math.sin(a) * len}px)`;
      } else if (t.identifier === lookId) {
        state.yaw -= (t.clientX - lookLast.x) * 0.008;
        state.pitch = Math.min(1.2, Math.max(0.12, state.pitch + (t.clientY - lookLast.y) * 0.005));
        lookLast = { x: t.clientX, y: t.clientY };
      }
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joyId) {
        joyId = null;
        state.joy = { x: 0, y: 0 };
        knob.style.transform = '';
        joy.hidden = true;
      }
      if (t.identifier === lookId) lookId = null;
    }
  };
  canvas.addEventListener('touchend', endTouch);
  canvas.addEventListener('touchcancel', endTouch);

  const act = document.getElementById('btn-action');
  act.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onActionDown();
  });
  act.addEventListener('pointerup', (e) => {
    e.preventDefault();
    onActionUp();
  });

  // Movement vector in camera space: x = strafe, y = forward. Returns { x, y, run }.
  function movement() {
    if (!state.enabled) return { x: 0, y: 0, run: false };
    let x = 0;
    let y = 0;
    if (keys.has('w') || keys.has('arrowup')) y += 1;
    if (keys.has('s') || keys.has('arrowdown')) y -= 1;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    if (state.joy.x || state.joy.y) {
      x = state.joy.x;
      y = -state.joy.y;
    }
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    const run = keys.has('shift') || Math.hypot(state.joy.x, state.joy.y) > 0.85;
    return { x, y, run };
  }

  return { state, movement, clear: () => keys.clear() };
}
