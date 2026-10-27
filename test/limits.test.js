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
