// Opt-in: BROWSER_E2E=1 npm test. The real pages in headless Chrome (system Chrome, CHROME_PATH to override), with their
// Content-Security-Policy, on chipnet: the owner pairs a shop wallet on /owner, then a customer submits a task on / and pays it
// with the WizardConnect button; the chipnet test wallet answers over the public relays. Needs test coins on the funding address.
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

test('browser: the owner pairs a wallet on /owner, a customer pays a task with WizardConnect', { skip: process.env.BROWSER_E2E !== '1', timeout: 240_000 }, async (t) => {
  const { chromium } = await import('playwright-core');
  const wallet = loadTestWallet();
  const token = 'browser-e2e-owner-token-0123456789';
  const dir = mkdtempSync(join(tmpdir(), 'ppta-browser-'));
  const config = loadConfig({ REVIEW_TOKEN: token, DATA_DIR: dir });
  const chain = createElectrumChain(config.electrumHost);
  const audit = createAuditLog(join(dir, 'audit.jsonl'));
  const owner = createOwnerStore(join(dir, 'owner.json'), config);
  const service = createService({ config, audit, chain, owner, agent: async (d) => `Done: ${d}`, storePath: join(dir, 'tasks.json') });
  const server = createApp({ config, service, audit, owner }).listen(0);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const sides = [];
  t.after(async () => { sides.forEach((s) => s.disconnectAll()); await browser.close(); server.close(); await chain.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage();
  const problems = [];
  // WizardConnect's own teardown logs these after we close the relay on purpose; anything else is a failure.
  const teardownNoise = /^WebSocket is already in CLOSING or CLOSED state\.|Failed to publish dapp_ready to (a relay|all relays)|relay connection closed by us/;
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !teardownNoise.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const cspViolations = async () => page.evaluate(() => window.__csp);
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  const wizLink = async () => {
    await page.waitForFunction(() => document.getElementById('wizlink')?.href.startsWith('wiz:'), null, { timeout: 30_000 });
    // No pause: the page shows the code only once its relay subscription is live, so a wallet may connect at once.
    return page.getAttribute('#wizlink', 'href');
  };

  // Owner: pair account 2 of the test wallet as the shop wallet.
  await page.goto(`${base}/owner`);
  await page.fill('#token', token);
  await page.click('#pair');
  sides.push(connectTestWallet(wallet, await wizLink(), 2));
  await page.waitForFunction(() => /Paired with|Not paired/.test(document.getElementById('status').textContent), null, { timeout: 60_000 })
    .catch(() => {});
  assert.match(await page.textContent('#status'), /Paired with/);
  assert.equal(owner.current().xpub, wallet.accountPaths(2)[0].xpub, 'only the receive xpub reached the server');
  assert.deepEqual(await cspViolations(), [], 'no CSP violation on /owner');

  // Customer: a task on the home page, paid with the WizardConnect button.
  await page.goto(base);
  await page.waitForFunction(() => document.getElementById('network').textContent === 'chipnet');
  await page.fill('#description', 'Write one sentence about Bitcoin Cash.');
  await page.fill('#price', '1200');
  await page.click('button[type=submit]');
  await page.getByRole('button', { name: 'Pay with a WizardConnect wallet' }).click();
  sides.push(connectTestWallet(wallet, await wizLink(), 0));
  await page.waitForFunction(() => /PAID/.test(document.getElementById('task').textContent), null, { timeout: 120_000 });
  assert.match(await page.textContent('#task'), /Done: Write one sentence about Bitcoin Cash\./);
  assert.deepEqual(await cspViolations(), [], 'no CSP violation on the home page');
  assert.deepEqual(problems, [], 'no page errors, HTTP errors or console errors');
  const broadcast = audit.read().find((e) => e.status === 'BROADCAST');
  console.log(`browser e2e txid ${broadcast.txid}`);
});
