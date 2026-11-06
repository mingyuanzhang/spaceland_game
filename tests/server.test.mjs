import test from 'node:test';
import assert from 'node:assert/strict';
import { requestHandler } from '../scripts/server.mjs';

async function request(url) {
  const response = { status: 0, headers: {}, body: null, writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(body) { this.body = body; } };
  await requestHandler({ url }, response);
  return response;
}

test('server serves the root as HTML, and browser assets with correct MIME types', async () => {
  for (const [url, mime] of [['/', 'text/html; charset=utf-8'], ['/index.html', 'text/html; charset=utf-8'], ['/style.css', 'text/css'], ['/app.bundle.js', 'text/javascript'], ['/assets/icon.svg', 'image/svg+xml']]) {
    const response = await request(url); assert.equal(response.status, 200); assert.equal(response.headers['Content-Type'], mime); assert.ok(response.body.length > 0);
  }
});

test('missing files and attempts to leave the game folder are handled', async () => {
  assert.equal((await request('/missing-file')).status, 404);
  assert.equal((await request('/%2e%2e%2fpackage.json')).status, 403);
});
