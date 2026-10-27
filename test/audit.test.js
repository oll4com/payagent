import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { setup } from './helpers.js';
import { createAuditLog, verifyChain } from '../src/audit.js';

test('the audit chain verifies, and any edit breaks it and blocks further appends', async () => {
  const { service, audit, dir } = setup();
  await service.submit({ description: 'Write a haiku about blocks', priceSats: 2000 });
  const entries = audit.read();
  assert.ok(entries.length >= 3);
  assert.deepEqual(verifyChain(entries), { ok: true });

  const path = `${dir}/audit.jsonl`;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  lines[1] = lines[1].replace('WORKING', 'PAID');
  writeFileSync(path, lines.join('\n') + '\n');
  assert.deepEqual(verifyChain(audit.read()), { ok: false, brokenAt: 1 });
  assert.throws(() => createAuditLog(path), /broken/);
});
