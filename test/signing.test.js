import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualMachineBCH, decodeTransaction, hexToBin } from '@bitauth/libauth';
import { buildPaymentRequest, paysTask } from '../src/payment-builder.js';
import { hdAddress } from '../src/receiver.js';
import { loadTestWallet } from './test-wallet.js';

test('a server-built payment, signed the WizardConnect way, passes the BCH virtual machine', async () => {
  const wallet = loadTestWallet();
  const xpubs = Object.fromEntries(wallet.customerPaths.map((p) => [p.name, p.xpub]));
  const funded = hdAddress({ xpub: xpubs.receive, path: 'receive' }, 0, 'bchtest');
  const change2 = hdAddress({ xpub: xpubs.change, path: 'receive' }, 2, 'bchtest');
  const chain = { listUnspent: async (a) => ({ [funded]: [{ tx_hash: '11'.repeat(32), tx_pos: 0, value: 6000 }], [change2]: [{ tx_hash: '22'.repeat(32), tx_pos: 3, value: 9000 }] })[a] ?? [] };
  const task = { id: 'signing-test', address: hdAddress({ xpub: wallet.shopReceiveXpub, path: 'receive' }, 0, 'bchtest'), amountSats: 12_000 };
  const request = await buildPaymentRequest({ xpubs, task, chain, prefix: 'bchtest' });
  const signed = wallet.sign({ transaction: request.transaction, sourceOutputs: request.sourceOutputs }, request.inputPaths);
  const result = createVirtualMachineBCH().verify({ sourceOutputs: request.sourceOutputs, transaction: decodeTransaction(hexToBin(signed)) });
  assert.equal(result, true, String(result));
  assert.ok(paysTask(signed, task));
});
