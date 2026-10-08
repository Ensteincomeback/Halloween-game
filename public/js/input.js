// Player input: WASD / arrows to move (Shift to run), hold-and-release E or
// Space at a door to knock, Tab/M for the menu, H for help, ` for the dev panel.
// Touch devices get a floating joystick and an action button.

export function createInput(surface, { onActionDown, onActionUp, onMenu, onHelp, onDev }) {
  const keys = new Set();
  const state = { joy: { x: 0, y: 0 }, enabled: true };
  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);

  window.addEventListener('keydown', (e) => {
    if (typing()) return;
    const k = e.key.toLowerCase();
    if (k === '`') return onDev?.();
    if (!state.enabled) return;
    if (k === 'e' || k === ' ') {
      e.preventDefault();
      if (!e.repeat) onActionDown();
      return;
    }
    if (k === 'tab' || k === 'm') {
      e.preventDefault();
      return onMenu();
    }
    if (k === 'h' || k === '?') return onHelp?.();
    keys.add(k);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if ((k === 'e' || k === ' ') && !typing()) onActionUp();
    keys.delete(k);
  });
  window.addEventListener('blur', () => keys.clear());

  // ---- touch joystick ----
  const joy = document.getElementById('joystick');
  const knob = document.getElementById('joystick-knob');
  let joyId = null;
  let origin = null;
  surface.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (joyId !== null) break;
      joyId = t.identifier;
      origin = { x: t.clientX, y: t.clientY };
      joy.style.left = `${t.clientX - 60}px`;
      joy.style.top = `${t.clientY - 60}px`;
      joy.hidden = false;
    }
    e.preventDefault();
  }, { passive: false });
  surface.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      const dx = t.clientX - origin.x;
      const dy = t.clientY - origin.y;
      const len = Math.min(50, Math.hypot(dx, dy));
      const a = Math.atan2(dy, dx);
      state.joy = { x: (Math.cos(a) * len) / 50, y: (Math.sin(a) * len) / 50 };
      knob.style.transform = `translate(${Math.cos(a) * len}px, ${Math.sin(a) * len}px)`;
    }
    e.preventDefault();
  }, { passive: false });
  const end = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      joyId = null;
      state.joy = { x: 0, y: 0 };
      knob.style.transform = '';
      joy.hidden = true;
    }
  };
  surface.addEventListener('touchend', end);
  surface.addEventListener('touchcancel', end);

  const act = document.getElementById('btn-action');
  act.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onActionDown();
  });
  act.addEventListener('pointerup', (e) => {
    e.preventDefault();
    onActionUp();
  });

  // World-space movement: x east, z north. Returns { x, z, run }.
  function movement() {
    if (!state.enabled) return { x: 0, z: 0, run: false };
    let x = 0;
    let z = 0;
    if (keys.has('w') || keys.has('arrowup')) z += 1;
    if (keys.has('s') || keys.has('arrowdown')) z -= 1;
    if (keys.has('a') || keys.has('arrowleft')) x -= 1;
    if (keys.has('d') || keys.has('arrowright')) x += 1;
    if (state.joy.x || state.joy.y) {
      x = state.joy.x;
      z = -state.joy.y;
    }
    const len = Math.hypot(x, z);
    if (len > 1) {
      x /= len;
      z /= len;
    }
    return { x, z, run: keys.has('shift') || Math.hypot(state.joy.x, state.joy.y) > 0.85 };
  }

  return { state, movement, clear: () => keys.clear() };
}
