import { castRay, conjugate, rotate } from './game.js';
import { EXIT_COLOR } from './world.js';

const BACKGROUND = [0.043, 0.051, 0.071];
const MAX_INSTANCES = 729;
const VIEW_RANGE = 26;

const WORLD_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColor;
layout(location=3) in vec3 aShade;
layout(location=4) in vec3 aOffset;
uniform mat4 uViewProjection;
out vec3 vWorld; out vec3 vNormal; out vec3 vColor; out vec3 vShade;
void main() {
  vWorld = aPosition + aOffset;
  vNormal = aNormal; vColor = aColor; vShade = aShade;
  gl_Position = uViewProjection * vec4(vWorld, 1.0);
}`;

const FIRST_PERSON_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec3 vColor; in vec3 vShade;
uniform vec3 uCamera; uniform vec3 uForward; uniform vec3 uBackground; uniform float uTime;
out vec4 fragment;
void main() {
  vec3 toCamera = uCamera - vWorld;
  float distance = length(toCamera);
  vec3 light = toCamera / distance;
  vec3 normal = normalize(vNormal);
  float beam = smoothstep(0.42, 0.95, dot(-light, uForward));
  float falloff = 1.0 / (1.0 + 0.02 * distance + 0.05 * distance * distance);
  float facing = max(dot(normal, light), 0.0) * 0.72 + 0.28;
  // Seams every voxel give the eye something to track while drifting.
  vec3 toSeam = abs(fract(vWorld + 0.5) - 0.5);
  vec3 seam = smoothstep(vec3(0.0), fwidth(vWorld) * 1.3 + 0.012, toSeam);
  seam = mix(seam, vec3(1.0), step(0.5, abs(normal)));
  float grid = mix(0.8, 1.0, min(seam.x, min(seam.y, seam.z)));
  float lighting = 0.12 + (0.26 + 0.86 * beam) * falloff * facing;
  vec3 mint = vec3(${EXIT_COLOR.join(',')});
  vec3 color = vColor * lighting * grid * vShade.x + (vColor * 0.55 + mint * 0.45) * mint * vShade.y * 0.95;
  float pulse = 1.08 + 0.16 * sin(uTime * 2.4);
  color = mix(color, mint * pulse * grid, vShade.z);
  float fog = smoothstep(7.0, 25.0, distance) * (1.0 - vShade.z * 0.6);
  fragment = vec4(mix(color, uBackground, fog), 1.0);
}`;

const XRAY_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in vec3 vColor; in vec3 vShade;
uniform vec3 uCamera; uniform float uOpacity;
out vec4 fragment;
void main() {
  vec3 view = normalize(uCamera - vWorld);
  float edge = pow(1.0 - abs(dot(normalize(vNormal), view)), 1.6);
  float strength = uOpacity * (0.32 + 1.5 * edge) * vShade.x;
  vec3 color = mix(vColor, vec3(${EXIT_COLOR.join(',')}), vShade.z);
  fragment = vec4(color * max(strength, vShade.z * 0.5), 1.0);
}`;

const SOLID_VERTEX = `#version 300 es
layout(location=0) in vec3 aPosition;
layout(location=1) in vec3 aNormal;
layout(location=2) in float aProgress;
layout(location=4) in vec3 aOffset;
uniform mat4 uViewProjection; uniform mat4 uModel;
out vec3 vWorld; out vec3 vNormal; out float vProgress;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0) + vec4(aOffset, 0.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vProgress = aProgress;
  gl_Position = uViewProjection * world;
}`;

const SOLID_FRAGMENT = `#version 300 es
precision highp float;
in vec3 vWorld; in vec3 vNormal; in float vProgress;
uniform vec3 uColor; uniform vec3 uCamera; uniform vec3 uBackground;
uniform float uOpacity; uniform float uProgress; uniform int uMode;
out vec4 fragment;
void main() {
  if (uMode == 2) { fragment = vec4(uColor, uOpacity); return; }
  vec3 toCamera = uCamera - vWorld;
  float distance = length(toCamera);
  float light = abs(dot(normalize(vNormal), toCamera / distance));
  if (uMode == 0) {
    vec3 color = uColor * (0.55 + 0.6 * light);
    fragment = vec4(mix(color, uBackground, smoothstep(7.0, 25.0, distance)), 1.0);
    return;
  }
  float reached = step(vProgress, uProgress);
  vec3 color = uColor * (0.55 + 0.6 * light);
  fragment = vec4(mix(color * 0.5, color, reached), mix(uOpacity * 0.28, uOpacity, reached));
}`;

function compile(gl, vertex, fragment) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const { name } = gl.getActiveUniform(program, i);
    uniforms[name] = gl.getUniformLocation(program, name);
  }
  return { program, uniforms };
}

function perspective(verticalFov, aspect, near, far) {
  const f = 1 / Math.tan(verticalFov / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
}

export function viewFrom(position, orientation) {
  const inverse = conjugate(orientation);
  const x = rotate(inverse, [1, 0, 0]);
  const y = rotate(inverse, [0, 1, 0]);
  const z = rotate(inverse, [0, 0, 1]);
  const t = rotate(inverse, position.map(c => -c));
  return [...x, 0, ...y, 0, ...z, 0, ...t, 1];
}

function modelFrom(position, orientation, scale) {
  const x = rotate(orientation, [scale[0], 0, 0]);
  const y = rotate(orientation, [0, scale[1], 0]);
  const z = rotate(orientation, [0, 0, scale[2]]);
  return [...x, 0, ...y, 0, ...z, 0, ...position, 1];
}

function lookAt(eye, target) {
  const f = target.map((c, i) => c - eye[i]);
  const flen = Math.hypot(...f);
  const back = f.map(c => -c / flen);
  const worldUp = Math.abs(back[1]) > 0.98 ? [0, 0, 1] : [0, 1, 0];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const rlen = cross(worldUp, back);
  const rl = Math.hypot(...rlen);
  const right = rlen.map(c => c / rl);
  const up = cross(back, right);
  const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return [right[0], up[0], back[0], 0, right[1], up[1], back[1], 0, right[2], up[2], back[2], 0, -d(right, eye), -d(up, eye), -d(back, eye), 1];
}

function worldVertices(faces) {
  const data = new Float32Array(faces.length * 6 * 12);
  let cursor = 0;
  for (const face of faces) {
    const { corners, normal, color, glow } = face;
    // Split along the brighter diagonal so that occlusion stays smooth.
    const order = corners[0].ao + corners[2].ao >= corners[1].ao + corners[3].ao ? [0, 1, 2, 0, 2, 3] : [1, 2, 3, 1, 3, 0];
    for (const i of order) {
      const { position, ao, light } = corners[i];
      data.set([...position, ...normal, ...color, ao, light, glow], cursor);
      cursor += 12;
    }
  }
  return data;
}

// Vertices of [x, y, z, nx, ny, nz, progress] from triangles of plain points.
function flatMesh(triangles) {
  const data = [];
  for (const [a, b, c] of triangles) {
    const u = b.map((v, i) => v - a[i]);
    const v = c.map((w, i) => w - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n) || 1;
    for (const p of [a, b, c]) data.push(...p, n[0] / length, n[1] / length, n[2] / length, 0);
  }
  return new Float32Array(data);
}

// The creature: Flatland's triangle, with one more dimension. It points along -Z.
function tetrahedronMesh() {
  const tip = [0, 0, -1.3];
  const a = [0, 0.75, 0.55];
  const b = [-0.72, -0.42, 0.55];
  const c = [0.72, -0.42, 0.55];
  return flatMesh([[tip, a, b], [tip, b, c], [tip, c, a], [a, c, b]]);
}

function octahedronMesh() {
  const p = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const triangles = [];
  for (const x of [0, 1]) for (const y of [2, 3]) for (const z of [4, 5]) triangles.push([p[x], p[y], p[z]]);
  return flatMesh(triangles);
}

function coneMesh(sides = 18) {
  const triangles = [];
  for (let i = 0; i < sides; i++) {
    const angle = (a) => [Math.cos(a) * 0.26, Math.sin(a) * 0.26, -1];
    triangles.push([[0, 0, 0], angle((i / sides) * Math.PI * 2), angle(((i + 1) / sides) * Math.PI * 2)]);
  }
  return flatMesh(triangles);
}

function boxLines() {
  const corners = [];
  for (let i = 0; i < 8; i++) corners.push([i & 1, (i >> 1) & 1, (i >> 2) & 1]);
  const data = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) data.push(...corners[i], 0, 0, 0, 0, ...corners[i | bit], 0, 0, 0, 0);
  return new Float32Array(data);
}

// A tube along the route, carrying normalized time so the replay can light it
// up as the creature passes. Its frame is transported to avoid twisting.
function routeTube(recording, radius = 0.075, sides = 6) {
  const stride = Math.max(1, Math.ceil(recording.length / 2400));
  const samples = recording.filter((_, i) => i % stride === 0 || i === recording.length - 1);
  const points = [];
  for (const s of samples) {
    const last = points[points.length - 1];
    if (!last || Math.hypot(...s.position.map((c, a) => c - last.position[a])) > 0.02) points.push(s);
  }
  if (points.length < 2) return null;
  const total = recording[recording.length - 1].t || 1;
  const data = [];
  let normal = [0.3, 0.8, 0.5];
  let previousRing = null;
  points.forEach((point, i) => {
    const before = points[Math.max(0, i - 1)].position;
    const after = points[Math.min(points.length - 1, i + 1)].position;
    const tangent = after.map((c, a) => c - before[a]);
    const tl = Math.hypot(...tangent) || 1;
    const t = tangent.map(c => c / tl);
    const along = normal[0] * t[0] + normal[1] * t[1] + normal[2] * t[2];
    normal = normal.map((c, a) => c - t[a] * along);
    const nl = Math.hypot(...normal) || 1;
    normal = normal.map(c => c / nl);
    const binormal = [t[1] * normal[2] - t[2] * normal[1], t[2] * normal[0] - t[0] * normal[2], t[0] * normal[1] - t[1] * normal[0]];
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const angle = (s / sides) * Math.PI * 2;
      const n = normal.map((c, a) => c * Math.cos(angle) + binormal[a] * Math.sin(angle));
      ring.push({ position: point.position.map((c, a) => c + n[a] * radius), normal: n, progress: point.t / total });
    }
    if (previousRing) {
      for (let s = 0; s < sides; s++) {
        const next = (s + 1) % sides;
        for (const v of [previousRing[s], ring[s], ring[next], previousRing[s], ring[next], previousRing[next]]) data.push(...v.position, ...v.normal, v.progress);
      }
    }
    previousRing = ring;
  });
  return new Float32Array(data);
}

export function createRenderer(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const firstPerson = compile(gl, WORLD_VERTEX, FIRST_PERSON_FRAGMENT);
  const xray = compile(gl, WORLD_VERTEX, XRAY_FRAGMENT);
  const solid = compile(gl, SOLID_VERTEX, SOLID_FRAGMENT);

  const instances = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_INSTANCES * 12, gl.DYNAMIC_DRAW);

  function bindInstances() {
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(4, 1);
  }

  function solidMesh(data, mode = gl.TRIANGLES) {
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    bindInstances();
    gl.bindVertexArray(null);
    return { vao, buffer, count: data.length / 7, mode };
  }

  const creature = solidMesh(tetrahedronMesh());
  const marker = solidMesh(octahedronMesh());
  const cone = solidMesh(coneMesh());
  const box = solidMesh(boxLines(), gl.LINES);

  const worldVao = gl.createVertexArray();
  const worldBuffer = gl.createBuffer();
  let worldVertexCount = 0;
  let route = null;
  let level = null;

  gl.bindVertexArray(worldVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, worldBuffer);
  [[0, 3, 0], [1, 3, 12], [2, 3, 24], [3, 3, 36]].forEach(([location, size, offset]) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 48, offset);
  });
  bindInstances();
  gl.bindVertexArray(null);

  function setInstances(offsets) {
    const count = Math.min(offsets.length, MAX_INSTANCES);
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(offsets.slice(0, count).flat()));
    return count;
  }

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    return width / height;
  }

  function drawSolid(mesh, { viewProjection, camera, model, color, opacity = 1, mode, progress = 1, instanceCount = 1 }) {
    gl.useProgram(solid.program);
    const u = solid.uniforms;
    gl.uniformMatrix4fv(u.uViewProjection, false, viewProjection);
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.uniform3fv(u.uColor, color);
    gl.uniform3fv(u.uCamera, camera);
    gl.uniform3fv(u.uBackground, BACKGROUND);
    gl.uniform1f(u.uOpacity, opacity);
    gl.uniform1f(u.uProgress, progress);
    gl.uniform1i(u.uMode, mode);
    gl.bindVertexArray(mesh.vao);
    gl.drawArraysInstanced(mesh.mode, 0, mesh.count, instanceCount);
  }

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  return {
    setLevel(next) {
      level = next;
      const data = worldVertices(level.faces);
      gl.bindBuffer(gl.ARRAY_BUFFER, worldBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      worldVertexCount = data.length / 12;
    },

    // Thicker in big views, so the route still reads among many copies.
    setRoute(recording, radius = 0.075) {
      if (route) { gl.deleteBuffer(route.buffer); gl.deleteVertexArray(route.vao); route = null; }
      const data = recording ? routeTube(recording, radius) : null;
      if (data) route = solidMesh(data);
    },

    resize,

    // The world seen from inside. On wrapped axes it is drawn again around the
    // camera, so the view runs on through the seam with no visible join.
    drawFirstPerson({ position, orientation, time }) {
      const aspect = resize();
      const { size, wrap } = level.grid;
      const reach = wrap.map((wrapped, a) => (wrapped ? Math.ceil(VIEW_RANGE / size[a]) : 0));
      const home = position.map((c, a) => (wrap[a] ? Math.floor(c / size[a]) : 0));
      const forward = rotate(orientation, [0, 0, -1]);
      // A three-torus could mean hundreds of copies, but only the few in front
      // of the camera and nearer than the fog can show.
      const offsets = [];
      for (let x = -reach[0]; x <= reach[0]; x++) for (let y = -reach[1]; y <= reach[1]; y++) for (let z = -reach[2]; z <= reach[2]; z++) {
        const offset = [(home[0] + x) * size[0], (home[1] + y) * size[1], (home[2] + z) * size[2]];
        const nearest = position.map((c, a) => Math.max(offset[a], Math.min(c, offset[a] + size[a])) - c);
        if (Math.hypot(...nearest) > VIEW_RANGE) continue;
        const farCorner = [0, 1, 2].reduce((sum, a) => sum + Math.max(offset[a] - position[a], offset[a] + size[a] - position[a]) * Math.max(0, forward[a])
          + Math.min(offset[a] - position[a], offset[a] + size[a] - position[a]) * Math.min(0, forward[a]), 0);
        if (farCorner < 0) continue;
        offsets.push(offset);
      }
      const count = setInstances(offsets);
      const projection = perspective((82 * Math.PI) / 180, aspect, 0.03, 90);
      const viewProjection = multiplyMatrices(projection, viewFrom(position, orientation));

      gl.clearColor(...BACKGROUND, 1);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      gl.useProgram(firstPerson.program);
      const u = firstPerson.uniforms;
      gl.uniformMatrix4fv(u.uViewProjection, false, viewProjection);
      gl.uniform3fv(u.uCamera, position);
      gl.uniform3fv(u.uForward, forward);
      gl.uniform3fv(u.uBackground, BACKGROUND);
      gl.uniform1f(u.uTime, time);
      gl.bindVertexArray(worldVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, worldVertexCount, count);

      // In a closed world, your own back can come into view down a corridor.
      if (wrap.some(Boolean)) {
        const images = [];
        for (let x = -reach[0]; x <= reach[0]; x++) for (let y = -reach[1]; y <= reach[1]; y++) for (let z = -reach[2]; z <= reach[2]; z++) {
          const image = [x * size[0], y * size[1], z * size[2]];
          if ((x || y || z) && Math.hypot(...image) <= VIEW_RANGE) images.push(image);
        }
        const imageCount = setInstances(images);
        drawSolid(creature, { viewProjection, camera: position, model: modelFrom(position, orientation, [0.2, 0.2, 0.2]), color: [1, 0.55, 0.42], mode: 0, instanceCount: imageCount });
      }
    },

    // The whole world seen from outside as glass. `tiles` are copies of the
    // world along the route on wrapped axes; `ghosts` are fainter neighbors.
    drawMap({ tiles, ghosts = [], yaw, pitch, zoom, progress = 1, actor = null, markers = [], focus }) {
      const aspect = resize();
      const { size } = level.grid;
      const low = [Infinity, Infinity, Infinity];
      const high = [-Infinity, -Infinity, -Infinity];
      for (const tile of tiles) for (let a = 0; a < 3; a++) {
        low[a] = Math.min(low[a], tile[a] * size[a]);
        high[a] = Math.max(high[a], (tile[a] + 1) * size[a]);
      }
      const center = focus ?? low.map((c, a) => (c + high[a]) / 2);
      const radius = Math.hypot(...high.map((c, a) => c - low[a])) / 2;
      const vertical = (42 * Math.PI) / 180;
      const fit = radius / Math.sin(Math.min(vertical, vertical * aspect) / 2);
      const distance = fit * zoom;
      const eye = [
        center[0] + distance * Math.cos(pitch) * Math.sin(yaw),
        center[1] + distance * Math.sin(pitch),
        center[2] + distance * Math.cos(pitch) * Math.cos(yaw),
      ];
      const projection = perspective(vertical, aspect, 0.1, distance * 4 + 100);
      const viewProjection = multiplyMatrices(projection, lookAt(eye, center));

      gl.clearColor(...BACKGROUND, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      const scaleOffsets = list => list.map(t => t.map((c, a) => c * size[a]));
      const faceScale = Math.min(1, 900 / (level.faces.length * Math.max(1, tiles.length * 0.6)) + 0.16);
      gl.useProgram(xray.program);
      gl.uniformMatrix4fv(xray.uniforms.uViewProjection, false, viewProjection);
      gl.uniform3fv(xray.uniforms.uCamera, eye);
      gl.bindVertexArray(worldVao);
      for (const [list, opacity] of [[ghosts, 0.08], [tiles, 0.34 * faceScale]]) {
        if (!list.length) continue;
        const count = setInstances(scaleOffsets(list));
        gl.uniform1f(xray.uniforms.uOpacity, opacity);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, worldVertexCount, count);
      }

      const frame = setInstances(scaleOffsets(tiles));
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      drawSolid(box, { viewProjection, camera: eye, model: modelFrom([0, 0, 0], [0, 0, 0, 1], size), color: [0.5, 0.56, 0.66], opacity: 0.4, mode: 2, instanceCount: frame });

      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(true);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      setInstances([[0, 0, 0]]);
      for (const { position, color, scale } of markers) {
        drawSolid(marker, { viewProjection, camera: eye, model: modelFrom(position, [0, 0, 0, 1], [scale, scale, scale]), color, opacity: 1, mode: 1 });
      }
      if (route) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        drawSolid(route, { viewProjection, camera: eye, model: identity, color: [1, 0.62, 0.48], opacity: 1, mode: 1, progress });
        gl.disable(gl.BLEND);
      }
      if (actor) {
        drawSolid(creature, { viewProjection, camera: eye, model: modelFrom(actor.position, actor.orientation, [0.42, 0.42, 0.42]), color: [1, 0.86, 0.7], mode: 1 });
        const forward = rotate(actor.orientation, [0, 0, -1]);
        const reach = Math.min(3, castRay(level.grid, actor.position, forward));
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        drawSolid(cone, { viewProjection, camera: eye, model: modelFrom(actor.position, actor.orientation, [reach, reach, reach]), color: [1, 0.9, 0.6], opacity: 0.16, mode: 2 });
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }
      gl.bindVertexArray(null);
    },
  };
}
