import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, testHdPublicKey } from './helpers.js';
import { hdAddress } from '../src/receiver.js';
const ownerTestAddress = hdAddress({ xpub: testHdPublicKey(), path: 'account' }, 0, 'bchtest');
import { createApp } from '../src/server.js';

test('HTTP: submit, read, and the reviewer gate needs the token', async (t) => {
  const { config, service, audit, owner } = setup();
  const server = createApp({ config, service, audit, owner }).listen(0);
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
  const ownerHeaders = { 'x-review-token': 'reviewer-secret' };
  assert.equal((await fetch(`${base}/api/owner`)).status, 403);
  assert.equal((await (await fetch(`${base}/api/owner`, { headers: ownerHeaders })).json()).receiver.mode, 'hd');
  assert.equal((await post('/api/owner/wallet', { xpub: 'nope', path: 'receive' }, ownerHeaders)).status, 400);
  assert.equal((await post('/api/owner/static-address', { address: 'bitcoincash:qqqq' }, ownerHeaders)).status, 400);
  assert.equal((await fetch(base + '/owner')).status, 200);
  assert.equal((await fetch(base + '/presentation')).status, 200);
  assert.equal((await (await fetch(base + '/api/config')).json()).donationAddress, null, 'no static address yet: placeholder');
  assert.equal((await post('/api/owner/static-address', { address: ownerTestAddress }, ownerHeaders)).status, 200);
  const config2 = await (await fetch(base + '/api/config')).json();
  assert.equal(config2.donationAddress, null, 'an xpub wins as receiver, so the donation address stays a placeholder');
  const auditView = await (await fetch(`${base}/api/audit`)).json();
  assert.deepEqual(auditView.verified, { ok: true });
  assert.equal((await fetch(base + '/')).headers.get('content-type'), 'text/html; charset=utf-8');
});
