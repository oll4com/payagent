import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskLimiter } from '../src/server.js';

test('task limits: per client per hour, then a daily cap for everyone', () => {
  let t = 0;
  const limit = createTaskLimiter({ tasksPerIpHour: 2, tasksPerDay: 3 }, () => t);
  assert.equal(limit('a'), null);
  assert.equal(limit('a'), null);
  assert.match(limit('a'), /this hour/);
  assert.equal(limit('b'), null);
  assert.match(limit('c'), /today/);
  t += 3_600_000;
  assert.match(limit('a'), /today/, 'the hour passed but the day is full');
  t += 86_400_000;
  assert.equal(limit('a'), null);
});

test('behind the proxy, each client is counted by its own address', async (t) => {
  const { setup } = await import('./helpers.js');
  const { createApp } = await import('../src/server.js');
  const { config, service, audit, owner } = setup({ env: { TRUST_PROXY: '1', TASKS_PER_IP_HOUR: '1' } });
  const server = createApp({ config, service, audit, owner }).listen(0);
  t.after(() => server.close());
  const post = (ip) => fetch(`http://127.0.0.1:${server.address().port}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ description: 'x', priceSats: 2000 }) });
  assert.equal((await post('203.0.113.1')).status, 201);
  assert.equal((await post('203.0.113.1')).status, 429);
  assert.equal((await post('203.0.113.2')).status, 201);
});
