import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, testHdPublicKey } from './helpers.js';
import { checkAddress, checkXpub, hdAddress } from '../src/receiver.js';

test('xpub mode: one address per task in index order, within the gap limit', async () => {
  const { service, config } = setup();
  const xpub = { xpub: config.hdPublicKey, path: 'receive' };
  const views = [];
  for (let i = 0; i < 20; i += 1) views.push(await service.submit({ description: `task ${i}`, priceSats: 2000 }));
  assert.deepEqual(views.map((v) => v.address), views.map((_, i) => hdAddress(xpub, i, 'bchtest')));
  const blocked = await service.submit({ description: 'one too many', priceSats: 2000 });
  assert.equal(blocked.status, 'FAILED');
  assert.match(blocked.error, /too many unpaid/);
});

test('a paid task moves the gap window on; an expired unpaid index is reused after an empty-balance check', async () => {
  const { service, config, pay } = setup({ env: { PAYMENT_WINDOW_HOURS: '0' } });
  const xpub = { xpub: config.hdPublicKey, path: 'receive' };
  const first = await service.submit({ description: 'first', priceSats: 2000 });
  pay(first.address, 2000);
  assert.equal((await service.checkPayment(first.id)).status, 'PAID');
  const second = await service.submit({ description: 'second', priceSats: 2000 });
  assert.equal(second.address, hdAddress(xpub, 1, 'bchtest'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await service.checkPayment(second.id)).status, 'EXPIRED');
  const third = await service.submit({ description: 'third', priceSats: 2000 });
  assert.equal(third.address, second.address, 'the expired, empty index is reused');
});

test('a late payment to an expired task releases its result and its index is not reused', async () => {
  const { service, config, pay } = setup({ env: { PAYMENT_WINDOW_HOURS: '0' } });
  const xpub = { xpub: config.hdPublicKey, path: 'receive' };
  const late = await service.submit({ description: 'late', priceSats: 2000 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await service.checkPayment(late.id)).status, 'EXPIRED');
  pay(late.address, 2000);
  const next = await service.submit({ description: 'next', priceSats: 2000 });
  assert.equal(next.address, hdAddress(xpub, 1, 'bchtest'));
  const settled = service.view(late.id);
  assert.equal(settled.status, 'PAID');
  assert.ok(settled.result);
});

test('static fallback: each open task gets its own amount, matched by exact amount and claimed once', async () => {
  const address = checkAddress(hdAddress({ xpub: testHdPublicKey(), path: 'account' }, 0, 'bchtest'), 'bchtest');
  const { service, utxo, mine } = setup({ env: { HD_PUBLIC_KEY: '', RECEIVE_ADDRESS: address } });
  const a = await service.submit({ description: 'a', priceSats: 5000 });
  const b = await service.submit({ description: 'b', priceSats: 5000 });
  assert.equal(a.address, address);
  assert.deepEqual([a.amountSats, b.amountSats], [5001, 5002]);
  assert.equal(a.paymentUri, `${address}?amount=0.00005001`);
  utxo(address, { tx_hash: 'aa'.repeat(32), tx_pos: 0, value: 5002, height: 0 });
  assert.equal((await service.checkPayment(a.id)).status, 'AWAITING_PAYMENT', 'the other task amount does not pay this one');
  assert.equal((await service.checkPayment(b.id)).status, 'PAID');
  mine();
  utxo(address, { tx_hash: 'bb'.repeat(32), tx_pos: 1, value: 5001, height: 1001 });
  assert.equal((await service.checkPayment(a.id)).status, 'PAID');
  const c = await service.submit({ description: 'c', priceSats: 5000 });
  assert.equal(c.amountSats, 5001, 'tags of settled tasks are free again');
  assert.equal((await service.checkPayment(c.id)).status, 'AWAITING_PAYMENT', 'an already claimed output never pays twice');
});

test('without a receiving wallet the task fails before the agent works', async () => {
  let ran = false;
  const { service } = setup({ agent: async () => { ran = true; return 'x'; }, env: { HD_PUBLIC_KEY: '' } });
  const t = await service.submit({ description: 'no wallet', priceSats: 2000 });
  assert.equal(t.status, 'FAILED');
  assert.match(t.error, /receiving wallet/);
  assert.equal(ran, false);
});

test('the owner store: a paired wallet wins over the environment; keys and addresses are checked', () => {
  const { owner, config } = setup();
  const paired = testHdPublicKey();
  owner.save({ hd: checkXpub(paired, 'receive', 'chipnet') });
  assert.equal(owner.current().xpub, paired);
  owner.save({ hd: null });
  assert.equal(owner.current().xpub, config.hdPublicKey);
  assert.throws(() => checkXpub('xpub-nonsense', 'receive', 'chipnet'), /not an HD public key/);
  assert.throws(() => checkXpub(paired, 'receive', 'mainnet'), /testnet/);
  assert.throws(() => checkXpub(paired, 'change', 'chipnet'), /account or receive/);
  assert.throws(() => checkAddress('bitcoincash:qqqq', 'bchtest'), /not a cash address|bitcoincash/);
});
