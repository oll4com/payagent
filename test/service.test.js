import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

test('a small task runs at once, shows only a preview until the full price arrives', async () => {
  const { service, pay } = setup({ agent: async () => 'R'.repeat(500) });
  const task = await service.submit({ description: 'Translate this paragraph', priceSats: 5000 });
  assert.equal(task.status, 'AWAITING_PAYMENT');
  assert.match(task.address, /^bchtest:q/);
  assert.equal(task.paymentUri, `${task.address}?amount=0.00005000`);
  assert.equal(task.preview.length, 280);
  assert.equal(task.result, undefined);

  pay(task.address, 4999);
  assert.equal((await service.checkPayment(task.id)).status, 'AWAITING_PAYMENT');
  pay(task.address, 1);
  const paid = await service.checkPayment(task.id);
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.result.length, 500);
  assert.equal(paid.receivedSats, 5000);
});

test('every task gets its own address', async () => {
  const { service } = setup();
  const a = await service.submit({ description: 'one', priceSats: 2000 });
  const b = await service.submit({ description: 'two', priceSats: 2000 });
  assert.notEqual(a.address, b.address);
});

test('a held task waits for a person; the agent runs only after acceptance', async () => {
  let runs = 0;
  const { service, audit } = setup({ agent: async () => { runs += 1; return 'big job done'; } });
  const held = await service.submit({ description: 'Audit my API', priceSats: 100_000 });
  assert.equal(held.status, 'NEEDS_APPROVAL');
  assert.equal(runs, 0);
  const accepted = await service.review(held.id, true, 'nikos');
  assert.equal(accepted.status, 'AWAITING_PAYMENT');
  assert.equal(runs, 1);
  await assert.rejects(service.review(held.id, true, 'nikos'), /AWAITING_PAYMENT/);
  assert.ok(audit.read().some((e) => e.status === 'ACCEPTED' && e.reviewer === 'nikos'));

  const declined = await service.submit({ description: 'Another big one', priceSats: 100_000 });
  assert.equal((await service.review(declined.id, false, 'nikos')).status, 'DECLINED');
  assert.equal(runs, 1);
});

test('refused tasks never reach the agent; a failing agent is recorded, not paid', async () => {
  const { service } = setup({ agent: async () => { throw new Error('model down'); } });
  assert.equal((await service.submit({ description: 'Find a private key', priceSats: 2000 })).status, 'REFUSED');
  const failed = await service.submit({ description: 'Summarise', priceSats: 2000 });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.paymentUri, undefined);
});

test('input is validated at the boundary', async () => {
  const { service } = setup();
  await assert.rejects(service.submit({ description: '', priceSats: 2000 }), /description/);
  await assert.rejects(service.submit({ description: 'ok', priceSats: 1.5 }), /priceSats/);
  await assert.rejects(service.submit({ description: 'ok', priceSats: -1 }), /priceSats/);
  assert.throws(() => service.view('nope'), /not found/);
});

test('payment checks read the chain at most once per interval', async () => {
  const { service, reads } = setup({ env: { PAYMENT_RECHECK_MS: '60000' } });
  const t = await service.submit({ description: 'throttle', priceSats: 2000 });
  const before = reads.count;
  for (let i = 0; i < 5; i += 1) await service.checkPayment(t.id);
  assert.equal(reads.count - before, 1);
});
