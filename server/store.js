// State store: in-memory state persisted to a JSON file with debounced,
// atomic writes. Stand-in for Postgres + Redis (design doc section 10).

import fs from 'node:fs';
import path from 'node:path';

export function createStore(file, { debounceMs = 500 } = {}) {
  let state = {};
  if (fs.existsSync(file)) {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  let timer = null;

  function flush() {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  function changed() {
    if (!timer) timer = setTimeout(flush, debounceMs);
  }

  return { state, changed, flush };
}
