// World layout for the top-down pixel-art map, in tiles (1 unit = 1 tile).
// +x is east, +z is north (up on screen). Every building faces south: its door
// is on its bottom edge at `z` (the base line), and it extends north from there.
//
// Shared by the server (door/bank/gatekeeper positions for travel checks) and
// the client (drawing, fences, collisions), so both agree on distances.

const COL = 12; // house spacing within a row
const r1 = (n) => Math.round(n * 100) / 100;

const rect = (id, minX, maxX, minZ, maxZ, extra = {}) => ({ id, minX, maxX, minZ, maxZ, ...extra });

// Neighborhood blocks around the town square.
const BLOCKS = [
  // Hollow Lane: north of the square. Two east-west roads, houses on their north side.
  {
    entrance: rect('hollow-gateway', -3, 3, 13, 25),
    block: rect('hollow', -66, 66, 24, 84),
    rows: [28.5, 55.5], // road centre lines
    firstX: -54, dirX: 1,
    connector: rect('hollow-connector', -1.5, 1.5, 14, 57),
    gate: null,
    secret: { x: 0, z: 74, path: rect('hollow-secret-path', -1.5, 1.5, 57, 74), hedge: { x1: -66, x2: 66, z: 68 } },
  },
  // Crypt Row: east of the square.
  {
    entrance: rect('crypt-gateway', 23, 31, -3, 3),
    block: rect('crypt', 30, 124, -34, 12),
    rows: [0, -24],
    firstX: 44, dirX: 1,
    connector: rect('crypt-connector', 34, 37, -25.5, 1.5),
    gate: { x: 27, z: 0, vertical: true, span: 6 },
    keeper: { x: 21.5, z: 4.5 },
    secret: { x: 118, z: 2.5, hedge: { z1: -34, z2: 12, x: 111 } },
  },
  // Witchwood Heights: west of the square.
  {
    entrance: rect('witch-gateway', -31, -23, -3, 3),
    block: rect('witchwood', -124, -30, -34, 12),
    rows: [0, -24],
    firstX: -44, dirX: -1,
    connector: rect('witch-connector', -37, -34, -25.5, 1.5),
    gate: { x: -27, z: 0, vertical: true, span: 6 },
    keeper: { x: -21.5, z: 4.5 },
    secret: { x: -118, z: 2.5, hedge: { z1: -34, z2: 12, x: -111 } },
  },
];

export function buildLayout(season) {
  const houses = {};
  const square = rect('square', -24, 24, -18, 14);
  const zones = [square];
  const roads = [rect('square-plaza', -24, 24, -18, 14, { kind: 'plaza' })];
  const gates = [];
  const keepers = [];
  const hedges = [];
  let id = 1;

  season.neighborhoods.forEach((hood, i) => {
    const B = BLOCKS[i % BLOCKS.length];
    zones.push({ ...B.entrance, hood: hood.id }, { ...B.block, hood: hood.id });
    roads.push({ ...B.entrance, kind: 'road' }, { ...B.connector, kind: 'road' });
    const perRow = Math.ceil(hood.types.length / 2);
    B.rows.forEach((rz) => {
      const minX = Math.min(B.block.minX, B.block.maxX) + 2;
      const maxX = Math.max(B.block.minX, B.block.maxX) - 2;
      roads.push(rect(`${hood.id}-road-${rz}`, minX, maxX, rz - 1.5, rz + 1.5, { kind: 'road' }));
    });
    hood.types.forEach((type, k) => {
      const row = k < perRow ? 0 : 1;
      const col = k % perRow;
      const x = B.firstX + B.dirX * col * COL;
      const z = B.rows[row] + 2.5; // house base line, just north of the road's sidewalk
      houses[id] = { id, hood: hood.id, x, z, door: { x, z: r1(z - 0.9) }, plot: (hood.plots || []).includes(k) };
      id += 1;
    });
    if (B.gate && (hood.minLevel > 1 || hood.unlockCost > 0)) {
      gates.push({ hood: hood.id, ...B.gate });
      keepers.push({ hood: hood.id, x: B.keeper.x, z: B.keeper.z, spot: { x: B.keeper.x, z: r1(B.keeper.z - 1.6) } });
    }
    const secret = season.secretHouses[i];
    if (secret && B.secret) {
      const s = B.secret;
      houses[secret.id] = { id: secret.id, hood: hood.id, x: s.x, z: s.z, door: { x: s.x, z: r1(s.z - 0.9) }, secret: true };
      if (s.path) roads.push({ ...s.path, kind: 'path' });
      hedges.push({ house: secret.id, ...s.hedge });
    }
  });

  return {
    tile: 16,
    houses,
    zones,
    roads,
    gates,
    keepers,
    hedges,
    bank: { x: -12, z: 6, w: 9, door: { x: -12, z: 5.1 } },
    // Shops around the town square (walk in and press E).
    stores: [
      store('costumes', 12, 6, 8),
      store('sweets', -14, -7, 7),
      store('cards', 14, -7, 7),
      store('dojo', -7, -15, 5),
      store('raffle', 7, -15, 5),
    ],
    // Townsfolk who hand out missions. Where they stand is shared with the
    // server, which checks you're next to them when you accept or claim.
    npcs: [
      npc('mayor', 3.5, -10),
      npc('hollow', 4, 44),
      npc('crypt', 40, -12),
      npc('witch', -40, -12),
    ],
    fountain: { x: 0, z: -1, r: 2.5 },
    spawn: { x: 0, z: -9 },
    bounds: { minX: -130, maxX: 130, minZ: -42, maxZ: 92 },
  };
}

function store(id, x, z, w) {
  return { id, x, z, w, door: { x, z: r1(z - 0.9) } };
}

function npc(id, x, z) {
  return { id, x, z, spot: { x, z: r1(z - 1.3) } };
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
