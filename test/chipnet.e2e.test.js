// Opt-in: CHIPNET_E2E=1 npm test. Pays a real task on chipnet end to end: the browser's own WizardConnect code (web/wallet.js)
// pairs with the test wallet over a public Nostr relay, the server builds the payment, the wallet signs, the server checks and
// broadcasts, and the task is released once Fulcrum sees the payment. Needs test coins on the test wallet's funding address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createAuditLog } from '../src/audit.js';
import { createElectrumChain } from '../src/chain.js';
import { createOwnerStore } from '../src/receiver.js';
import { createService } from '../src/service.js';
import { createApp } from '../src/server.js';
import { connectTestWallet, loadTestWallet } from './test-wallet.js';

test('chipnet: a customer pays a task from a WizardConnect wallet and gets the result', { skip: process.env.CHIPNET_E2E !== '1', timeout: 180_000 }, async (t) => {
  const wallet = loadTestWallet();
  const dir = mkdtempSync(join(tmpdir(), 'ppta-e2e-'));
  const config = loadConfig({ HD_PUBLIC_KEY: wallet.shopReceiveXpub, HD_PUBLIC_KEY_PATH: 'receive', REVIEW_TOKEN: 'e2e-reviewer-token-0123456789', DATA_DIR: dir });
  const chain = createElectrumChain(config.electrumHost);
  const audit = createAuditLog(join(dir, 'audit.jsonl'));
  const owner = createOwnerStore(join(dir, 'owner.json'), config);
  const service = createService({ config, audit, chain, owner, agent: async (d) => `Finished: ${d}`, storePath: join(dir, 'tasks.json') });
  const server = createApp({ config, service, audit, owner }).listen(0);
  let walletSide;
  t.after(() => { server.close(); walletSide?.disconnectAll(); chain.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const task = await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: 'Write one sentence about Bitcoin Cash.', priceSats: 1500 }) })).json();
  assert.equal(task.status, 'AWAITING_PAYMENT');

  const { payWithWallet } = await import('../web/wallet.js');
  const steps = [];
  let view = await payWithWallet(task.id, { base, onStatus: (s) => steps.push(s), onPairing: (uri) => { walletSide = connectTestWallet(wallet, uri); } });
  for (let i = 0; i < 20 && view.status !== 'PAID'; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    view = await (await fetch(`${base}/api/tasks/${task.id}/check`, { method: 'POST' })).json();
  }
  assert.equal(view.status, 'PAID', JSON.stringify(view));
  assert.equal(view.result, 'Finished: Write one sentence about Bitcoin Cash.');
  const broadcast = audit.read().find((e) => e.status === 'BROADCAST');
  assert.match(broadcast.txid, /^[0-9a-f]{64}$/);
  console.log(`chipnet txid ${broadcast.txid}; steps: ${steps.join(' / ')}`);
});
