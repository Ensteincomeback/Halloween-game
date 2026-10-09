// Season Pack loader. A pack may `extends` another and override only what
// changes (names, art, monsters, odds), so a new season is data, not code.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Arrays of {id} objects (neighborhoods) merge item by item, so an override
// can rename a neighborhood without restating its houses.
function mergeById(base, over) {
  const byId = new Map(base.map((x) => [x.id, x]));
  return over.map((x) => (byId.has(x.id) ? deepMerge(byId.get(x.id), x) : x));
}

export function deepMerge(base, over) {
  const keyed = (a) => Array.isArray(a) && a.length && a.every((x) => isObject(x) && 'id' in x);
  if (keyed(base) && keyed(over) && over.every((x) => base.some((b) => b.id === x.id))) return mergeById(base, over);
  if (!isObject(base) || !isObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

export function loadSeason(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!raw.extends) return raw;
  const parent = loadSeason(path.join(path.dirname(file), `${raw.extends}.json`));
  const { extends: _, ...rest } = raw;
  return deepMerge(parent, rest);
}

// The hash anchored in the on-chain season registry.
export function seasonHash(season) {
  return crypto.createHash('sha256').update(JSON.stringify(season)).digest('hex');
}
