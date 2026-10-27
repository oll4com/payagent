// Opt-in: RELAY_E2E=1 npm test. The real WizardConnect relay with the browser's own code (web/wallet.js) and the test wallet;
// the chain is a stand-in whose broadcast only accepts a transaction the BCH virtual machine verifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualMachineBCH, decodeTransaction, hexToBin, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { setup } from './helpers.js';
import { createApp } from '../src/server.js';
import { hdAddress } from '../src/receiver.js';
import { connectTestWallet, loadTestWallet } from './test-wallet.js';

test('relay: the owner pairs the wallet, then a customer pays a task from it', { skip: process.env.RELAY_E2E !== '1', timeout: 120_000 }, async (t) => {
  const wallet = loadTestWallet();
  const ctx = setup({ env: { HD_PUBLIC_KEY: '' } });
  const funded = hdAddress({ xpub: wallet.customerPaths[0].xpub, path: 'receive' }, 0, 'bchtest');
  const coin = { tx_hash: '33'.repeat(32), tx_pos: 0, value: 50_000, height: 900 };
  const vm = createVirtualMachineBCH();
  const chain = {
    tipHeight: async () => 1000,
    listUnspent: async (a) => (a === funded ? [coin] : []),
    receivedSats: async (a) => ctx.received?.get(a) ?? 0,
    hasHistory: async (a) => (ctx.received?.get(a) ?? 0) > 0,
    async broadcast(hex) {
      const tx = decodeTransaction(hexToBin(hex));
      const sourceOutputs = [{ ...tx.inputs[0], lockingBytecode: cashAddressToLockingBytecode(funded).bytecode, valueSatoshis: 50_000n }];
      const ok = vm.verify({ sourceOutputs, transaction: tx });
      if (ok !== true) throw Object.assign(new Error(`rejected: ${ok}`), { status: 422 });
      for (const o of tx.outputs) for (const a of ctx.watch) if (binToHex(cashAddressToLockingBytecode(a).bytecode) === binToHex(o.lockingBytecode)) ctx.received.set(a, Number(o.valueSatoshis));
      return 'ab'.repeat(32);
    }
  };
  ctx.received = new Map();
  ctx.watch = [];
  const { createService } = await import('../src/service.js');
  const { join } = await import('node:path');
  const service = createService({ config: ctx.config, audit: ctx.audit, chain, owner: ctx.owner, agent: async () => 'relay result', storePath: join(ctx.dir, 'relay-tasks.json') });
  const server = createApp({ config: ctx.config, service, audit: ctx.audit, owner: ctx.owner }).listen(0);
  const sides = [];
  t.after(() => { server.close(); sides.forEach((s) => s.disconnectAll()); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { pairWallet, payWithWallet } = await import('../web/wallet.js');

  // Owner pairing: only the receive xpub reaches the server.
  const paired = await pairWallet({ onPairing: (uri) => sides.push(connectTestWallet(wallet, uri)) });
  assert.equal(paired.xpub, wallet.customerPaths[0].xpub);
  const saved = await fetch(`${base}/api/owner/wallet`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-review-token': 'reviewer-secret' }, body: JSON.stringify({ xpub: paired.xpub, path: 'receive' }) });
  assert.equal(saved.status, 200);

  const task = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'relay test', priceSats: 1500 }) })).json();
  assert.equal(task.address, hdAddress({ xpub: paired.xpub, path: 'receive' }, 0, 'bchtest'), 'first task address comes from the paired wallet');
  ctx.watch.push(task.address);
  const view = await payWithWallet(task.id, { base, onStatus: () => {}, onPairing: (uri) => sides.push(connectTestWallet(wallet, uri)) });
  assert.equal(view.status, 'PAID');
  assert.equal(view.result, 'relay result');
});
