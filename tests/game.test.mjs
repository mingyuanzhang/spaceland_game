import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRS, LEVELS, floodFrom, isSolid, shortestPath, voxelIndex } from '../src/world.js';
import { viewFrom } from '../src/render.js';
import { Game, RADIUS, SPEED, castRay, conjugate, dot, facingName, moveWithCollision, multiply, pilotInput, quatAngle, quatFromForward, rotate, sampleRecording, squaredUp } from '../src/game.js';

const close = (a, b, epsilon = 1e-6) => a.forEach((c, i) => assert.ok(Math.abs(c - b[i]) < epsilon, `${a} ~ ${b}`));
const fly = (game, route, limit = 60 * 240) => {
  const state = { index: 0 };
  for (let frame = 0; frame < limit && game.status === 'playing'; frame++) game.step(1 / 60, pilotInput(game, route, state));
};

test('there are ten levels, ending in a world wrapped on all three axes', () => {
  assert.equal(LEVELS.length, 10);
  assert.deepEqual(LEVELS.map(l => l.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(LEVELS[9].grid.wrap, [true, true, true]);
});

test('every level connects start to exit and the exit is a dead end', () => {
  for (const level of LEVELS) {
    assert.ok(!isSolid(level.grid, ...level.start), level.title);
    assert.ok(!isSolid(level.grid, ...level.exit), level.title);
    assert.ok(floodFrom(level.grid, level.start).distance[voxelIndex(level.grid, ...level.exit)] > 0, level.title);
    const openings = DIRS.filter(d => !isSolid(level.grid, level.exit[0] + d[0], level.exit[1] + d[1], level.exit[2] + d[2]));
    assert.equal(openings.length, 1, level.title);
  }
});

test('the first levels are short and the hard ones are far longer', () => {
  const lengths = LEVELS.map(l => l.path.length - 1);
  assert.ok(lengths[0] <= 6);
  // Level 2 is one long corridor with no choices, so length only counts from level 3.
  for (let i = 3; i < 6; i++) assert.ok(lengths[i] >= lengths[i - 1], `level ${i + 1}: ${lengths}`);
  assert.ok(lengths[8] > 2.5 * lengths[3], `${lengths}`);
  assert.ok(lengths[9] > 2 * lengths[3], `${lengths}`);
});

test('solving a wrapped level requires crossing a seam', () => {
  for (const level of LEVELS.filter(l => l.grid.wrap.some(Boolean))) {
    const crossed = level.path.some(p => p.some((c, a) => level.grid.wrap[a] && (c < 0 || c >= level.grid.size[a])));
    assert.ok(crossed, level.title);
  }
});

test('every level can be finished using real turning, flying and collision', () => {
  for (const level of LEVELS) {
    const game = new Game(level);
    fly(game, shortestPath(level));
    assert.equal(game.status, 'escaped', level.title);
    assert.ok(game.flown >= (level.path.length - 2) * 0.9, level.title);
  }
});

test('the player never overlaps a wall while flying', () => {
  const level = LEVELS[5];
  const game = new Game(level);
  const state = { index: 0 };
  const route = shortestPath(level);
  while (game.status === 'playing') {
    game.step(1 / 60, pilotInput(game, route, state));
    const [x, y, z] = game.position.map(Math.floor);
    assert.ok(!isSolid(level.grid, x, y, z), `inside a wall at ${game.position}`);
  }
});

test('flying into a wall stops and slides along it instead of passing through', () => {
  const grid = LEVELS[0].grid;
  let position = [3.5, 3.5, 3.5];
  for (let i = 0; i < 100; i++) position = moveWithCollision(grid, position, [0.3, 0.1, 0]);
  assert.ok(Math.abs(position[0] - (6 - RADIUS)) < 0.01);
  assert.ok(Math.abs(position[1] - (6 - RADIUS)) < 0.01, 'slides until reaching the corner');
  const fast = moveWithCollision(grid, [3.5, 3.5, 3.5], [30, 0, 0]);
  assert.ok(fast[0] < 6);
});

test('movement follows the player frame in any orientation, with no gravity', () => {
  const level = LEVELS[0];
  for (const forward of [[0, 1, 0], [1, 0, 0], [0, 0, 1]]) {
    const game = new Game(level);
    game.orientation = quatFromForward(forward);
    for (let i = 0; i < 20; i++) game.step(1 / 60, { move: [0, 0, -1] });
    const travelled = game.position.map((c, a) => c - (level.start[a] + 0.5));
    assert.ok(dot(travelled, forward) > 0.4);
    assert.ok(Math.hypot(...travelled.map((c, a) => c - forward[a] * dot(travelled, forward))) < 1e-6, 'moves straight along the look direction');
  }
  const idle = new Game(level);
  for (let i = 0; i < 120; i++) idle.step(1 / 60);
  close(idle.position, level.start.map(c => c + 0.5));
});

test('the player drifts briefly after thrust ends, then stops', () => {
  const game = new Game(LEVELS[0]);
  for (let i = 0; i < 30; i++) game.step(1 / 60, { move: [1, 0, 0] });
  const atRelease = game.position[0];
  assert.ok(Math.hypot(...game.velocity) > SPEED * 0.8);
  for (let i = 0; i < 12; i++) game.step(1 / 60);
  assert.ok(game.position[0] > atRelease + 0.05);
  for (let i = 0; i < 300; i++) game.step(1 / 60);
  assert.equal(Math.hypot(...game.velocity), 0);
});

test('pitch, yaw and roll act around the player axes, so turns can reach any orientation', () => {
  const game = new Game(LEVELS[0]);
  game.step(1 / 60, { look: [Math.PI / 2, 0, 0] });
  close(rotate(game.orientation, [0, 0, -1]), [0, 1, 0], 1e-2);
  game.step(1 / 60, { look: [0, -Math.PI / 2, 0] });
  close(rotate(game.orientation, [0, 0, -1]), [1, 0, 0], 1e-2);
  const rolling = new Game(LEVELS[0]);
  rolling.orientation = quatFromForward([0, 0, -1]);
  for (let i = 0; i < 30; i++) rolling.step(1 / 60, { turn: [0, 0, 1] });
  close(rotate(rolling.orientation, [0, 0, -1]), [0, 0, -1], 1e-6);
  assert.ok(quatAngle(rolling.orientation, quatFromForward([0, 0, -1])) > 0.3);
});

test('squaring up lands on the nearest wall-aligned frame', () => {
  const start = quatFromForward([0.9, 0.3, -0.2]);
  const aligned = squaredUp(start);
  close(rotate(aligned, [0, 0, -1]), [1, 0, 0]);
  const up = rotate(aligned, [0, 1, 0]);
  assert.ok(up.every(c => Math.abs(Math.abs(c) - Math.round(Math.abs(c))) < 1e-6));
  const game = new Game(LEVELS[0]);
  game.orientation = start;
  game.squareUp();
  for (let i = 0; i < 90; i++) game.step(1 / 60);
  assert.ok(quatAngle(game.orientation, aligned) < 1e-3);
});

test('recording leaves out idle time and blocked flight, and replays smoothly', () => {
  const game = new Game(LEVELS[0]);
  for (let i = 0; i < 300; i++) game.step(1 / 60);
  assert.equal(game.recording.length, 1);
  assert.equal(game.activeTime, 0);
  for (let i = 0; i < 90; i++) game.step(1 / 60, { move: [1, 0, 0] });
  while (Math.hypot(...game.velocity) > 0) game.step(1 / 60, { move: [1, 0, 0] });
  const active = game.activeTime;
  const count = game.recording.length;
  for (let i = 0; i < 240; i++) game.step(1 / 60, { move: [1, 0, 0] });
  assert.equal(game.activeTime, active);
  assert.equal(game.recording.length, count);
  for (let i = 1; i < count; i++) {
    const a = sampleRecording(game.recording, game.recording[i - 1].t);
    const b = sampleRecording(game.recording, game.recording[i].t);
    assert.ok(Math.hypot(...a.position.map((c, k) => c - b.position[k])) < 0.5);
  }
});

test('distance since the last turn counts travel and resets on a turn', () => {
  const game = new Game(LEVELS[0]);
  for (let i = 0; i < 30; i++) game.step(1 / 60, { move: [0, 0, -1] });
  assert.ok(game.walked > 0.5);
  assert.equal(game.walked, game.flown);
  game.step(1 / 60, { look: [0, 0.2, 0] });
  assert.ok(game.walked < 0.1);
  assert.ok(game.flown > 0.5);
});

test('crossing a wrapped seam keeps coordinates continuous and reaches the same world', () => {
  const level = LEVELS[6];
  const game = new Game(level);
  const route = shortestPath(level);
  fly(game, route);
  assert.equal(game.status, 'escaped');
  for (let i = 1; i < game.recording.length; i++) {
    const jump = Math.hypot(...game.recording[i].position.map((c, a) => c - game.recording[i - 1].position[a]));
    assert.ok(jump < 0.5, 'a seam crossing never teleports the recording');
  }
  const x = level.grid.size[0];
  assert.equal(isSolid(level.grid, 1 + x, 1, 1), isSolid(level.grid, 1, 1, 1));
  assert.equal(isSolid(level.grid, 0 - x, 3, 3), isSolid(level.grid, 0, 3, 3));
});

test('ring and three-torus worlds open with a clear view right around to your own back', () => {
  for (const level of [LEVELS[6], LEVELS[9]]) {
    assert.deepEqual(level.facing, [1, 0, 0]);
    assert.equal(castRay(level.grid, level.start.map(c => c + 0.5), [1, 0, 0], 40), 40, level.title);
  }
});

test('a closed axis is solid outside the grid, but a wrapped axis has no outside', () => {
  assert.ok(isSolid(LEVELS[0].grid, -1, 3, 3));
  const wrapped = LEVELS[9].grid;
  for (const v of [[-1, 1, 1], [1, wrapped.size[1] + 1, 1]]) assert.notEqual(voxelIndex(wrapped, ...v), -1);
});

test('walls have unique paint, and no paint is green like the exit', () => {
  for (const level of LEVELS) {
    const byWall = new Map();
    for (const face of level.faces) {
      if (face.glow) { assert.equal(face.wallId, -1); continue; }
      const [r, g, b] = face.color;
      assert.ok(!(g > r + 0.02 && g > b + 0.02), `green paint in ${level.title}: ${face.color}`);
      if (byWall.has(face.wallId)) assert.equal(byWall.get(face.wallId), face.color);
      byWall.set(face.wallId, face.color);
    }
    assert.equal(new Set([...byWall.values()].map(c => c.join())).size, byWall.size, level.title);
    assert.equal(byWall.size, level.wallCount);
    assert.ok(level.faces.some(f => f.glow), level.title);
  }
});

test('a long wall is one wall, and a wall continues across a wrapped seam', () => {
  const room = LEVELS[0];
  const roomWall = room.faces.filter(f => f.dir === 1 && f.voxel[0] === 1);
  assert.equal(new Set(roomWall.map(f => f.wallId)).size, 1);
  const level = LEVELS[6];
  const size = level.grid.size[0];
  const seam = level.faces.find(f => (f.dir >> 1) !== 0 && f.voxel[0] === size - 1 && level.faces.some(o => o.dir === f.dir && o.voxel[0] === 0 && o.voxel[1] === f.voxel[1] && o.voxel[2] === f.voxel[2]));
  assert.ok(seam, 'a corridor crosses the seam');
  const other = level.faces.find(o => o.dir === seam.dir && o.voxel[0] === 0 && o.voxel[1] === seam.voxel[1] && o.voxel[2] === seam.voxel[2]);
  assert.equal(seam.wallId, other.wallId);
});

test('exit light fades along the route and never reaches past a wall', () => {
  for (const level of LEVELS) {
    const { distance } = floodFrom(level.grid, level.exit);
    for (const face of level.faces) {
      const steps = distance[voxelIndex(level.grid, ...face.voxel)];
      if (steps > 11) for (const corner of face.corners) assert.equal(corner.light, 0, level.title);
    }
  }
  const lit = LEVELS[0].faces.filter(f => f.voxel[1] === 5).flatMap(f => f.corners.map(c => c.light));
  assert.ok(Math.max(...lit) > 0.2);
});

test('rays stop at the first wall and rotate() is the inverse of its conjugate', () => {
  assert.ok(Math.abs(castRay(LEVELS[0].grid, [3.5, 3.5, 3.5], [1, 0, 0]) - 2.5) < 1e-9);
  assert.ok(Math.abs(castRay(LEVELS[0].grid, [3.5, 3.5, 3.5], [0, 1, 0]) - 4.5) < 1e-9, 'straight up the exit shaft');
  const q = quatFromForward([1, 2, 3]);
  close(rotate(conjugate(q), rotate(q, [0.2, 0.4, 0.9])), [0.2, 0.4, 0.9]);
  close(multiply(q, conjugate(q)), [0, 0, 0, 1]);
});

test('facing names follow the look direction', () => {
  assert.equal(facingName(quatFromForward([0, 0, -1])), 'NORTH');
  assert.equal(facingName(quatFromForward([0, 1, 0])), 'UP');
  assert.equal(facingName(quatFromForward([1, 0, 0])), 'EAST');
});

test('giving up keeps the path but does not count as escaping', () => {
  const game = new Game(LEVELS[1]);
  for (let i = 0; i < 40; i++) game.step(1 / 60, { move: [0, 0, -1] });
  game.finish('gaveup');
  assert.equal(game.status, 'gaveup');
  const position = game.position;
  game.step(1 / 60, { move: [0, 0, -1] });
  assert.equal(game.position, position);
  assert.ok(game.recording.length > 2);
  game.reset();
  assert.equal(game.status, 'playing');
  assert.equal(game.recording.length, 1);
});

test('the camera matrix puts what you face straight ahead, in every orientation', () => {
  // Transposing this matrix only shows up away from the start orientation:
  // the view is then black while the game still plays normally.
  const transform = (m, [x, y, z]) => [0, 1, 2].map(i => m[i] * x + m[i + 4] * y + m[i + 8] * z + m[i + 12]);
  const position = [3.5, 2.5, 7.5];
  for (const forward of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [1, 2, -3]]) {
    const orientation = quatFromForward(forward);
    const view = viewFrom(position, orientation);
    const length = Math.hypot(...forward);
    close(transform(view, position), [0, 0, 0]);
    close(transform(view, position.map((c, a) => c + forward[a] / length * 2)), [0, 0, -2]);
    const crown = rotate(orientation, [0, 1, 0]);
    close(transform(view, position.map((c, a) => c + crown[a])), [0, 1, 0]);
  }
});
