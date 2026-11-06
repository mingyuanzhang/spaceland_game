import { DIRS, isSolid, mod, voxelIndex } from './world.js';

export const RADIUS = 0.24;
export const SPEED = 3.4;
export const TURN_RATE = 1.9;
const THRUST_RESPONSE = 7;
const TURN_RESPONSE = 14;
const ALIGN_RESPONSE = 11;
const RECORD_INTERVAL = 0.05;
const EXIT_REACH = 0.6;

// Quaternions are [x, y, z, w]. The player's local frame looks along -Z with
// +Y as "crown" and +X to the right; no direction in the world is special.
export const conjugate = ([x, y, z, w]) => [-x, -y, -z, w];

export function multiply(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function normalize(v) {
  const length = Math.hypot(...v) || 1;
  return v.map(c => c / length);
}

export function rotate([qx, qy, qz, qw], [x, y, z]) {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + qy * tz - qz * ty, y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
}

export const dot = (a, b) => a.reduce((sum, c, i) => sum + c * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const quatAngle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(dot(a, b))));

// Nearest-sign interpolation keeps a turn going the short way around.
export function nlerp(a, b, t) {
  const sign = dot(a, b) < 0 ? -1 : 1;
  return normalize(a.map((c, i) => c + (b[i] * sign - c) * t));
}

function quatFromBasis(right, up, back) {
  const [m00, m10, m20] = right;
  const [m01, m11, m21] = up;
  const [m02, m12, m22] = back;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return normalize([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return normalize([0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return normalize([(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return normalize([(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]);
}

function frameFrom(forward, upHint) {
  const up = normalize(upHint.map((c, i) => c - forward[i] * dot(upHint, forward)));
  return quatFromBasis(cross(forward, up), up, forward.map(c => -c));
}

export function quatFromForward(forward) {
  const upHint = Math.abs(forward[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  return frameFrom(normalize(forward), upHint);
}

const nearestAxis = (v, exclude = -1) => {
  let best = 0;
  let bestDot = -Infinity;
  for (let i = 0; i < 6; i++) {
    if (i >> 1 === exclude) continue;
    const value = dot(v, DIRS[i]);
    if (value > bestDot) { bestDot = value; best = i; }
  }
  return best;
};

// The nearest of the 24 orientations that line up with the walls.
export function squaredUp(q) {
  const forward = nearestAxis(rotate(q, [0, 0, -1]));
  const up = nearestAxis(rotate(q, [0, 1, 0]), forward >> 1);
  return frameFrom(DIRS[forward], DIRS[up]);
}

export const AXIS_NAMES = ['EAST', 'WEST', 'UP', 'DOWN', 'SOUTH', 'NORTH'];

export function facingName(q) {
  return AXIS_NAMES[nearestAxis(rotate(q, [0, 0, -1]))];
}

// Rounded corners: push the sphere out of each solid voxel it overlaps. Moves
// are split so that a step can never cross a whole wall.
export function moveWithCollision(grid, position, delta) {
  const distance = Math.hypot(...delta);
  const steps = Math.max(1, Math.ceil(distance / (RADIUS * 0.5)));
  let p = position;
  for (let s = 0; s < steps; s++) {
    p = p.map((c, a) => c + delta[a] / steps);
    for (let iteration = 0; iteration < 3; iteration++) {
      let pushed = false;
      const low = p.map(c => Math.floor(c - RADIUS));
      const high = p.map(c => Math.floor(c + RADIUS));
      for (let z = low[2]; z <= high[2]; z++) for (let y = low[1]; y <= high[1]; y++) for (let x = low[0]; x <= high[0]; x++) {
        if (!isSolid(grid, x, y, z)) continue;
        const nearest = [Math.max(x, Math.min(p[0], x + 1)), Math.max(y, Math.min(p[1], y + 1)), Math.max(z, Math.min(p[2], z + 1))];
        const away = p.map((c, a) => c - nearest[a]);
        const gap = Math.hypot(...away);
        if (gap >= RADIUS || gap === 0) continue;
        p = p.map((c, a) => c + (away[a] / gap) * (RADIUS - gap));
        pushed = true;
      }
      if (!pushed) break;
    }
  }
  return p;
}

// How far a ray travels before reaching a wall (used by the replay's beam).
export function castRay(grid, origin, direction, limit = 24) {
  const cell = origin.map(Math.floor);
  const step = direction.map(Math.sign);
  const unit = direction.map(d => (d === 0 ? Infinity : Math.abs(1 / d)));
  const next = origin.map((c, a) => (step[a] > 0 ? cell[a] + 1 - c : c - cell[a]) * unit[a]);
  let travelled = 0;
  while (travelled < limit) {
    const axis = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    travelled = next[axis];
    next[axis] += unit[axis];
    cell[axis] += step[axis];
    if (isSolid(grid, ...cell)) return Math.min(travelled, limit);
  }
  return limit;
}

export class Game {
  constructor(level) {
    this.level = level;
    this.reset();
  }

  reset() {
    this.position = this.level.start.map(c => c + 0.5);
    this.orientation = quatFromForward(this.level.facing);
    this.velocity = [0, 0, 0];
    this.spin = [0, 0, 0];
    this.alignTarget = null;
    this.status = 'playing';
    this.walked = 0;
    this.flown = 0;
    this.activeTime = 0;
    this.lastRecorded = 0;
    this.recording = [this.snapshot()];
  }

  snapshot() {
    return { t: this.activeTime, position: [...this.position], orientation: [...this.orientation] };
  }

  squareUp() {
    this.alignTarget = squaredUp(this.orientation);
    this.spin = [0, 0, 0];
  }

  // input.move is local [right, crown, back] from -1 to 1, input.turn is
  // [pitch, yaw, roll] from -1 to 1, and input.look is immediate radians.
  step(dt, input = {}) {
    if (this.status !== 'playing') return;
    dt = Math.min(dt, 0.05);
    const startPosition = this.position;
    const startOrientation = this.orientation;
    this.updateOrientation(dt, input);

    const move = input.move ?? [0, 0, 0];
    const magnitude = Math.hypot(...move);
    const thrust = magnitude > 1 ? move.map(c => c / magnitude) : move;
    const wanted = rotate(this.orientation, thrust).map(c => c * SPEED);
    const response = 1 - Math.exp(-THRUST_RESPONSE * dt);
    this.velocity = this.velocity.map((c, a) => c + (wanted[a] - c) * response);
    if (Math.hypot(...this.velocity) < 0.01) this.velocity = [0, 0, 0];

    this.position = moveWithCollision(this.level.grid, startPosition, this.velocity.map(c => c * dt));
    // Whatever a wall absorbed is gone, so nothing builds up against it.
    this.velocity = this.position.map((c, a) => (c - startPosition[a]) / dt);

    const moved = Math.hypot(...this.position.map((c, a) => c - startPosition[a]));
    const turned = quatAngle(startOrientation, this.orientation);
    if (turned > 0.002) this.walked = 0;
    if (moved > 1e-4) { this.walked += moved; this.flown += moved; }
    if (moved > 1e-4 || turned > 1e-4) {
      this.activeTime += dt;
      if (this.activeTime - this.lastRecorded >= RECORD_INTERVAL) {
        this.recording.push(this.snapshot());
        this.lastRecorded = this.activeTime;
      }
    }
    if (this.atExit()) this.finish('escaped');
  }

  updateOrientation(dt, input) {
    const turn = input.turn ?? [0, 0, 0];
    const look = input.look ?? [0, 0, 0];
    const response = 1 - Math.exp(-TURN_RESPONSE * dt);
    this.spin = this.spin.map((c, a) => c + (turn[a] * TURN_RATE - c) * response);
    const rotation = this.spin.map((c, a) => c * dt + look[a]);
    if (Math.hypot(...rotation) > 1e-5) {
      this.alignTarget = turn.some(Boolean) || look.some(Boolean) ? null : this.alignTarget;
      const angle = Math.hypot(...rotation);
      const scale = Math.sin(angle / 2) / angle;
      this.orientation = normalize(multiply(this.orientation, [rotation[0] * scale, rotation[1] * scale, rotation[2] * scale, Math.cos(angle / 2)]));
    }
    if (this.alignTarget) {
      this.orientation = nlerp(this.orientation, this.alignTarget, 1 - Math.exp(-ALIGN_RESPONSE * dt));
      if (quatAngle(this.orientation, this.alignTarget) < 0.004) {
        this.orientation = this.alignTarget;
        this.alignTarget = null;
      }
    }
  }

  atExit() {
    const { grid, exit } = this.level;
    const cell = this.position.map(Math.floor);
    if (voxelIndex(grid, ...cell) !== voxelIndex(grid, ...exit)) return false;
    return Math.hypot(...this.position.map(c => mod(c, 1) - 0.5)) < EXIT_REACH;
  }

  finish(status) {
    if (this.status !== 'playing') return;
    this.status = status;
    this.recording.push(this.snapshot());
  }
}

// Position and orientation along a recording at an active time.
export function sampleRecording(recording, t) {
  const last = recording[recording.length - 1];
  if (t <= recording[0].t) return { position: recording[0].position, orientation: recording[0].orientation };
  if (t >= last.t) return { position: last.position, orientation: last.orientation };
  let low = 0;
  let high = recording.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (recording[middle].t <= t) low = middle; else high = middle;
  }
  const a = recording[low];
  const b = recording[high];
  const mix = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return { position: a.position.map((c, i) => c + (b.position[i] - c) * mix), orientation: nlerp(a.orientation, b.orientation, mix) };
}

// Flies a route using ordinary controls. The tests use it to prove each level
// can be finished through real movement and collision.
export function pilotInput(game, route, state) {
  const clamp = v => Math.max(-1, Math.min(1, v));
  let toTarget;
  for (;;) {
    toTarget = route[state.index].map((c, a) => c + 0.5 - game.position[a]);
    if (Math.hypot(...toTarget) > 0.3 || state.index === route.length - 1) break;
    state.index++;
  }
  const local = rotate(conjugate(game.orientation), normalize(toTarget));
  const aligned = local[2] < -0.85;
  const yaw = local[2] > 0 && Math.abs(local[0]) < 0.3 ? 1 : clamp(-local[0] * 3);
  return {
    turn: [clamp(local[1] * 3), yaw, 0],
    move: aligned ? [clamp(local[0] * 2), clamp(local[1] * 2), -1] : [0, 0, 0],
  };
}
