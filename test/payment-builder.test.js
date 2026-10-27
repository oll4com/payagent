import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binToHex, cashAddressToLockingBytecode, decodeTransaction, encodeTransaction, hexToBin } from '@bitauth/libauth';
import { buildPaymentRequest, pathXpubs, paysTask } from '../src/payment-builder.js';
import { taskAddress } from '../src/chain.js';
import { testHdPublicKey } from './helpers.js';

const prefix = 'bchtest';
const wallet = { receive: testHdPublicKey(), change: testHdPublicKey() };
const task = { id: 'task-0001-abcd', address: taskAddress(testHdPublicKey(), 0, prefix), priceSats: 10_000 };
const txid = (n) => String(n).padStart(64, '0');
const chainWith = (utxosByAddress) => ({ listUnspent: async (address) => utxosByAddress[address] ?? [] });
const bytecode = (address) => binToHex(cashAddressToLockingBytecode(address).bytecode);

test('pays the task in full from the wallet, change back to the wallet, signing paths for each input', async () => {
  const a0 = taskAddress(wallet.receive, 0, prefix);
  const c3 = taskAddress(wallet.change, 3, prefix);
  const chain = chainWith({
    [a0]: [{ tx_hash: txid(1), tx_pos: 0, value: 6000 }, { tx_hash: txid(9), tx_pos: 0, value: 50_000, token_data: {} }],
    [c3]: [{ tx_hash: txid(2), tx_pos: 1, value: 8000 }]
  });
  const request = await buildPaymentRequest({ xpubs: wallet, task, chain, prefix });
  const tx = decodeTransaction(hexToBin(request.transaction));
  assert.equal(tx.inputs.length, 2, 'both plain coins, never the CashToken one');
  assert.deepEqual(request.inputPaths, [[0, 'change', 3], [1, 'receive', 0]]);
  assert.equal(tx.outputs[0].valueSatoshis, 10_000n);
  assert.equal(binToHex(tx.outputs[0].lockingBytecode), bytecode(task.address));
  const fee = 14_000n - 10_000n - tx.outputs[1].valueSatoshis;
  assert.equal(fee, BigInt(10 + 148 * 2 + 34 * 2));
  assert.equal(binToHex(tx.outputs[1].lockingBytecode), bytecode(taskAddress(wallet.change, 0, prefix)));
  assert.equal(request.sourceOutputs[0].valueSatoshis, 8000n);
  assert.ok(paysTask(request.transaction, task));
});

test('no change output when the change would be dust', async () => {
  const a0 = taskAddress(wallet.receive, 0, prefix);
  const request = await buildPaymentRequest({ xpubs: wallet, task, chain: chainWith({ [a0]: [{ tx_hash: txid(1), tx_pos: 0, value: 10_500 }] }), prefix });
  assert.equal(decodeTransaction(hexToBin(request.transaction)).outputs.length, 1);
});

test('too little money, missing xpubs and short payments are refused', async () => {
  const a0 = taskAddress(wallet.receive, 0, prefix);
  await assert.rejects(buildPaymentRequest({ xpubs: wallet, task, chain: chainWith({ [a0]: [{ tx_hash: txid(1), tx_pos: 0, value: 10_000 }] }), prefix }), /too low/);
  assert.throws(() => pathXpubs([{ name: 'receive', xpub: wallet.receive }]), /receive and change/);
  assert.deepEqual(pathXpubs([{ name: 'receive', xpub: 'r' }, { name: 'change', xpub: 'c' }, { name: 'defi', xpub: 'd' }]), { receive: 'r', change: 'c' });
  const short = binToHex(encodeTransaction({ version: 2, locktime: 0, inputs: [], outputs: [{ lockingBytecode: hexToBin(bytecode(task.address)), valueSatoshis: 9_999n }] }));
  assert.equal(paysTask(short, task), false);
  assert.equal(paysTask('zz', task), false);
});
