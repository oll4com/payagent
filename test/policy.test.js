import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/policy.js';

const config = { minPriceSats: 1000, autoMaxSats: 50_000, maxPriceSats: 1_000_000, autoMaxChars: 1000 };
const d = (description, priceSats) => decide({ description, priceSats }, config);

test('the first matching rule decides, with its id', () => {
  assert.deepEqual(d('Summarise this README', 5000), { decision: 'AUTO', ruleId: 'auto-small-task' });
  assert.deepEqual(d('Summarise this README', 60_000), { decision: 'APPROVE', ruleId: 'approve-above-auto-limit' });
  assert.deepEqual(d('x'.repeat(1001), 5000), { decision: 'APPROVE', ruleId: 'approve-long-task' });
  assert.deepEqual(d('Summarise', 2_000_000), { decision: 'REFUSE', ruleId: 'refuse-above-max-price' });
  assert.deepEqual(d('Summarise', 10), { decision: 'REFUSE', ruleId: 'refuse-below-min-price' });
  assert.deepEqual(d('Recover my SEED PHRASE', 60_000), { decision: 'REFUSE', ruleId: 'refuse-secrets-or-abuse' });
});
