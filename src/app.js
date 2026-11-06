import { AXIS_NAMES, Game, conjugate, facingName, pilotInput, rotate, sampleRecording } from './game.js';
import { DIRS, EXIT_COLOR, LEVELS, shortestPath } from './world.js';
import { createRenderer } from './render.js';

const $ = id => document.getElementById(id);
const STORE_KEY = 'spaceland-progress-v1';
const LOOK_SPEED = 0.0023;
const REPLAY_LIMIT = 40;
const pad = n => String(n).padStart(2, '0');
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function loadSettings() {
  const defaults = { done: [], invert: false, sound: false };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY)) }; } catch { return defaults; }
}

const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* Private browsing: progress lasts for this visit. */ }
}

// Optional and off by default: a low drone that follows speed, a chime on escape.
class Sound {
  constructor() { this.context = null; this.gain = null; }
  start() {
    if (this.context) { this.context.resume?.(); return; }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    this.context = new Context();
    this.gain = this.context.createGain();
    this.gain.gain.value = 0;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 240;
    for (const frequency of [55, 82.5]) {
      const oscillator = this.context.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.value = frequency;
      oscillator.connect(filter);
      oscillator.start();
    }
    filter.connect(this.gain).connect(this.context.destination);
  }
  drone(level) {
    if (this.context) this.gain.gain.setTargetAtTime(settings.sound ? 0.012 + level * 0.05 : 0, this.context.currentTime, 0.08);
  }
  chime() {
    if (!this.context || !settings.sound) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, i) => {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const at = this.context.currentTime + i * 0.11;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.09, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
      oscillator.connect(gain).connect(this.context.destination);
      oscillator.start(at);
      oscillator.stop(at + 1.15);
    });
  }
}

class App {
  constructor() {
    this.canvas = $('view-canvas');
    this.renderer = createRenderer(this.canvas);
    this.sound = new Sound();
    this.gyro = $('gyro-canvas').getContext('2d');
    this.keys = new Set();
    this.held = new Set();
    this.look = [0, 0];
    this.drag = null;
    this.orbit = { yaw: 0.7, pitch: 0.42, zoom: 1, moved: false };
    this.replay = { time: 0, speed: 1, playing: false, duration: 1 };
    this.state = 'idle';
    this.locked = false;
    this.lastFrame = 0;
    this.levelIndex = Math.min(LEVELS.length - 1, LEVELS.findIndex(l => !settings.done.includes(l.id)) >>> 0);
    this.buildLevelGrid();
    this.bindControls();
    if (!this.renderer) {
      $('cover-title').textContent = 'WebGL 2 is unavailable.';
      $('cover-text').textContent = 'This game draws its world with WebGL 2. Try a current browser with hardware acceleration turned on.';
      $('start-button').disabled = true;
      $('peek-button').disabled = true;
    }
    this.selectLevel(this.levelIndex);
    requestAnimationFrame(t => this.frame(t));
  }

  get level() { return LEVELS[this.levelIndex]; }

  buildLevelGrid() {
    $('level-grid').replaceChildren(...LEVELS.map((level, i) => {
      const button = document.createElement('button');
      button.className = 'level-choice';
      button.innerHTML = `<span>${pad(level.id)}</span><strong></strong><em></em>`;
      button.querySelector('strong').textContent = level.title;
      button.querySelector('em').textContent = level.surface;
      button.addEventListener('click', () => { $('level-dialog').close(); this.selectLevel(i); });
      return button;
    }));
  }

  refreshLevelGrid() {
    [...$('level-grid').children].forEach((button, i) => {
      button.classList.toggle('done', settings.done.includes(LEVELS[i].id));
      button.classList.toggle('current', i === this.levelIndex);
    });
  }

  selectLevel(index) {
    this.releasePointer();
    this.levelIndex = index;
    const level = this.level;
    this.game = new Game(level);
    this.renderer?.setLevel(level);
    this.renderer?.setRoute(null);
    this.state = 'idle';
    $('level-number').textContent = pad(level.id);
    $('level-total').textContent = `/ ${pad(LEVELS.length)}`;
    $('difficulty').textContent = level.difficulty;
    $('level-title').textContent = level.title;
    $('level-subtitle').textContent = level.subtitle;
    $('surface-label').textContent = level.surface;
    $('chapter-label').textContent = `${pad(level.id)} / ${level.surface}`;
    $('hint-text').textContent = level.hint;
    $('hint-text').hidden = true;
    $('objective').innerHTML = 'Find the <span class="mint-text">green light.</span><br>Fly into it.';
    $('objective-label').textContent = 'YOUR OBJECTIVE';
    $('stats').hidden = true;
    $('start-label').textContent = 'Enter this world';
    $('start-button').className = 'primary-button';
    this.startAction = () => this.play();
    $('peek-button').hidden = false;
    $('peek-label').textContent = 'Peek map';
    $('next-button').hidden = true;
    $('view-cover').hidden = false;
    $('cover-title').textContent = level.id === 1 ? 'There is no floor here.' : level.title + '.';
    $('cover-text').textContent = level.id === 1 ? 'No up. No down. Six directions, and all of them are yours.' : level.subtitle;
    this.setViewMode('cover');
    this.refreshLevelGrid();
  }

  setViewMode(mode) {
    const playing = mode === 'play' || mode === 'pause';
    document.body.classList.toggle('immersive', playing);
    // The map and replay need the whole window height, not the page's title.
    document.body.classList.toggle('focused', mode === 'peek' || mode === 'replay');
    $('pause-panel').hidden = mode !== 'pause';
    $('replay-bar').hidden = mode !== 'replay';
    $('gyro').hidden = !(playing || mode === 'replay');
    $('play-hud').hidden = !playing;
    $('touch-controls').hidden = mode !== 'play' || !window.matchMedia?.('(pointer: coarse)').matches;
    $('view-label').textContent = { cover: 'FIRST-PERSON VIEW', play: 'FIRST-PERSON VIEW', pause: 'PAUSED', peek: 'MAP OF THE WORLD', replay: 'YOUR ROUTE' }[mode];
    $('dimension-label').textContent = this.level.surface;
    this.renderer?.resize();
  }

  requestPointer() {
    if (window.matchMedia?.('(pointer: coarse)').matches) return;
    try { Promise.resolve(this.canvas.requestPointerLock?.()).catch(() => {}); } catch { /* Drag-to-look still works. */ }
  }

  // Cleared here, not in the change event, so that letting go on purpose is not
  // mistaken for the player leaving when that event arrives a moment later.
  releasePointer() {
    this.locked = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  play(restart = true) {
    if (restart) { this.game.reset(); this.renderer.setRoute(null); }
    this.state = 'playing';
    this.keys.clear();
    this.held.clear();
    this.look = [0, 0];
    $('view-cover').hidden = true;
    this.setViewMode('play');
    this.flashControls();
    if (settings.sound) this.sound.start();
    this.requestPointer();
    $('viewport').focus({ preventScroll: true });
  }

  flashControls() {
    const help = $('controls-help');
    help.classList.remove('faded');
    clearTimeout(this.helpTimer);
    this.helpTimer = setTimeout(() => help.classList.add('faded'), this.level.id <= 2 ? 15000 : 5000);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.pausedAt = performance.now();
    this.keys.clear();
    this.held.clear();
    this.sound.drone(0);
    this.releasePointer();
    this.setViewMode('pause');
    this.updateToggles();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.play(false);
  }

  endAttempt(status) {
    this.game.finish(status);
    this.sound.drone(0);
    this.releasePointer();
    const escaped = status === 'escaped';
    if (escaped) {
      this.sound.chime();
      if (!settings.done.includes(this.level.id)) { settings.done.push(this.level.id); saveSettings(); }
      this.refreshLevelGrid();
    }
    this.state = 'replay';
    this.showReplay(escaped);
  }

  showReplay(escaped) {
    const { recording, flown } = this.game;
    const total = recording[recording.length - 1].t;
    this.replay = { time: 0, speed: 1, playing: !reducedMotion(), rate: Math.max(1, total / REPLAY_LIMIT), duration: Math.max(total, 0.001) };
    this.orbit = { yaw: 0.7, pitch: 0.42, zoom: 1, moved: false };
    const { size } = this.level.grid;
    const tiles = new Map();
    for (const { position } of recording) {
      const tile = position.map((c, a) => Math.floor(c / size[a]));
      tiles.set(tile.join(), tile);
    }
    this.routeTiles = [...tiles.values()].slice(0, 24);
    this.renderer.setRoute(recording, 0.075 * Math.max(1, Math.max(...size) / 9) * Math.cbrt(this.routeTiles.length));
    $('view-cover').hidden = true;
    this.setViewMode('replay');
    $('objective-label').textContent = escaped ? 'YOU GOT OUT' : 'YOUR PATH SO FAR';
    $('objective').textContent = escaped ? this.level.lesson : 'Every turn you took, from outside. Study it, then try again.';
    $('stats').hidden = false;
    $('stat-flown').textContent = flown.toFixed(1);
    $('stat-best').textContent = String(this.level.path.length - 1);
    $('stat-time').textContent = `${Math.floor(total / 60)}:${pad(Math.floor(total % 60))}`;
    $('start-label').textContent = 'Fly it again';
    this.startAction = () => this.play();
    $('peek-button').hidden = true;
    const next = this.levelIndex + 1 < LEVELS.length;
    $('next-button').hidden = !(escaped && next);
    $('start-button').className = escaped && next ? 'secondary-action' : 'primary-button';
    this.updateReplayControls();
    $('scrubber').value = 0;
  }

  togglePeek() {
    if (this.state === 'peek') {
      this.state = 'idle';
      $('view-cover').hidden = false;
      $('peek-label').textContent = 'Peek map';
      this.setViewMode('cover');
      return;
    }
    this.state = 'peek';
    this.orbit = { yaw: 0.7, pitch: 0.42, zoom: 1, moved: false };
    $('view-cover').hidden = true;
    $('peek-label').textContent = 'Hide map';
    this.setViewMode('peek');
  }

  updateToggles() {
    $('invert-button').textContent = `Invert look: ${settings.invert ? 'on' : 'off'}`;
    $('sound-button').textContent = `Sound: ${settings.sound ? 'on' : 'off'}`;
  }

  updateReplayControls() {
    $('replay-play').textContent = this.replay.playing ? 'Pause' : 'Play';
    document.querySelectorAll('[data-speed]').forEach(button => button.classList.toggle('active', Number(button.dataset.speed) === this.replay.speed));
  }

  bindControls() {
    $('start-button').addEventListener('click', () => this.startAction());
    $('peek-button').addEventListener('click', () => this.togglePeek());
    $('next-button').addEventListener('click', () => { this.selectLevel(this.levelIndex + 1); this.play(); });
    $('hint-button').addEventListener('click', () => { $('hint-text').hidden = !$('hint-text').hidden; });
    $('levels-button').addEventListener('click', () => { this.refreshLevelGrid(); $('level-dialog').showModal(); });
    $('levels-close').addEventListener('click', () => $('level-dialog').close());
    $('about-button').addEventListener('click', () => $('about-dialog').showModal());
    $('about-close').addEventListener('click', () => $('about-dialog').close());
    $('resume-button').addEventListener('click', () => this.resume());
    $('restart-button').addEventListener('click', () => this.play());
    $('give-up-button').addEventListener('click', () => this.endAttempt('gaveup'));
    $('quit-button').addEventListener('click', () => this.selectLevel(this.levelIndex));
    $('invert-button').addEventListener('click', () => { settings.invert = !settings.invert; saveSettings(); this.updateToggles(); });
    $('sound-button').addEventListener('click', () => {
      settings.sound = !settings.sound;
      saveSettings();
      if (settings.sound) this.sound.start();
      this.updateToggles();
    });
    $('replay-play').addEventListener('click', () => {
      if (this.replay.time >= this.replay.duration) this.replay.time = 0;
      this.replay.playing = !this.replay.playing;
      this.updateReplayControls();
    });
    document.querySelectorAll('[data-speed]').forEach(button => button.addEventListener('click', () => {
      this.replay.speed = Number(button.dataset.speed);
      this.updateReplayControls();
    }));
    $('scrubber').addEventListener('input', event => {
      this.replay.time = (Number(event.target.value) / 1000) * this.replay.duration;
      this.replay.playing = false;
      this.updateReplayControls();
    });

    const controlKeys = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
    window.addEventListener('keydown', event => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Escape' && !document.querySelector('dialog[open]')) {
        if (this.state === 'playing') this.pause();
        // Leaving pointer lock can pause first and still deliver this same key.
        else if (this.state === 'paused' && performance.now() - this.pausedAt > 300) this.resume();
        return;
      }
      if (this.state !== 'playing') return;
      if (event.code === 'KeyP') { this.pause(); return; }
      if (event.code === 'KeyT' && !event.repeat) this.game.squareUp();
      if (controlKeys.has(event.code)) event.preventDefault();
      this.keys.add(event.code);
    });
    window.addEventListener('keyup', event => this.keys.delete(event.code));
    window.addEventListener('blur', () => this.pause());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pause(); });
    document.addEventListener('pointerlockchange', () => {
      const lockedNow = document.pointerLockElement === this.canvas;
      if (this.locked && !lockedNow) this.pause();
      this.locked = lockedNow;
    });
    document.addEventListener('mousemove', event => {
      if (!this.locked || this.state !== 'playing') return;
      this.look[0] += event.movementX;
      this.look[1] += event.movementY;
    });

    const viewport = $('viewport');
    viewport.addEventListener('pointerdown', event => {
      if (event.target.closest('button, input')) return;
      if (this.state === 'playing' && !this.locked && event.pointerType === 'mouse') this.requestPointer();
      if (this.locked) return;
      this.drag = { x: event.clientX, y: event.clientY };
      // Refused while pointer lock is taking hold, when dragging is not needed.
      try { viewport.setPointerCapture(event.pointerId); } catch { /* Lock wins. */ }
    });
    viewport.addEventListener('pointermove', event => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      this.drag = { x: event.clientX, y: event.clientY };
      if (this.state === 'playing') {
        this.look[0] += dx * 1.4;
        this.look[1] += dy * 1.4;
      } else if (this.state === 'replay' || this.state === 'peek') {
        this.orbit.yaw -= dx * 0.008;
        this.orbit.pitch = Math.max(-1.5, Math.min(1.5, this.orbit.pitch + dy * 0.008));
        this.orbit.moved = true;
      }
    });
    const endDrag = () => { this.drag = null; };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('wheel', event => {
      if (this.state !== 'replay' && this.state !== 'peek') return;
      event.preventDefault();
      this.orbit.zoom = Math.max(0.35, Math.min(2.2, this.orbit.zoom * Math.exp(event.deltaY * 0.001)));
    }, { passive: false });

    document.querySelectorAll('[data-hold]').forEach(button => {
      const release = () => this.held.delete(button.dataset.hold);
      button.addEventListener('pointerdown', event => {
        event.preventDefault();
        event.stopPropagation();
        this.held.add(button.dataset.hold);
      });
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
    });
    $('touch-pause').addEventListener('click', () => this.pause());
    $('touch-square').addEventListener('click', () => this.game.squareUp());
    new ResizeObserver(() => this.renderer?.resize()).observe(viewport);
  }

  readInput() {
    const on = (...codes) => (codes.some(code => this.keys.has(code) || this.held.has(code)) ? 1 : 0);
    const invert = settings.invert ? -1 : 1;
    const input = {
      move: [on('KeyD') - on('KeyA'), on('Space', 'KeyR') - on('ShiftLeft', 'ShiftRight', 'KeyF'), on('KeyS') - on('KeyW')],
      turn: [(on('ArrowUp') - on('ArrowDown')) * invert, on('ArrowLeft') - on('ArrowRight'), on('KeyE') - on('KeyQ')],
      look: [-this.look[1] * LOOK_SPEED * invert, -this.look[0] * LOOK_SPEED, 0],
    };
    this.look = [0, 0];
    return input;
  }

  frame(time) {
    requestAnimationFrame(t => this.frame(t));
    const dt = Math.min(0.1, (time - this.lastFrame) / 1000);
    this.lastFrame = time;
    if (!this.renderer) return;
    if (this.state === 'playing') this.updatePlay(dt);
    if (this.state === 'playing' || this.state === 'paused') {
      this.renderer.drawFirstPerson({ position: this.game.position, orientation: this.game.orientation, time: time / 1000 });
      this.drawGyro(this.game.orientation);
      this.updateHud();
    } else if (this.state === 'replay') {
      this.drawReplay(dt);
    } else if (this.state === 'peek') {
      this.drawPeek(dt);
    } else {
      // Behind the title card, the view holds still at the start of the level.
      this.renderer.drawFirstPerson({ position: this.game.position, orientation: this.game.orientation, time: time / 1000 });
    }
  }

  updatePlay(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const input = this.autopilot ? pilotInput(this.game, this.autopilot.route, this.autopilot) : this.readInput();
    for (let i = 0; i < steps && this.state === 'playing'; i++) {
      this.game.step(dt / steps, i === 0 ? input : { ...input, look: [0, 0, 0] });
      if (this.game.status !== 'playing') this.endAttempt(this.game.status);
    }
    this.sound.drone(Math.hypot(...this.game.velocity) / 3.4);
  }

  updateHud() {
    $('gyro-readout').textContent = `FACING ${facingName(this.game.orientation)}`;
    $('walked').textContent = `${this.game.walked.toFixed(1)} SINCE LAST TURN`;
  }

  drawOrbit(dt) {
    if (!this.orbit.moved && !reducedMotion()) this.orbit.yaw += dt * 0.12;
  }

  drawPeek(dt) {
    this.drawOrbit(dt);
    const level = this.level;
    const ghosts = [];
    level.grid.wrap.forEach((wrapped, axis) => {
      if (!wrapped) return;
      for (const side of [-1, 1]) ghosts.push([0, 1, 2].map(a => (a === axis ? side : 0)));
    });
    this.renderer.drawMap({
      tiles: [[0, 0, 0]], ghosts, yaw: this.orbit.yaw, pitch: this.orbit.pitch, zoom: this.orbit.zoom,
      markers: [
        { position: level.start.map(c => c + 0.5), color: [1, 0.55, 0.42], scale: 0.42 },
        { position: level.exit.map(c => c + 0.5), color: EXIT_COLOR, scale: 0.5 },
      ],
    });
  }

  drawReplay(dt) {
    this.drawOrbit(dt);
    const replay = this.replay;
    if (replay.playing) {
      replay.time += dt * replay.speed * replay.rate;
      if (replay.time >= replay.duration) {
        replay.time = replay.duration;
        replay.playing = false;
        this.updateReplayControls();
      }
      $('scrubber').value = (replay.time / replay.duration) * 1000;
    }
    const recording = this.game.recording;
    const actor = sampleRecording(recording, replay.time);
    const final = recording[recording.length - 1].position;
    const { size, wrap } = this.level.grid;
    const exitTile = final.map((c, a) => (wrap[a] ? Math.floor(c / size[a]) : 0));
    const markers = [
      { position: this.level.start.map(c => c + 0.5), color: [1, 0.55, 0.42], scale: 0.32 },
      { position: this.level.exit.map((c, a) => c + 0.5 + exitTile[a] * size[a]), color: EXIT_COLOR, scale: 0.42 },
    ];
    this.renderer.drawMap({ tiles: this.routeTiles, yaw: this.orbit.yaw, pitch: this.orbit.pitch, zoom: this.orbit.zoom, progress: replay.time / replay.duration, actor, markers });
    this.drawGyro(actor.orientation);
    $('gyro-readout').textContent = `FACING ${facingName(actor.orientation)}`;
    $('walked').textContent = `${Math.round((replay.time / replay.duration) * 100)}% OF THE ROUTE`;
  }

  // A ball fixed to the world, seen from inside the creature's frame. The label
  // in the middle of the ball is the direction you are flying.
  drawGyro(orientation) {
    const context = this.gyro;
    const canvas = context.canvas;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const size = canvas.clientWidth * ratio;
    if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const css = canvas.clientWidth;
    const radius = css / 2 - 9;
    const center = css / 2;
    context.clearRect(0, 0, css, css);
    context.strokeStyle = 'rgba(180, 190, 205, .35)';
    context.lineWidth = 1;
    context.beginPath();
    context.arc(center, center, radius, 0, Math.PI * 2);
    context.stroke();
    const inverse = conjugate(orientation);
    const axes = DIRS.map((direction, i) => ({ view: rotate(inverse, direction), name: AXIS_NAMES[i][0], isNorth: i === 5 }));
    axes.sort((a, b) => b.view[2] - a.view[2]);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const { view: [x, y, z], name, isNorth } of axes) {
      const front = z < 0;
      const px = center + x * radius;
      const py = center - y * radius;
      context.strokeStyle = isNorth ? 'rgba(124, 164, 240, .7)' : 'rgba(200, 205, 215, .22)';
      context.globalAlpha = front ? 1 : 0.5;
      context.beginPath();
      context.moveTo(center, center);
      context.lineTo(px, py);
      context.stroke();
      context.font = `600 ${front ? 12 : 10}px ui-monospace, monospace`;
      context.fillStyle = isNorth ? '#8fb4f5' : front ? '#e8e6df' : '#8a8f98';
      context.fillText(name, px, py);
    }
    context.globalAlpha = 1;
  }
}

const app = new App();
// A stable handle for the browser check: fly the true route using normal input.
window.spaceland = {
  app,
  autopilot() { app.autopilot = { route: shortestPath(app.level), index: 0 }; },
};
