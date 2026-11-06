// Optional real-browser check. Uses installed Chrome (software WebGL when
// headless) and Node's built-in WebSocket; writes screenshots under artifacts/.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'spaceland-browser-'));
const browser = spawn(chrome, ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });

const pending = new Map();
const errors = [];
let serial = 0;
let ws;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function run(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function shot(name) {
  await delay(250);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(artifacts, name), Buffer.from(data, 'base64'));
}
async function waitFor(expression, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await run(expression)) return;
    await delay(50);
  }
  throw Error(`Timed out: ${expression} (state ${await run('window.spaceland?.app.state')}, level ${await run('window.spaceland?.app.levelIndex')})`);
}
const stateIs = state => `window.spaceland.app.state === ${JSON.stringify(state)}`;
const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });

try {
  let port;
  for (let i = 0; i < 300 && !port; i++) {
    try { port = Number(readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { /* Chrome has not written it yet. */ }
    await delay(100);
  }
  assert.ok(port, 'Chrome starts');
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(Error(message.error.message)); else entry.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    } else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      errors.push(message.params.entry.text);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await size(1440, 900);

  // Direct file:// launch is the main way to play.
  await send('Page.navigate', { url: pathToFileURL(join(root, 'index.html')).href });
  await waitFor('document.readyState === "complete" && !!window.spaceland');
  assert.ok(await run('!!window.spaceland.app.renderer'), 'WebGL 2 renderer exists');
  assert.equal(await run('document.querySelectorAll(".level-choice").length'), 10);
  await shot('01-title.png');

  await run('document.getElementById("peek-button").click()');
  await waitFor(stateIs('peek'));
  await shot('02-peek-room.png');
  await run('document.getElementById("peek-button").click()');
  await waitFor(stateIs('idle'));

  // Keyboard flight reaches the game through real key events.
  await run('document.getElementById("start-button").click()');
  await waitFor(stateIs('playing'));
  assert.ok(await run('document.body.classList.contains("immersive")'));
  const before = await run('window.spaceland.app.game.position[2]');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  await delay(500);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
  assert.ok(await run('window.spaceland.app.game.position[2]') < before - 0.2, 'W flies forward');
  await shot('03-first-person-room.png');

  // Looking and rolling work through real input events.
  const orientation = 'JSON.stringify(window.spaceland.app.game.orientation)';
  const beforeKey = await run(orientation);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await delay(300);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'ArrowLeft', key: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  assert.notEqual(await run(orientation), beforeKey, 'arrow keys turn');
  const beforeMouse = await run(orientation);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: 400 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 400, button: 'left', clickCount: 1 });
  for (let x = 620; x <= 760; x += 20) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 430, button: 'left', buttons: 1 }); await delay(20); }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 760, y: 430, button: 'left', clickCount: 1 });
  await delay(100);
  assert.notEqual(await run(orientation), beforeMouse, 'the mouse turns the view');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyT', key: 't', windowsVirtualKeyCode: 84 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyT', key: 't', windowsVirtualKeyCode: 84 });
  await waitFor('window.spaceland.app.game.alignTarget === null');
  assert.ok(await run('window.spaceland.app.game.orientation.every(c => [0, .5, 1, Math.SQRT1_2].some(v => Math.abs(Math.abs(c) - v) < 1e-6))'), 'T squares up');

  await run('(() => { const { game } = window.spaceland.app; game.reset(); game.orientation = [Math.SQRT1_2, 0, 0, Math.SQRT1_2]; })()');
  await shot('04-looking-up-at-exit.png');

  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Escape', key: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(stateIs('paused'));
  await shot('05-paused.png');
  await run('document.getElementById("restart-button").click()');
  await waitFor(stateIs('playing'));

  // Win through the app's real loop, then watch the replay.
  await run('window.spaceland.autopilot()');
  await waitFor(stateIs('replay'), 60000);
  await run('window.spaceland.app.autopilot = null');
  assert.equal(await run('document.getElementById("objective-label").textContent'), 'YOU GOT OUT');
  assert.ok(!(await run('document.getElementById("next-button").hidden')));
  await run('window.spaceland.app.replay.time = window.spaceland.app.replay.duration * .6');
  await shot('06-replay-room.png');

  await run('document.getElementById("next-button").click()');
  await waitFor(stateIs('playing'));
  assert.equal(await run('window.spaceland.app.levelIndex'), 1);
  await run('window.spaceland.app.selectLevel(0); document.getElementById("levels-button").click()');
  await shot('07-levels.png');
  await run('document.getElementById("level-dialog").close()');

  // Representative worlds, mid-route, in closed and wrapped space.
  for (const [index, name] of [[3, 'storeys'], [6, 'ring'], [9, 'three-torus']]) {
    await run(`(() => { const { app } = window.spaceland; app.selectLevel(${index}); app.play(); const { game, level } = app; const point = level.path[Math.floor(level.path.length * .4)]; game.position = point.map(c => c + .5); })()`);
    await shot(`08-play-${name}.png`);
    await run('(() => { const { app } = window.spaceland; app.game.position = app.level.start.map(c => c + .5); window.spaceland.autopilot(); })()');
    await waitFor(stateIs('replay'), 180000);
    await run('window.spaceland.app.autopilot = null; window.spaceland.app.replay.time = window.spaceland.app.replay.duration * .75');
    await shot(`09-replay-${name}.png`);
  }

  await run('window.spaceland.app.selectLevel(6); window.spaceland.app.play()');
  await shot('12-seeing-yourself.png');

  await run('(() => { const { app } = window.spaceland; app.selectLevel(8); app.togglePeek(); })()');
  await shot('10-peek-deep.png');

  await run('window.spaceland.app.selectLevel(1); window.spaceland.app.play(); document.getElementById("view-canvas")');
  await waitFor(stateIs('playing'));
  await run('window.spaceland.app.pause(); document.getElementById("give-up-button").click()');
  await waitFor(stateIs('replay'));
  assert.equal(await run('document.getElementById("objective-label").textContent'), 'YOUR PATH SO FAR');
  assert.ok(await run('document.getElementById("next-button").hidden'));

  await size(420, 860, true);
  await run('window.spaceland.app.selectLevel(0)');
  await shot('11-mobile.png');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }] });
  await run('window.spaceland.app.selectLevel(3); window.spaceland.app.play()');
  await shot('13-mobile-play.png');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Browser check passed. Screenshots are in artifacts/.');
} catch (error) {
  console.error(error);
  console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  ws?.close();
  browser.kill();
  await delay(300);
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
