import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';
import { createApp } from '../src/server.js';

test('HTTP: submit, read, and the reviewer gate needs the token', async (t) => {
  const { config, service, audit } = setup();
  const server = createApp({ config, service, audit }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const held = await (await post('/api/tasks', { description: 'Big job', priceSats: 100_000 })).json();
  assert.equal(held.status, 'NEEDS_APPROVAL');
  assert.equal((await post(`/api/tasks/${held.id}/review`, { approve: true })).status, 403);
  assert.equal((await post(`/api/tasks/${held.id}/review`, { approve: true }, { 'x-review-token': 'wrong-secret!!' })).status, 403);
  const ok = await post(`/api/tasks/${held.id}/review`, { approve: true }, { 'x-review-token': 'reviewer-secret' });
  assert.equal((await ok.json()).status, 'AWAITING_PAYMENT');

  assert.equal((await post('/api/tasks', { description: '', priceSats: 1 })).status, 400);
  assert.equal((await fetch(`${base}/api/tasks`)).status, 403);
  assert.equal((await (await fetch(`${base}/api/tasks`, { headers: { 'x-review-token': 'reviewer-secret' } })).json()).length, 1);
  assert.equal((await fetch(`${base}/api/tasks/unknown`)).status, 404);
  const auditView = await (await fetch(`${base}/api/audit`)).json();
  assert.deepEqual(auditView.verified, { ok: true });
  assert.equal((await fetch(base + '/')).headers.get('content-type'), 'text/html; charset=utf-8');
});
