// Worlds are voxel grids: corridors are one voxel wide and walls one voxel
// thick. An axis may wrap, which joins its far side to its near side. Everything
// here is pure data, so levels can be solved and checked without a browser.

export const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
export const EXIT_COLOR = [0.61, 0.87, 0.71];
const EXIT_LIGHT_REACH = 9;
const EXIT_LIGHT_FALLOFF = 0.74;

export const mod = (a, n) => ((a % n) + n) % n;

export function createRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGrid(size, wrap = [false, false, false]) {
  return { size, wrap, data: new Uint8Array(size[0] * size[1] * size[2]).fill(1) };
}

// Index of a voxel, following wrapped axes. Outside a closed axis it is -1.
export function voxelIndex(grid, x, y, z) {
  const [sx, sy, sz] = grid.size;
  if (grid.wrap[0]) x = mod(x, sx); else if (x < 0 || x >= sx) return -1;
  if (grid.wrap[1]) y = mod(y, sy); else if (y < 0 || y >= sy) return -1;
  if (grid.wrap[2]) z = mod(z, sz); else if (z < 0 || z >= sz) return -1;
  return x + sx * (y + sy * z);
}

export function isSolid(grid, x, y, z) {
  const i = voxelIndex(grid, x, y, z);
  return i < 0 || grid.data[i] === 1;
}

const carve = (grid, x, y, z) => { grid.data[voxelIndex(grid, x, y, z)] = 0; };

function voxelAt(grid, index) {
  const [sx, sy] = grid.size;
  return [index % sx, Math.floor(index / sx) % sy, Math.floor(index / (sx * sy))];
}

function carveBox(grid, from, to) {
  for (let z = from[2]; z <= to[2]; z++) for (let y = from[1]; y <= to[1]; y++) for (let x = from[0]; x <= to[0]; x++) carve(grid, x, y, z);
}

// Breadth-first search over air. Returns step counts and the direction taken to
// reach each voxel, which lets a route be walked out in unwrapped coordinates.
export function floodFrom(grid, start) {
  const count = grid.data.length;
  const distance = new Int32Array(count).fill(-1);
  const via = new Int8Array(count).fill(-1);
  const startIndex = voxelIndex(grid, ...start);
  const queue = [startIndex];
  distance[startIndex] = 0;
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const [x, y, z] = voxelAt(grid, index);
    for (let d = 0; d < 6; d++) {
      const next = voxelIndex(grid, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2]);
      if (next < 0 || grid.data[next] === 1 || distance[next] >= 0) continue;
      distance[next] = distance[index] + 1;
      via[next] = d;
      queue.push(next);
    }
  }
  return { distance, via };
}

// The shortest route as unwrapped voxel coordinates: on a wrapped axis it keeps
// counting past the seam, so consecutive points are always one step apart.
export function shortestPath(level) {
  const { grid, start, exit } = level;
  const { via } = floodFrom(grid, start);
  const steps = [];
  let cursor = exit;
  while (voxelIndex(grid, ...cursor) !== voxelIndex(grid, ...start)) {
    const d = via[voxelIndex(grid, ...cursor)];
    steps.push(d);
    cursor = cursor.map((c, a) => c - DIRS[d][a]);
  }
  const path = [[...start]];
  for (const d of steps.reverse()) path.push(path[path.length - 1].map((c, a) => c + DIRS[d][a]));
  return path;
}

const airNeighbors = (grid, [x, y, z]) => DIRS.filter(d => !isSolid(grid, x + d[0], y + d[1], z + d[2])).length;

export function carveMaze({ cells, wrap = [false, false, false], seed, straight = 0.45, branch = 0.2, braid = 0, rooms = [], sightline = -1 }) {
  const random = createRandom(seed);
  const size = cells.map((n, a) => (wrap[a] ? 2 * n : 2 * n + 1));
  const grid = createGrid(size, wrap);
  const voxel = cell => cell.map(c => 2 * c + 1);
  const cellKey = cell => cell.join();
  const neighbor = (cell, d) => {
    const next = cell.map((c, a) => c + DIRS[d][a]);
    for (let a = 0; a < 3; a++) {
      if (wrap[a]) next[a] = mod(next[a], cells[a]);
      else if (next[a] < 0 || next[a] >= cells[a]) return null;
    }
    return next;
  };
  const link = (cell, d) => { const v = voxel(cell); carve(grid, v[0] + DIRS[d][0], v[1] + DIRS[d][1], v[2] + DIRS[d][2]); };

  const seen = new Set(['0,0,0']);
  carve(grid, ...voxel([0, 0, 0]));
  const active = [{ cell: [0, 0, 0], from: -1 }];
  while (active.length) {
    const index = random() < branch ? Math.floor(random() * active.length) : active.length - 1;
    const { cell, from } = active[index];
    const options = [0, 1, 2, 3, 4, 5].filter(d => { const n = neighbor(cell, d); return n && !seen.has(cellKey(n)); });
    if (!options.length) { active.splice(index, 1); continue; }
    const d = options.includes(from) && random() < straight ? from : options[Math.floor(random() * options.length)];
    const next = neighbor(cell, d);
    link(cell, d);
    carve(grid, ...voxel(next));
    seen.add(cellKey(next));
    active.push({ cell: next, from: d });
  }

  // Open some dead ends into loops, then hollow out chambers. Both create
  // shortcuts, so the exit is chosen last, from the finished world.
  if (braid > 0) {
    for (let z = 0; z < cells[2]; z++) for (let y = 0; y < cells[1]; y++) for (let x = 0; x < cells[0]; x++) {
      const cell = [x, y, z];
      const v = voxel(cell);
      if (airNeighbors(grid, v) !== 1 || random() >= braid) continue;
      const options = [0, 1, 2, 3, 4, 5].filter(d => neighbor(cell, d) && isSolid(grid, v[0] + DIRS[d][0], v[1] + DIRS[d][1], v[2] + DIRS[d][2]));
      if (options.length) link(cell, options[Math.floor(random() * options.length)]);
    }
  }

  for (const span of rooms) {
    const low = cells.map(n => Math.floor(random() * (n - span + 1)));
    if (low.every(c => c === 0)) continue;
    carveBox(grid, voxel(low), voxel(low.map(c => c + span - 1)));
  }

  const start = voxel([0, 0, 0]);
  // One clear line right around a wrapped axis, so that looking along it from
  // the start shows the back of your own head.
  if (sightline >= 0) {
    for (let i = 0; i < size[sightline]; i++) carve(grid, ...start.map((c, a) => (a === sightline ? i : c)));
  }
  const exit = farthestDeadEnd(grid, start);
  return { grid, start, exit };
}

function farthestDeadEnd(grid, start) {
  const { distance } = floodFrom(grid, start);
  let best = null;
  let bestDistance = -1;
  for (let index = 0; index < distance.length; index++) {
    const voxel = voxelAt(grid, index);
    if (distance[index] > bestDistance && voxel.every(v => v % 2 === 1) && airNeighbors(grid, voxel) === 1) {
      best = voxel;
      bestDistance = distance[index];
    }
  }
  return best;
}

function carvePath(size, points) {
  const grid = createGrid(size);
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1].map((c, a) => Math.min(c, points[i][a]));
    const to = points[i - 1].map((c, a) => Math.max(c, points[i][a]));
    carveBox(grid, from, to);
  }
  return { grid, start: points[0], exit: points[points.length - 1] };
}

class DisjointSet {
  constructor(count) { this.parent = Array.from({ length: count }, (_, i) => i); }
  find(a) {
    while (this.parent[a] !== a) { this.parent[a] = this.parent[this.parent[a]]; a = this.parent[a]; }
    return a;
  }
  union(a, b) { this.parent[this.find(a)] = this.find(b); }
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const channel = n => {
    const k = mod(n + h / 30, 12);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

// Hues run from 190° through violet and red to 60°, so nothing competes with
// the mint exit. A stride coprime with the count spreads neighboring IDs apart.
function wallPaints(count, seed) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let stride = Math.max(1, Math.round(count * 0.382));
  while (gcd(stride, count) !== 1) stride++;
  return Array.from({ length: count }, (_, i) => {
    const hue = mod(190 + mod((i * stride) / count + seed * 0.137, 1) * 230, 360);
    return hslToRgb(hue, [0.55, 0.42, 0.62][i % 3], [0.64, 0.72, 0.58, 0.68][i % 4]);
  });
}

// Green light is flooded through the air from the exit instead of being a point
// light, so it pours around corners but can never leak through a wall.
function exitLightField(grid, exit) {
  const { distance } = floodFrom(grid, exit);
  const field = new Float32Array(distance.length);
  for (let i = 0; i < field.length; i++) {
    if (distance[i] >= 0 && distance[i] <= EXIT_LIGHT_REACH) field[i] = EXIT_LIGHT_FALLOFF ** distance[i];
  }
  return field;
}

// One quad per exposed voxel face. Connected coplanar faces share a wall ID,
// and a wall that continues across a wrapped seam is still one wall.
function buildFaces(grid, exit, level) {
  const [sx, sy, sz] = grid.size;
  const light = exitLightField(grid, exit);
  const exitIndex = voxelIndex(grid, ...exit);
  const faces = [];
  const faceByKey = new Map();
  for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
    if (isSolid(grid, x, y, z)) continue;
    for (let d = 0; d < 6; d++) {
      if (!isSolid(grid, x + DIRS[d][0], y + DIRS[d][1], z + DIRS[d][2])) continue;
      faceByKey.set(voxelIndex(grid, x, y, z) * 6 + d, faces.length);
      faces.push({ voxel: [x, y, z], dir: d, glow: voxelIndex(grid, x, y, z) === exitIndex ? 1 : 0 });
    }
  }

  const walls = new DisjointSet(faces.length);
  faces.forEach((face, i) => {
    if (face.glow) return;
    const axis = face.dir >> 1;
    for (const tangent of [(axis + 1) % 3, (axis + 2) % 3]) {
      const next = face.voxel.map((c, a) => (a === tangent ? c + 1 : c));
      const nextIndex = voxelIndex(grid, ...next);
      if (nextIndex < 0 || nextIndex === exitIndex) continue;
      const match = faceByKey.get(nextIndex * 6 + face.dir);
      if (match !== undefined) walls.union(i, match);
    }
  });

  const wallIds = new Map();
  faces.forEach((face, i) => {
    if (face.glow) { face.wallId = -1; return; }
    const root = walls.find(i);
    if (!wallIds.has(root)) wallIds.set(root, wallIds.size);
    face.wallId = wallIds.get(root);
  });
  const paints = wallPaints(wallIds.size, level);

  for (const face of faces) {
    face.color = face.glow ? EXIT_COLOR : paints[face.wallId];
    const axis = face.dir >> 1;
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const plane = face.voxel[axis] + (face.dir & 1 ? 0 : 1);
    face.normal = DIRS[face.dir].map(c => -c);
    face.corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([cu, cv]) => {
      const position = [0, 0, 0];
      position[axis] = plane;
      position[u] = face.voxel[u] + cu;
      position[v] = face.voxel[v] + cv;
      // Occlusion and exit light both come from the three air-side neighbors
      // around this corner, which keeps shading continuous across faces.
      const step = (du, dv) => face.voxel.map((c, a) => c + (a === u ? du : 0) + (a === v ? dv : 0));
      const su = cu ? 1 : -1;
      const sv = cv ? 1 : -1;
      const sideU = step(su, 0);
      const sideV = step(0, sv);
      const diagonal = step(su, sv);
      const blockedU = isSolid(grid, ...sideU);
      const blockedV = isSolid(grid, ...sideV);
      const blockedD = isSolid(grid, ...diagonal);
      const occlusion = blockedU && blockedV ? 3 : Number(blockedU) + Number(blockedV) + Number(blockedD);
      let total = light[voxelIndex(grid, ...face.voxel)];
      let samples = 1;
      for (const [blocked, voxel] of [[blockedU, sideU], [blockedV, sideV], [blockedD || (blockedU && blockedV), diagonal]]) {
        if (blocked) continue;
        total += light[voxelIndex(grid, ...voxel)];
        samples++;
      }
      return { position, ao: 1 - occlusion * 0.17, light: total / samples };
    });
  }
  return { faces, wallCount: wallIds.size };
}

function createLevel(meta, { grid, start, exit }) {
  const level = { ...meta, grid, start, exit };
  const firstOpen = DIRS.findIndex(d => !isSolid(grid, start[0] + d[0], start[1] + d[1], start[2] + d[2]));
  level.facing = meta.facing ?? DIRS[firstOpen];
  Object.assign(level, buildFaces(grid, exit, meta.id));
  level.path = shortestPath(level);
  return level;
}

const room = (() => {
  const grid = createGrid([7, 9, 7]);
  carveBox(grid, [1, 1, 1], [5, 5, 5]);
  carveBox(grid, [3, 6, 3], [3, 7, 3]);
  return { grid, start: [3, 3, 3], exit: [3, 7, 3] };
})();

const RING = [true, false, false];
const TORUS = [true, true, false];
const OPEN = [true, true, true];

export const LEVELS = [
  createLevel({
    id: 1, title: 'A room with no floor', subtitle: 'There was never a down.', surface: 'ENCLOSED SPACE', difficulty: 'FIRST STEPS', facing: [0, 0, -1],
    hint: 'None of these walls is the floor. Look around in every direction, including straight up. Mint green is the way out, and it spills light onto the walls beside it.',
    lesson: 'Up was only a habit. From here on, every direction is a direction.',
  }, room),
  createLevel({
    id: 2, title: 'Round the bend', subtitle: 'One corridor, three directions.', surface: 'ENCLOSED SPACE', difficulty: 'FIRST STEPS',
    hint: 'There is only one way to go. When the corridor bends, turn to face along it and keep flying. Press T to square yourself up with the walls.',
    lesson: 'A corridor can turn in ways a floor never could.',
  }, carvePath([9, 9, 9], [[1, 1, 7], [1, 1, 1], [1, 5, 1], [5, 5, 1], [5, 5, 5], [7, 5, 5], [7, 7, 5]])),
  createLevel({
    id: 3, title: 'The small cube', subtitle: 'Your first real choice.', surface: 'ENCLOSED SPACE', difficulty: 'A LITTLE LOST',
    hint: 'Each wall keeps its own color. Use familiar paint to recognize a corridor you have already flown through. If a branch stops dead, come back and take the other one.',
    lesson: 'Paint is memory. The walls remember where you have been, even if you do not.',
  }, carveMaze({ cells: [2, 2, 2], seed: 1, straight: 0.2 })),
  createLevel({
    id: 4, title: 'Two storeys, no stairs', subtitle: 'A flat maze that refuses to stay flat.', surface: 'ENCLOSED SPACE', difficulty: 'A LITTLE LOST',
    hint: 'This world is wide and shallow. Square up with T and keep one direction as your personal up. The compass ball tells you which way each axis lies.',
    lesson: 'Pick an up and it will serve you, as long as you remember you chose it.',
  }, carveMaze({ cells: [4, 2, 4], seed: 1, straight: 0.5 })),
  createLevel({
    id: 5, title: 'The cube', subtitle: 'Three ways to be wrong at every junction.', surface: 'ENCLOSED SPACE', difficulty: 'TRUE 3D',
    hint: 'Keep your orientation fixed: move with strafe and rise instead of turning, and the compass stays put. The label in the middle of the ball is the direction you face.',
    lesson: 'In a line you can go two ways, on a plane four. Here it is six.',
  }, carveMaze({ cells: [3, 3, 3], seed: 12, straight: 0.3 })),
  createLevel({
    id: 6, title: 'Hollow places', subtitle: 'Some rooms have no walls nearby.', surface: 'ENCLOSED SPACE', difficulty: 'TRUE 3D',
    hint: 'Open chambers are easy to get turned around in, because every wall looks like a way out. Pick a wall color and follow the chamber around it before leaving.',
    lesson: 'Open space is harder to read than a corridor. There is nothing to follow.',
  }, carveMaze({ cells: [4, 4, 4], seed: 8, straight: 0.45, rooms: [2, 2] })),
  createLevel({
    id: 7, title: 'The long ring', subtitle: 'Keep going east and arrive from the west.', surface: 'RING WORLD', difficulty: 'CLOSED SPACE', facing: [1, 0, 0],
    hint: 'One axis of this world closes on itself, so flying far enough east brings you back from the west. That small tetrahedron far down the corridor is you, seen from behind. Move and it moves.',
    lesson: 'There was no edge. There was only more of the same world.',
  }, carveMaze({ cells: [6, 3, 3], wrap: RING, seed: 21, straight: 0.6, sightline: 0 })),
  createLevel({
    id: 8, title: 'Doughnut logic', subtitle: 'Two directions now go around.', surface: 'TORUS WORLD', difficulty: 'CLOSED SPACE',
    hint: 'East–west and up–down both wrap here. A wall of a color you just left may be the same wall seen from the far side.',
    lesson: 'Your map has edges. Your world does not.',
  }, carveMaze({ cells: [4, 4, 3], wrap: TORUS, seed: 30, straight: 0.5, braid: 0.25 })),
  createLevel({
    id: 9, title: 'Deep interior', subtitle: 'Loops, chambers, and a long way out.', surface: 'ENCLOSED SPACE', difficulty: 'VERY LOST',
    hint: 'Loops mean you can no longer follow one wall home. Treat chambers as landmarks: learn the colors around them, and count which way you left each one.',
    lesson: 'Nobody holds this much space in their head. You found a way anyway.',
  }, carveMaze({ cells: [6, 6, 6], seed: 26, straight: 0.55, branch: 0.12, braid: 0.3, rooms: [3, 2, 2] })),
  createLevel({
    id: 10, title: 'No outside', subtitle: 'All three directions come back.', surface: 'THREE-TORUS', difficulty: 'ALL THE WAY OUT', facing: [1, 0, 0],
    hint: 'Every axis wraps. There is no wall at the edge of this world because there is no edge. Use the paint: it is the only thing here that can tell you apart from your other selves.',
    lesson: 'A creature on a line imagined a plane. You have flown through a world with no outside. What are you failing to imagine?',
  }, carveMaze({ cells: [5, 5, 5], wrap: OPEN, seed: 202, straight: 0.5, branch: 0.15, braid: 0.2, rooms: [2], sightline: 0 })),
];
