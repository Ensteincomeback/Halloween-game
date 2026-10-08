// World layout: where every house, door, gate and the Candy Bank sit in 3D
// space. Deterministic from the Season Pack, shared by the server (travel
// checks) and the client (rendering), so both agree on distances.

const SPACING = 16; // between house pairs along a street
const SETBACK = 10; // house centre from the road centre line
const DOOR = 5.7; // where you stand to knock: just in front of the door
const START = 24; // first house distance from the square's centre
const HALF_WIDTH = 19; // street corridor half-width
const SQUARE = 22; // town square half-size

// Street directions: Hollow Lane north, Crypt Row east, Witchwood west.
const DIRS = [
  { dx: 0, dz: 1, lx: 1, lz: 0 },
  { dx: 1, dz: 0, lx: 0, lz: -1 },
  { dx: -1, dz: 0, lx: 0, lz: 1 },
];

const r1 = (n) => Math.round(n * 100) / 100;

export function buildLayout(season) {
  const houses = {};
  const zones = [{ id: 'square', minX: -SQUARE, maxX: SQUARE, minZ: -SQUARE, maxZ: SQUARE }];
  const gates = [];
  const hedges = [];
  const streets = [];
  let id = 1;

  season.neighborhoods.forEach((hood, i) => {
    const d = DIRS[i % DIRS.length];
    const at = (u, v) => ({ x: r1(d.dx * u + d.lx * v), z: r1(d.dz * u + d.lz * v) });
    const pairs = Math.ceil(hood.types.length / 2);
    const end = START + pairs * SPACING + 32;
    hood.types.forEach((type, k) => {
      const u = START + Math.floor(k / 2) * SPACING + SPACING / 2;
      const side = k % 2 ? 1 : -1;
      const pos = at(u, side * SETBACK);
      const door = at(u, side * DOOR);
      // The house front faces the road: from the house toward its door.
      const rot = r1(Math.atan2(door.x - pos.x, door.z - pos.z));
      houses[id] = { id, hood: hood.id, ...pos, rot, door, plot: (hood.plots || []).includes(k) };
      id += 1;
    });
    // Corridor the player may walk in, from the square to the street's end.
    const a = at(SQUARE - 2, -HALF_WIDTH);
    const b = at(end, HALF_WIDTH);
    zones.push({ id: hood.id, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
    streets.push({ hood: hood.id, from: at(SQUARE - 2, 0), to: at(end, 0), dir: { x: d.dx, z: d.dz } });
    if (hood.minLevel > 1 || hood.unlockCost > 0) gates.push({ hood: hood.id, ...at(SQUARE + 1, 0), along: { x: d.dx, z: d.dz }, width: HALF_WIDTH * 2 });

    // One secret house at the far end of each street, behind a hedge.
    const secret = season.secretHouses[i];
    if (secret) {
      const pos = at(end - 12, 0);
      const door = at(end - 16.6, 0);
      houses[secret.id] = { id: secret.id, hood: hood.id, ...pos, rot: r1(Math.atan2(door.x - pos.x, door.z - pos.z)), door, secret: true };
      hedges.push({ house: secret.id, ...at(end - 24, 0), along: { x: d.dx, z: d.dz }, width: HALF_WIDTH * 2 });
    }
  });

  return {
    houses,
    zones,
    gates,
    hedges,
    streets,
    bank: { x: 0, z: -14, rot: 0, door: { x: 0, z: -8.6 } },
    spawn: { x: 0, z: 2 },
  };
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
