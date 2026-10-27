import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAuditLog, verifyChain } from './audit.js';
import { createElectrumChain } from './chain.js';
import { createAgent } from './agent.js';
import { createService } from './service.js';
import { checkAddress, checkXpub, createOwnerStore, tokenAddress } from './receiver.js';

const MAX_BODY = 256 * 1024; // a signed transaction with many inputs

export function createApp({ config, service, audit, owner }) {
  const page = readFileSync(new URL('../public/index.html', import.meta.url));
  const ownerPage = readFileSync(new URL('../public/owner.html', import.meta.url));
  const deck = readFileSync(new URL('../public/presentation.html', import.meta.url));
  const isReviewer = (req) => {
    const given = Buffer.from(String(req.headers['x-review-token'] ?? ''));
    const want = Buffer.from(config.reviewToken);
    return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
  };
  const body = (req) => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(Object.assign(new Error('body too large'), { status: 413 }));
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
  });

  return createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      // Wallet requests carry bytes and satoshi bigints: bytes go as hex, bigints as decimal strings.
      res.end(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v)));
    };
    try {
      const { pathname } = new URL(req.url, 'http://local');
      const [, api, resource, id, action] = pathname.split('/');
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      if (req.method === 'GET' && pathname === '/presentation') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(deck);
      }
      if (req.method === 'GET' && pathname === '/owner') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(ownerPage);
      }
      if (req.method === 'GET' && pathname === '/wallet.bundle.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        return res.end(readFileSync(new URL('../public/wallet.bundle.js', import.meta.url)));
      }
      if (api !== 'api') return send(404, { error: 'not found' });
      if (resource === 'config' && req.method === 'GET') {
        // Donations (BLAZE community votes) go to the owner's static address in its token-aware form until one is set explicitly.
        const r = owner.current();
        const donation = config.donationAddress || (r?.mode === 'static' ? tokenAddress(r.address) : null);
        return send(200, {
          network: config.network, minPriceSats: config.minPriceSats, autoMaxSats: config.autoMaxSats, maxPriceSats: config.maxPriceSats,
          repoUrl: config.repoUrl || null, donationAddress: donation
        });
      }
      if (resource === 'audit' && req.method === 'GET') {
        const entries = audit.read();
        return send(200, { verified: verifyChain(entries), entries });
      }
      // The owner sets where payments go: a wallet paired over WizardConnect (its receive xpub) or one static address.
      if (resource === 'owner') {
        if (!isReviewer(req)) return send(403, { error: 'owner token required' });
        if (!id && req.method === 'GET') {
          const r = owner.current();
          return send(200, { receiver: r && { mode: r.mode, path: r.path, xpub: r.xpub && `${r.xpub.slice(0, 12)}…${r.xpub.slice(-6)}`, address: r.address } });
        }
        if (id === 'wallet' && req.method === 'POST') {
          const { xpub, path = 'receive' } = await body(req);
          owner.save({ hd: checkXpub(xpub, path, config.network) });
          audit.append({ status: 'OWNER_WALLET_SET', path });
          return send(200, { ok: true });
        }
        if (id === 'wallet' && req.method === 'DELETE') {
          owner.save({ hd: null });
          audit.append({ status: 'OWNER_WALLET_REMOVED' });
          return send(200, { ok: true });
        }
        if (id === 'static-address' && req.method === 'POST') {
          owner.save({ staticAddress: checkAddress((await body(req)).address, config.addressPrefix) });
          audit.append({ status: 'OWNER_STATIC_ADDRESS_SET' });
          return send(200, { ok: true });
        }
        return send(404, { error: 'not found' });
      }
      if (resource !== 'tasks') return send(404, { error: 'not found' });
      // The list hands out task ids, and an id unlocks a paid result: reviewers only.
      if (!id && req.method === 'GET') return isReviewer(req) ? send(200, service.list()) : send(403, { error: 'reviewer token required' });
      if (!id && req.method === 'POST') return send(201, await service.submit(await body(req)));
      if (id && !action && req.method === 'GET') return send(200, service.view(id));
      if (action === 'check' && req.method === 'POST') return send(200, await service.checkPayment(id));
      if (action === 'payment-request' && req.method === 'POST') return send(200, await service.paymentRequest(id, (await body(req)).paths));
      if (action === 'payment' && req.method === 'POST') return send(200, await service.submitPayment(id, (await body(req)).signedTransaction));
      if (action === 'review' && req.method === 'POST') {
        if (!isReviewer(req)) return send(403, { error: 'reviewer token required' });
        const { approve, reviewer = 'reviewer' } = await body(req);
        return send(200, await service.review(id, approve === true, String(reviewer).slice(0, 80)));
      }
      return send(404, { error: 'not found' });
    } catch (error) {
      send(error.status ?? 500, { error: error.status ? error.message : 'internal error' });
      if (!error.status) console.error(error);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  if (config.hdPublicKey) checkXpub(config.hdPublicKey, config.hdPublicKeyPath, config.network);
  if (config.receiveAddress) config.receiveAddress = checkAddress(config.receiveAddress, config.addressPrefix);
  if (!config.reviewToken || config.reviewToken.length < 24) throw new Error('set REVIEW_TOKEN to a random secret of 24+ characters');
  mkdirSync(config.dataDir, { recursive: true });
  const audit = createAuditLog(join(config.dataDir, 'audit.jsonl'));
  const owner = createOwnerStore(join(config.dataDir, 'owner.json'), config);
  const service = createService({
    config, audit, owner, chain: createElectrumChain(config.electrumHost), agent: createAgent(),
    storePath: join(config.dataDir, 'tasks.json')
  });
  createApp({ config, service, audit, owner }).listen(config.port, () => console.log(`pay-per-task agent on :${config.port} (${config.network})`));
}
