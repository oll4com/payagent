import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { createAuditLog, verifyChain } from './audit.js';
import { createElectrumChain } from './chain.js';
import { createAgent } from './agent.js';
import { createService } from './service.js';

const MAX_BODY = 16 * 1024;

export function createApp({ config, service, audit }) {
  const page = readFileSync(new URL('../public/index.html', import.meta.url));
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
      res.end(JSON.stringify(value));
    };
    try {
      const { pathname } = new URL(req.url, 'http://local');
      const [, api, resource, id, action] = pathname.split('/');
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
      if (api !== 'api') return send(404, { error: 'not found' });
      if (resource === 'config' && req.method === 'GET') {
        return send(200, { network: config.network, minPriceSats: config.minPriceSats, autoMaxSats: config.autoMaxSats, maxPriceSats: config.maxPriceSats });
      }
      if (resource === 'audit' && req.method === 'GET') {
        const entries = audit.read();
        return send(200, { verified: verifyChain(entries), entries });
      }
      if (resource !== 'tasks') return send(404, { error: 'not found' });
      // The list hands out task ids, and an id unlocks a paid result: reviewers only.
      if (!id && req.method === 'GET') return isReviewer(req) ? send(200, service.list()) : send(403, { error: 'reviewer token required' });
      if (!id && req.method === 'POST') return send(201, await service.submit(await body(req)));
      if (id && !action && req.method === 'GET') return send(200, service.view(id));
      if (action === 'check' && req.method === 'POST') return send(200, await service.checkPayment(id));
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
  mkdirSync(config.dataDir, { recursive: true });
  const audit = createAuditLog(join(config.dataDir, 'audit.jsonl'));
  const service = createService({
    config, audit, chain: createElectrumChain(config.electrumHost), agent: createAgent(),
    storePath: join(config.dataDir, 'tasks.json')
  });
  createApp({ config, service, audit }).listen(config.port, () => console.log(`pay-per-task agent on :${config.port} (${config.network})`));
}
